import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID, type McpBridgeSnapshot } from './common/types.ts'
import { ReverseMcpBridge } from './mcp/server.ts'
import { AcpAdapter } from './provider/adapter.ts'
import { defineAgyAcpMirrorTool } from './provider/mirror-tool.ts'
import { AcpRunStore } from './provider/run-store.ts'
import { resolveAgyBin } from './runtime/bin.ts'
import { MultiAccountPool } from './runtime/account-pool.ts'
import { ConfigStore } from './runtime/config-store.ts'
import { CredentialSlotLeaseManager } from './runtime/credential-lease.ts'
import { formatAgyStatusReport, runAgyDoctor } from './runtime/doctor.ts'
import { EgressGuard } from './runtime/egress-guard.ts'
import { hostPermissions, type SessionAgent } from './runtime/host-permissions.ts'
import { SessionPolicyChangedError } from './runtime/permission-manager.ts'
import { SessionIndex } from './runtime/session-index.ts'
import { AcpSessionPool } from './runtime/session-pool.ts'
import { registerAcpRoutes, type WebServerLike } from './transport/sse.ts'

export const name = '@morsewayne/dsh-agy-acp'
export const inject = ['llm', 'commands', 'agents', 'permissionPresets', 'approval', 'sandboxPolicy', 'sandbox']

interface DshToolsServiceLike {
  register(t: unknown): (() => void) | void
  schemas?(agent: SessionAgent): Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
  execute?(input: {
    calls: Array<{ type: 'tool-call'; id: ToolCallId; name: string; arguments: unknown }>
    agent: SessionAgent; signal: AbortSignal
  }): Promise<{ results: Array<{ result: ToolExecutionResult }> }>
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

  const permissions = hostPermissions(ctx as unknown as Parameters<typeof hostPermissions>[0])
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
    for (const b of bridges.values()) {
      const st = b.getStats()
      inFlightCalls += st.inFlightCalls
      totalCalls += st.totalCalls
      failedCalls += st.failedCalls
      if (st.lastCallAt && (!latestAt || st.lastCallAt >= latestAt)) {
        latestAt = st.lastCallAt
        latestTool = st.lastToolName
        latestErr = st.lastError
      }
    }
    return {
      enabled: cfg.mcpBridge,
      activeBridges: bridges.size,
      inFlightCalls,
      totalCalls,
      failedCalls,
      lastToolName: latestTool,
      lastCallAt: latestAt,
      lastError: latestErr,
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
    async getMcpServers(key) {
      const tools = bridgeTools
      if (!cfg.mcpBridge || !tools?.schemas || !tools.execute) return []
      const owner = permissions.agent(key)
      const authority = (): AbortSignal => {
        const signal = pool.activeSignal(key)
        if (!signal || !cfg.mcpBridge || bridges.get(key) !== bridge || bridgeTools !== tools) throw new Error('Inactive ACP tool bridge')
        return signal
      }
      const bridge = new ReverseMcpBridge({
        listTools: () => tools.schemas!(owner).map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        callTool: async (name, args, signal) => {
          const turn = authority()
          if (!tools.schemas!(owner).some(t => t.name === name)) throw new Error('Tool not available to this DSH session')
          const batch = await tools.execute!({ agent: owner, signal: AbortSignal.any([signal, turn]),
            calls: [{ type: 'tool-call', id: `mcp:${randomUUID()}` as ToolCallId, name, arguments: args }] })
          const result = batch.results[0]?.result
          if (!result) throw new Error('No DSH tool result')
          return { content: [{ type: 'text', text: result.content.map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n') }], isError: result.isError }
        },
        callTimeoutMs: () => Math.min(cfg.requestTimeoutMs, 120_000),
        onActivity: () => pool.notifyStatusChange(),
        log,
      })
      bridges.set(key, bridge)
      await bridge.start()
      if (!cfg.mcpBridge || bridges.get(key) !== bridge) { await bridge.dispose(); return [] }
      const spec = bridge.getMcpServerSpec()
      return spec ? [spec] : []
    },
    log,
  })

  const boundaryEvents = new Set(['sandbox/mode', 'approval/policy', 'permission/preset'])
  ctx.on('session/event' as never, ((session: { id: string }, event: { type: string }) => {
    if (event.type === 'working-directory/change') pool.invalidate(session.id, new SessionPolicyChangedError())
    else if (boundaryEvents.has(event.type)) pool.policyChanged(session.id)
  }) as never, { global: true })
  ctx.on('session/disposed' as never, ((session: { id: string }) => pool.evictSession(session.id)) as never, { global: true })
  multiAccountPool?.on('change', () => {
    pool.notifyStatusChange()
  })

  const adapter = new AcpAdapter({
    getConfig: () => cfg,
    pool,
    runs,
    log,
  })

  // Plugin status SSE and the host model menu are separate subscriptions.
  // Publish only changed/recovered catalogs, after the cache is ready for re-entry.
  pool.on('models-updated', () => {
    // The running host declares this event; the oldest supported peer typings do not.
    (ctx.emit as (event: 'llm/models-updated', provider: string) => void)('llm/models-updated', PROVIDER_ID)
  })

  // 1. Register LLM provider route
  if (cfg.enabled) {
    const llm = ctx.get('llm') as { registerAdapter(providers: string[], a: unknown): unknown } | undefined
    if (llm) {
      llm.registerAdapter([PROVIDER_ID], adapter)
      log(`registered provider route: ${PROVIDER_ID}`)
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
    return () => {
      bridgeTools = undefined
      for (const key of bridges.keys()) releaseBridge(key)
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
    return registerAcpRoutes(webServer, pool)
  })

  // 5. Cleanup on plugin unload
  ctx.effect(() => () => {
    pool.dispose()
    for (const key of bridges.keys()) releaseBridge(key)
  })
}
