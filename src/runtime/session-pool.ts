import { cancelled, policyKey, type SessionPolicy, type FilePolicy } from './permission-manager.ts'
import { EventEmitter } from 'node:events'
import { AcpClient, AcpProcessExitError, AcpTimeoutError } from '../acp/client.ts'
import { isGeoUnsupportedError } from '../common/geo.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type {
  AcpConfigOption,
  AcpMcpServerSpec,
  AcpUsage,
  InitializeResult,
  PromptContentBlock,
  SessionNewResult,
  SessionPromptResult,
  SessionUpdatePayload,
  RequestPermissionParams, RequestPermissionResult,
} from '../acp/protocol.ts'
import {
  PROVIDER_ID,
  type AccountEgressSnapshot,
  type AccountHealthSnapshot,
  type AccountLease,
  type AccountProvider,
  type AccountQuotaSample,
  type AcpModelOption,
  type PluginConfig,
  type SessionSummary,
  type StatusSnapshot,
  type UsageTotals,
} from '../common/types.ts'

import { AccountQuotaError, readAccountQuota, requireFileCredentialMode } from './account-quota.ts'
import { EgressBlockedError, EgressGuard } from './egress-guard.ts'
import { defaultEffort, sortedEfforts } from '../common/effort.ts'
import { mapUsage } from '../acp/usage.ts'
import { modelCatalog, selectOption, values } from './model-catalog.ts'

export class EgressCheckError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface ManagedAcpSession {
  models: AcpModelOption[]
  modelRoutes: ReturnType<typeof modelCatalog>['routes']
  dshSessionKey: string
  acpSessionId: string
  accountId: string
  cwd: string
  currentModel: string
  currentEffort: string
  currentMode: string
  configOptions: AcpConfigOption[]
  supportsSystemPromptAppend?: boolean
  appliedSystemHash?: string | null
  contextUsed: number | null
  contextSize: number
  lastActiveAt: number
}

export interface AuxiliaryPromptParams {
  sessionKey?: string
  model?: string
  effort?: string
  systemPromptAppend: string
  systemFallbackBlock: PromptContentBlock
  prompt: PromptContentBlock[]
  signal?: AbortSignal
  timeoutMs?: number
  onUpdate?: (update: SessionUpdatePayload) => void
}

/** Default single-account provider (current machine login). */
export class SingleAccountProvider implements AccountProvider {
  private leases = 0
  private lastUsedAt: number | null = null
  constructor(private readonly onChange?: () => void) {}

  async acquire(): Promise<AccountLease> {
    this.lastUsedAt = Date.now()
    this.leases++
    this.onChange?.()
    let released = false
    return { accountId: 'default', release: () => {
      if (released) return
      released = true
      this.leases--
      this.onChange?.()
    } }
  }

  async acquireQuotaLease(id: string): Promise<AccountLease> {
    if (id !== 'default') throw new AccountQuotaError('未知账号', 404)
    return { accountId: id, release: () => {} }
  }

  getAccountEnv(): NodeJS.ProcessEnv | undefined {
    return undefined
  }

  getHealthSnapshots(): AccountHealthSnapshot[] {
    return [{ id: 'default', label: '本机默认账号', enabled: true, hasSandboxHome: false, hasProxy: false,
      activeLeases: this.leases, lastUsedAt: this.lastUsedAt, families: {}, lastError: null }]
  }
}

export interface SessionPoolDeps {
  getConfig: () => PluginConfig
  resolveBin: () => string | null
  readPolicy: (key: string) => SessionPolicy
  prepareArgv: (argv: string[], policy: FilePolicy, signal?: AbortSignal) => Promise<string[]>
  onPermission?: (req: RequestPermissionParams, key: string, signal: AbortSignal) => Promise<RequestPermissionResult>
  isMcpBridgeActive?: () => boolean
  onConfigPatch?: (patch: Partial<PluginConfig>) => void | Promise<void>
  onConfigReset?: () => void | Promise<void>
  hasPersistedConfig?: () => boolean
  onSessionClosed?: (key: string) => void
  accountProvider?: AccountProvider
  egressGuard?: EgressGuard
  getMcpServers?: (sessionKey: string) => Promise<AcpMcpServerSpec[]>
  log?: (msg: string) => void
}

/**
 * Manages persistent `agy acp` processes (one per DSH session and policy) and maps DSH session keys
 * to long-lived ACP sessions, eliminating per-turn CLI cold starts while supporting
 * multi-account isolation and failover.
 */
