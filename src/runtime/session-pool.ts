import { cancelled, policyKey, type SessionPolicy, type FilePolicy } from './permission-manager.ts'
import { EventEmitter } from 'node:events'
import { AcpClient } from '../acp/client.ts'
import type {
  AcpConfigOption,
  AcpMcpServerSpec,
  AcpUsage,
  InitializeResult,
  SessionNewResult,
  RequestPermissionParams, RequestPermissionResult,
} from '../acp/protocol.ts'
import {
  PROVIDER_ID,
  type AccountHealthSnapshot,
  type AccountLease,
  type AccountProvider,
  type AcpModelOption,
  type PluginConfig,
  type SessionSummary,
  type StatusSnapshot,
  type UsageTotals,
} from '../common/types.ts'

import { modelCatalog, selectOption, values } from './model-catalog.ts'

export interface ManagedAcpSession {
  modelRoutes: ReturnType<typeof modelCatalog>['routes']
  dshSessionKey: string
  acpSessionId: string
  accountId: string
  cwd: string
  currentModel: string
  currentEffort: string
  currentMode: string
  configOptions: AcpConfigOption[]
  contextUsed: number
  contextSize: number
  lastActiveAt: number
}

/** Default single-account provider (current machine login). */
export class SingleAccountProvider implements AccountProvider {
  async acquire(): Promise<AccountLease> {
    return { accountId: 'default', release: () => {} }
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
  onSessionClosed?: (key: string) => void
  accountProvider?: AccountProvider
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
  private catalogProbe?: Promise<AcpModelOption[]>
  private initResult: InitializeResult | null = null
  private readonly sessions = new Map<string, ManagedAcpSession>()
  private readonly accountProvider: AccountProvider
  private cachedModels: AcpModelOption[] = []
  private catalogExpiresAt = 0
  private cachedTier: string | null = null
  private lastError: string | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private usageTotals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
  }

  constructor(private readonly deps: SessionPoolDeps) {
    super()
    this.accountProvider = deps.accountProvider ?? new SingleAccountProvider()
    this.sweepTimer = setInterval(() => {
      void this.sweepIdleSessions()
    }, 60_000)
    this.sweepTimer.unref?.()
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
    return this.accountProvider.getHealthSnapshots?.() ?? []
  }

  recordContextUsage(dshSessionKey: string, used: number, size: number): void {
    const sess = this.sessions.get(dshSessionKey)
    if (!sess) return
    sess.contextUsed = used
    if (size > 0) sess.contextSize = size
    sess.lastActiveAt = Date.now()
    this.emitStatus()
  }

  recordTurnUsage(usage: AcpUsage | undefined): void {
    if (!usage) return
    const cached = usage.cachedReadTokens ?? 0
    const input = Math.max(0, (usage.inputTokens ?? 0) - cached)
    this.usageTotals = {
      inputTokens: this.usageTotals.inputTokens + input,
      outputTokens: this.usageTotals.outputTokens + (usage.outputTokens ?? 0),
      cachedReadTokens: this.usageTotals.cachedReadTokens + cached,
      reasoningTokens: this.usageTotals.reasoningTokens + (usage.thoughtTokens ?? 0),
    }
    this.emitStatus()
  }

  async updateConfig(patch: Partial<PluginConfig>): Promise<void> {
    await this.deps.onConfigPatch?.(patch)
    this.emitStatus()
  }

