import { EventEmitter } from 'node:events'
import { AcpClient, type PermissionHandler } from '../acp/client.ts'
import type {
  AcpConfigOption,
  AcpMcpServerSpec,
  InitializeResult,
  SessionNewResult,
} from '../acp/protocol.ts'
import {
  PROVIDER_ID,
  type AccountLease,
  type AccountProvider,
  type AcpModelOption,
  type PluginConfig,
  type StatusSnapshot,
} from '../common/types.ts'

export interface ManagedAcpSession {
  dshSessionKey: string
  acpSessionId: string
  cwd: string
  currentModel: string
  currentEffort: string
  currentMode: string
  configOptions: AcpConfigOption[]
  lastActiveAt: number
}

/** Phase 1 default: single local account authenticated via `agy`. */
export class SingleAccountProvider implements AccountProvider {
  async acquire(): Promise<AccountLease> {
    return { accountId: 'default', release: () => {} }
  }
}

export interface SessionPoolDeps {
  getConfig: () => PluginConfig
  resolveBin: () => string | null
  onPermission?: PermissionHandler
  accountProvider?: AccountProvider
  getMcpServers?: (sessionKey: string) => AcpMcpServerSpec[]
  log?: (msg: string) => void
}

/**
 * Manages a persistent `agy acp` process and maps DSH session keys to
 * long-lived ACP sessions, eliminating per-turn CLI cold starts.
 */
export class AcpSessionPool extends EventEmitter {
  private client: AcpClient | null = null
  private initPromise: Promise<AcpClient> | null = null
  private initResult: InitializeResult | null = null
  private readonly sessions = new Map<string, ManagedAcpSession>()
  private cachedModels: AcpModelOption[] = []
  private cachedTier: string | null = null
  private lastError: string | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: SessionPoolDeps) {
    super()
    this.sweepTimer = setInterval(() => {
      void this.sweepIdleSessions()
    }, 60_000)
    this.sweepTimer.unref?.()
  }

  getClient(): AcpClient | null {
    return this.client
  }

  getStatus(): StatusSnapshot {
    const cfg = this.deps.getConfig()
    return {
      providerId: PROVIDER_ID,
      enabled: cfg.enabled,
      connected: Boolean(this.client?.isRunning),
      agentName: this.initResult?.agentInfo?.name ?? null,
      agentVersion: this.initResult?.agentInfo?.version ?? null,
      tierName: this.cachedTier,
      activeSessions: this.sessions.size,
      models: this.cachedModels,
      permissionMode: cfg.permissionMode,
      lastError: this.lastError,
      updatedAt: Date.now(),
    }
  }

  async ensureClient(): Promise<AcpClient> {
    if (this.client?.isRunning) return this.client
    if (this.initPromise) return this.initPromise

    this.initPromise = this.startClient().finally(() => {
      this.initPromise = null
    })
    return this.initPromise
  }

  private async startClient(): Promise<AcpClient> {
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
      defaultTimeoutMs: cfg.requestTimeoutMs,
      onPermission: this.deps.onPermission,
      onLog: this.deps.log,
      onExit: (code, signal) => {
        this.deps.log?.(`agy acp process exited (code=${String(code)}, signal=${String(signal)})`)
        this.sessions.clear()
        this.client = null
        this.emitStatus()
      },
    })

    client.start()
    const initRes = await client.initialize()
    this.client = client
    this.initResult = initRes
    this.lastError = null
    this.deps.log?.(
      `connected to ${initRes.agentInfo?.name ?? 'agy acp'} ${initRes.agentInfo?.version ?? ''}`.trim(),
    )
    this.emitStatus()
    return client
  }

  async getOrCreateSession(
    dshSessionKey: string,
    cwd: string,
  ): Promise<{ client: AcpClient; session: ManagedAcpSession; created: boolean }> {
    const client = await this.ensureClient()
    const existing = this.sessions.get(dshSessionKey)
    if (existing) {
      existing.lastActiveAt = Date.now()
      return { client, session: existing, created: false }
    }

    const mcpServers = this.deps.getMcpServers?.(dshSessionKey) ?? []
    const res = await client.sessionNew({ cwd, mcpServers })
    this.captureCatalogFromSession(res)

    const configOptions = res.configOptions ?? []
    const session: ManagedAcpSession = {
      dshSessionKey,
      acpSessionId: res.sessionId,
      cwd,
      currentModel: findCurrentOption(configOptions, 'model') ?? res.models?.currentModelId ?? '',
      currentEffort: findCurrentOption(configOptions, 'thought_level') ?? '',
      currentMode: findCurrentOption(configOptions, 'mode') ?? res.modes?.currentModeId ?? 'default',
      configOptions,
      lastActiveAt: Date.now(),
    }
    this.sessions.set(dshSessionKey, session)
    this.emitStatus()
    return { client, session, created: true }
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
    const client = await this.ensureClient()
    const res = await client.sessionNew({ cwd: cwd || this.deps.getConfig().workspaceRoot || process.cwd(), mcpServers: [] })
    this.captureCatalogFromSession(res)
    await client.sessionClose(res.sessionId).catch(() => undefined)
    this.emitStatus()
    return this.cachedModels
  }

  async closeSession(dshSessionKey: string): Promise<void> {
    const sess = this.sessions.get(dshSessionKey)
    if (!sess) return
    this.sessions.delete(dshSessionKey)
    if (this.client?.isRunning) {
      await this.client.sessionClose(sess.acpSessionId).catch(() => undefined)
    }
    this.emitStatus()
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
    this.client?.dispose()
    this.client = null
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