export class AcpSessionPool extends EventEmitter {
  private readonly clients = new Map<string, AcpClient>()
  private readonly policies = new Map<string, string>()
  private readonly opening = new Map<string, AbortController>()
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; settle(): void }>()
  private readonly lifetime = new AbortController()
  private disposed = false
  private readonly quotaSamples = new Map<string, AccountQuotaSample>()
  private readonly quotaReads = new Map<string, Promise<void>>()
  private configQueue: Promise<void> = Promise.resolve()
  private catalogGeneration = 0
  private catalogProbe?: Promise<AcpModelOption[]>
  private catalogRetry?: ReturnType<typeof setTimeout>
  private catalogRetryCount = 0
  private catalogSignature = ''
  private initResult: InitializeResult | null = null
  private readonly sessions = new Map<string, ManagedAcpSession>()
  private readonly sessionEnvs = new Map<string, NodeJS.ProcessEnv | undefined>()
  private readonly accountProvider: AccountProvider
  private readonly egressGuard: EgressGuard
  private cachedModels: AcpModelOption[] = []
  private readonly observedWindows = new Map<string, number>()
  private catalogExpiresAt = 0
  private cachedTier: string | null = null
  private lastError: string | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private usageTotals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
  }

  constructor(private readonly deps: SessionPoolDeps) {
    super()
    this.accountProvider = deps.accountProvider ?? new SingleAccountProvider(() => this.emitStatus())
    this.egressGuard = deps.egressGuard ?? new EgressGuard({ log: deps.log })
    this.sweepTimer = setInterval(() => {
      void this.sweepIdleSessions()
    }, 60_000)
    this.sweepTimer.unref?.()
  }

  private accountLabel(accountId: string): string {
    return this.accountProvider.getHealthSnapshots?.().find(a => a.id === accountId)?.label ?? accountId
  }

  private findActiveGeoBlockedError(): EgressBlockedError | null {
    const mode = this.deps.getConfig().geoFenceMode
    if (mode === 'off' || mode === 'warn') return null
    const now = Date.now()
    for (const acc of this.accountProvider.getHealthSnapshots?.() ?? []) {
      if (!acc.enabled) continue
      const env = this.accountProvider.getAccountEnv?.(acc.id)
      const snap = this.egressGuard.getSnapshot(acc.id, env)
      if (!snap || snap.expiresAt <= now) continue
      if (snap.status === 'unsupported' || (mode === 'strict' && (snap.status === 'unknown' || snap.status === 'error'))) {
        return new EgressBlockedError(acc.id, acc.label, snap)
      }
    }
    return null
  }

  private async acquireAccountLease(
    sessionKey: string,
    model: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<AccountLease> {
    try {
      return await this.accountProvider.acquire(sessionKey, model, excludeAccountIds)
    } catch (err) {
      if (err instanceof Error && /No healthy accounts available/i.test(err.message)) {
        const geoErr = this.findActiveGeoBlockedError()
        if (geoErr) throw geoErr
      }
      throw err
    }
  }

  async assertEgressAllowed(
    accountId: string,
    env: NodeJS.ProcessEnv | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const mode = this.deps.getConfig().geoFenceMode
    if (mode === 'off') return
    const prev = this.egressGuard.getSnapshot(accountId, env)
    try {
      const snap = await this.egressGuard.assertAllowed({
        accountId,
        accountLabel: this.accountLabel(accountId),
        env,
        mode,
        signal,
      })
      if (snap) {
        if (snap.status === 'supported') {
          this.accountProvider.clearGeoBlock?.(accountId)
        }
        if (!prev || prev.checkedAt !== snap.checkedAt || prev.status !== snap.status) {
          this.emitStatus()
        }
      }
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        this.accountProvider.markGeoBlocked?.(accountId, err.snapshot.expiresAt, err.message)
        this.emitStatus()
      }
      throw err
    }
  }

  async checkAccountEgress(accountId?: string): Promise<void> {
    if (this.disposed || !this.deps.getConfig().enabled) {
      throw new EgressCheckError('ACP 插件未启用', 409)
    }
    const accounts = this.accountProvider.getHealthSnapshots?.() ?? []
    const mode = this.deps.getConfig().geoFenceMode

    const probeOne = async (id: string): Promise<AccountEgressSnapshot> => {
      const env = this.accountProvider.getAccountEnv?.(id)
      const snap = await this.egressGuard.check(id, env, { force: true, signal: this.lifetime.signal })
      if (snap.status === 'supported') {
        this.accountProvider.clearGeoBlock?.(id)
      } else if (snap.status === 'unsupported' && mode !== 'off' && mode !== 'warn') {
        this.accountProvider.markGeoBlocked?.(id, snap.expiresAt, snap.reason)
      }
      return snap
    }

    let anySupported = false
    if (accountId !== undefined) {
      const target = accounts.find(a => a.id === accountId)
      if (!target) {
        throw new EgressCheckError('未找到该账号', 404)
      }
      const snap = await probeOne(accountId)
      anySupported = snap.status === 'supported'
    } else {
      const enabled = accounts.filter(a => a.enabled)
      const results = await Promise.all(enabled.map(a => probeOne(a.id)))
      anySupported = results.some(r => r.status === 'supported')
    }

    if (anySupported && this.lastError && (this.lastError.startsWith('[安全拦截]') || this.lastError.startsWith('[地域风控熔断]'))) {
      this.lastError = null
      if (this.cachedModels.length === 0) {
        void this.refreshModels().catch(() => {})
      }
    }
    this.emitStatus()
  }

  recordGeoRejection(accountId: string, env?: NodeJS.ProcessEnv): AccountEgressSnapshot {
    const resolvedEnv = env ?? this.accountProvider.getAccountEnv?.(accountId)
    const snap = this.egressGuard.recordGeoRejection(accountId, resolvedEnv, () => {
      if (!this.disposed) this.emitStatus()
    })
    const mode = this.deps.getConfig().geoFenceMode
    if (mode !== 'off' && mode !== 'warn') {
      this.accountProvider.markGeoBlocked?.(accountId, snap.expiresAt, snap.reason)
    }
    this.lastError = `[地域风控熔断] 账号“${this.accountLabel(accountId)}”触发上游 Google 地域限制（400），已在本地熔断 60 秒；请切换至支持地区节点后点击「检测出口」。`
    this.emitStatus()
    return snap
  }

  notifyStatusChange(): void {
    this.emitStatus()
  }

  reportAccountSuccess(accountId: string, model: string): void {
    this.accountProvider.reportSuccess?.(accountId, model)
    this.emitStatus()
  }

  reportAccountFailure(accountId: string, model: string, error: unknown): void {
    this.accountProvider.reportFailure?.(accountId, model, error)
    this.emitStatus()
  }

  clearAccountCooldown(accountId?: string): void {
    this.accountProvider.clearCooldown?.(accountId)
    this.emitStatus()
  }

  getAccountHealthSnapshots(): AccountHealthSnapshot[] {
    return (this.accountProvider.getHealthSnapshots?.() ?? []).map(account => {
      const env = this.accountProvider.getAccountEnv?.(account.id)
      const egress = this.egressGuard.getSnapshot(account.id, env)
      return {
        ...account,
        ...(egress ? { egress } : {}),
        quota: this.quotaSamples.get(account.id),
        quotaRefreshUnavailable: !this.deps.getConfig().enabled ? 'ACP 插件未启用' : account.quotaRefreshUnavailable,
      }
    })
  }

  /** Manual observation only: never acquire a scheduler-selected fallback or change local cooldowns. */
  async refreshAccountQuota(id: string): Promise<void> {
    if (this.disposed || !this.deps.getConfig().enabled) throw new AccountQuotaError('ACP 插件未启用', 409)
    const account = this.getAccountHealthSnapshots().find(a => a.id === id)
    if (!account) throw new AccountQuotaError('未找到该账号', 404)
    if (account.quotaRefreshUnavailable || !account.enabled || !this.accountProvider.acquireQuotaLease) {
      throw new AccountQuotaError(account.quotaRefreshUnavailable || '此账号不支持配额查询', 409)
    }
    const pending = this.quotaReads.get(id)
    if (pending) return pending
    const task = this.probeAccountQuota(id).finally(() => this.quotaReads.delete(id))
    this.quotaReads.set(id, task)
    return task
  }

  private async probeAccountQuota(id: string): Promise<void> {
    const bin = this.deps.resolveBin()
    if (!bin) throw new AccountQuotaError('未找到 agy CLI', 503)
    const cwd = this.deps.getConfig().workspaceRoot || process.cwd()
    const signal = this.lifetime.signal
    const lease = await this.accountProvider.acquireQuotaLease!(id)
    try {
      signal.throwIfAborted()
      if (lease.accountId !== id) throw new AccountQuotaError('账号环境不匹配，未查询配额', 409)
      try {
        await this.assertEgressAllowed(lease.accountId, lease.env, signal)
      } catch (err) {
        if (err instanceof EgressBlockedError) {
          throw new AccountQuotaError(err.message, 451)
        }
        throw err
      }
      const policy: FilePolicy = { sessionId: '__quota__', mode: 'read-only', workspaceRoot: cwd }
      if (lease.requiresFileCredentialMode) {
        const versionArgv = await this.deps.prepareArgv([bin, '--version'], policy, signal)
        await requireFileCredentialMode(versionArgv, lease.env, cwd, signal)
      }
      const argv = await this.deps.prepareArgv([bin, '-p', '/usage', '--output-format', 'stream-json'], policy, signal)
      const groups = await readAccountQuota(argv, lease.env, cwd, signal)
      signal.throwIfAborted()
      this.quotaSamples.set(id, { groups, sampledAt: Date.now() })
      this.emitStatus()
    } finally { lease.release() }
  }

  contextWindowFor(model: string): number | undefined {
    return this.observedWindows.get(model) ?? (model.startsWith('claude') ? 200_000 : model.startsWith('gemini') ? 1_048_576 : undefined)
  }

  recordContextUsage(sess: ManagedAcpSession, model: string, used: number, size: number): void {
    if (!this.owns(sess) || !Number.isSafeInteger(used) || used < 0) return
    sess.contextUsed = used
    if (Number.isSafeInteger(size) && size > 0) {
      sess.contextSize = size
      this.observedWindows.set(model, size)
    }
    sess.lastActiveAt = Date.now()
    this.emitStatus()
  }

  recordTurnUsage(usage: AcpUsage | undefined): void {
    if (!usage) return
    const sample = mapUsage(usage)
    this.usageTotals = {
      inputTokens: this.usageTotals.inputTokens + sample.inputTokens,
      outputTokens: this.usageTotals.outputTokens + sample.outputTokens,
      cachedReadTokens: this.usageTotals.cachedReadTokens + (sample.cacheReadTokens ?? 0),
      cachedWriteTokens: this.usageTotals.cachedWriteTokens + (sample.cacheWriteTokens ?? 0),
      reasoningTokens: this.usageTotals.reasoningTokens + (sample.reasoningTokens ?? 0),
    }
    this.emitStatus()
  }

  private runConfigOp<T>(op: () => Promise<T>): Promise<T> {
    const next = this.configQueue.catch(() => {}).then(async () => {
      if (this.disposed) throw new Error('ACP session pool disposed')
      return await op()
    })
    this.configQueue = next.then(() => {}, () => {})
    return next
  }

  async updateConfig(patch: Partial<PluginConfig>): Promise<void> {
    await this.runConfigOp(async () => {
      await this.deps.onConfigPatch?.(patch)
      this.emitStatus()
    })
  }

  async resetConfig(): Promise<void> {
    await this.runConfigOp(async () => {
      await this.deps.onConfigReset?.()
      this.emitStatus()
    })
  }

  getStatus(): StatusSnapshot {
    const cfg = this.deps.getConfig()
    const sessions: SessionSummary[] = Array.from(this.sessions.values(), (s) => ({
      dshSessionKey: s.dshSessionKey,
      acpSessionId: s.acpSessionId,
      accountId: s.accountId,
      cwd: s.cwd,
      currentModel: s.currentModel,
      currentEffort: s.currentEffort,
      currentMode: s.currentMode,
      contextUsed: s.contextUsed,
      contextSize: s.contextSize,
      lastActiveAt: s.lastActiveAt,
    }))
    const connected = Array.from(this.clients.values()).some((c) => c.isRunning)
    return {
      providerId: PROVIDER_ID,
      enabled: cfg.enabled,
      connected,
      agentName: this.initResult?.agentInfo?.name ?? null,
      agentVersion: this.initResult?.agentInfo?.version ?? null,
      tierName: this.cachedTier,
      activeSessions: sessions.length,
      sessions,
      mcpBridgeActive: this.deps.isMcpBridgeActive?.() ?? false,
      usageTotals: { ...this.usageTotals },
      accounts: this.getAccountHealthSnapshots(),
      models: this.cachedModels.filter(m => !m.variantOf),
      config: {
        agyBin: cfg.agyBin,
        workspaceRoot: cfg.workspaceRoot,
        defaultModel: cfg.defaultModel,
        defaultEffort: cfg.defaultEffort,
        mcpBridge: cfg.mcpBridge,
        sessionIdleTtlMs: cfg.sessionIdleTtlMs,
        requestTimeoutMs: cfg.requestTimeoutMs,
        geoFenceMode: cfg.geoFenceMode,
      },
      hasPersistedConfig: this.deps.hasPersistedConfig?.() ?? false,
      lastError: this.lastError,
      updatedAt: Date.now(),
    }
  }

  policy(key: string): SessionPolicy {
    const p = this.deps.readPolicy(key)
    if (p.sessionId !== key) throw new Error('DSH permission owner mismatch')
    return p
  }

  owns(session: ManagedAcpSession): boolean {
    return this.sessions.get(session.dshSessionKey) === session
  }

  activeSignal(key: string): AbortSignal | undefined {
    const signal = this.active.get(key)?.controller.signal
    if (!signal || signal.aborted || this.policies.get(key) !== policyKey(this.policy(key))) return undefined
    return signal
  }

  beginPrompt(session: ManagedAcpSession, signal?: AbortSignal): { cancel(): void; finish(): void } {
    const key = session.dshSessionKey
    if (this.sessions.get(key) !== session || this.active.has(key) || this.policies.get(key) !== policyKey(this.policy(key))) {
      throw new Error('ACP session policy changed or session is busy; retry the turn')
    }
    signal?.throwIfAborted()
    const ac = new AbortController()
    const cancel = () => ac.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const { promise: done, resolve: settle } = Promise.withResolvers<void>()
    this.active.set(key, { controller: ac, done, settle })
    return { cancel, finish: () => {
      signal?.removeEventListener('abort', cancel)
      cancel()
      settle()
      if (this.active.get(key)?.controller === ac) this.active.delete(key)
    } }
  }

  private async newClient(
    policy: FilePolicy,
    env: NodeJS.ProcessEnv | undefined,
    signal: AbortSignal,
    onPermission?: (r: RequestPermissionParams) => Promise<RequestPermissionResult>,
    onExit?: (code: number | null, signal: NodeJS.Signals | null, client: AcpClient) => void,
  ): Promise<{ client: AcpClient; initResult: InitializeResult }> {
    const bin = this.deps.resolveBin()
    if (!bin) throw new Error('agy binary not found — install Antigravity CLI first')
    const [exe, ...args] = await this.deps.prepareArgv([bin, 'acp'], policy, signal)
    signal.throwIfAborted()
    if (!exe || this.disposed) throw new Error('ACP launch unavailable')
    const client = new AcpClient({ bin: exe, args, env, cwd: policy.workspaceRoot,
      defaultTimeoutMs: this.deps.getConfig().requestTimeoutMs, onPermission, onExit, onLog: this.deps.log })
    const stop = () => client.dispose()
    signal.addEventListener('abort', stop, { once: true })
    try {
      client.start()
      const initResult = await client.initialize()
      this.initResult = initResult
      return { client, initResult }
    } catch (err) { client.dispose(); throw err }
    finally { signal.removeEventListener('abort', stop) }
  }

  async getOrCreateSession(
    key: string,
    cwd: string,
    model = '',
    exclude?: ReadonlySet<string>,
    systemPrompt?: { append: string; hash: string },
  ): Promise<{ client: AcpClient; session: ManagedAcpSession; created: boolean }> {
    if (this.disposed || this.opening.has(key)) throw new Error('ACP session unavailable or opening')
    const previous = this.active.get(key)
    if (previous?.controller.signal.aborted) await previous.done
    else if (previous) throw new Error('ACP session already has an active turn')
    const policy = this.policy(key)
    if (cwd !== policy.workspaceRoot) throw new Error('DSH workspace changed during startup')
    const fingerprint = policyKey(policy)
    const existing = this.sessions.get(key)
    const current = this.clients.get(key)
    if (existing && current?.isRunning && !exclude?.has(existing.accountId) && this.policies.get(key) === fingerprint) {
      const existingEnv = this.sessionEnvs.get(key) ?? this.accountProvider.getAccountEnv?.(existing.accountId)
      await this.assertEgressAllowed(existing.accountId, existingEnv, this.lifetime.signal)
      existing.lastActiveAt = Date.now()
      return { client: current, session: existing, created: false }
    }
    if (existing || current) this.invalidate(key)
    const opening = new AbortController()
    this.opening.set(key, opening)
    const stopOpening = () => client?.dispose()
    opening.signal.addEventListener('abort', stopOpening, { once: true })
    let lease: AccountLease | undefined
    let client: AcpClient | undefined
    try {
      lease = await this.acquireAccountLease(key, model, exclude)
      opening.signal.throwIfAborted()
      await this.assertEgressAllowed(lease.accountId, lease.env, opening.signal)
      opening.signal.throwIfAborted()
      const launched = await this.newClient(
        policy,
        lease.env,
        opening.signal,
        async req => {
          const signal = this.activeSignal(key)
          if (!signal || this.clients.get(key) !== client || req.sessionId !== this.sessions.get(key)?.acpSessionId) return cancelled()
          return await this.deps.onPermission?.(req, key, signal) ?? cancelled()
        },
        (code, signal, exitedClient) => {
          if (this.clients.get(key) !== exitedClient) return
          this.deps.log?.(`agy acp session "${key}" exited unexpectedly (code=${String(code)}, signal=${String(signal)})`)
          this.clients.delete(key)
          this.sessions.delete(key)
          this.sessionEnvs.delete(key)
          this.policies.delete(key)
          const activeTurn = this.active.get(key)
          if (activeTurn) {
            activeTurn.controller.abort()
            activeTurn.settle()
            this.active.delete(key)
          }
          this.deps.onSessionClosed?.(key)
          this.emitStatus()
        },
      )
      client = launched.client
      const supportsSystemPromptAppend = Boolean(launched.initResult.agentCapabilities?._meta?.antigravity?.systemPrompt?.append)
      opening.signal.throwIfAborted()
      const mcpServers = await this.deps.getMcpServers?.(key) ?? []
      opening.signal.throwIfAborted()
      const res = await client.sessionNew({
        cwd,
        mcpServers,
        ...(supportsSystemPromptAppend && systemPrompt?.append
          ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt.append } } } }
          : {}),
      })
      opening.signal.throwIfAborted()
      if (policyKey(this.policy(key)) !== fingerprint) throw new Error('DSH session policy changed during startup')
      const { routes: modelRoutes, models } = this.captureCatalogFromSession(res)
      const configOptions = res.configOptions ?? []
      const session: ManagedAcpSession = {
        models,
        modelRoutes,
        dshSessionKey: key, acpSessionId: res.sessionId, accountId: lease.accountId, cwd,
        currentModel: findCurrentOption(configOptions, 'model') ?? res.models?.currentModelId ?? '',
        currentEffort: findCurrentOption(configOptions, 'thought_level') ?? '',
        currentMode: findCurrentOption(configOptions, 'mode') ?? res.modes?.currentModeId ?? '',
        configOptions,
        supportsSystemPromptAppend,
        appliedSystemHash: supportsSystemPromptAppend && systemPrompt ? systemPrompt.hash : null,
        contextUsed: null, contextSize: 0, lastActiveAt: Date.now(),
      }
      this.clients.set(key, client)
      this.sessions.set(key, session)
      this.sessionEnvs.set(key, lease.env)
      this.policies.set(key, fingerprint)
      this.emitStatus()
      return { client, session, created: true }
    } catch (err) {
      client?.dispose()
      this.deps.onSessionClosed?.(key)
      throw err
    } finally { opening.signal.removeEventListener('abort', stopOpening); this.opening.delete(key); lease?.release() }
  }

  /**
   * Stateless, read-only, tool-free auxiliary prompt execution (e.g. `session-title`, `compaction`).
   * Never enters `this.sessions`, refuses all permissions, enforces `mode=default`, and cleans up immediately.
   */
  async runAuxiliaryPrompt(params: AuxiliaryPromptParams): Promise<SessionPromptResult> {
    if (this.disposed) throw new Error('ACP session pool disposed')
    const cfg = this.deps.getConfig()
    const runSignal = params.signal ? AbortSignal.any([this.lifetime.signal, params.signal]) : this.lifetime.signal
    runSignal.throwIfAborted()

    let cwd = params.sessionKey ? this.sessions.get(params.sessionKey)?.cwd : undefined
    if (!cwd && params.sessionKey) {
      try { cwd = this.policy(params.sessionKey).workspaceRoot } catch { /* fallback to workspaceRoot/cwd */ }
    }
    cwd = cwd || cfg.workspaceRoot || process.cwd()

    const requestedModel = params.model || cfg.defaultModel || ''
    const maxAccounts = Math.max(1, cfg.accounts.filter((a) => a.enabled !== false).length || 1)
    const triedAccounts = new Set<string>()

    const denyAllPermissions = async (req: RequestPermissionParams): Promise<RequestPermissionResult> => {
      const reject = req.options.find(o => o.kind === 'reject_once')
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelled()
    }

    for (let attempt = 0; attempt < maxAccounts; attempt++) {
      const lease = await this.acquireAccountLease(
        '__auxiliary__',
        requestedModel,
        triedAccounts.size > 0 ? triedAccounts : undefined,
      )
      let client: AcpClient | undefined
      let acpSessionId: string | undefined
      let unsub: (() => void) | undefined
      const onAbort = (): void => {
        if (acpSessionId && client?.isRunning) client.sessionCancel(acpSessionId)
      }

      try {
        runSignal.throwIfAborted()
        await this.assertEgressAllowed(lease.accountId, lease.env, runSignal)
        runSignal.throwIfAborted()
        const launched = await this.newClient(
          { sessionId: '__auxiliary__', mode: 'read-only', workspaceRoot: cwd },
          lease.env,
          runSignal,
          denyAllPermissions,
        )
        client = launched.client
        const supportsAppend = Boolean(launched.initResult.agentCapabilities?._meta?.antigravity?.systemPrompt?.append)
        runSignal.throwIfAborted()

        const res = await client.sessionNew({
          cwd,
          mcpServers: [],
          ...(supportsAppend && params.systemPromptAppend
            ? { _meta: { antigravity: { systemPrompt: { append: params.systemPromptAppend } } } }
            : {}),
        })
        acpSessionId = res.sessionId
        runSignal.throwIfAborted()

        let configOptions = res.configOptions ?? []
        const modeOpt = selectOption(configOptions, 'mode')
        let currentMode = modeOpt?.currentValue ?? res.modes?.currentModeId ?? ''
        if (currentMode !== 'default') {
          const canSetDefault =
            values(modeOpt).some(o => o.value === 'default') ||
            Boolean(res.modes?.availableModes?.some(m => m.id === 'default'))
          if (canSetDefault) {
            const modeRes = await client.sessionSetConfigOption({
              sessionId: acpSessionId,
              configId: modeOpt?.id ?? 'mode',
              value: 'default',
            })
            if (modeRes.configOptions) configOptions = modeRes.configOptions
            currentMode = modeRes.configOptions ? (findCurrentOption(modeRes.configOptions, 'mode') ?? '') : 'default'
          }
          if (currentMode !== 'default' && currentMode !== 'plan' && currentMode !== '') {
            throw new Error(`Antigravity auxiliary call refused unsafe permission mode "${currentMode}"`)
          }
        }

        const { routes } = modelCatalog(res)
        let currentModel = findCurrentOption(configOptions, 'model') ?? res.models?.currentModelId ?? ''
        if (requestedModel) {
          const route = routes.get(requestedModel)
          const targetModel = route?.value ?? requestedModel
          if (targetModel && targetModel !== currentModel) {
            if (route?.kind === 'legacy') {
              await client.request('session/set_model', { sessionId: acpSessionId, modelId: targetModel }, 15_000)
              currentModel = targetModel
            } else if (route?.kind === 'config' || values(selectOption(configOptions, 'model')).some(o => o.value === targetModel)) {
              const mRes = await client.sessionSetConfigOption({
                sessionId: acpSessionId,
                configId: selectOption(configOptions, 'model')?.id ?? 'model',
                value: targetModel,
              })
              if (mRes.configOptions) configOptions = mRes.configOptions
              currentModel = mRes.configOptions ? (findCurrentOption(mRes.configOptions, 'model') ?? targetModel) : targetModel
            }
          }
        }

        if (params.effort) {
          const thoughtOpt = selectOption(configOptions, 'thought_level')
          if (thoughtOpt && values(thoughtOpt).some(o => o.value === params.effort) && thoughtOpt.currentValue !== params.effort) {
            const eRes = await client.sessionSetConfigOption({
              sessionId: acpSessionId,
              configId: thoughtOpt.id,
              value: params.effort,
            })
            if (eRes.configOptions) configOptions = eRes.configOptions
          }
        }

        if (params.onUpdate) {
          unsub = client.onSessionUpdate(acpSessionId, params.onUpdate)
        }
        runSignal.addEventListener('abort', onAbort, { once: true })
        runSignal.throwIfAborted()

        const promptBlocks = supportsAppend ? params.prompt : [params.systemFallbackBlock, ...params.prompt]
        const timeoutMs = params.timeoutMs ?? Math.min(cfg.requestTimeoutMs, 90_000)
        const result = await client.sessionPrompt({ sessionId: acpSessionId, prompt: promptBlocks }, timeoutMs)
        this.reportAccountSuccess(lease.accountId, requestedModel)
        this.recordTurnUsage(result.usage)
        return result
      } catch (err) {
        if (err instanceof EgressBlockedError) {
          triedAccounts.add(lease.accountId)
          if (triedAccounts.size < maxAccounts && !runSignal.aborted) {
            continue
          }
          throw err
        }
        if (isGeoUnsupportedError(err)) {
          this.recordGeoRejection(lease.accountId, lease.env)
          triedAccounts.add(lease.accountId)
          this.reportAccountFailure(lease.accountId, requestedModel, err)
          if (triedAccounts.size < maxAccounts && !runSignal.aborted) {
            continue
          }
          throw err
        }
        this.reportAccountFailure(lease.accountId, requestedModel, err)
        throw err
      } finally {
        runSignal.removeEventListener('abort', onAbort)
        unsub?.()
        if (acpSessionId && client?.isRunning && !runSignal.aborted) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            client.sessionClose(acpSessionId).catch(() => {}),
            new Promise<void>(resolve => {
              timer = setTimeout(resolve, 1_000)
              timer.unref?.()
            }),
          ])
          if (timer) clearTimeout(timer)
        }
        client?.dispose()
        lease.release()
      }
    }
    throw new Error('Auxiliary prompt exhausted all candidate accounts')
  }

  async syncSessionOptions(
    client: AcpClient,
    session: ManagedAcpSession,
    desired: { model?: string; effort?: string; configuredEffort?: string; mode?: string },
  ): Promise<void> {
    const route = desired.model ? session.modelRoutes.get(desired.model) : undefined
    const model = route?.value ?? desired.model
    if (model && model !== session.currentModel) {
      session.contextUsed = null
      session.contextSize = 0
      if (route?.kind === 'legacy') {
        await client.request('session/set_model', { sessionId: session.acpSessionId, modelId: model }, 15_000)
        session.currentModel = model
        session.currentEffort = ''
      } else {
        const res = await client.sessionSetConfigOption({
          sessionId: session.acpSessionId,
          configId: selectOption(session.configOptions, 'model')?.id ?? 'model', value: model,
        })
        if (res.configOptions) session.configOptions = res.configOptions
        session.currentModel = res.configOptions ? findCurrentOption(res.configOptions, 'model') ?? model : model
        session.currentEffort = findCurrentOption(res.configOptions ?? [], 'thought_level') ?? ''
        if (session.currentModel !== model) throw new Error(`agy did not select model ${model}`)
        // Some peers advertise levels only after switching the model. Never
        // copy the previous model's selector into this model's capabilities.
        const base = session.models.find(m => m.value === model)
        const thought = selectOption(res.configOptions, 'thought_level')
        if (base && !base.efforts.length && thought) {
          base.efforts = sortedEfforts(values(thought).map(o => o.value))
          base.nativeEffort = thought.currentValue
        }
      }
    }
    const fixedEffort = route?.kind === 'config' ? route.effort : undefined
    const effort = route?.kind === 'legacy' ? undefined : fixedEffort ?? desired.effort
      ?? defaultEffort(session.models.find(m => m.value === model), desired.configuredEffort ?? '')
    if (effort && effort !== session.currentEffort) {
      const option = selectOption(session.configOptions, 'thought_level')
      if (option && values(option).some(o => o.value === effort)) {
        const res = await client.sessionSetConfigOption({ sessionId: session.acpSessionId, configId: option.id, value: effort })
        if (res.configOptions) session.configOptions = res.configOptions
        session.currentEffort = res.configOptions ? findCurrentOption(res.configOptions, 'thought_level') ?? '' : effort
      }
      if (session.currentEffort !== effort) throw new Error(`agy did not select reasoning effort ${effort} for ${desired.model}`)
    }

    if (desired.mode && desired.mode !== session.currentMode) {
      const res = await client.sessionSetConfigOption({
        sessionId: session.acpSessionId,
        configId: 'mode',
        value: desired.mode,
      })
      if (res.configOptions) {
        session.configOptions = res.configOptions
        session.currentMode = findCurrentOption(res.configOptions, 'mode') ?? desired.mode
        if (route?.kind === 'config') {
          session.currentEffort = findCurrentOption(res.configOptions, 'thought_level') ?? ''
          if (effort && session.currentEffort !== effort) throw new Error(`agy did not retain reasoning effort ${effort} for ${desired.model}`)
        }
      } else {
        session.currentMode = desired.mode
      }
    }
  }

  invalidateCatalog(): void {
    this.catalogGeneration++
    this.catalogExpiresAt = 0
    clearTimeout(this.catalogRetry)
    this.catalogRetry = undefined
    this.catalogRetryCount = 0
    this.catalogProbe = undefined
  }

  private runCatalogProbe(cwd?: string): Promise<AcpModelOption[]> {
    if (!this.catalogProbe) {
      const gen = this.catalogGeneration
      const probe = this.probeCatalog(cwd, gen).catch(err => {
        if (this.disposed || gen !== this.catalogGeneration) throw err
        // A failed group is cached by DSH's menu just like a successful group. Retry
        // the constrained discovery, then publish its recovery without requiring a chat turn.
        this.lastError = formatCatalogProbeError(err)
        const isGeoBlocked = err instanceof EgressBlockedError || isGeoUnsupportedError(err)
        const delay = isGeoBlocked ? undefined : [5_000, 30_000, 60_000][this.catalogRetryCount]
        if (delay !== undefined && !this.catalogRetry) {
          this.catalogRetryCount++
          this.catalogRetry = setTimeout(() => {
            this.catalogRetry = undefined
            this.catalogExpiresAt = 0
            void this.refreshModels(cwd).catch(() => {})
          }, delay)
          this.catalogRetry.unref?.()
        }
        // Keep the last successful list during a transient outage. Avoid one failed
        // re-probe per resolveModelInfo when the host expands the returned group.
        if (this.cachedModels.length) {
          this.catalogExpiresAt = Date.now() + (delay ?? 30_000)
        }
        this.emitStatus()
        throw err
      }).finally(() => {
        if (this.catalogProbe === probe) this.catalogProbe = undefined
      })
      this.catalogProbe = probe
    }
    return this.catalogProbe
  }

  async refreshModels(cwd?: string): Promise<AcpModelOption[]> {
    if (this.cachedModels.length > 0 && Date.now() < this.catalogExpiresAt) return this.cachedModels
    try {
      return await this.runCatalogProbe(cwd)
    } catch (err) {
      if (!this.disposed && this.cachedModels.length > 0) {
        return this.cachedModels
      }
      throw err
    }
  }

  async forceRefreshModels(cwd?: string): Promise<AcpModelOption[]> {
    if (this.disposed) throw new Error('ACP session pool disposed')
    this.invalidateCatalog()
    return await this.runCatalogProbe(cwd)
  }

  private async probeCatalog(cwd?: string, expectedGen?: number): Promise<AcpModelOption[]> {
    const cfg = this.deps.getConfig()
    const maxAccounts = Math.max(1, cfg.accounts.filter((a) => a.enabled !== false).length || 1)
    const triedAccounts = new Set<string>()
    for (let attempt = 0; attempt < maxAccounts; attempt++) {
      const lease = await this.acquireAccountLease(
        '__catalog__',
        '',
        triedAccounts.size > 0 ? triedAccounts : undefined,
      )
      let client: AcpClient | undefined
      try {
        await this.assertEgressAllowed(lease.accountId, lease.env, this.lifetime.signal)
        const root = cwd || cfg.workspaceRoot || process.cwd()
        // No initiating agent: never prompt, attach MCP, or start an unrestricted helper.
        client = (await this.newClient({ sessionId: '__catalog__', workspaceRoot: root, mode: 'read-only' }, lease.env, this.lifetime.signal)).client
        this.lifetime.signal.throwIfAborted()
        const stop = () => client?.dispose()
        this.lifetime.signal.addEventListener('abort', stop, { once: true })
        try {
          const res = await client.sessionNew({ cwd: root, mcpServers: [] })
          if (expectedGen !== undefined && expectedGen !== this.catalogGeneration) {
            return this.cachedModels
          }
          const catalog = this.captureCatalogFromSession(res)
          if (!catalog.models.length) throw new Error('agy returned an empty ACP model catalog')
        } finally {
          this.lifetime.signal.removeEventListener('abort', stop)
        }
        return this.cachedModels
      } catch (err) {
        if (err instanceof EgressBlockedError) {
          triedAccounts.add(lease.accountId)
          if (triedAccounts.size < maxAccounts && !this.lifetime.signal.aborted) {
            continue
          }
        } else if (isGeoUnsupportedError(err)) {
          this.recordGeoRejection(lease.accountId, lease.env)
          triedAccounts.add(lease.accountId)
          if (triedAccounts.size < maxAccounts && !this.lifetime.signal.aborted) {
            continue
          }
        }
        throw err
      } finally {
        client?.dispose()
        lease.release()
      }
    }
    return this.cachedModels
  }

  invalidate(key: string): void {
    if (!this.opening.has(key) && !this.sessions.has(key) && !this.clients.has(key)) return
    this.opening.get(key)?.abort()
    this.active.get(key)?.controller.abort()
    this.active.get(key)?.settle()
    this.active.delete(key)
    this.sessions.delete(key)
    this.sessionEnvs.delete(key)
    this.policies.delete(key)
    const client = this.clients.get(key)
    this.clients.delete(key)
    client?.dispose()
    this.deps.onSessionClosed?.(key)
    this.emitStatus()
  }

  async closeSession(key: string): Promise<void> { this.invalidate(key) }

  async resetAllSessions(): Promise<number> {
    const keys = new Set([...this.sessions.keys(), ...this.opening.keys(), ...this.clients.keys()])
    for (const key of keys) this.invalidate(key)
    return keys.size
  }

  async sweepIdleSessions(): Promise<void> {
    const ttl = this.deps.getConfig().sessionIdleTtlMs
    const now = Date.now()
    for (const [key, sess] of this.sessions) {
      if (now - sess.lastActiveAt > ttl) {
        await this.closeSession(key)
      }
    }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.disposed = true
    clearTimeout(this.catalogRetry)
    this.lifetime.abort()
    this.egressGuard.dispose()
    void this.resetAllSessions()
    this.accountProvider.dispose?.()
    this.removeAllListeners()
  }

  private captureCatalogFromSession(res: SessionNewResult) {
    const tier = res._meta?.antigravity?.tier?.name
    if (tier) this.cachedTier = tier
    const catalog = modelCatalog(res)
    if (!catalog.models.length || this.disposed) return catalog
    const signature = JSON.stringify(catalog.models.filter(m => !m.variantOf))
    const changed = signature !== this.catalogSignature || this.lastError !== null
    this.catalogSignature = signature
    this.cachedModels = catalog.models
    this.catalogExpiresAt = Date.now() + 5 * 60_000
    this.lastError = null
    clearTimeout(this.catalogRetry)
    this.catalogRetry = undefined
    this.catalogRetryCount = 0
    if (changed) {
      this.emitStatus()
      this.emit('models-updated')
    }
    return catalog
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}

