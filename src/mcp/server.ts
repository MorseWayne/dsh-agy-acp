import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpHttpMcpServerSpec, AcpMcpServerSpec, AcpStdioMcpServerSpec } from '../acp/protocol.ts'
import {
  classifyDshTool,
  DSH_CALL_TOOL_NAME,
  DSH_DISCOVER_TOOLS_NAME,
  firstLineSummary,
  resolveEffectiveMcpToolPolicy,
  resolveToolExposure,
  type EffectiveMcpToolPolicy,
  type McpToolPolicyConfig,
} from '../common/mcp-tool-policy.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../common/types.ts'
import {
  compactToolsForAgyBudget,
  DEFAULT_MAX_EAGER_SCHEMA_BYTES,
  normalizeBridgeTool,
  type BridgeToolSchema,
  type NormalizedBridgeTool,
} from './schema-budget.ts'

export type { BridgeToolSchema } from './schema-budget.ts'

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000
export const DEFAULT_MCP_MAX_CONCURRENT_CALLS = 8

export interface BridgeToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface McpBridgeStats {
  inFlightCalls: number
  totalCalls: number
  failedCalls: number
  transport: 'http' | 'stdio'
  lastToolName: string | null
  lastCallAt: number | null
  lastError: string | null
}

export interface ReverseMcpBridgeOptions {
  listTools: () => BridgeToolSchema[] | Promise<BridgeToolSchema[]>
  callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<BridgeToolResult>
  blockedTools?: readonly string[]
  /** When true, hide DSH base tools that duplicate Antigravity's native tools to save prompt tokens. */
  excludeOverlappingNativeTools?: boolean
  /**
   * Progressive-disclosure & supplement/replace tool routing policy.
   * When provided, tools are partitioned into lossless eager tools, on-demand gateway tools
   * (`dsh_discover_tools` / `dsh_call_tool`), and disabled (`off`) tools; `schema-budget`
   * becomes a last-resort safety net rather than normal-path truncation.
   */
  toolPolicy?: McpToolPolicyConfig | EffectiveMcpToolPolicy
  /** Legacy compatibility flag paired with `toolPolicy` (maps unset overlapping groups to `'replace'`). */
  legacyExposeOverlappingTools?: boolean
  serverName?: string
  bridgeScriptPath?: string
  /** Per-tool-call execution timeout in ms (default: 60_000). */
  callTimeoutMs?: number | (() => number)
  /** Maximum concurrent in-flight tool calls on this session bridge (default: 8). */
  maxConcurrentCalls?: number
  /** Maximum estimated ACP eager MCP declaration bytes before compacting verbose descriptions (default: 52_000; 0/Infinity disables). */
  maxEstimatedSchemaBytes?: number
  /** Optional callback fired when call metrics or errors change. */
  onActivity?: () => void
  log?: (msg: string) => void
}

const DEFAULT_BLOCKED_TOOLS = new Set<string>([MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME])
const META_GATEWAY_TOOLS: readonly NormalizedBridgeTool[] = [
  {
    name: DSH_DISCOVER_TOOLS_NAME,
    description:
      'Inspect full descriptions and JSON input schemas for on-demand DSH host tools before calling them via dsh_call_tool. Pass exact tool names to fetch full schemas, or pass a keyword query (or omit both) to search/list available on-demand tools.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact DSH tool names to retrieve full descriptions and JSON input schemas for.',
        },
        query: {
          type: 'string',
          description: 'Optional keyword filter across tool names, descriptions, and capability groups.',
        },
        includeSchemas: {
          type: 'boolean',
          description: 'Include full inputSchema for broader query matches (up to 10 tools per call).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: DSH_CALL_TOOL_NAME,
    description:
      'Invoke an on-demand DSH host tool by exact name and JSON arguments. Call dsh_discover_tools first when you need its full parameter schema.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact name of the DSH host tool to invoke (e.g. "workflow", "office_convert", "codex_image_generate").',
        },
        arguments: {
          type: 'object',
          description: 'JSON arguments object matching the target tool inputSchema.',
          additionalProperties: true,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
]

function isEffectivePolicy(
  p: McpToolPolicyConfig | EffectiveMcpToolPolicy,
): p is EffectiveMcpToolPolicy {
  return (
    typeof (p as EffectiveMcpToolPolicy).groups === 'object' &&
    typeof (p as EffectiveMcpToolPolicy).replace === 'object' &&
    typeof (p as EffectiveMcpToolPolicy).overrides === 'object' &&
    'memory_core' in (p as EffectiveMcpToolPolicy).groups &&
    'subagents' in (p as EffectiveMcpToolPolicy).replace
  )
}

/**
 * DSH host tools whose local capabilities already exist natively in Antigravity (`agy acp`).
 * Filtering them out by default saves ~6-10K prompt tokens per session, avoids tool-choice
 * splitting (e.g. `mcp_dsh-tools_glob` scanning `node_modules`), and preserves DSH-unique
 * extensions (`mnemon_*`, `team_task_*`, `goal`, `office_*`, `present`, `web_fetch`, etc.)
 * as well as DSH multi-agent orchestration tools (`subagent`, `subagent_fork`, `list_agents`,
 * `wait_agent`, `send_message`, `list_subagent_models`) required for cross-provider task
 * routing and host Agent Teams (which Antigravity's native `invoke_subagent` cannot perform).
 */
export const OVERLAPPING_NATIVE_DSH_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'web_search',
  'todo_write',
  'ask_user_question',
  'job_output',
  'job_list',
  'job_kill',
])

function resolveDefaultBridgeScriptPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(dir, 'bridge.mjs'),
    path.join(dir, 'mcp-bridge.mjs'),
    path.resolve(dir, '../mcp/bridge.mjs'),
    path.resolve(dir, '../../src/mcp/bridge.mjs'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]!
}

function readJsonBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw.trim() ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Localhost-only HTTP MCP JSON-RPC 2.0 server paired with a zero-dependency stdio bridge.
 * Injected per ACP session via `session/new` / `session/load` `mcpServers` without mutating global config.
 */
export class ReverseMcpBridge {
  private server: Server | null = null
  private readonly token: string
  private readonly blocked: Set<string>
  private readonly effectivePolicy: EffectiveMcpToolPolicy | null
  private readonly serverName: string
  private readonly bridgeScriptPath: string
  private readonly maxConcurrentCalls: number
  private readonly maxEstimatedSchemaBytes: number
  private readonly activeCallControllers = new Set<AbortController>()
  private url: string | null = null
  private activeTransport: 'http' | 'stdio' = 'stdio'
  private inFlightCalls = 0
  private totalCalls = 0
  private failedCalls = 0
  private lastToolName: string | null = null
  private lastCallAt: number | null = null
  private lastError: string | null = null

  constructor(private readonly opts: ReverseMcpBridgeOptions) {
    this.token = randomBytes(32).toString('hex')
    this.effectivePolicy = opts.toolPolicy
      ? isEffectivePolicy(opts.toolPolicy)
        ? opts.toolPolicy
        : resolveEffectiveMcpToolPolicy(opts.toolPolicy, opts.legacyExposeOverlappingTools)
      : null
    this.blocked = new Set([
      ...DEFAULT_BLOCKED_TOOLS,
      ...(!this.effectivePolicy && opts.excludeOverlappingNativeTools ? OVERLAPPING_NATIVE_DSH_TOOLS : []),
      ...(opts.blockedTools ?? []),
    ])
    this.serverName = opts.serverName ?? 'dsh-tools'
    this.bridgeScriptPath = opts.bridgeScriptPath ?? resolveDefaultBridgeScriptPath()
    this.maxConcurrentCalls = Math.max(1, opts.maxConcurrentCalls ?? DEFAULT_MCP_MAX_CONCURRENT_CALLS)
    this.maxEstimatedSchemaBytes = opts.maxEstimatedSchemaBytes ?? DEFAULT_MAX_EAGER_SCHEMA_BYTES
  }

  get isRunning(): boolean {
    return this.server !== null && this.url !== null
  }

  get endpointUrl(): string | null {
    return this.url
  }

  getStats(): McpBridgeStats {
    return {
      inFlightCalls: this.inFlightCalls,
      totalCalls: this.totalCalls,
      failedCalls: this.failedCalls,
      transport: this.activeTransport,
      lastToolName: this.lastToolName,
      lastCallAt: this.lastCallAt,
      lastError: this.lastError,
    }
  }

