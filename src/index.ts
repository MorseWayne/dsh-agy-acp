import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { DEFAULT_ACCOUNT_ID, maskProxyUrlForDisplay, validateProxyUrl } from './common/account-validation.ts'
import { resolveConfig } from './common/config.ts'
import {
  DEFAULT_MAX_EAGER_SCHEMA_BYTES,
  DSH_CALL_TOOL_NAME,
  DSH_DISCOVER_TOOLS_NAME,
  estimateToolSchemaBytes,
  firstLineSummary,
  META_GATEWAY_ESTIMATED_BYTES,
  resolveEffectiveMcpToolPolicy,
  resolveToolExposure,
} from './common/mcp-tool-policy.ts'
import {
  MIRROR_TOOL_NAME,
  PROVIDER_ID,
  WRAPPER_TOOL_NAME,
  type EnvironmentCheckReport,
  type EnvironmentSnapshot,
  type McpBridgeSnapshot,
  type McpToolCatalogEntry,
  type McpToolCatalogSnapshot,
  type ReviewProviderOption,
} from './common/types.ts'
import { ReverseMcpBridge } from './mcp/server.ts'
import { AcpAdapter, resolveAutoReviewRedirectOptions } from './provider/adapter.ts'
import { defineAgyAcpMirrorTool } from './provider/mirror-tool.ts'
import type { ReadPromptFile, ReadPromptImage } from './provider/prompt-builder.ts'
import { AcpRunStore } from './provider/run-store.ts'
import { AccountLoginError, AccountLoginManager } from './runtime/account-login.ts'
import { buildAccountEnv, MultiAccountPool } from './runtime/account-pool.ts'
import {
  AccountStore,
  detectAccountIdentityFromHome,
  inspectAccountAuthStatus,
  MANAGED_ACCOUNT_SSH_SENTINEL,
} from './runtime/account-store.ts'
import { resolveAgyBin } from './runtime/bin.ts'
import { ConfigStore } from './runtime/config-store.ts'
import { CredentialSlotLeaseManager } from './runtime/credential-lease.ts'
import { formatAgyStatusReport, runAgyDoctor } from './runtime/doctor.ts'
import { EgressGuard } from './runtime/egress-guard.ts'
import { AgyInstaller } from './runtime/env-setup.ts'
import { hostPermissions, type QuestionService, type SessionAgent } from './runtime/host-permissions.ts'
import { SessionPolicyChangedError } from './runtime/permission-manager.ts'
import { SessionIndex } from './runtime/session-index.ts'
import { AcpSessionPool } from './runtime/session-pool.ts'
import { registerAcpRoutes, type ConnectionLike, type WebServerLike } from './transport/sse.ts'

export const name = '@morsewayne/dsh-agy-acp'
export const inject = ['llm', 'commands', 'agents', 'permissionPresets', 'approval', 'sandboxPolicy', 'sandbox']

interface DshToolsServiceLike {
  register(t: unknown): (() => void) | void
  schemas?(agent?: SessionAgent): Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
}

