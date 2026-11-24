import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID } from './common/types.ts'
import { AcpAdapter } from './provider/adapter.ts'
import { defineAgyAcpMirrorTool } from './provider/mirror-tool.ts'
import { AcpRunStore } from './provider/run-store.ts'
import { resolveAgyBin } from './runtime/bin.ts'
import { AcpSessionPool } from './runtime/session-pool.ts'
import { registerAcpRoutes, type WebServerLike } from './transport/sse.ts'

export const name = 'dsh-agy-acp'
export const inject = ['llm', 'commands']

export function apply(ctx: Context, entryConfig: Record<string, unknown> = {}): void {
  const cfg = resolveConfig(entryConfig)
  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[dsh-agy-acp] ${msg}`)
  }

  const runs = new AcpRunStore()
  const pool = new AcpSessionPool({
    getConfig: () => cfg,
    resolveBin: () => resolveAgyBin(cfg.agyBin),
    onPermission: async (req) => {
      // Phase 1 policy: honor configured permissionMode; Phase 2 wires interactive DSH approval UI.
      const allowOpt = req.options.find((o) => o.kind.includes('allow'))
      const denyOpt = req.options.find((o) => o.kind.includes('reject'))
      if (cfg.permissionMode === 'skip' || cfg.permissionMode === 'accept-edits') {
        if (allowOpt) return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
      }
      if (cfg.permissionMode === 'plan' && req.toolCall.kind === 'execute' && denyOpt) {
        return { outcome: { outcome: 'selected', optionId: denyOpt.optionId } }
      }
      return allowOpt
        ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    },
    log,
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

  // 2. Register synthetic mirror tool + pre-execute bypass
  ctx.inject(['tools'], (sub) => {
    const tools = sub.get('tools') as { register(t: unknown): (() => void) | void } | undefined
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
    return () => {
      if (typeof unlisten === 'function') unlisten()
      if (typeof disposeTool === 'function') disposeTool()
    }
  })

  // 3. Register /agy-acp status command
  const commands = ctx.get('commands') as { register(def: unknown): unknown } | undefined
  commands?.register({
    name: 'agy-acp',
    description: 'Inspect Antigravity ACP bridge status',
    async execute() {
      const s = pool.getStatus()
      return [
        `Antigravity ACP (${s.providerId})`,
        `Connected: ${s.connected ? 'yes' : 'no'} (${s.agentName ?? 'idle'} ${s.agentVersion ?? ''})`,
        `Tier: ${s.tierName ?? 'unknown'}`,
        `Active Sessions: ${s.activeSessions}`,
        `Permission Mode: ${s.permissionMode}`,
        `Models Cached: ${s.models.length}`,
      ].join('\n')
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
  })
}
