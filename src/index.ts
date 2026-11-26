import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
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
import { resolveAgyBin } from './runtime/bin.ts'
import { MultiAccountPool } from './runtime/account-pool.ts'
import { ConfigStore } from './runtime/config-store.ts'
import { CredentialSlotLeaseManager } from './runtime/credential-lease.ts'
import { formatAgyStatusReport, runAgyDoctor } from './runtime/doctor.ts'
import { EgressGuard } from './runtime/egress-guard.ts'
import { hostPermissions, type QuestionService, type SessionAgent } from './runtime/host-permissions.ts'
import { SessionPolicyChangedError } from './runtime/permission-manager.ts'
import { SessionIndex } from './runtime/session-index.ts'
import { AcpSessionPool } from './runtime/session-pool.ts'
import { registerAcpRoutes, type WebServerLike } from './transport/sse.ts'

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

  function collectMcpToolCatalog(): McpToolCatalogSnapshot {
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
    return {
      tools: entries,
      eagerCount,
      lazyCount,
      offCount,
      estimatedEagerBytes,
      budgetBytes: DEFAULT_MAX_EAGER_SCHEMA_BYTES,
      willCompact: estimatedEagerBytes > DEFAULT_MAX_EAGER_SCHEMA_BYTES,
      source: entries.length > 0 ? 'live' : 'empty',
    }
  }

  const slotManager = cfg.credentialSlotDir
    ? new CredentialSlotLeaseManager({ slotDir: cfg.credentialSlotDir })
    : undefined
  const multiAccountPool =
    cfg.accounts.length > 0
      ? new MultiAccountPool({
          accounts: cfg.accounts,
          slotManager,
          log,
        })
      : undefined

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

  const boundaryEvents = new Set(['sandbox/mode', 'approval/policy', 'permission/preset'])
  ctx.on('session/event' as never, ((session: { id: string }, event: { type: string }) => {
    if (event.type === 'working-directory/change') pool.invalidate(session.id, new SessionPolicyChangedError())
    else if (boundaryEvents.has(event.type)) pool.policyChanged(session.id)
    else if (event.type === 'turn/end') runs.cancelActiveForOwner(session.id, new Error('DSH turn ended'))
  }) as never, { global: true })
  ctx.on('session/disposed' as never, ((session: { id: string }) => pool.evictSession(session.id)) as never, { global: true })
  multiAccountPool?.on('change', () => {
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
    (ctx.emit as (event: 'llm/models-updated', provider: string) => void)('llm/models-updated', PROVIDER_ID)
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
    const unlistenChange = sub.on(
      'tools/change' as never,
      (() => {
        pool.notifyStatusChange()
      }) as never,
      { global: true },
    )
    pool.notifyStatusChange()
    return () => {
      bridgeTools = undefined
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

  // 4. Register HTTP + SSE endpoints for browser client
  ctx.inject(['webServer'], (sub) => {
    const webServer = sub.get('webServer') as WebServerLike | undefined
    if (!webServer) return
    return registerAcpRoutes(webServer, pool, {
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
    })
  })

  // 5. Cleanup on plugin unload
  ctx.effect(() => () => {
    pool.dispose()
    slotManager?.dispose()
    for (const key of bridges.keys()) releaseBridge(key)
  })
}
