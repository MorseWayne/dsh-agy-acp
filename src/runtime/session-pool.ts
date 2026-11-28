import { cancelled, canFinishConfinedTurn, policyKey, SessionPolicyChangedError, type DecidePermissionOptions, type SessionPolicy, type FilePolicy } from './permission-manager.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAbortListener, EventEmitter } from 'node:events'
import { AcpClient, AcpProcessExitError, AcpRpcError, AcpTimeoutError } from '../acp/client.ts'
import { transcriptCandidates } from '../acp/transcript-usage.ts'
import { resolveModelAccountRoute } from '../common/account-routing.ts'
import { isGeoUnsupportedError } from '../common/geo.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import {
  supportsMcpHttp,
  supportsSessionLoad,
  supportsSessionResume,
  type AcpConfigOption,
  type AcpMcpServerSpec,
  type AcpUsage,
  type InitializeResult,
  type PromptContentBlock,
  type SessionLoadResult,
  type SessionNewResult,
  type SessionPromptResult,
  type SessionResumeResult,
  type SessionUpdatePayload,
  type RequestPermissionParams,
  type RequestPermissionResult,
} from '../acp/protocol.ts'
import {
  PROVIDER_ID,
  type AcpCapabilitiesSnapshot,
  type AccountEgressSnapshot,
  type AccountFailureOptions,
  type AccountHealthSnapshot,
  type AccountLease,
  type AccountLoginSessionSnapshot,
  type AccountProvider,
  type AccountQuotaSample,
  type AcpModelOption,
  type EnvironmentSnapshot,
  type McpBridgeSnapshot,
  type McpToolCatalogSnapshot,
  type PluginConfig,
  type ReviewProviderOption,
  type SessionSummary,
  type StatusSnapshot,
  type UsageTotals,
} from '../common/types.ts'

import { isAuthFailureError, isQuotaOrRateLimitError, isTosViolationError } from './account-pool.ts'
import { UsageStore } from './usage-store.ts'
import {
  AccountQuotaError,
  mapQuotaGroupsToFamilies,
  readAccountQuota,
  readDirectAccountQuota,
  requireFileCredentialMode,
} from './account-quota.ts'
import { EgressBlockedError, EgressGuard } from './egress-guard.ts'
import { createPrivateProcessTemp } from './session-cleanup.ts'
import type { SessionIndex } from './session-index.ts'
import { defaultEffort, sortedEfforts } from '../common/effort.ts'
import { createTurnOutcomeWatcher } from '../acp/turn-outcome.ts'
import { mapUsage } from '../acp/usage.ts'
import { mergeModelCatalog, modelCatalog, selectOption, values, type ModelCatalog } from './model-catalog.ts'

export class EgressCheckError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface ManagedAcpSession {
  models: AcpModelOption[]
  modelRoutes: ModelCatalog['routes']
  dshSessionKey: string
  acpSessionId: string
  accountId: string
  cwd: string
  currentModel: string
  /** Requested model ID used by account routing; upstream may expose a different canonical ID. */
  routingModel?: string
  currentEffort: string
  currentMode: string
  title?: string
  resumed?: boolean
  resumedVia?: 'resume' | 'load'
  mcpTransport?: 'http' | 'stdio' | 'none'
  promptCapabilities?: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  configOptions: AcpConfigOption[]
  hasMcpServers?: boolean
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
  /** When true and `effort` is not specified, pick the model's lowest available `thought_level`. */
  preferLowestEffort?: boolean
  verifySelection?: boolean
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
    return [{ id: 'default', label: '本机默认账号', enabled: true, hasSandboxHome: false,
      activeLeases: this.leases, lastUsedAt: this.lastUsedAt, families: {}, lastError: null }]
  }
}

function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, reasoningTokens: 0 }
}

interface AccountModelCatalog {
  catalog: ModelCatalog
  image?: boolean
  windows: Map<string, number>
}

export interface CallModelCapabilities {
  model: AcpModelOption
  image: boolean
  contextWindow?: number
}

interface TurnPermissions {
  requests: number
  pending: Set<string>
  granted: Set<string>
  interruptedBeforeGrant?: string
}

export interface SessionPoolDeps {
  getConfig: () => PluginConfig
  resolveBin: () => string | null
  readPolicy: (key: string) => SessionPolicy
  prepareArgv: (argv: string[], policy: FilePolicy, signal?: AbortSignal) => Promise<string[]>
  onPermission?: (req: RequestPermissionParams, key: string, signal: AbortSignal, launchPolicy: SessionPolicy, opts?: DecidePermissionOptions) => Promise<RequestPermissionResult>
  isMcpBridgeActive?: () => boolean
  getMcpBridgeSnapshot?: () => McpBridgeSnapshot
  getMcpToolCatalog?: () => McpToolCatalogSnapshot | undefined
  getEnvironmentSnapshot?: () => EnvironmentSnapshot
  getActiveLoginSnapshot?: () => AccountLoginSessionSnapshot | null
  listReviewProviders?: () => ReviewProviderOption[]
  onConfigPatch?: (patch: Partial<PluginConfig>) => void | Promise<void>
  onConfigReset?: () => void | Promise<void>
  hasPersistedConfig?: () => boolean
  onSessionClosed?: (key: string) => void
  accountProvider?: AccountProvider
  egressGuard?: EgressGuard
  sessionIndex?: SessionIndex
  usageStore?: UsageStore
  getMcpServers?: (sessionKey: string, opts?: { preferHttp?: boolean }) => Promise<AcpMcpServerSpec[]>
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
  private readonly active = new Map<string, { controller: AbortController; launchPolicy: SessionPolicy; retire: boolean; permissions: TurnPermissions; done: Promise<void>; settle(): void }>()
  private readonly lifetime = new AbortController()
  private disposed = false
  private traceSession = process.env.DSH_AGY_ACP_TRACE_SESSION
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

  /** Effective process environment bound to this session's account (if isolated). */
  accountEnvFor(session: ManagedAcpSession): NodeJS.ProcessEnv | undefined {
    return this.sessionEnvs.get(session.dshSessionKey) ?? this.accountProvider.getAccountEnv?.(session.accountId)
  }

  /** Where agy writes this session's per-call transcript, under the account's own HOME. */
  transcriptPaths(session: ManagedAcpSession): string[] {
    return transcriptCandidates(session.acpSessionId, this.accountEnvFor(session))
  }
  private readonly sessionUnsubs = new Map<string, () => void>()
  private readonly accountProvider: AccountProvider
  private readonly egressGuard: EgressGuard
  private cachedCatalog: ModelCatalog = { models: [], routes: new Map() }
  private get cachedModels(): AcpModelOption[] { return this.cachedCatalog.models }
  private catalogAccountId?: string
  private readonly accountCatalogs = new Map<string, AccountModelCatalog>()
  private readonly observedWindows = new Map<string, number>()
  private catalogExpiresAt = 0
  private cachedTier: string | null = null
  private lastError: string | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly usageStore: UsageStore
  private usageTotals: UsageTotals = emptyUsageTotals()