  getStatus(): StatusSnapshot {
    const cfg = this.deps.getConfig()
    const sessions: SessionSummary[] = Array.from(this.sessions.values(), (s) => ({
      dshSessionKey: s.dshSessionKey,
      acpSessionId: s.acpSessionId,
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
      models: this.cachedModels,
      config: {
        agyBin: cfg.agyBin,
        workspaceRoot: cfg.workspaceRoot,
        defaultModel: cfg.defaultModel,
        defaultEffort: cfg.defaultEffort,
        mcpBridge: cfg.mcpBridge,
        sessionIdleTtlMs: cfg.sessionIdleTtlMs,
        requestTimeoutMs: cfg.requestTimeoutMs,
      },
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

  private async newClient(policy: FilePolicy, env: NodeJS.ProcessEnv | undefined, signal: AbortSignal, onPermission?: (r: RequestPermissionParams) => Promise<RequestPermissionResult>): Promise<AcpClient> {
    const bin = this.deps.resolveBin()
    if (!bin) throw new Error('agy binary not found — install Antigravity CLI first')
    const [exe, ...args] = await this.deps.prepareArgv([bin, 'acp'], policy, signal)
    signal.throwIfAborted()
    if (!exe || this.disposed) throw new Error('ACP launch unavailable')
    const client = new AcpClient({ bin: exe, args, env, cwd: policy.workspaceRoot,
      defaultTimeoutMs: this.deps.getConfig().requestTimeoutMs, onPermission, onLog: this.deps.log })
    const stop = () => client.dispose()
    signal.addEventListener('abort', stop, { once: true })
    try {
      client.start()
      this.initResult = await client.initialize()
      return client
    } catch (err) { client.dispose(); throw err }
    finally { signal.removeEventListener('abort', stop) }
  }

  async getOrCreateSession(key: string, cwd: string, model = '', exclude?: ReadonlySet<string>): Promise<{ client: AcpClient; session: ManagedAcpSession; created: boolean }> {
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
      existing.lastActiveAt = Date.now()
      return { client: current, session: existing, created: false }
    }
    if (existing) this.invalidate(key)
    const opening = new AbortController()
    this.opening.set(key, opening)
    const stopOpening = () => client?.dispose()
    opening.signal.addEventListener('abort', stopOpening, { once: true })
    let lease: AccountLease | undefined
    let client: AcpClient | undefined
    try {
      lease = await this.accountProvider.acquire(key, model, exclude)
      opening.signal.throwIfAborted()
      client = await this.newClient(policy, lease.env, opening.signal, async req => {
        const signal = this.activeSignal(key)
        if (!signal || this.clients.get(key) !== client || req.sessionId !== this.sessions.get(key)?.acpSessionId) return cancelled()
        return await this.deps.onPermission?.(req, key, signal) ?? cancelled()
      })
      opening.signal.throwIfAborted()
      const mcpServers = await this.deps.getMcpServers?.(key) ?? []
      opening.signal.throwIfAborted()
      const res = await client.sessionNew({ cwd, mcpServers })
      opening.signal.throwIfAborted()
      if (policyKey(this.policy(key)) !== fingerprint) throw new Error('DSH session policy changed during startup')
      const modelRoutes = this.captureCatalogFromSession(res)
      const configOptions = res.configOptions ?? []
      const session: ManagedAcpSession = {
        modelRoutes,
        dshSessionKey: key, acpSessionId: res.sessionId, accountId: lease.accountId, cwd,
        currentModel: findCurrentOption(configOptions, 'model') ?? res.models?.currentModelId ?? '',
        currentEffort: findCurrentOption(configOptions, 'thought_level') ?? '',
        currentMode: findCurrentOption(configOptions, 'mode') ?? res.modes?.currentModeId ?? '',
        configOptions, contextUsed: 0, contextSize: 0, lastActiveAt: Date.now(),
      }
      this.clients.set(key, client)
      this.sessions.set(key, session)
      this.policies.set(key, fingerprint)
      this.emitStatus()
      return { client, session, created: true }
    } catch (err) {
      client?.dispose()
      this.deps.onSessionClosed?.(key)
      throw err
    } finally { opening.signal.removeEventListener('abort', stopOpening); this.opening.delete(key); lease?.release() }
  }

  async syncSessionOptions(
    client: AcpClient,
    session: ManagedAcpSession,
    desired: { model?: string; effort?: string; mode?: string },
  ): Promise<void> {
    const route = desired.model ? session.modelRoutes.get(desired.model) : undefined
    const model = route?.value ?? desired.model
    if (model && model !== session.currentModel) {
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
      }
    }
    const fixedEffort = route?.kind === 'config' ? route.effort : undefined
    const effort = route?.kind === 'legacy' ? undefined : fixedEffort ?? desired.effort
    if (effort && effort !== session.currentEffort) {
      const option = selectOption(session.configOptions, 'thought_level')
      if (option && values(option).some(o => o.value === effort)) {
        const res = await client.sessionSetConfigOption({ sessionId: session.acpSessionId, configId: option.id, value: effort })
        if (res.configOptions) session.configOptions = res.configOptions
        session.currentEffort = findCurrentOption(res.configOptions ?? [], 'thought_level') ?? effort
      }
      if (fixedEffort && session.currentEffort !== fixedEffort) throw new Error(`agy did not select ${desired.model}`)
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
      } else {
        session.currentMode = desired.mode
      }
    }
  }

  async refreshModels(cwd?: string): Promise<AcpModelOption[]> {
    if (this.cachedModels.length > 0 && Date.now() < this.catalogExpiresAt) return this.cachedModels
    if (!this.catalogProbe) this.catalogProbe = this.probeCatalog(cwd).finally(() => { this.catalogProbe = undefined })
    return this.catalogProbe
  }

  private async probeCatalog(cwd?: string): Promise<AcpModelOption[]> {
    const lease = await this.accountProvider.acquire('__catalog__', '')
    let client: AcpClient | undefined
    try {
      const root = cwd || this.deps.getConfig().workspaceRoot || process.cwd()
      // No initiating agent: never prompt, attach MCP, or start an unrestricted helper.
      client = await this.newClient({ sessionId: '__catalog__', workspaceRoot: root, mode: 'read-only' }, lease.env, this.lifetime.signal)
      this.lifetime.signal.throwIfAborted()
      const stop = () => client?.dispose()
      this.lifetime.signal.addEventListener('abort', stop, { once: true })
      try { this.captureCatalogFromSession(await client.sessionNew({ cwd: root, mcpServers: [] })) }
      finally { this.lifetime.signal.removeEventListener('abort', stop) }
      return this.cachedModels
    } finally { client?.dispose(); lease.release() }
  }

  invalidate(key: string): void {
    if (!this.opening.has(key) && !this.sessions.has(key)) return
    this.opening.get(key)?.abort()
    this.active.get(key)?.controller.abort()
    this.active.get(key)?.settle()
    this.active.delete(key)
    this.sessions.delete(key)
    this.policies.delete(key)
    this.clients.get(key)?.dispose()
    this.clients.delete(key)
    this.deps.onSessionClosed?.(key)
    this.emitStatus()
  }

  async closeSession(key: string): Promise<void> { this.invalidate(key) }

  async resetAllSessions(): Promise<number> {
    const keys = new Set([...this.sessions.keys(), ...this.opening.keys()])
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
    this.lifetime.abort()
    void this.resetAllSessions()
    this.accountProvider.dispose?.()
    this.removeAllListeners()
  }

  private captureCatalogFromSession(res: SessionNewResult) {
    const tier = res._meta?.antigravity?.tier?.name
    if (tier) this.cachedTier = tier
    const { models, routes } = modelCatalog(res)
    this.cachedModels = models
    this.catalogExpiresAt = Date.now() + 5 * 60_000
    return routes
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}

function findCurrentOption(options: AcpConfigOption[], id: string): string | undefined {
  return selectOption(options, id)?.currentValue
}