function findCurrentOption(options: AcpConfigOption[], id: string): string | undefined {
  return selectOption(options, id)?.currentValue
}

export function formatCatalogProbeError(err: unknown): string {
  if (err instanceof EgressBlockedError) {
    return sanitizeDiagnosticText(err.message, 260)
  }
  if (isGeoUnsupportedError(err)) {
    return '[地域限制熔断] ACP 模型目录探测被上游 Google 地域限制（400）拒绝，已暂停自动重试；请切换至支持地区节点后点击「检测出口」或「重新探测目录」。'
  }
  if (err instanceof AcpTimeoutError) {
    return err.stderrTail
      ? `ACP 模型目录探测超时，请检查 agy CLI 登录状态或网络连接（${err.stderrTail}）`
      : 'ACP 模型目录探测超时，请检查 agy CLI 登录状态或网络连接。'
  }
  if (err instanceof AcpProcessExitError) {
    if (err.causeError && /ENOENT/i.test(err.causeError)) {
      return '未找到 agy 可执行文件，请检查 PATH 或插件配置中的 agyBin 路径。'
    }
    if (err.causeError) {
      return `ACP 模型目录探测启动失败：${sanitizeDiagnosticText(err.causeError, 160)}`
    }
    const base = `ACP 模型目录探测进程异常退出（code=${String(err.code)}, signal=${String(err.signal)}）`
    return err.stderrTail ? `${base}：${err.stderrTail}` : base
  }
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/binary not found|ENOENT/i.test(msg)) {
    return '未找到 agy 可执行文件，请检查 PATH 或插件配置中的 agyBin 路径。'
  }
  if (/refusing unconfined startup/i.test(msg)) {
    return '宿主只读沙箱不可用（未满足完整受限约束），已拒绝无沙箱探测模型目录。'
  }
  if (/empty ACP model catalog/i.test(msg)) {
    return 'agy 返回了空的 ACP 模型目录，请检查当前账号登录状态。'
  }
  const safe = sanitizeDiagnosticText(msg, 200)
  return safe ? `ACP 模型目录探测失败：${safe}` : 'ACP 模型目录探测失败；请检查 agy 登录状态和只读探测环境。'
}