interface DshLlmServiceLike {
  registerAdapter(providers: string[], a: unknown): unknown
  listProviders?(): LlmProviderInfo[]
  listModels?(provider: string): Promise<LlmModelInfo[]>
  stream?(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export function apply(ctx: Context, entryConfig: Record<string, unknown> = {}): void {
  const baseCfg = resolveConfig(entryConfig)
  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[dsh-agy-acp] ${msg}`)
  }
  const configStore = new ConfigStore({ log })
  const loaded = configStore.load()
  let cfg = { ...baseCfg, ...loaded.patch }

  let questions: QuestionService | undefined
  ctx.inject(['userQuestions'], sub => {
    questions = sub.get('userQuestions') as QuestionService | undefined
    return () => { questions = undefined }
  })
  const permissions = hostPermissions(ctx as unknown as Parameters<typeof hostPermissions>[0], () => questions)
  let bridgeTools: DshToolsServiceLike | undefined
  const bridges = new Map<string, ReverseMcpBridge>()
  let archivedBridgeCalls = 0
  let archivedBridgeFailures = 0
  let lastBridgeToolName: string | null = null
  let lastBridgeCallAt: number | null = null
  let lastBridgeError: string | null = null

  function releaseBridge(key: string) {
    const bridge = bridges.get(key)
    bridges.delete(key)
    if (bridge) {
      const stats = bridge.getStats()
      archivedBridgeCalls += stats.totalCalls
      archivedBridgeFailures += stats.failedCalls
      if (stats.lastCallAt && (!lastBridgeCallAt || stats.lastCallAt >= lastBridgeCallAt)) {
        lastBridgeCallAt = stats.lastCallAt
        lastBridgeToolName = stats.lastToolName
        lastBridgeError = stats.lastError
      }
      void bridge.dispose().catch(err => log(String(err)))
    }
  }

  function collectMcpBridgeSnapshot(): McpBridgeSnapshot {
    let inFlightCalls = 0
    let totalCalls = archivedBridgeCalls
    let failedCalls = archivedBridgeFailures
    let latestTool = lastBridgeToolName
    let latestAt = lastBridgeCallAt
    let latestErr = lastBridgeError
    let sawHttp = false
    let sawStdio = false
    for (const b of bridges.values()) {
      const st = b.getStats()
      inFlightCalls += st.inFlightCalls
      totalCalls += st.totalCalls
      failedCalls += st.failedCalls
      if (st.transport === 'http') sawHttp = true
      else sawStdio = true
      if (st.lastCallAt && (!latestAt || st.lastCallAt >= latestAt)) {
        latestAt = st.lastCallAt
        latestTool = st.lastToolName
        latestErr = st.lastError
      }
    }
    const transport: McpBridgeSnapshot['transport'] =
      sawHttp && sawStdio ? 'mixed' : sawHttp ? 'http' : sawStdio ? 'stdio' : undefined
    return {
      enabled: cfg.mcpBridge,
      activeBridges: bridges.size,
      inFlightCalls,
      totalCalls,
      failedCalls,
      ...(transport ? { transport } : {}),
      lastToolName: latestTool,
      lastCallAt: latestAt,
      lastError: latestErr,
    }
  }

  let cachedMcpToolCatalog: McpToolCatalogSnapshot | null = null
  let cachedMcpToolCatalogPolicyKey = ''

  function invalidateMcpToolCatalog(): void {
    cachedMcpToolCatalog = null
    cachedMcpToolCatalogPolicyKey = ''
  }

  function collectMcpToolCatalog(): McpToolCatalogSnapshot {
    const policyKey = `${cfg.mcpExposeOverlappingTools ? '1' : '0'}:${JSON.stringify(cfg.mcpToolPolicy ?? null)}`
    if (
      cachedMcpToolCatalog &&
      cachedMcpToolCatalogPolicyKey === policyKey &&
      (cachedMcpToolCatalog.source === 'live' || bridges.size === 0)
    ) {
      return cachedMcpToolCatalog
    }

    const rawSchemas: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> = []
    if (bridgeTools?.schemas) {
      try {
        rawSchemas.push(...bridgeTools.schemas())
      } catch {
        // Fallback: if the host requires a scope, try any active bridge session owner.
        for (const key of bridges.keys()) {
          try {
            rawSchemas.push(...bridgeTools.schemas(permissions.agent(key)))
            break
          } catch {
            // try next session
          }
        }
      }
    }

    const effectivePolicy = resolveEffectiveMcpToolPolicy(cfg.mcpToolPolicy, cfg.mcpExposeOverlappingTools)
    const entries: McpToolCatalogEntry[] = []
    let eagerCount = 0
    let lazyCount = 0
    let offCount = 0
    let estimatedEagerBytes = 0

    for (const t of rawSchemas) {
      if (
        !t?.name ||
        t.name === MIRROR_TOOL_NAME ||
        t.name === WRAPPER_TOOL_NAME ||
        t.name === DSH_DISCOVER_TOOLS_NAME ||
        t.name === DSH_CALL_TOOL_NAME
      ) {
        continue
      }
      const { mode, group, replacedNative, overridden } = resolveToolExposure(t.name, effectivePolicy)
      const bytes = estimateToolSchemaBytes({ name: t.name, description: t.description, inputSchema: t.parameters })
      if (mode === 'eager') {
        eagerCount++
        estimatedEagerBytes += bytes
      } else if (mode === 'lazy') {
        lazyCount++
      } else {
        offCount++
      }
      entries.push({
        name: t.name,
        groupId: group.id,
        kind: group.kind,
        description: firstLineSummary(t.description, 100),
        estimatedBytes: bytes,
        effectiveMode: mode,
        replacedNative,
        overridden,
      })
    }

    if (lazyCount > 0) {
      estimatedEagerBytes += META_GATEWAY_ESTIMATED_BYTES
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const snapshot: McpToolCatalogSnapshot = {
      tools: entries,
      eagerCount,
      lazyCount,
      offCount,
      estimatedEagerBytes,
      budgetBytes: DEFAULT_MAX_EAGER_SCHEMA_BYTES,
      willCompact: estimatedEagerBytes > DEFAULT_MAX_EAGER_SCHEMA_BYTES,
      source: entries.length > 0 ? 'live' : 'empty',
    }
    cachedMcpToolCatalog = snapshot
    cachedMcpToolCatalogPolicyKey = policyKey
    return snapshot
  }

  const slotManager = cfg.credentialSlotDir
    ? new CredentialSlotLeaseManager({ slotDir: cfg.credentialSlotDir })
    : undefined
  const accountStore = new AccountStore({ log })
  accountStore.load()
  const hostAccountIds = new Set(baseCfg.accounts.map(a => a.id))
  let defaultAuthFailed = false
  let lastEnvCheck: EnvironmentCheckReport | null = null
  let poolRef: AcpSessionPool | null = null
  const markDefaultAuth = (state: 'verified' | 'failed'): void => {
    if (state === 'verified') {
      const wasFailed = defaultAuthFailed
      defaultAuthFailed = false
      const changed = accountStore.setDefaultAuthVerified(true)
      if (wasFailed || changed) poolRef?.notifyStatusChange()
    } else {
      const wasFailed = defaultAuthFailed
      defaultAuthFailed = true
      const changed = accountStore.setDefaultAuthVerified(false)
      if (!wasFailed || changed) poolRef?.notifyStatusChange()
    }
  }
  const multiAccountPool = new MultiAccountPool({
    accounts: accountStore.buildEffectiveProfiles(baseCfg.accounts),
    preferredAccountId: accountStore.getPreferredAccountId(),
    slotManager,
    inspectAuthStatus: (profile) =>
      inspectAccountAuthStatus(profile, {
        defaultConnected: profile.id === DEFAULT_ACCOUNT_ID && accountStore.isDefaultAuthVerified(),
        defaultAuthFailed: profile.id === DEFAULT_ACCOUNT_ID && defaultAuthFailed,
      }),
    onAuthObserved: (accountId, state) => {
      if (accountId === DEFAULT_ACCOUNT_ID) markDefaultAuth(state)
    },
    log,
  })
  const syncManagedAccounts = (): void => {
    const profiles = accountStore.buildEffectiveProfiles(baseCfg.accounts)
    multiAccountPool.syncProfiles(profiles)
    multiAccountPool.setPreferredAccount(accountStore.getPreferredAccountId())
  }

  const installer = new AgyInstaller({
    resolveBin: () => resolveAgyBin(cfg.agyBin),
    onInstalled: async () => {
      pool.invalidateCatalog()
      pool.notifyStatusChange()
      void pool.refreshModels().catch(() => {})
    },
    log,
  })

  const loginManager = new AccountLoginManager({
    onLoginSuccess: async (accountId) => {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        markDefaultAuth('verified')
      }
      pool.retireSessionsForAccount(accountId)
      pool.clearAccountCooldown(accountId)
      pool.invalidateCatalog()
      pool.notifyStatusChange()
      void pool.refreshModels().catch(() => {})
    },
    log,
  })

  const collectEnvironmentSnapshot = (): EnvironmentSnapshot => {
    const binPath = resolveAgyBin(cfg.agyBin)
    const task = installer.getSnapshot()
    return {
      platform: process.platform,
      agyFound: Boolean(binPath),
      agyBinPath: binPath,
      agyVersion: lastEnvCheck?.cliVersion ?? null,
      ...(lastEnvCheck ? { supportsFileCredentials: lastEnvCheck.supportsFileCredentials } : {}),
      manualInstallCommand: installer.manualInstallCommand,
      ...(task.state !== 'idle' || task.logs.length > 0 ? { installTask: task } : {}),
      ...(lastEnvCheck ? { lastCheck: lastEnvCheck } : {}),
    }
  }

  const llm = ctx.get('llm') as DshLlmServiceLike | undefined
  const listReviewProviders = (): ReviewProviderOption[] => {
    const raw = llm?.listProviders?.() ?? []
    const seen = new Set<string>()
    const out: ReviewProviderOption[] = []
    for (const p of raw) {
      if (!p || typeof p.id !== 'string' || !p.id.trim() || seen.has(p.id)) continue
      seen.add(p.id)
      out.push({ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id })
    }
    return out
  }

  const runs = new AcpRunStore()
  const egressGuard = new EgressGuard({ log })
  const sessionIndex = new SessionIndex({ log })
  sessionIndex.load()
  const pool: AcpSessionPool = new AcpSessionPool({
    getConfig: () => cfg,
    resolveBin: () => resolveAgyBin(cfg.agyBin),
    accountProvider: multiAccountPool,
    egressGuard,
    sessionIndex,
    ...permissions,
    isMcpBridgeActive: () => bridges.size > 0,
    getMcpBridgeSnapshot: collectMcpBridgeSnapshot,
    getMcpToolCatalog: collectMcpToolCatalog,
    getEnvironmentSnapshot: collectEnvironmentSnapshot,
    getActiveLoginSnapshot: () => loginManager.getActiveSnapshot(),
    listReviewProviders,
    hasPersistedConfig: () => configStore.hasPersistedOverrides,
    onConfigPatch: patch => {
      configStore.savePatch(patch)
      const prevBin = cfg.agyBin
      const prevRoot = cfg.workspaceRoot
      const prevGeo = cfg.geoFenceMode
      cfg = { ...cfg, ...patch }
      if (!cfg.mcpBridge) for (const key of bridges.keys()) releaseBridge(key)
      if (
        cfg.agyBin !== prevBin ||
        cfg.workspaceRoot !== prevRoot ||
        (cfg.geoFenceMode !== prevGeo && (cfg.geoFenceMode === 'off' || cfg.geoFenceMode === 'warn') && pool.getStatus().models.length === 0)
      ) {
        pool.invalidateCatalog()
        void pool.refreshModels().catch(() => {})
      }
    },
    onConfigReset: () => {
      configStore.reset()
      const prevBin = cfg.agyBin
      const prevRoot = cfg.workspaceRoot
      const prevGeo = cfg.geoFenceMode
      cfg = { ...baseCfg }
      if (!cfg.mcpBridge) for (const key of bridges.keys()) releaseBridge(key)
      if (
        cfg.agyBin !== prevBin ||
        cfg.workspaceRoot !== prevRoot ||
        (cfg.geoFenceMode !== prevGeo && pool.getStatus().models.length === 0)
      ) {
        pool.invalidateCatalog()
        void pool.refreshModels().catch(() => {})
      }
    },
    onSessionClosed: releaseBridge,
    async getMcpServers(key, opts) {
      const tools = bridgeTools
      if (!cfg.mcpBridge || !tools?.schemas) return []
      const owner = permissions.agent(key)
      const authority = (): AbortSignal => {
        const signal = pool.activeSignal(key)
        if (!signal || !cfg.mcpBridge || bridges.get(key) !== bridge || bridgeTools !== tools) throw new Error('Inactive ACP tool bridge')
        return signal
      }
      const bridge = new ReverseMcpBridge({
        toolPolicy: resolveEffectiveMcpToolPolicy(cfg.mcpToolPolicy, cfg.mcpExposeOverlappingTools),
        listTools: () => tools.schemas!(owner).map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        callTool: async (name, args, signal) => {
          const turn = authority()
          const schema = tools.schemas!(owner).find(t => t.name === name)
          if (!schema) throw new Error('Tool not available to this DSH session')
          // agy may add its display-only summary even for strict tools which do not declare it.
          if (Object.hasOwn(args, 'toolSummary') && !Object.hasOwn(schema.parameters?.properties ?? {}, 'toolSummary')) {
            const { toolSummary: _, ...actualArgs } = args
            args = actualArgs
          }
          const combinedSignal = AbortSignal.any([signal, turn])
          const activeRec = runs.getActiveForOwner(key)
          if (!activeRec) {
            throw new Error('No active ACP turn for delegated MCP call')
          }
          if (!activeRec.delegatesMcp) {
            return {
              content: [{ type: 'text', text: `Error: Tool "${name}" is not available in this DSH step` }],
              isError: true,
            }
          }
          const resumeTimer = pool.pauseTurnTimer(key)
          try {
            return await activeRec.enqueueMcpCall(name, args, combinedSignal)
          } finally {
            resumeTimer()
          }
        },
        callTimeoutMs: () => Math.min(Math.max(cfg.requestTimeoutMs, 120_000), 600_000),
        onActivity: () => pool.notifyStatusChange(),
        log,
      })
      bridges.set(key, bridge)
      await bridge.start()
      if (!cfg.mcpBridge || bridges.get(key) !== bridge) { await bridge.dispose(); return [] }
      const spec = bridge.getPreferredMcpServerSpec(Boolean(opts?.preferHttp))
      return spec ? [spec] : []
    },
    log,
  })
  poolRef = pool

  const boundaryEvents = new Set(['sandbox/mode', 'approval/policy', 'permission/preset'])
  ctx.on('session/event' as never, ((session: { id: string }, event: { type: string; data?: { turn?: number } }) => {
    if (event.type === 'working-directory/change') pool.invalidate(session.id, new SessionPolicyChangedError())
    else if (boundaryEvents.has(event.type)) pool.policyChanged(session.id)
    else if (event.type === 'turn/start' && typeof event.data?.turn === 'number') runs.beginHostTurn(session.id, event.data.turn)
    else if (event.type === 'turn/end' && typeof event.data?.turn === 'number') runs.endHostTurn(session.id, event.data.turn)
  }) as never, { global: true })
  ctx.on('session/disposed' as never, ((session: { id: string }) => {
    runs.closeOwnerTurn(session.id)
    pool.evictSession(session.id)
  }) as never, { global: true })
  multiAccountPool.on('change', () => {
    pool.notifyStatusChange()
  })
  installer.on('change', () => {
    pool.notifyStatusChange()
  })
  loginManager.on('change', () => {
    pool.notifyStatusChange()
  })

  let readFileStream: ReadPromptFile | undefined
  let readImage: ReadPromptImage | undefined
  ctx.inject(['attachments'], sub => {
    const svc = sub.get('attachments') as { readImage?: ReadPromptImage; readFileStream?: ReadPromptFile } | undefined
    readImage = svc?.readImage?.bind(svc)
    readFileStream = svc?.readFileStream?.bind(svc)
    return () => { readImage = undefined; readFileStream = undefined }
  })
  const adapter = new AcpAdapter({
    get readImage() { return readImage },
    get readFileStream() { return readFileStream },
    getConfig: () => cfg,
    pool,
    runs,
    canUseMirrorTool: (sessionKey) => {
      if (!bridgeTools?.schemas) return false
      try {
        return bridgeTools.schemas(permissions.agent(sessionKey)).some(t => t.name === MIRROR_TOOL_NAME)
      } catch {
        return false
      }
    },
    listSessionTools: (sessionKey) => {
      if (!bridgeTools?.schemas) return []
      try {
        return bridgeTools.schemas(permissions.agent(sessionKey)).map(t => ({ name: t.name, description: t.description }))
      } catch {
        return []
      }
    },
    log,
  })

  // Plugin status SSE and the host model menu are separate subscriptions.
  // Publish only changed/recovered catalogs, after the cache is ready for re-entry.
  pool.on('models-updated', () => {
    // The running host declares this event; the oldest supported peer typings do not.
    ;(ctx.emit as (event: 'llm/models-updated', provider: string) => void)('llm/models-updated', PROVIDER_ID)
  })

  // 1. Register LLM provider route & optional cross-provider auto-review redirect
  if (cfg.enabled) {
    if (llm) {
      llm.registerAdapter([PROVIDER_ID], adapter)
      log(`registered provider route: ${PROVIDER_ID}`)
      if (typeof llm.stream === 'function') {
        ctx.on(
          'llm/stream' as never,
          ((options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
            const redirected = resolveAutoReviewRedirectOptions(options, cfg)
            if (redirected) {
              return llm.stream!(redirected)
            }
            return next()
          }) as never,
          { global: true },
        )
      }
      // A menu may already hold a catalog from before this plugin was reloaded.
      // Prime the actual read-only ACP catalog (no prompt, MCP or fabricated model IDs).
      void pool.refreshModels().catch(() => { /* status and bounded retry are owned by the pool */ })
    }
  }

  // 2. Register synthetic mirror tool, pre-execute bypass, and optional session-scoped reverse MCP bridge
  ctx.inject(['tools'], (sub) => {
    const tools = sub.get('tools') as DshToolsServiceLike | undefined
    if (!tools) return
    const disposeTool = cfg.enabled ? tools.register(defineAgyAcpMirrorTool(runs)) : undefined
    const unlisten = sub.on(
      'tools/pre-execute' as never,
      (async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        if (exec.name === MIRROR_TOOL_NAME) return { kind: 'allow' }
        return next()
      }) as never,
      { prepend: true, global: true },
    )

    bridgeTools = tools
    invalidateMcpToolCatalog()
    const unlistenChange = sub.on(
      'tools/change' as never,
      (() => {
        invalidateMcpToolCatalog()
        pool.notifyStatusChange()
      }) as never,
      { global: true },
    )
    pool.notifyStatusChange()
    return () => {
      bridgeTools = undefined
      invalidateMcpToolCatalog()
      for (const key of bridges.keys()) releaseBridge(key)
      if (typeof unlistenChange === 'function') unlistenChange()
      if (typeof unlisten === 'function') unlisten()
      if (typeof disposeTool === 'function') disposeTool()
    }
  })

  // 3. Register /agy-acp status & doctor command
  const commands = ctx.get('commands') as { register(def: unknown): unknown } | undefined
  commands?.register({
    name: 'agy-acp',
    description: '查看 Antigravity ACP 状态概览，或输入 `/agy-acp doctor` 执行环境与出口自检',
    input: { hint: '[status | doctor]' },
    async handler(invocation?: { rawInput?: string; signal?: AbortSignal }) {
      const arg = (invocation?.rawInput ?? '').trim().toLowerCase()
      if (!arg || arg === 'status') {
        return {
          kind: 'success' as const,
          text: formatAgyStatusReport(pool.getStatus()),
        }
      }
      if (arg === 'doctor') {
        const outcome = await runAgyDoctor(
          {
            pool,
            resolveBin: () => resolveAgyBin(cfg.agyBin),
            prepareArgv: permissions.prepareArgv,
            configFilePath: configStore.filePath,
            sessionsFilePath: sessionIndex.filePath,
          },
          invocation?.signal,
        )
        lastEnvCheck = outcome.report
        pool.notifyStatusChange()
        return {
          kind: 'success' as const,
          text: outcome.text,
        }
      }
      return {
        kind: 'error' as const,
        text: `未知子命令 "${arg.slice(0, 32)}"。用法：/agy-acp [status | doctor]`,
      }
    },
  })

  // 4. Register HTTP + SSE endpoints for browser client behind DSH connection trust & auth fence
  ctx.inject(['webServer', 'connection'], (sub) => {
    const webServer = sub.get('webServer') as WebServerLike | undefined
    const connection = sub.get('connection') as ConnectionLike | undefined
    if (!webServer || !connection || typeof connection.requestRejection !== 'function') return
    return registerAcpRoutes(webServer, pool, {
      connection,
      listReviewModels: async (provider: string) => {
        const providers = listReviewProviders()
        if (!providers.some(p => p.id === provider)) return null
        if (provider === PROVIDER_ID) {
          return pool.getStatus().models.map(m => ({ id: m.value, name: m.name }))
        }
        if (typeof llm?.listModels !== 'function') return []
        const list = await llm.listModels(provider)
        return list.map(m => ({ id: m.id, name: m.name || m.id }))
      },
      runEnvCheck: async () => {
        const outcome = await runAgyDoctor({
          pool,
          resolveBin: () => resolveAgyBin(cfg.agyBin),
          prepareArgv: permissions.prepareArgv,
          configFilePath: configStore.filePath,
          sessionsFilePath: sessionIndex.filePath,
        })
        lastEnvCheck = outcome.report
        pool.notifyStatusChange()
        return outcome.report
      },
      startAgyInstall: (input) => installer.start(input),
      addAccount: async (body) => {
        const created = accountStore.addAccount(body, hostAccountIds)
        syncManagedAccounts()
        return created
      },
      selectAccount: accountId => {
        const validIds = new Set([DEFAULT_ACCOUNT_ID, ...hostAccountIds, ...accountStore.listManaged().map(a => a.id)])
        accountStore.setPreferredAccount(accountId, validIds)
        pool.switchActiveAccount(accountId)
      },
      updateAccount: async (body) => {
        const updated = accountStore.updateAccount(body)
        syncManagedAccounts()
        const targetId = typeof body.accountId === 'string' ? body.accountId.trim().toLowerCase() : ''
        if (targetId && (body.enabled === false || Object.hasOwn(body, 'proxyUrl'))) {
          pool.evictSessionsForAccount(
            targetId,
            new Error('该账号配置已变更或被停用，当前会话已关闭，下一轮将自动重新调度。'),
          )
        }
        return updated
      },
      removeAccount: async (accountId, opts) => {
        const cleanId = accountId.trim().toLowerCase()
        if (loginManager.getActiveSnapshot()?.accountId === cleanId) {
          loginManager.cancelLogin()
        }
        pool.evictSessionsForAccount(cleanId, new Error('该账号已被移除，当前会话已关闭。'))
        accountStore.removeAccount(cleanId, opts)
        syncManagedAccounts()
      },
      startAccountLogin: async ({ accountId, proxyUrl }) => {
        const bin = resolveAgyBin(cfg.agyBin)
        if (!bin) {
          throw new AccountLoginError('未检测到 agy 可执行文件，请先在上方点击「一键安装 agy」', 409)
        }
        const cwd = cfg.workspaceRoot || process.cwd()

        // Direct one-click OAuth onboarding: no pre-filled account name/ID required.
        if (!accountId) {
          const proxyChecked = validateProxyUrl(proxyUrl)
          if (!proxyChecked.ok) {
            throw new AccountLoginError(proxyChecked.error, 400)
          }
          const cleanProxy = proxyChecked.value || undefined
          const pendingId = randomUUID().slice(0, 12)
          const pendingHome = accountStore.preparePendingAccountHome(pendingId)
          const pendingEnvOverrides: Record<string, string> = {
            SSH_CONNECTION: MANAGED_ACCOUNT_SSH_SENTINEL,
          }
          if (cleanProxy) {
            pendingEnvOverrides.HTTPS_PROXY = cleanProxy
            pendingEnvOverrides.HTTP_PROXY = cleanProxy
            pendingEnvOverrides.ALL_PROXY = cleanProxy
          }
          const env = buildAccountEnv({
            id: `pending-${pendingId}`,
            homeDir: pendingHome,
            env: pendingEnvOverrides,
            ...(cleanProxy ? { proxyUrl: cleanProxy } : {}),
          })
          return await loginManager.startLogin({
            accountId: `pending-${pendingId}`,
            accountLabel: '新 Google 账号',
            isNewAccount: true,
            proxyDisplay: maskProxyUrlForDisplay(cleanProxy),
            bin,
            env,
            cwd,
            onBeforeSuccess: async ({ outputLog }) => {
              const identity = await detectAccountIdentityFromHome(pendingHome, {
                env,
                outputText: outputLog,
              })
              const created = accountStore.commitPendingAccount({
                pendingId,
                email: identity.email,
                name: identity.name,
                proxyUrl: cleanProxy,
                reservedHostIds: hostAccountIds,
              })
              syncManagedAccounts()
              pool.switchActiveAccount(created.id)
              return { accountId: created.id, accountLabel: created.label }
            },
            onCleanup: () => {
              accountStore.cleanupPendingAccountHome(pendingId)
            },
          })
        }

        const profile = multiAccountPool.getProfile(accountId)
        if (!profile) {
          throw new AccountLoginError('未找到该账号，请刷新页面后重试', 404)
        }
        if (profile.source === 'managed') {
          accountStore.ensureManagedAccountHome(profile.id)
        }
        const env = multiAccountPool.getAccountEnv(profile.id)
        return await loginManager.startLogin({
          accountId: profile.id,
          accountLabel: profile.label ?? profile.id,
          proxyDisplay: maskProxyUrlForDisplay(profile.proxyUrl),
          bin,
          env,
          cwd,
        })
      },
      submitAccountLoginCode: async (loginId, code) => await loginManager.submitCode(loginId, code),
      cancelAccountLogin: (loginId) => loginManager.cancelLogin(loginId),
    })
  })

  // 5. Cleanup on plugin unload
  ctx.effect(() => () => {
    loginManager.dispose()
    installer.dispose()
    pool.dispose()
    slotManager?.dispose()
    for (const key of bridges.keys()) releaseBridge(key)
  })
}
