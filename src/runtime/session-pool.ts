import { EventEmitter } from 'node:events'
import { AcpClient, type PermissionHandler } from '../acp/client.ts'
import type {
  AcpConfigOption,
  AcpMcpServerSpec,
  AcpUsage,
  InitializeResult,
  SessionNewResult,
} from '../acp/protocol.ts'
import {
  PROVIDER_ID,
  type AccountHealthSnapshot,
  type AccountLease,
  type AccountProvider,
  type AcpModelOption,
  type PendingPermission,
  type PermissionMode,
  type PluginConfig,
  type SessionSummary,
  type StatusSnapshot,
  type UsageTotals,
} from '../common/types.ts'

export interface ManagedAcpSession {
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
  onPermission?: PermissionHandler
  getPendingPermissions?: () => PendingPermission[]
  isMcpBridgeActive?: () => boolean
  onPermissionModeChange?: (mode: PermissionMode) => void
  onConfigPatch?: (patch: Partial<PluginConfig>) => void | Promise<void>
  onSessionClosed?: (acpSessionId: string) => void
  accountProvider?: AccountProvider
  getMcpServers?: (sessionKey: string) => AcpMcpServerSpec[]
  log?: (msg: string) => void
}

/**
 * Manages persistent `agy acp` processes (one per active account) and maps DSH session keys
 * to long-lived ACP sessions, eliminating per-turn CLI cold starts while supporting
 * multi-account isolation and failover.
 */
export class AcpSessionPool extends EventEmitter {
  private readonly clients = new Map<string, AcpClient>()
  private readonly initPromises = new Map<string, Promise<AcpClient>>()
  private initResult: InitializeResult | null = null
  private readonly sessions = new Map<string, ManagedAcpSession>()
  private readonly accountProvider: AccountProvider
  private cachedModels: AcpModelOption[] = []
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

  getClient(accountId = 'default'): AcpClient | null {
    return this.clients.get(accountId) ?? this.clients.values().next().value ?? null
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

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.deps.onPermissionModeChange?.(mode)
    if (mode !== 'skip') {
      for (const sess of this.sessions.values()) {
        const client = this.clients.get(sess.accountId)
        if (client?.isRunning) {
          await this.syncSessionOptions(client, sess, { mode }).catch(() => undefined)
        }
      }
    }
    this.emitStatus()
  }