  private resolveCallTimeoutMs(): number {
    const raw = typeof this.opts.callTimeoutMs === 'function' ? this.opts.callTimeoutMs() : this.opts.callTimeoutMs
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 50) {
      return Math.round(raw)
    }
    return DEFAULT_MCP_CALL_TIMEOUT_MS
  }

  async start(): Promise<string> {
    if (this.url) return this.url
    const server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const addr = server.address() as AddressInfo
    this.server = server
    this.url = `http://127.0.0.1:${addr.port}/mcp`
    this.opts.log?.(`reverse MCP bridge listening on ${this.url}`)
    return this.url
  }

  getMcpServerSpec(): AcpStdioMcpServerSpec | null {
    if (!this.url) return null
    this.activeTransport = 'stdio'
    const stdioTimeoutMs = this.resolveCallTimeoutMs() + 5_000
    return {
      name: this.serverName,
      command: process.execPath,
      args: [this.bridgeScriptPath],
      env: [
        { name: 'DSH_MCP_BRIDGE_URL', value: this.url },
        { name: 'DSH_MCP_BRIDGE_TOKEN', value: this.token },
        { name: 'DSH_MCP_BRIDGE_TIMEOUT_MS', value: String(stdioTimeoutMs) },
      ],
    }
  }

  /** Native ACP HTTP MCP server spec (skips spawning per-session stdio `bridge.mjs` child). */
  getHttpMcpServerSpec(): AcpHttpMcpServerSpec | null {
    if (!this.url) return null
    this.activeTransport = 'http'
    return {
      type: 'http',
      name: this.serverName,
      url: this.url,
      headers: [
        { name: 'Authorization', value: `Bearer ${this.token}` },
      ],
    }
  }

  /** Chooses direct HTTP when negotiated via `mcpCapabilities.http`, otherwise falls back to stdio bridge. */
  getPreferredMcpServerSpec(preferHttp: boolean): AcpMcpServerSpec | null {
    return preferHttp ? this.getHttpMcpServerSpec() : this.getMcpServerSpec()
  }

  async dispose(): Promise<void> {
    for (const ac of this.activeCallControllers) {
      ac.abort(new Error('Reverse MCP bridge disposed'))
    }
    this.activeCallControllers.clear()
    const srv = this.server
    this.server = null
    this.url = null
    if (!srv) return
    srv.closeAllConnections?.()
    await new Promise<void>((resolve) => {
      srv.close(() => resolve())
    })
  }

  private verifyAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) return false
    const provided = Buffer.from(auth.slice(7), 'utf8')
    const expected = Buffer.from(this.token, 'utf8')
    if (provided.length !== expected.length) return false
    return timingSafeEqual(provided, expected)
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== '/mcp') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    if (!this.verifyAuth(req)) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    // This endpoint is stateless at the MCP layer: ACP owns the bridge lifetime and token.
    if (req.headers.origin && req.headers.origin !== (this.url && new URL(this.url).origin)) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end('Method Not Allowed')
      return
    }

    let body: Record<string, unknown>
    try {
      const parsed = await readJsonBody(req)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid JSON-RPC payload')
      }
      body = parsed as Record<string, unknown>
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err instanceof Error ? err.message : 'Parse error' },
        }),
      )
      return
    }

    const id = body.id
    const method = typeof body.method === 'string' ? body.method : ''
    const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>

    // Notification (no id)
    if (id === undefined || id === null) {
      res.writeHead(202)
      res.end()
      return
    }

    const ac = new AbortController()
    res.once('close', () => {
      if (!res.writableEnded) ac.abort()
    })

    try {
      const result = await this.dispatchRpc(method, params, ac.signal)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch (err) {
      const code = (err as { code?: number }).code ?? -32603
      const message = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 240) || 'Internal error'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
    }
  }

  private async dispatchRpc(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (method === 'initialize') {
      return {
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(String(params.protocolVersion))
          ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: this.serverName, version: '0.6.0' },
      }
    }

    if (method === 'ping') {
      return {}
    }

    if (method === 'tools/list') {
      const { eager, lazy } = await this.partitionHostTools()
      const exposed = lazy.length > 0 ? [...eager, ...META_GATEWAY_TOOLS] : eager
      const budgeted = compactToolsForAgyBudget(exposed, this.maxEstimatedSchemaBytes)
      if (budgeted.compacted) {
        this.opts.log?.(
          `[warn] compacted reverse MCP schemas for ${budgeted.tools.length} tools (${budgeted.originalEstimatedBytes} -> ${budgeted.finalEstimatedBytes} est. bytes); consider moving low-frequency groups to lazy`,
        )
      }
      return { tools: budgeted.tools }
    }

    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!name) {
        throw Object.assign(new Error('Missing tool name'), { code: -32602 })
      }
      const rawArgs =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}

      if (this.effectivePolicy && name === DSH_DISCOVER_TOOLS_NAME) {
        return await this.handleDiscoverTools(rawArgs)
      }

      if (this.effectivePolicy && name === DSH_CALL_TOOL_NAME) {
        const targetName = typeof rawArgs.name === 'string' ? rawArgs.name.trim() : ''
        if (!targetName) {
          return {
            content: [{ type: 'text', text: 'Error: dsh_call_tool requires a non-empty string "name".' }],
            isError: true,
          }
        }
        if (targetName === DSH_CALL_TOOL_NAME || targetName === DSH_DISCOVER_TOOLS_NAME) {
          return {
            content: [{ type: 'text', text: `Error: Cannot invoke meta-gateway tool "${targetName}" recursively.` }],
            isError: true,
          }
        }
        const nestedArgs = rawArgs.arguments
        if (nestedArgs !== undefined && (typeof nestedArgs !== 'object' || nestedArgs === null || Array.isArray(nestedArgs))) {
          return {
            content: [{ type: 'text', text: 'Error: dsh_call_tool "arguments" must be a JSON object.' }],
            isError: true,
          }
        }
        return await this.invokeHostTool(targetName, (nestedArgs as Record<string, unknown> | undefined) ?? {}, signal)
      }

      return await this.invokeHostTool(name, rawArgs, signal)
    }

    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }

  private async partitionHostTools(): Promise<{
    eager: NormalizedBridgeTool[]
    lazy: NormalizedBridgeTool[]
    off: NormalizedBridgeTool[]
  }> {
    const all = await this.opts.listTools()
    const normalized = all
      .filter((t) => !this.blocked.has(t.name) && t.name !== DSH_DISCOVER_TOOLS_NAME && t.name !== DSH_CALL_TOOL_NAME)
      .map(normalizeBridgeTool)

    if (!this.effectivePolicy) {
      return { eager: normalized, lazy: [], off: [] }
    }

    const eager: NormalizedBridgeTool[] = []
    const lazy: NormalizedBridgeTool[] = []
    const off: NormalizedBridgeTool[] = []
    for (const tool of normalized) {
      const { mode } = resolveToolExposure(tool.name, this.effectivePolicy)
      if (mode === 'eager') eager.push(tool)
      else if (mode === 'lazy') lazy.push(tool)
      else off.push(tool)
    }
    return { eager, lazy, off }
  }

  private async handleDiscoverTools(args: Record<string, unknown>): Promise<BridgeToolResult> {
    const { eager, lazy } = await this.partitionHostTools()
    const lazyByName = new Map(lazy.map((t) => [t.name, t]))
    const eagerByName = new Map(eager.map((t) => [t.name, t]))

    const rawNames = Array.isArray(args.names)
      ? args.names.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      : []

    if (rawNames.length > 0) {
      const found: Array<Record<string, unknown>> = []
      const notFound: string[] = []
      for (const reqName of rawNames.slice(0, 12)) {
        const lazyTool = lazyByName.get(reqName)
        if (lazyTool) {
          found.push({
            name: lazyTool.name,
            group: classifyDshTool(lazyTool.name).label,
            mode: 'on-demand',
            invokeVia: `mcp_dsh-tools_${DSH_CALL_TOOL_NAME}`,
            description: lazyTool.description,
            inputSchema: lazyTool.inputSchema,
          })
          continue
        }
        const eagerTool = eagerByName.get(reqName)
        if (eagerTool) {
          found.push({
            name: eagerTool.name,
            group: classifyDshTool(eagerTool.name).label,
            mode: 'eager',
            invokeVia: `mcp_dsh-tools_${eagerTool.name}`,
            description: eagerTool.description,
            inputSchema: eagerTool.inputSchema,
          })
          continue
        }
        notFound.push(reqName)
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ tools: found, ...(notFound.length ? { notFound } : {}) }, null, 2) }],
        isError: false,
      }
    }

    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const tokens = query ? query.split(/\s+/).filter(Boolean) : []
    const includeSchemas = args.includeSchemas === true

    const matched = lazy.filter((tool) => {
      if (tokens.length === 0) return true
      const group = classifyDshTool(tool.name)
      const haystack = `${tool.name} ${tool.description} ${group.id} ${group.label}`.toLowerCase()
      return tokens.every((tok) => haystack.includes(tok))
    })

    const attachFullSchemas = matched.length <= 5 || includeSchemas
    const capped = attachFullSchemas ? matched.slice(0, 10) : matched
    const payload = {
      totalOnDemand: lazy.length,
      matched: matched.length,
      invokeVia: `mcp_dsh-tools_${DSH_CALL_TOOL_NAME}`,
      tools: capped.map((tool) => {
        const group = classifyDshTool(tool.name)
        return attachFullSchemas
          ? {
              name: tool.name,
              group: group.label,
              description: tool.description,
              inputSchema: tool.inputSchema,
            }
          : {
              name: tool.name,
              group: group.label,
              summary: firstLineSummary(tool.description, 120),
            }
      }),
      ...(!attachFullSchemas
        ? { hint: `Pass names: [...] to mcp_dsh-tools_${DSH_DISCOVER_TOOLS_NAME} to fetch full schemas before calling.` }
        : matched.length > capped.length
          ? { truncated: true, hint: 'Narrow your query or pass specific tool names to inspect remaining schemas.' }
          : {}),
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: false,
    }
  }

  private async invokeHostTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<BridgeToolResult> {
    if (this.blocked.has(name)) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" is blocked by reverse MCP bridge to prevent recursion.` }],
        isError: true,
      }
    }
    if (this.effectivePolicy) {
      const { mode } = resolveToolExposure(name, this.effectivePolicy)
      if (mode === 'off') {
        return {
          content: [{ type: 'text', text: `Tool "${name}" is disabled by the user's reverse MCP tool policy.` }],
          isError: true,
        }
      }
    }
    if (this.inFlightCalls >= this.maxConcurrentCalls) {
      this.totalCalls++
      this.failedCalls++
      this.lastToolName = name
      this.lastCallAt = Date.now()
      this.lastError = sanitizeDiagnosticText(
        `工具 "${name}" 被拒绝：反向 MCP 并发调用已达上限（${this.maxConcurrentCalls}）`,
        160,
      )
      this.opts.onActivity?.()
      throw Object.assign(
        new Error(`Reverse MCP bridge concurrency limit (${this.maxConcurrentCalls}) exceeded`),
        { code: -32005 },
      )
    }

    const timeoutMs = this.resolveCallTimeoutMs()
    const callAc = new AbortController()
    this.activeCallControllers.add(callAc)
    const combinedSignal = AbortSignal.any([signal, callAc.signal])

    this.inFlightCalls++
    this.totalCalls++
    this.lastToolName = name
    this.lastCallAt = Date.now()
    this.opts.onActivity?.()

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.opts.callTool(name, args, combinedSignal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const timeoutErr = Object.assign(
              new Error(`Reverse MCP tool "${name}" timed out after ${timeoutMs}ms`),
              { code: -32001 },
            )
            callAc.abort(timeoutErr)
            reject(timeoutErr)
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
      if (result.isError) {
        this.failedCalls++
        const text = result.content.map(c => c.text).join(' ')
        this.lastError = sanitizeDiagnosticText(`工具 "${name}" 返回错误：${text}`, 160)
      } else {
        this.lastError = null
      }
      return result
    } catch (err) {
      this.failedCalls++
      const code = (err as { code?: number }).code ?? -32603
      const rawMsg = err instanceof Error ? err.message : String(err)
      const safeMsg = sanitizeDiagnosticText(rawMsg, 180) || '反向 MCP 工具调用失败'
      this.lastError =
        code === -32001
          ? sanitizeDiagnosticText(`工具 "${name}" 调用超时（>${timeoutMs}ms）`, 160)
          : sanitizeDiagnosticText(`工具 "${name}" 调用异常：${safeMsg}`, 160)
      throw Object.assign(new Error(safeMsg), { code })
    } finally {
      if (timer) clearTimeout(timer)
      this.activeCallControllers.delete(callAc)
      this.inFlightCalls = Math.max(0, this.inFlightCalls - 1)
      this.opts.onActivity?.()
    }
  }
}