  constructor(private readonly deps: SessionPoolDeps) {
    super()
    this.accountProvider = deps.accountProvider ?? new SingleAccountProvider(() => this.emitStatus())
    this.usageStore = deps.usageStore ?? new UsageStore({ persist: false })
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

  recordGeoRejection(accountId: string, env?: NodeJS.ProcessEnv, publishError = true): AccountEgressSnapshot {
    const resolvedEnv = env ?? this.accountProvider.getAccountEnv?.(accountId)
    const snap = this.egressGuard.recordGeoRejection(accountId, resolvedEnv, () => {
      if (!this.disposed) this.emitStatus()
    })
    const mode = this.deps.getConfig().geoFenceMode
    if (mode !== 'off' && mode !== 'warn') {
      this.accountProvider.markGeoBlocked?.(accountId, snap.expiresAt, snap.reason)
    }
    if (publishError) {
      this.lastError = `[地域风控熔断] 账号“${this.accountLabel(accountId)}”触发上游 Google 地域限制（400），已在本地熔断 60 秒；请切换至支持地区节点后点击「检测出口」。`
    }
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

  reportAccountFailure(accountId: string, model: string, error: unknown, options?: AccountFailureOptions): void {
    this.recordAccountFailureUsage(accountId, model, error, options)
    this.accountProvider.reportFailure?.(accountId, model, error, options)
    this.emitStatus()
  }

  // Broken session history is a failed turn, but must not affect the account scheduler.
  recordAccountFailureUsage(accountId: string, model: string, error: unknown, options?: AccountFailureOptions): void {
    if (this.disposed || (error instanceof Error && (error.name === 'AbortError' ||
      ('code' in error && error.code === 'ABORT_ERR')))) return
    this.usageStore.recordFailure({ accountId, accountLabel: this.accountLabel(accountId), model,
      rateLimited: options?.code === 'QUOTA_EXHAUSTED' || isQuotaOrRateLimitError(error) })
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

  /** Observation only: never acquire a scheduler-selected fallback or change local cooldowns. */
  async refreshAccountQuota(id: string, opts?: { maxAgeMs?: number }): Promise<void> {
    if (this.disposed || !this.deps.getConfig().enabled) throw new AccountQuotaError('ACP 插件未启用', 409)
    const account = this.getAccountHealthSnapshots().find(a => a.id === id)
    if (!account) throw new AccountQuotaError('未找到该账号', 404)
    if (account.quotaRefreshUnavailable || !account.enabled || !this.accountProvider.acquireQuotaLease) {
      throw new AccountQuotaError(account.quotaRefreshUnavailable || '此账号不支持配额查询', 409)
    }
    if (typeof opts?.maxAgeMs === 'number' && Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0) {
      const existing = this.quotaSamples.get(id)
      const now = Date.now()
      if (existing && now - existing.sampledAt < opts.maxAgeMs) {
        const hasExpiredBucket = existing.groups.some(
          g =>
            (g.fiveHour?.resetAt != null && g.fiveHour.resetAt <= now) ||
            (g.sevenDay?.resetAt != null && g.sevenDay.resetAt <= now),
        )
        if (!hasExpiredBucket) return
      }
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
      let groups = lease.directQuotaHome
        ? await readDirectAccountQuota(lease.env, signal, { accountHome: lease.directQuotaHome })
        : null
      let source: 'direct' | 'cli' = 'direct'
      if (!groups?.length) {
        signal.throwIfAborted()
        source = 'cli'
        const argv = await this.deps.prepareArgv([bin, '-p', '/usage', '--output-format', 'stream-json'], policy, signal)
        groups = await readAccountQuota(argv, lease.env, cwd, signal)
      }
      signal.throwIfAborted()
      const sample: AccountQuotaSample = { groups, sampledAt: Date.now(), source }
      this.quotaSamples.set(id, sample)
      this.accountProvider.markAuthVerified?.(id)
      if (this.deps.getConfig().quotaAwareScheduling) {
        this.applySampleToScheduler(id, sample)
      }
      this.emitStatus()
    } finally { lease.release() }
  }

  private applySampleToScheduler(accountId: string, sample: AccountQuotaSample): void {
    if (!this.accountProvider.updateQuota) return
    const mapped = mapQuotaGroupsToFamilies(sample.groups)
    this.accountProvider.clearQuotaSamples?.(accountId)
    for (const [family, buckets] of Object.entries(mapped)) {
      if (buckets) {
        this.accountProvider.updateQuota(accountId, family as Parameters<NonNullable<AccountProvider['updateQuota']>>[1], buckets)
      }
    }
  }

  syncQuotaSchedulingMode(): void {
    if (this.deps.getConfig().quotaAwareScheduling) {
      for (const [id, sample] of this.quotaSamples) {
        this.applySampleToScheduler(id, sample)
      }
    } else {
      this.accountProvider.clearQuotaSamples?.()
    }
  }

  private callAccountFor(model: string): string | undefined {
    const route = resolveModelAccountRoute(this.accountProvider.getModelRouting?.(), model)?.rule
    if (route?.fallback === 'strict') return route.accountId
    // The host adapter interface provides no conversation ID here. A preferred
    // account with automatic fallback is not a reliable account identity.
    const enabled = this.accountProvider.getHealthSnapshots?.().filter(a => a.enabled)
    return enabled?.length === 1 ? enabled[0]?.id : undefined
  }

  async resolveCallModelCapabilities(model: string, signal?: AbortSignal): Promise<{ capabilities?: CallModelCapabilities } | undefined> {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('ACP session pool disposed')
    const accountId = this.callAccountFor(model)
    if (!accountId) return undefined
    const read = (): CallModelCapabilities | undefined => {
      const account = this.accountCatalogs.get(accountId)
      const modelOption = account?.catalog.models.find(m => m.value === model)
      if (!account || !modelOption) return undefined
      return {
        model: modelOption, image: account.image === true,
        contextWindow: account.windows.get(model) ?? this.defaultContextWindowFor(model),
      }
    }
    const observed = read()
    if (observed?.model.efforts.length || (observed && this.accountCatalogs.get(accountId)?.catalog.routes.get(model)?.kind === 'legacy')) {
      return { capabilities: observed }
    }
    const enabled = this.accountProvider.getHealthSnapshots?.().filter(a => a.enabled)
    if (enabled?.length === 1 && enabled[0]?.id === accountId && (!this.catalogAccountId || this.catalogAccountId === accountId)) {
      // Cold single-account preparation may share the existing constrained menu probe.
      await this.refreshModels(undefined, signal)
    } else {
      // Strict routing must never refresh capabilities under a different account.
      const runSignal = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
      await this.probeCatalog(undefined, this.catalogGeneration, { accountId, model }, runSignal)
    }
    signal?.throwIfAborted()
    if (this.callAccountFor(model) !== accountId) throw new Error('ACP account routing changed during call preparation; retry the turn')
    return { capabilities: read() }
  }

  supportsImageInput(): boolean { return this.initResult?.agentCapabilities?.promptCapabilities?.image === true }

  defaultContextWindowFor(model: string): number | undefined {
    return model.startsWith('claude') ? 200_000 : model.startsWith('gemini') ? 1_048_576 : undefined
  }

  contextWindowFor(model: string): number | undefined {
    return this.observedWindows.get(model) ?? this.defaultContextWindowFor(model)
  }

  recordContextUsage(sess: ManagedAcpSession, model: string, used: number, size: number): void {
    if (!this.owns(sess) || !Number.isSafeInteger(used) || used < 0) return
    sess.contextUsed = used
    if (Number.isSafeInteger(size) && size > 0) {
      sess.contextSize = size
      this.observedWindows.set(model, size)
      this.accountCatalogs.get(sess.accountId)?.windows.set(model, size)
    }
    sess.lastActiveAt = Date.now()
    this.emitStatus()
  }

  recordTurnUsage(usage: AcpUsage | undefined, meta?: { accountId?: string; model?: string; countRequest?: boolean }): void {
    if (this.disposed || (!usage && !meta?.countRequest)) return
    if (usage) {
      const sample = mapUsage(usage)
      this.usageTotals = {
        inputTokens: this.usageTotals.inputTokens + sample.inputTokens,
        outputTokens: this.usageTotals.outputTokens + sample.outputTokens,
        cachedReadTokens: this.usageTotals.cachedReadTokens + (sample.cacheReadTokens ?? 0),
        cachedWriteTokens: this.usageTotals.cachedWriteTokens + (sample.cacheWriteTokens ?? 0),
        reasoningTokens: this.usageTotals.reasoningTokens + (sample.reasoningTokens ?? 0),
      }
    }
    if (meta?.accountId) {
      this.usageStore.recordTurn({ accountId: meta.accountId, accountLabel: this.accountLabel(meta.accountId),
        model: meta.model, countRequest: meta.countRequest, usage: usage && { ...usage, reasoningTokens: usage.thoughtTokens } })
    }
    this.emitStatus()
  }

  resetUsageStats(): void {
    this.usageStore.reset()
    this.usageTotals = emptyUsageTotals()
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
      this.syncQuotaSchedulingMode()
      this.emitStatus()
    })
  }

  async resetConfig(): Promise<void> {
    await this.runConfigOp(async () => {
      await this.deps.onConfigReset?.()
      this.syncQuotaSchedulingMode()
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
      ...(s.title ? { title: s.title } : {}),
      ...(s.resumed ? { resumed: true } : {}),
      ...(s.resumedVia ? { resumedVia: s.resumedVia } : {}),
      ...(s.mcpTransport ? { mcpTransport: s.mcpTransport } : {}),
      contextUsed: s.contextUsed,
      contextSize: s.contextSize,
      lastActiveAt: s.lastActiveAt,
    }))
    const accounts = this.getAccountHealthSnapshots()
    const liveLabels = new Map(accounts.map(a => [a.id, a.label]))
    const connected = Array.from(this.clients.values()).some((c) => c.isRunning)
    const mcpBridge = this.deps.getMcpBridgeSnapshot?.()
    const mcpToolCatalog = this.deps.getMcpToolCatalog?.()
    const capabilities: AcpCapabilitiesSnapshot | undefined = this.initResult
      ? {
          resumeSession: supportsSessionResume(this.initResult),
          loadSession: supportsSessionLoad(this.initResult),
          mcpHttp: supportsMcpHttp(this.initResult),
          image: this.initResult.agentCapabilities?.promptCapabilities?.image === true,
          audio: this.initResult.agentCapabilities?.promptCapabilities?.audio === true,
          embeddedContext: this.initResult.agentCapabilities?.promptCapabilities?.embeddedContext === true,
          systemPromptAppend: Boolean(this.initResult.agentCapabilities?._meta?.antigravity?.systemPrompt?.append),
        }
      : undefined
    return {
      providerId: PROVIDER_ID,
      enabled: cfg.enabled,
      connected,
      agentName: this.initResult?.agentInfo?.name ?? null,
      agentVersion: this.initResult?.agentInfo?.version ?? null,
      tierName: this.cachedTier,
      ...(capabilities ? { capabilities } : {}),
      activeSessions: sessions.length,
      ...(this.deps.sessionIndex ? { persistedSessions: this.deps.sessionIndex.size } : {}),
      sessions,
      mcpBridgeActive: this.deps.isMcpBridgeActive?.() ?? false,
      ...(mcpBridge ? { mcpBridge } : {}),
      ...(mcpToolCatalog ? { mcpToolCatalog } : {}),
      usageTotals: { ...this.usageTotals },
      accountUsage: this.usageStore.getSnapshot({ liveLabels }),
      accounts,
      preferredAccountId: this.accountProvider.getPreferredAccountId?.() ?? null,
      models: this.cachedModels.filter(m => !m.variantOf),
      ...(this.deps.listReviewProviders ? { reviewProviders: this.deps.listReviewProviders() } : {}),
      ...(this.deps.getEnvironmentSnapshot ? { environment: this.deps.getEnvironmentSnapshot() } : {}),
      ...(this.deps.getActiveLoginSnapshot ? { activeLogin: this.deps.getActiveLoginSnapshot() } : {}),
      config: {
        agyBin: cfg.agyBin,
        workspaceRoot: cfg.workspaceRoot,
        defaultModel: cfg.defaultModel,
        defaultEffort: cfg.defaultEffort,
        autoReviewProvider: cfg.autoReviewProvider,
        autoReviewModel: cfg.autoReviewModel,
        autoReviewEffort: cfg.autoReviewEffort,
        mcpBridge: cfg.mcpBridge,
        mcpExposeOverlappingTools: cfg.mcpExposeOverlappingTools,
        ...(cfg.mcpToolPolicy ? { mcpToolPolicy: cfg.mcpToolPolicy } : {}),
        ...(cfg.modelAccountRouting ? { modelAccountRouting: cfg.modelAccountRouting } : {}),
        quotaAwareScheduling: cfg.quotaAwareScheduling,
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

  policyChanged(key: string): void {
    this.deps.sessionIndex?.delete(key)
    const turn = this.active.get(key)
    if (turn) {
      try {
        const current = this.policy(key)
        if (this.policies.get(key) === policyKey(current)) return
        if (!this.sessions.get(key)?.hasMcpServers && canFinishConfinedTurn(turn.launchPolicy, current)) {
          turn.retire = true
          return
        }
      } catch { /* Unknown authority requires closing the existing sandbox. */ }
    }
    this.invalidate(key, new SessionPolicyChangedError())
  }

  recordAppliedSystemHash(session: ManagedAcpSession, hash: string): void {
    if (!this.owns(session)) return
    session.appliedSystemHash = hash
    this.deps.sessionIndex?.updateMeta(session.dshSessionKey, { appliedSystemHash: hash })
  }

  private applySessionMetadataUpdate(key: string, session: ManagedAcpSession, update: SessionUpdatePayload): boolean {
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      session.configOptions = update.configOptions
      const nextModel = findCurrentOption(update.configOptions, 'model')
      if (nextModel && nextModel !== session.currentModel) {
        session.currentModel = nextModel
        session.contextUsed = null
        session.contextSize = 0
      }
      const nextEffort = findCurrentOption(update.configOptions, 'thought_level')
      if (nextEffort !== undefined) {
        session.currentEffort = nextEffort
      }
      const nextMode = findCurrentOption(update.configOptions, 'mode')
      if (nextMode) {
        session.currentMode = nextMode
      }
      session.lastActiveAt = Date.now()
      this.captureCatalogFromSession({ configOptions: update.configOptions }, { accountId: session.accountId, session })
      return true
    }

    if (update.sessionUpdate === 'session_info_update' && typeof update.title === 'string') {
      const cleanTitle = sanitizeDiagnosticText(update.title, 120)
      const nextTitle = cleanTitle || undefined
      if (nextTitle !== session.title) {
        session.title = nextTitle
        this.deps.sessionIndex?.updateMeta(key, { title: nextTitle ?? '', touch: false })
        return true
      }
      return false
    }

    if (update.sessionUpdate === 'usage_update' && typeof update.used === 'number' && Number.isSafeInteger(update.used) && update.used >= 0) {
      session.contextUsed = update.used
      const size = typeof update.size === 'number' && Number.isSafeInteger(update.size) && update.size > 0 ? update.size : 0
      if (size > 0) {
        session.contextSize = size
        if (session.currentModel) {
          this.observedWindows.set(session.currentModel, size)
          this.accountCatalogs.get(session.accountId)?.windows.set(session.currentModel, size)
        }
      }
      session.lastActiveAt = Date.now()
      return true
    }

    return false
  }

  private bindPersistentSessionUpdates(key: string, client: AcpClient, session: ManagedAcpSession): void {
    this.sessionUnsubs.get(key)?.()
    const unsub = client.onSessionUpdate(session.acpSessionId, (update) => {
      if (this.sessions.get(key) !== session) return
      // During an active prompt, usage_update is already handled via recordContextUsage with targetModel.
      if (update.sessionUpdate === 'usage_update' && this.active.has(key)) return
      if (this.applySessionMetadataUpdate(key, session, update)) {
        this.emitStatus()
      }
    })
    this.sessionUnsubs.set(key, unsub)
  }

  activeSignal(key: string): AbortSignal | undefined {
    const signal = this.active.get(key)?.controller.signal
    if (!signal || signal.aborted || this.policies.get(key) !== policyKey(this.policy(key))) return undefined
    return signal
  }

  /** Pause the active ACP prompt inactivity timer while a delegated DSH tool call or approval runs. */
  pauseTurnTimer(key: string): () => void {
    const client = this.clients.get(key)
    const session = this.sessions.get(key)
    if (!client || !session || !this.active.has(key)) return () => {}
    return client.pauseSessionTimer(session.acpSessionId)
  }

  beginPrompt(session: ManagedAcpSession, signal?: AbortSignal) {
    const key = session.dshSessionKey
    const launchPolicy = this.policy(key)
    if (this.sessions.get(key) !== session || this.active.has(key) || this.policies.get(key) !== policyKey(launchPolicy)) {
      throw new Error('ACP session policy changed or session is busy; retry the turn')
    }
    signal?.throwIfAborted()
    const ac = new AbortController()
    const cancel = () => ac.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const { promise: done, resolve: settle } = Promise.withResolvers<void>()
    const permissions: TurnPermissions = { requests: 0, pending: new Set(), granted: new Set() }
    const turn = { controller: ac, launchPolicy, retire: false, permissions, done, settle }
    this.active.set(key, turn)
    return { cancel, permissions, finish: () => {
      signal?.removeEventListener('abort', cancel)
      cancel()
      settle()
      if (this.active.get(key) === turn) {
        this.active.delete(key)
        if (turn.retire) this.invalidate(key)
      }
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
    // The host owns the writable roots. Never implicitly grant the credential or executable directory.
    const argv = await this.deps.prepareArgv([bin, 'acp'], policy, signal)
    signal.throwIfAborted()
    if (!argv[0] || this.disposed) throw new Error('ACP launch unavailable')
    let [exe, ...args] = argv
    if (process.platform === 'linux' && this.traceSession === policy.sessionId) {
      this.traceSession = undefined
      const trace = join(mkdtempSync(join(tmpdir(), 'dsh-acp-signal-')), 'signals.log')
      // Keep the sandbox runner as the direct child. Trace one launch, including its descendants.
      args = ['-DDD', '-f', '-qq', '-tt', '-Y', '--seccomp-bpf', '-e', 'trace=kill,pidfd_send_signal',
        '-e', 'signal=SIGTERM', '-o', trace, '--', ...argv]
      exe = '/usr/bin/strace'
      this.deps.log?.(`ACP signal trace for "${policy.sessionId}": ${trace}`)
    }
    const temp = createPrivateProcessTemp(env, { argv })
    const client = new AcpClient({ bin: exe, args, env: temp.env, cwd: policy.workspaceRoot,
      onClose: () => { temp.cleanup() },
      defaultTimeoutMs: this.deps.getConfig().requestTimeoutMs, onPermission, onExit, onLog: this.deps.log })
    const stop = () => client.dispose(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    try {
      try { client.start() } catch (err) { temp.cleanup(); throw err }
      this.deps.log?.(`ACP started for "${policy.sessionId}" (pid=${client.pid}, executable=${argv[0]})`)
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
    options?: { forceNew?: boolean },
  ): Promise<{ client: AcpClient; session: ManagedAcpSession; created: boolean }> {
    if (this.disposed || this.opening.has(key)) throw new Error('ACP session unavailable or opening')
    const previous = this.active.get(key)
    if (previous?.controller.signal.aborted) await previous.done
    else if (previous) throw new Error('ACP session already has an active turn')
    const policy = this.policy(key)
    if (cwd !== policy.workspaceRoot) throw new Error('DSH workspace changed during startup')
    const fingerprint = policyKey(policy)
    if (options?.forceNew) {
      this.deps.sessionIndex?.delete(key)
    }
    const existing = this.sessions.get(key)
    const current = this.clients.get(key)
    if (
      !options?.forceNew &&
      existing &&
      current?.isRunning &&
      !exclude?.has(existing.accountId) &&
      !this.accountProvider.shouldSwitchSessionAccount?.(existing.accountId, model, exclude) &&
      this.policies.get(key) === fingerprint
    ) {
      const existingEnv = this.sessionEnvs.get(key) ?? this.accountProvider.getAccountEnv?.(existing.accountId)
      await this.assertEgressAllowed(existing.accountId, existingEnv, this.lifetime.signal)
      existing.routingModel = model || existing.currentModel
      existing.lastActiveAt = Date.now()
      this.deps.sessionIndex?.updateMeta(key, { touch: true })
      return { client: current, session: existing, created: false }
    }
    if (existing || current) this.invalidate(key)
    const opening = new AbortController()
    this.opening.set(key, opening)
    const stopOpening = () => client?.dispose(opening.signal.reason)
    opening.signal.addEventListener('abort', stopOpening, { once: true })
    let lease: AccountLease | undefined
    let client: AcpClient | undefined
    try {
      lease = await this.acquireAccountLease(key, model, exclude)
      opening.signal.throwIfAborted()
      await this.assertEgressAllowed(lease.accountId, lease.env, opening.signal)
      opening.signal.throwIfAborted()

      const makePermissionBridge = () => async (req: RequestPermissionParams): Promise<RequestPermissionResult> => {
        const turn = this.active.get(key)
        if (!turn || this.clients.get(key) !== client || req.sessionId !== this.sessions.get(key)?.acpSessionId) return cancelled()
        const { signal } = turn.controller
        const live = this.policy(key)
        if (signal.aborted || (fingerprint !== policyKey(live) && !(turn.retire && canFinishConfinedTurn(policy, live)))) return cancelled()
        const permissions = turn.permissions
        const id = req.toolCall.toolCallId
        permissions.requests++
        permissions.pending.add(id)
        try {
          const hasReverseMcpBridge = Boolean(this.sessions.get(key)?.hasMcpServers)
          const result = await this.deps.onPermission?.(req, key, signal, policy, { hasReverseMcpBridge }) ?? cancelled()
          if (signal.aborted) return cancelled()
          const { outcome } = result
          if (outcome.outcome === 'selected' && req.options.some(o =>
            o.optionId === outcome.optionId && (o.kind === 'allow_once' || o.kind === 'allow_always'))) {
            permissions.granted.add(id)
          }
          return result
        } finally {
          permissions.pending.delete(id)
        }
      }

      const makeExitHandler = () => (code: number | null, signal: NodeJS.Signals | null, exitedClient: AcpClient): void => {
        if (this.clients.get(key) !== exitedClient) return
        const activeTurn = this.active.get(key)
        const permissions = activeTurn?.permissions
        const phase = permissions?.pending.size ? 'permission-pending' : permissions?.granted.size ? 'after-grant' : activeTurn ? 'prompt' : 'idle'
        this.deps.log?.(`agy acp session "${key}" exited unexpectedly (pid=${exitedClient.pid}, phase=${phase}, code=${code}, signal=${signal})`)
        if (phase !== 'idle') {
          this.deps.sessionIndex?.delete(key)
        }
        // Snapshot before aborting the approval. Its promise may resolve during cleanup.
        if (activeTurn && !activeTurn.controller.signal.aborted && permissions?.requests === 1 && !permissions.granted.size) {
          permissions.interruptedBeforeGrant = permissions.pending.values().next().value
        }
        this.sessionUnsubs.get(key)?.()
        this.sessionUnsubs.delete(key)
        this.clients.delete(key)
        this.sessions.delete(key)
        this.sessionEnvs.delete(key)
        this.policies.delete(key)
        if (activeTurn) {
          activeTurn.controller.abort()
          activeTurn.settle()
          this.active.delete(key)
        }
        this.deps.onSessionClosed?.(key)
        this.emitStatus()
      }

      const leaseEnv = lease.env
      const launched = await this.newClient(policy, leaseEnv, opening.signal, makePermissionBridge(), makeExitHandler())
      client = launched.client
      const supportsSystemPromptAppend = Boolean(launched.initResult.agentCapabilities?._meta?.antigravity?.systemPrompt?.append)
      opening.signal.throwIfAborted()
      const mcpServers = await this.deps.getMcpServers?.(key, { preferHttp: supportsMcpHttp(launched.initResult) }) ?? []
      opening.signal.throwIfAborted()

      const persisted = !options?.forceNew ? this.deps.sessionIndex?.get(key) : undefined
      const persistedMatches = Boolean(
        persisted &&
        persisted.accountId === lease.accountId &&
        persisted.cwd === cwd &&
        persisted.policyFingerprint === fingerprint,
      )

      let sessionResult: SessionNewResult | undefined
      let resumedFromDisk = false
      let resumedVia: 'resume' | 'load' | undefined
      // Ignore replayed conversation content. Only the latest three kinds of metadata affect a restored session.
      const bufferedLoadUpdates = new Map<string, SessionUpdatePayload>()
      const rememberMetadata = (u: SessionUpdatePayload): void => {
        if (!['session_info_update', 'config_option_update', 'usage_update'].includes(u.sessionUpdate)) return
        bufferedLoadUpdates.delete(u.sessionUpdate)
        bufferedLoadUpdates.set(u.sessionUpdate, u)
      }

      if (persistedMatches && persisted) {
        // Never inject DSH's host system prompt via `_meta.antigravity.systemPrompt.append`:
        // Google Cloud Code upstream returns HTTP 429 RESOURCE_EXHAUSTED (triggering ~2.5m silent
        // agy retries) when native `systemInstruction` contains third-party harness identity.
        // Host instructions are delivered via `<host_system_instructions>` prompt blocks instead.
        const resumePayload = {
          sessionId: persisted.acpSessionId,
          cwd,
          mcpServers,
        }

        // Prefer lightweight `session/resume` (no full history replay storm); fall back to `session/load`.
        if (supportsSessionResume(launched.initResult)) {
          const unsubResume = client.onSessionUpdate(persisted.acpSessionId, rememberMetadata)
          try {
            const resumeRes: SessionResumeResult = await client.sessionResume(resumePayload)
            sessionResult = restoredSessionResult(resumeRes, persisted.acpSessionId)
            resumedFromDisk = true
            resumedVia = 'resume'
          } catch (resumeErr) {
            opening.signal.throwIfAborted()
            if (!canReplaceUnrestorableSession(resumeErr)) throw resumeErr
            bufferedLoadUpdates.clear()
            this.deps.log?.(
              `ACP session/resume unavailable for "${key}"; ${supportsSessionLoad(launched.initResult) ? 'trying session/load' : 'starting a new session'}`,
            )
          } finally {
            unsubResume()
          }
        }

        if (!sessionResult && supportsSessionLoad(launched.initResult)) {
          const unsubReplay = client.onSessionUpdate(persisted.acpSessionId, rememberMetadata)
          try {
            const loadRes: SessionLoadResult = await client.sessionLoad(resumePayload)
            sessionResult = restoredSessionResult(loadRes, persisted.acpSessionId)
            resumedFromDisk = true
            resumedVia = 'load'
          } catch (loadErr) {
            opening.signal.throwIfAborted()
            // Operational failures leave the index intact. Replace the binding only
            // after the peer definitively cannot restore it and a new session succeeds.
            if (!canReplaceUnrestorableSession(loadErr)) throw loadErr
            bufferedLoadUpdates.clear()
            this.deps.log?.(`ACP session/load unavailable for "${key}"; starting a new session`)
          } finally {
            unsubReplay()
          }
        }
      }

      if (!sessionResult) {
        sessionResult = await client.sessionNew({
          cwd,
          mcpServers,
        })
      }

      opening.signal.throwIfAborted()
      if (policyKey(this.policy(key)) !== fingerprint) throw new Error('DSH session policy changed during startup')
      const { routes: modelRoutes, models } = this.captureCatalogFromSession(sessionResult, {
        accountId: lease.accountId, image: launched.initResult.agentCapabilities?.promptCapabilities?.image === true,
      })
      const configOptions = sessionResult.configOptions ?? []
      const appliedSystemHash = resumedFromDisk ? (persisted?.appliedSystemHash ?? null) : null
      const mcpTransport: ManagedAcpSession['mcpTransport'] =
        mcpServers.length === 0
          ? 'none'
          : mcpServers.some((s) => s.type === 'http')
            ? 'http'
            : 'stdio'
      const session: ManagedAcpSession = {
        models,
        modelRoutes,
        dshSessionKey: key,
        acpSessionId: sessionResult.sessionId,
        accountId: lease.accountId,
        cwd,
        routingModel: model,
        currentModel: findCurrentOption(configOptions, 'model') ?? sessionResult.models?.currentModelId ?? '',
        currentEffort: findCurrentOption(configOptions, 'thought_level') ?? '',
        currentMode: findCurrentOption(configOptions, 'mode') ?? sessionResult.modes?.currentModeId ?? '',
        ...(resumedFromDisk && persisted?.title ? { title: persisted.title } : {}),
        ...(resumedFromDisk ? { resumed: true } : {}),
        ...(resumedVia ? { resumedVia } : {}),
        mcpTransport,
        ...(launched.initResult.agentCapabilities?.promptCapabilities
          ? { promptCapabilities: launched.initResult.agentCapabilities.promptCapabilities }
          : {}),
        configOptions,
        hasMcpServers: mcpServers.length > 0,
        supportsSystemPromptAppend,
        appliedSystemHash,
        contextUsed: null,
        contextSize: 0,
        lastActiveAt: Date.now(),
      }
      for (const replayUpdate of bufferedLoadUpdates.values()) {
        this.applySessionMetadataUpdate(key, session, replayUpdate)
      }
      this.clients.set(key, client)
      this.sessions.set(key, session)
      this.sessionEnvs.set(key, lease.env)
      this.policies.set(key, fingerprint)
      this.bindPersistentSessionUpdates(key, client, session)
      this.deps.sessionIndex?.upsert({
        dshSessionKey: key,
        acpSessionId: session.acpSessionId,
        accountId: session.accountId,
        cwd: session.cwd,
        policyFingerprint: fingerprint,
        appliedSystemHash: session.appliedSystemHash,
        ...(session.title ? { title: session.title } : {}),
      })
      this.emitStatus()
      return { client, session, created: !resumedFromDisk }
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
    const maxAccounts = this.isStrictModelRoute(requestedModel) ? 1 : this.enabledAccountCount()
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
      let helperInit: InitializeResult | undefined
      let usageModel = requestedModel
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
        helperInit = launched.initResult
        runSignal.throwIfAborted()

        const res = await client.sessionNew({
          cwd,
          mcpServers: [],
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
          if (params.verifySelection && params.effort && (route?.kind === 'legacy' ||
              (route?.kind === 'config' && route.effort && route.effort !== params.effort))) {
            throw new Error(`ACP account ${lease.accountId} did not advertise reasoning effort ${params.effort} for ${requestedModel}`)
          }
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
          if (params.verifySelection && currentModel !== targetModel) {
            throw new Error(`ACP account ${lease.accountId} did not select model ${requestedModel}`)
          }
        }

        const thoughtOpt = selectOption(configOptions, 'thought_level')
        if (params.verifySelection && params.effort && thoughtOpt?.currentValue !== params.effort &&
            !values(thoughtOpt).some(e => e.value === params.effort)) {
          throw new Error(`ACP account ${lease.accountId} did not advertise reasoning effort ${params.effort} for ${requestedModel}`)
        }
        if (thoughtOpt) {
          const availableEfforts = sortedEfforts(values(thoughtOpt).map(o => o.value))
          const targetEffort =
            params.effort && availableEfforts.includes(params.effort)
              ? params.effort
              : params.preferLowestEffort
                ? availableEfforts[0]
                : undefined
          if (targetEffort && thoughtOpt.currentValue !== targetEffort) {
            const eRes = await client.sessionSetConfigOption({
              sessionId: acpSessionId,
              configId: thoughtOpt.id,
              value: targetEffort,
            })
            if (eRes.configOptions) configOptions = eRes.configOptions
            if (params.verifySelection && eRes.configOptions && findCurrentOption(configOptions, 'thought_level') !== targetEffort) {
              throw new Error(`ACP account ${lease.accountId} did not select reasoning effort ${targetEffort} for ${requestedModel}`)
            }
          }
        }

        if (params.onUpdate) {
          unsub = client.onSessionUpdate(acpSessionId, params.onUpdate)
        }
        runSignal.addEventListener('abort', onAbort, { once: true })
        runSignal.throwIfAborted()

        const promptBlocks = [params.systemFallbackBlock, ...params.prompt]
        const timeoutMs = params.timeoutMs ?? Math.min(cfg.requestTimeoutMs, 90_000)
        usageModel = requestedModel || currentModel
        const meta = { accountId: lease.accountId, model: usageModel }
        const watcher = createTurnOutcomeWatcher(acpSessionId, lease.env)
        const result = await client.sessionPrompt({ sessionId: acpSessionId, prompt: promptBlocks }, timeoutMs)
        runSignal.throwIfAborted()
        const completed = result.stopReason !== 'cancelled' && result.stopReason !== 'aborted'
        const hidden = completed && watcher.check(result)
        if (hidden) {
          this.recordTurnUsage(result.usage, { ...meta, countRequest: false })
          throw Object.assign(new Error(`${hidden.kind === 'quota' ? 'QUOTA_EXHAUSTED' : hidden.code}: ${hidden.message}`), { resetAt: hidden.resetAt })
        }
        if (completed) this.reportAccountSuccess(lease.accountId, requestedModel)
        this.recordTurnUsage(result.usage, { ...meta, countRequest: completed })
        return result
      } catch (err) {
        if (runSignal.aborted) throw err
        if (isTosViolationError(err)) {
          this.reportAccountFailure(lease.accountId, usageModel, err)
          throw err
        }
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
          this.reportAccountFailure(lease.accountId, usageModel, err)
          if (triedAccounts.size < maxAccounts && !runSignal.aborted) {
            continue
          }
          throw err
        }
        const resetAt = err instanceof Error && 'resetAt' in err && typeof err.resetAt === 'number' ? err.resetAt : undefined
        this.reportAccountFailure(lease.accountId, usageModel, err, { resetAt })
        throw err
      } finally {
        runSignal.removeEventListener('abort', onAbort)
        unsub?.()
        if (!runSignal.aborted) await this.finishHelperSession(client, helperInit, acpSessionId)
        client?.dispose()
        lease.release()
      }
    }
    throw new Error('Auxiliary prompt exhausted all candidate accounts')
  }

  async syncSessionOptions(
    client: AcpClient,
    session: ManagedAcpSession,
    desired: { model?: string; effort?: string; configuredEffort?: string; mode?: string; verifySelection?: boolean },
  ): Promise<void> {
    const route = desired.model ? session.modelRoutes.get(desired.model) : undefined
    const model = route?.value ?? desired.model
    if (desired.verifySelection && model && model !== session.currentModel && !route &&
        !values(selectOption(session.configOptions, 'model')).some(e => e.value === model)) {
      throw new Error(`ACP account ${session.accountId} did not advertise model ${desired.model}`)
    }
    if (desired.verifySelection && desired.effort && (route?.kind === 'legacy' ||
        (route?.kind === 'config' && route.effort && route.effort !== desired.effort))) {
      throw new Error(`ACP account ${session.accountId} did not advertise reasoning effort ${desired.effort} for ${desired.model}`)
    }
    if (model && model !== session.currentModel) {
      let catalogOptions: AcpConfigOption[] | undefined
      if (route?.kind === 'legacy') {
        await client.request('session/set_model', { sessionId: session.acpSessionId, modelId: model }, 15_000)
        session.currentModel = model
        session.currentEffort = ''
      } else {
        const modelOption = selectOption(session.configOptions, 'model')
        const res = await client.sessionSetConfigOption({
          sessionId: session.acpSessionId,
          configId: modelOption?.id ?? 'model', value: model,
        })
        if (res.configOptions) session.configOptions = res.configOptions
        session.currentModel = res.configOptions ? findCurrentOption(res.configOptions, 'model') ?? model : model
        session.currentEffort = findCurrentOption(res.configOptions ?? [], 'thought_level') ?? ''
        if (session.currentModel !== model) throw new Error(`agy did not select model ${model}`)
        if (res.configOptions) {
          // Some peers advertise levels only after switching. Use the new thought selector, never the old model's.
          catalogOptions = modelOption && !selectOption(res.configOptions, 'model')
            ? [...res.configOptions, { ...modelOption, currentValue: model }]
            : res.configOptions
        }
      }
      session.contextUsed = null
      session.contextSize = 0
      if (catalogOptions) this.captureCatalogFromSession({ configOptions: catalogOptions }, { accountId: session.accountId, session })
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
        if (route?.kind === 'config' || (desired.verifySelection && effort)) {
          session.currentEffort = findCurrentOption(res.configOptions, 'thought_level') ?? ''
          if (effort && session.currentEffort !== effort) throw new Error(`agy did not retain reasoning effort ${effort} for ${desired.model}`)
        }
      } else {
        session.currentMode = desired.mode
      }
    }
  }

  invalidateCatalog(): void {
    this.accountCatalogs.clear()
    this.restartCatalogProbe()
  }

  private restartCatalogProbe(): void {
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
        const stopAutoRetry = err instanceof EgressBlockedError || isGeoUnsupportedError(err) || isTosViolationError(err)
        const delay = stopAutoRetry ? undefined : [5_000, 30_000, 60_000][this.catalogRetryCount]
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

  async refreshModels(cwd?: string, signal?: AbortSignal): Promise<AcpModelOption[]> {
    signal?.throwIfAborted()
    if (this.cachedModels.length > 0 && Date.now() < this.catalogExpiresAt) return this.cachedModels
    const probe = this.runCatalogProbe(cwd)
    // Cancel only this caller's wait: the constrained probe is shared by unrelated callers.
    const aborted = signal ? Promise.withResolvers<never>() : undefined
    const listener = signal && aborted ? addAbortListener(signal, () => aborted.reject(signal.reason)) : undefined
    try {
      return await (aborted ? Promise.race([probe, aborted.promise]) : probe)
    } catch (err) {
      signal?.throwIfAborted()
      if (!this.disposed && this.cachedModels.length > 0) {
        return this.cachedModels
      }
      throw err
    } finally {
      listener?.[Symbol.dispose]()
    }
  }

  async forceRefreshModels(cwd?: string): Promise<AcpModelOption[]> {
    if (this.disposed) throw new Error('ACP session pool disposed')
    this.restartCatalogProbe()
    return await this.runCatalogProbe(cwd)
  }

  // Only the child which just created this disposable session may retire it. If the peer
  // has no native delete operation, close it and leave shared profile files untouched.
  private async finishHelperSession(client?: AcpClient, init?: InitializeResult, id?: string): Promise<void> {
    if (!id || !client?.isRunning || [...this.sessions.values()].some(s => s.acpSessionId === id) ||
        this.deps.sessionIndex?.hasNativeSession(id)) return
    const capability = init?.agentCapabilities?.sessionCapabilities?.delete
    const method = capability === true || (capability && typeof capability === 'object' && !Array.isArray(capability))
      ? 'session/delete' : 'session/close'
    await client.request(method, { sessionId: id }, 1_000).catch(() => {})
  }

  private async probeCatalog(
    cwd?: string,
    expectedGen?: number,
    target?: { accountId: string; model: string },
    signal = this.lifetime.signal,
  ): Promise<AcpModelOption[]> {
    const cfg = this.deps.getConfig()
    const maxAccounts = target ? 1 : this.enabledAccountCount()
    const triedAccounts = new Set<string>()
    for (let attempt = 0; attempt < maxAccounts; attempt++) {
      const lease = await this.acquireAccountLease(
        '__catalog__',
        target?.model ?? '',
        triedAccounts.size > 0 ? triedAccounts : undefined,
      )
      let client: AcpClient | undefined
      const root = cwd || cfg.workspaceRoot || process.cwd()
      let probeId: string | undefined
      let probeInit: InitializeResult | undefined
      try {
        signal.throwIfAborted()
        if (target && lease.accountId !== target.accountId) throw new Error('ACP catalog account changed during preparation; retry the turn')
        await this.assertEgressAllowed(lease.accountId, lease.env, signal)
        // No initiating agent: never prompt, attach MCP, or start an unrestricted helper.
        const launched = await this.newClient({ sessionId: '__catalog__', workspaceRoot: root, mode: 'read-only' }, lease.env, signal)
        client = launched.client
        probeInit = launched.initResult
        signal.throwIfAborted()
        const activeClient = client
        const stop = () => activeClient.dispose(signal.reason)
        signal.addEventListener('abort', stop, { once: true })
        try {
          const res = await client.sessionNew({ cwd: root, mcpServers: [] })
          probeId = res.sessionId
          signal.throwIfAborted()
          this.accountProvider.markAuthVerified?.(lease.accountId)
          if (expectedGen !== undefined && expectedGen !== this.catalogGeneration) {
            return this.cachedModels
          }
          this.captureCatalogFromSession(res, {
            accountId: lease.accountId, fromProbe: target ? 'target' : 'menu',
            image: launched.initResult.agentCapabilities?.promptCapabilities?.image === true,
          })
        } finally {
          signal.removeEventListener('abort', stop)
        }
        return this.cachedModels
      } catch (err) {
        signal.throwIfAborted()
        if (isTosViolationError(err)) {
          this.reportAccountFailure(lease.accountId, '', err)
          throw err
        }
        if (isAuthFailureError(err)) {
          this.reportAccountFailure(lease.accountId, '', err)
        }
        if (err instanceof EgressBlockedError) {
          triedAccounts.add(lease.accountId)
          if (triedAccounts.size < maxAccounts && !signal.aborted) {
            continue
          }
        } else if (isGeoUnsupportedError(err)) {
          // Keep the account's breaker armed without replacing the menu's error.
          this.recordGeoRejection(lease.accountId, lease.env, !target)
          triedAccounts.add(lease.accountId)
          if (triedAccounts.size < maxAccounts && !signal.aborted) {
            continue
          }
        }
        throw err
      } finally {
        if (!signal.aborted) await this.finishHelperSession(client, probeInit, probeId)
        client?.dispose()
        lease.release()
      }
    }
    return this.cachedModels
  }

  invalidate(key: string, reason?: Error): void {
    if (reason instanceof SessionPolicyChangedError) {
      this.deps.sessionIndex?.delete(key)
    }
    if (!this.opening.has(key) && !this.sessions.has(key) && !this.clients.has(key)) return
    this.opening.get(key)?.abort(reason)
    this.active.get(key)?.controller.abort()
    this.active.get(key)?.settle()
    this.active.delete(key)
    this.sessionUnsubs.get(key)?.()
    this.sessionUnsubs.delete(key)
    this.sessions.delete(key)
    this.sessionEnvs.delete(key)
    this.policies.delete(key)
    const client = this.clients.get(key)
    this.clients.delete(key)
    client?.dispose(reason)
    this.deps.onSessionClosed?.(key)
    this.emitStatus()
  }

  isStrictModelRoute(model: string): boolean {
    return this.accountProvider.isStrictModelRoute?.(model) ?? false
  }

  enabledAccountCount(): number {
    const snapshots = this.accountProvider.getHealthSnapshots?.()
    if (snapshots && snapshots.length > 0) {
      return Math.max(1, snapshots.filter((a) => a.enabled).length)
    }
    return Math.max(1, this.deps.getConfig().accounts.filter((a) => a.enabled !== false).length || 1)
  }

  /** Switch future turns without interrupting an in-flight prompt. Cold bindings are
   * resumed only after the scheduler acquires a lease for the same account. */
  switchActiveAccount(accountId: string | null): void {
    this.accountProvider.setPreferredAccount?.(accountId)
    if (accountId !== null) {
      const routing = this.accountProvider.getModelRouting?.()
      for (const [key, session] of this.sessions) {
        if (session.accountId === accountId || resolveModelAccountRoute(routing, session.routingModel || session.currentModel)) continue
        this.deps.sessionIndex?.delete(key)
        const turn = this.active.get(key)
        if (turn) turn.retire = true
        else this.invalidate(key)
      }
    }
    this.emitStatus()
  }

  /** Retire live sessions pinned to an account without interrupting active turns (e.g. after re-login). */
  retireSessionsForAccount(accountId: string): void {
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.accountId !== accountId) continue
      this.deps.sessionIndex?.delete(key)
      const turn = this.active.get(key)
      if (turn) turn.retire = true
      else this.invalidate(key)
    }
  }

  /** Evict live sessions currently pinned to an account (e.g. after removal, disable, or proxy change). */
  evictSessionsForAccount(accountId: string, reason?: Error): number {
    this.accountCatalogs.delete(accountId)
    this.restartCatalogProbe()
    let closed = 0
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.accountId === accountId) {
        this.invalidate(key, reason)
        closed++
      }
    }
    return closed
  }

  evictSession(key: string, reason?: Error): void {
    this.deps.sessionIndex?.delete(key)
    this.invalidate(key, reason)
  }

  async closeSession(key: string): Promise<void> {
    this.deps.sessionIndex?.delete(key)
    this.invalidate(key)
  }

  async resetAllSessions(): Promise<number> {
    this.deps.sessionIndex?.clear()
    const keys = new Set([...this.sessions.keys(), ...this.opening.keys(), ...this.clients.keys()])
    for (const key of keys) this.invalidate(key)
    this.emitStatus()
    return keys.size
  }

  async sweepIdleSessions(): Promise<void> {
    const ttl = this.deps.getConfig().sessionIdleTtlMs
    const now = Date.now()
    for (const [key, sess] of this.sessions) {
      // Preserve SessionIndex entry across idle sweeps so next turn restores via `session/load`.
      if (!this.active.has(key) && now - sess.lastActiveAt > ttl) {
        this.invalidate(key)
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
    const keys = new Set([...this.sessions.keys(), ...this.opening.keys(), ...this.clients.keys()])
    if (keys.size) {
      const busy = [...keys].filter(key => this.active.has(key) || this.opening.has(key)).length
      this.deps.log?.(`plugin unloading/reloading: terminating ${keys.size} ACP session(s) (${busy} with an in-flight turn)`)
    }
    const reason = new Error('dsh-agy-acp 插件已重载或卸载（例如 dist/ 被重新构建），当前 ACP 会话被终止，请重新发起请求。')
    for (const key of keys) this.invalidate(key, reason)
    this.accountProvider.dispose?.()
    this.removeAllListeners()
    this.usageStore.dispose()
  }

  private captureCatalogFromSession(
    res: Pick<SessionNewResult, 'configOptions' | 'models' | '_meta'>,
    { accountId, session, fromProbe, image }: {
      accountId: string; session?: ManagedAcpSession; fromProbe?: 'menu' | 'target'; image?: boolean
    },
  ): ModelCatalog {
    const snapshot = modelCatalog(res)
    if (fromProbe && !snapshot.models.length) throw new Error('agy returned an empty ACP model catalog')
    if (this.disposed) return snapshot
    const account: AccountModelCatalog = this.accountCatalogs.get(accountId) ?? { catalog: { models: [], routes: new Map() }, windows: new Map() }
    if (image !== undefined) account.image = image
    this.accountCatalogs.set(accountId, account)
    const menuProbe = fromProbe === 'menu'
    const sameMenuAccount = this.catalogAccountId === accountId
    const publishMenu = menuProbe || (fromProbe !== 'target' && (sameMenuAccount || this.catalogAccountId === undefined))
    const tier = res._meta?.antigravity?.tier?.name
    if (publishMenu && tier) this.cachedTier = tier
    if (!snapshot.models.length) return account.catalog
    if (session) {
      const local = mergeModelCatalog({ models: session.models, routes: session.modelRoutes }, snapshot)
      session.models = local.models
      session.modelRoutes = local.routes
    }
    const catalog = mergeModelCatalog(account.catalog, snapshot)
    account.catalog = catalog
    if (!publishMenu) return catalog
    // Merge only with the same account's published menu, never its call catalog:
    // a targeted probe may have replaced that catalog with a narrower snapshot.
    const menuCatalog = sameMenuAccount ? mergeModelCatalog(this.cachedCatalog, snapshot) : snapshot
    const signature = JSON.stringify(menuCatalog.models)
    const recovered = this.lastError !== null && (snapshot.complete || menuProbe)
    const changed = signature !== this.catalogSignature || recovered
    this.catalogSignature = signature
    this.cachedCatalog = menuCatalog
    this.catalogAccountId = accountId
    // Session metadata can improve capabilities, but only a complete snapshot is fresh for five minutes.
    if (snapshot.complete) this.catalogExpiresAt = Date.now() + 5 * 60_000
    if (snapshot.complete || menuProbe) {
      this.lastError = null
      clearTimeout(this.catalogRetry)
      this.catalogRetry = undefined
      this.catalogRetryCount = 0
    }
    if (changed) {
      this.emit('models-updated')
      this.emitStatus()
    }
    return catalog
  }

  private emitStatus(): void {
    if (this.listenerCount('status') === 0) return
    this.emit('status', this.getStatus())
  }
}

function canReplaceUnrestorableSession(err: unknown): boolean {
  if (!(err instanceof AcpRpcError) || isTosViolationError(err) || isGeoUnsupportedError(err)) return false
  // JSON-RPC method not found, or the peer explicitly says the native session is absent.
  // In particular, process exits, timeouts, internal errors and EROFS are not evidence of loss.
  return err.code === -32601 ||
    (err.code === -32002 && /^ACP RPC error \(-32002\): (?:session not found|unknown session)(?:\s*[:.]|$)/i.test(err.message))
}

function restoredSessionResult(result: SessionLoadResult | SessionResumeResult, sessionId: string): SessionNewResult {
  if (result.sessionId !== undefined && result.sessionId !== sessionId) {
    throw new Error('ACP recovery returned a different session ID; the original binding was preserved')
  }
  return { ...result, sessionId }
}

function findCurrentOption(options: AcpConfigOption[], id: string): string | undefined {
  return selectOption(options, id)?.currentValue
}

export function formatCatalogProbeError(err: unknown): string {
  if (isTosViolationError(err)) {
    return '[风控熔断] 账号触发上游服务条款/账号风控限制（TOS_VIOLATION），已本地隔离并暂停自动重试与切号；请核查账号状态后再手动解除隔离。'
  }
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