  async updateConfig(patch: Partial<PluginConfig>): Promise<void> {
    await this.deps.onConfigPatch?.(patch)
    if (patch.permissionMode && patch.permissionMode !== 'skip') {
      for (const sess of this.sessions.values()) {
        const client = this.clients.get(sess.accountId)
        if (client?.isRunning) {
          await this.syncSessionOptions(client, sess, { mode: patch.permissionMode }).catch(() => undefined)
        }
      }
    }
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
      pendingPermissions: this.deps.getPendingPermissions?.() ?? [],
      mcpBridgeActive: this.deps.isMcpBridgeActive?.() ?? false,
      usageTotals: { ...this.usageTotals },
      accounts: this.getAccountHealthSnapshots(),
      models: this.cachedModels,
      permissionMode: cfg.permissionMode,
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

  async ensureClient(accountId = 'default', env?: NodeJS.ProcessEnv): Promise<AcpClient> {
    const existing = this.clients.get(accountId)
    if (existing?.isRunning) return existing
    const pending = this.initPromises.get(accountId)
    if (pending) return pending

    const promise = this.startClient(accountId, env).finally(() => {
      this.initPromises.delete(accountId)
    })
    this.initPromises.set(accountId, promise)
    return promise
  }

  private async startClient(accountId: string, env?: NodeJS.ProcessEnv): Promise<AcpClient> {
    const cfg = this.deps.getConfig()
    const bin = this.deps.resolveBin()
    if (!bin) {
      this.lastError = 'agy binary not found'
      this.emitStatus()
      throw new Error('agy binary not found — install Antigravity CLI first')
    }

    const args: string[] = []
    if (cfg.permissionMode === 'skip') {
      args.push('--dangerously-skip-permissions')
    }

    const client = new AcpClient({
      bin,
      args,
      cwd: cfg.workspaceRoot || process.cwd(),
      env,
      defaultTimeoutMs: cfg.requestTimeoutMs,
      onPermission: this.deps.onPermission,
      onLog: this.deps.log,
      onExit: (code, signal) => {
        this.deps.log?.(`agy acp [${accountId}] exited (code=${String(code)}, signal=${String(signal)})`)
        for (const [key, sess] of this.sessions) {
          if (sess.accountId === accountId) {
            this.sessions.delete(key)
            this.deps.onSessionClosed?.(sess.acpSessionId)
          }
        }
        if (this.clients.get(accountId) === client) {
          this.clients.delete(accountId)
        }
        this.emitStatus()
      },
    })

    client.start()
    const initRes = await client.initialize()
    this.clients.set(accountId, client)
    this.initResult = initRes
    this.lastError = null
    this.deps.log?.(
      `connected [${accountId}] to ${initRes.agentInfo?.name ?? 'agy acp'} ${initRes.agentInfo?.version ?? ''}`.trim(),
    )
    this.emitStatus()
    return client
  }

  async getOrCreateSession(
    dshSessionKey: string,
    cwd: string,
    model = '',
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ client: AcpClient; session: ManagedAcpSession; created: boolean }> {
    const existing = this.sessions.get(dshSessionKey)
    if (existing && !excludeAccountIds?.has(existing.accountId)) {
      const client = this.clients.get(existing.accountId)
      if (client?.isRunning) {
        existing.lastActiveAt = Date.now()
        return { client, session: existing, created: false }
      }
      this.sessions.delete(dshSessionKey)
    } else if (existing && excludeAccountIds?.has(existing.accountId)) {
      await this.closeSession(dshSessionKey)
    }

    // Acquire account lease (and optional cross-process credential slot) only across
    // process startup + session/new authentication, then release immediately.
    const lease = await this.accountProvider.acquire(dshSessionKey, model, excludeAccountIds)
    try {
      const client = await this.ensureClient(lease.accountId, lease.env)
      const mcpServers = this.deps.getMcpServers?.(dshSessionKey) ?? []
      const res = await client.sessionNew({ cwd, mcpServers })
      this.captureCatalogFromSession(res)

      const configOptions = res.configOptions ?? []
      const session: ManagedAcpSession = {
        dshSessionKey,
        acpSessionId: res.sessionId,
        accountId: lease.accountId,
        cwd,
        currentModel: findCurrentOption(configOptions, 'model') ?? res.models?.currentModelId ?? '',
        currentEffort: findCurrentOption(configOptions, 'thought_level') ?? '',
        currentMode: findCurrentOption(configOptions, 'mode') ?? res.modes?.currentModeId ?? 'default',
        configOptions,
        contextUsed: 0,
        contextSize: 0,
        lastActiveAt: Date.now(),
      }
      this.sessions.set(dshSessionKey, session)
      this.emitStatus()
      return { client, session, created: true }
    } finally {
      lease.release()
    }
  }

  async syncSessionOptions(
    client: AcpClient,
    session: ManagedAcpSession,
    desired: { model?: string; effort?: string; mode?: string },
  ): Promise<void> {
    if (desired.model && desired.model !== session.currentModel) {
      const res = await client.sessionSetConfigOption({
        sessionId: session.acpSessionId,
        configId: 'model',
        value: desired.model,
      })
      if (res.configOptions) {
        session.configOptions = res.configOptions
        session.currentModel = findCurrentOption(res.configOptions, 'model') ?? desired.model
        session.currentEffort = findCurrentOption(res.configOptions, 'thought_level') ?? session.currentEffort
      } else {
        session.currentModel = desired.model
      }
    }

    if (desired.effort && desired.effort !== session.currentEffort) {
      const thoughtOpt = session.configOptions.find((o) => o.id === 'thought_level')
      const allowed = thoughtOpt?.options?.map((o) => o.value) ?? []
      if (allowed.length === 0 || allowed.includes(desired.effort)) {
        const res = await client.sessionSetConfigOption({
          sessionId: session.acpSessionId,
          configId: 'thought_level',
          value: desired.effort,
        })
        if (res.configOptions) {
          session.configOptions = res.configOptions
          session.currentEffort = findCurrentOption(res.configOptions, 'thought_level') ?? desired.effort
        } else {
          session.currentEffort = desired.effort
        }
      }
    }

    if (desired.mode && desired.mode !== 'skip' && desired.mode !== session.currentMode) {
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
    if (this.cachedModels.length > 0) return this.cachedModels
    const lease = await this.accountProvider.acquire('__catalog__', '')
    try {
      const client = await this.ensureClient(lease.accountId, lease.env)
      const res = await client.sessionNew({
        cwd: cwd || this.deps.getConfig().workspaceRoot || process.cwd(),
        mcpServers: [],
      })
      this.captureCatalogFromSession(res)
      await client.sessionClose(res.sessionId).catch(() => undefined)
      this.emitStatus()
      return this.cachedModels
    } finally {
      lease.release()
    }
  }

  async closeSession(dshSessionKey: string): Promise<void> {
    const sess = this.sessions.get(dshSessionKey)
    if (!sess) return
    this.sessions.delete(dshSessionKey)
    this.deps.onSessionClosed?.(sess.acpSessionId)
    const client = this.clients.get(sess.accountId)
    if (client?.isRunning) {
      await client.sessionClose(sess.acpSessionId).catch(() => undefined)
    }
    this.emitStatus()
  }

  async resetAllSessions(): Promise<number> {
    const keys = Array.from(this.sessions.keys())
    for (const key of keys) {
      await this.closeSession(key)
    }
    return keys.length
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
    this.sessions.clear()
    for (const client of this.clients.values()) {
      client.dispose()
    }
    this.clients.clear()
    this.initPromises.clear()
    this.accountProvider.dispose?.()
    this.removeAllListeners()
  }

  private captureCatalogFromSession(res: SessionNewResult): void {
    const tier = res._meta?.antigravity?.tier?.name
    if (tier) this.cachedTier = tier

    const modelOpt = res.configOptions?.find((o) => o.id === 'model')
    const defaultEfforts =
      res.configOptions?.find((o) => o.id === 'thought_level')?.options?.map((o) => o.value) ?? []

    // Derive per-model efforts from availableModels slugs (e.g. gemini-3.8-flash-low/medium/high)
    const availableSlugs = res.models?.availableModels.map((m) => m.modelId) ?? []
    if (modelOpt?.options && modelOpt.options.length > 0) {
      this.cachedModels = modelOpt.options.map((opt) => {
        const prefix = opt.value + '-'
        const matchedEfforts = availableSlugs
          .filter((slug) => slug.startsWith(prefix))
          .map((slug) => slug.slice(prefix.length))
          .filter((e) => ['low', 'medium', 'high', 'xhigh'].includes(e))
        return {
          value: opt.value,
          name: opt.name,
          efforts: matchedEfforts.length > 0 ? matchedEfforts : defaultEfforts,
        }
      })
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}

function findCurrentOption(options: AcpConfigOption[], id: string): string | undefined {
  return options.find((o) => o.id === id)?.currentValue
}
