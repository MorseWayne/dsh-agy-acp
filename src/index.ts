import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID } from './common/types.ts'
import { ReverseMcpBridge } from './mcp/server.ts'
import { AcpAdapter } from './provider/adapter.ts'
import { defineAgyAcpMirrorTool } from './provider/mirror-tool.ts'
import { AcpRunStore } from './provider/run-store.ts'
import { resolveAgyBin } from './runtime/bin.ts'
import { MultiAccountPool } from './runtime/account-pool.ts'
import { CredentialSlotLeaseManager } from './runtime/credential-lease.ts'
import { hostPermissions, type SessionAgent } from './runtime/host-permissions.ts'
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
  let cfg = resolveConfig(entryConfig)
  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[dsh-agy-acp] ${msg}`)
  }

  const permissions = hostPermissions(ctx as unknown as Parameters<typeof hostPermissions>[0])
  let bridgeTools: DshToolsServiceLike | undefined
  const bridges = new Map<string, ReverseMcpBridge>()
  function releaseBridge(key: string) {
    const bridge = bridges.get(key)
    bridges.delete(key)
    if (bridge) void bridge.dispose().catch(err => log(String(err)))
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
  const pool: AcpSessionPool = new AcpSessionPool({
    getConfig: () => cfg,
    resolveBin: () => resolveAgyBin(cfg.agyBin),
    accountProvider: multiAccountPool,
    ...permissions,
    isMcpBridgeActive: () => bridges.size > 0,
    onConfigPatch: patch => {
      cfg = { ...cfg, ...patch }
      if (!cfg.mcpBridge) for (const key of bridges.keys()) releaseBridge(key)
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
        }, log,
      })
      bridges.set(key, bridge)
      await bridge.start()
      if (!cfg.mcpBridge || bridges.get(key) !== bridge) { await bridge.dispose(); return [] }
      const spec = bridge.getMcpServerSpec()
      return spec ? [spec] : []
    },
    log,
  })

  const boundaryEvents = new Set(['sandbox/mode', 'approval/policy', 'permission/preset', 'working-directory/change'])
  ctx.on('session/event' as never, ((session: { id: string }, event: { type: string }) => {
    if (boundaryEvents.has(event.type)) pool.invalidate(session.id)
  }) as never, { global: true })
  ctx.on('session/disposed' as never, ((session: { id: string }) => pool.invalidate(session.id)) as never, { global: true })
  multiAccountPool?.on('change', () => {
    pool.notifyStatusChange()
  })

  const adapter = new AcpAdapter({
    getConfig: () => cfg,
    pool,
    runs,
    log,
  })

  // 1. Register LLM provider route
  if (cfg.enabled) {
    const llm = ctx.get('llm') as { registerAdapter(providers: string[], a: unknown): unknown } | undefined
    llm?.registerAdapter([PROVIDER_ID], adapter)
    log(`registered provider route: ${PROVIDER_ID}`)
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

  // 3. Register /agy-acp status command
  const commands = ctx.get('commands') as { register(def: unknown): unknown } | undefined
  commands?.register({
    name: 'agy-acp',
    description: 'Inspect Antigravity ACP bridge status',
    async handler() {
      const s = pool.getStatus()
      return {
        kind: 'success' as const,
        text: [
          `Antigravity ACP (${s.providerId})`,
          `Connected: ${s.connected ? 'yes' : 'no'} (${s.agentName ?? 'idle'} ${s.agentVersion ?? ''})`,
          `Tier: ${s.tierName ?? 'unknown'}`,
          `Active Sessions: ${s.activeSessions}`,
          `MCP Bridge: ${s.mcpBridgeActive ? 'active' : 'off'}`,
          'Permission policy: DSH conversation',
          `Tokens: in=${s.usageTotals.inputTokens} cached=${s.usageTotals.cachedReadTokens} out=${s.usageTotals.outputTokens} think=${s.usageTotals.reasoningTokens}`,
          `Models Cached: ${s.models.length}`,
        ].join('\n'),
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
