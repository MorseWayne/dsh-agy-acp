import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID, type PermissionMode } from './common/types.ts'
import { ReverseMcpBridge, type BridgeToolSchema } from './mcp/server.ts'
import { AcpAdapter } from './provider/adapter.ts'
import { defineAgyAcpMirrorTool } from './provider/mirror-tool.ts'
import { AcpRunStore } from './provider/run-store.ts'
import { resolveAgyBin } from './runtime/bin.ts'
import { MultiAccountPool } from './runtime/account-pool.ts'
import { CredentialSlotLeaseManager } from './runtime/credential-lease.ts'
import { PermissionManager } from './runtime/permission-manager.ts'
import { AcpSessionPool } from './runtime/session-pool.ts'
import { registerAcpRoutes, type WebServerLike } from './transport/sse.ts'

export const name = 'dsh-agy-acp'
export const inject = ['llm', 'commands']

interface DshToolsServiceLike {
  register(t: unknown): (() => void) | void
  schemas?(): Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
  execute?(input: {
    callId: ToolCallId
    name: string
    arguments: unknown
    signal: AbortSignal
  }): Promise<ToolExecutionResult>
}

export function apply(ctx: Context, entryConfig: Record<string, unknown> = {}): void {
  let cfg = resolveConfig(entryConfig)
  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[dsh-agy-acp] ${msg}`)
  }

  let mcpBridge: ReverseMcpBridge | null = null
  let syncMcpBridge: (() => Promise<void>) | null = null

  const permissions = new PermissionManager({
    getMode: () => cfg.permissionMode,
    log,
  })

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
  const pool = new AcpSessionPool({
    getConfig: () => cfg,
    resolveBin: () => resolveAgyBin(cfg.agyBin),
    accountProvider: multiAccountPool,
    onPermission: (req) => permissions.handleRequest(req),
    getPendingPermissions: () => permissions.listPending(),
    isMcpBridgeActive: () => Boolean(mcpBridge?.isRunning),
    onPermissionModeChange: (mode: PermissionMode) => {
      cfg = { ...cfg, permissionMode: mode }
    },
    onConfigPatch: async (patch) => {
      cfg = { ...cfg, ...patch }
      await syncMcpBridge?.()
    },
    onSessionClosed: (acpSessionId) => {
      permissions.clearSessionRules(acpSessionId)
    },
    getMcpServers: () => {
      const spec = mcpBridge?.getMcpServerSpec()
      return spec ? [spec] : []
    },
    log,
  })

  permissions.on('change', () => {
    pool.notifyStatusChange()
  })
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

    let localBridge: ReverseMcpBridge | null = null
    const ensureBridgeState = async (): Promise<void> => {
      const want = cfg.enabled && cfg.mcpBridge && typeof tools.schemas === 'function' && typeof tools.execute === 'function'
      if (want && !localBridge) {
        const toolsSvc = tools
        const b = new ReverseMcpBridge({
          listTools: (): BridgeToolSchema[] =>
            (toolsSvc.schemas?.() ?? []).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            })),
          callTool: async (toolName, args, signal) => {
            const result = await toolsSvc.execute!({
              callId: `mcp:${randomUUID().slice(0, 12)}` as ToolCallId,
              name: toolName,
              arguments: args,
              signal,
            })
            const textParts = result.content
              .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
              .filter((t) => t.length > 0)
            return {
              content: [{ type: 'text', text: textParts.join('\n') || '(no output)' }],
              isError: result.isError,
            }
          },
          log,
        })
        localBridge = b
        mcpBridge = b
        try {
          await b.start()
        } catch (err) {
          log(`reverse MCP bridge failed to start: ${err instanceof Error ? err.message : String(err)}`)
        }
        pool.notifyStatusChange()
      } else if (!want && localBridge) {
        const closing = localBridge
        localBridge = null
        if (mcpBridge === closing) mcpBridge = null
        await closing.dispose()
        pool.notifyStatusChange()
      }
    }

    syncMcpBridge = ensureBridgeState
    void ensureBridgeState()

    return () => {
      if (syncMcpBridge === ensureBridgeState) syncMcpBridge = null
      if (typeof unlisten === 'function') unlisten()
      if (typeof disposeTool === 'function') disposeTool()
      if (localBridge) {
        const closing = localBridge
        localBridge = null
        if (mcpBridge === closing) mcpBridge = null
        void closing.dispose().finally(() => pool.notifyStatusChange())
      }
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
          `Pending Permissions: ${s.pendingPermissions.length}`,
          `MCP Bridge: ${s.mcpBridgeActive ? 'active' : 'off'}`,
          `Permission Mode: ${s.permissionMode}`,
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
    return registerAcpRoutes(webServer, pool, permissions)
  })

  // 5. Cleanup on plugin unload
  ctx.effect(() => () => {
    permissions.dispose()
    pool.dispose()
    if (mcpBridge) {
      void mcpBridge.dispose()
      mcpBridge = null
    }
  })
}
