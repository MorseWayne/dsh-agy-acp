import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpMcpServerSpec } from '../acp/protocol.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../common/types.ts'

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000
export const DEFAULT_MCP_MAX_CONCURRENT_CALLS = 8

export interface BridgeToolSchema {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface BridgeToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface McpBridgeStats {
  inFlightCalls: number
  totalCalls: number
  failedCalls: number
  lastToolName: string | null
  lastCallAt: number | null
  lastError: string | null
}

export interface ReverseMcpBridgeOptions {
  listTools: () => BridgeToolSchema[] | Promise<BridgeToolSchema[]>
  callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<BridgeToolResult>
  blockedTools?: readonly string[]
  serverName?: string
  bridgeScriptPath?: string
  /** Per-tool-call execution timeout in ms (default: 60_000). */
  callTimeoutMs?: number | (() => number)
  /** Maximum concurrent in-flight tool calls on this session bridge (default: 8). */
  maxConcurrentCalls?: number
  /** Optional callback fired when call metrics or errors change. */
  onActivity?: () => void
  log?: (msg: string) => void
}

const DEFAULT_BLOCKED_TOOLS = new Set<string>([MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME])

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
  private readonly serverName: string
  private readonly bridgeScriptPath: string
  private readonly maxConcurrentCalls: number
  private readonly activeCallControllers = new Set<AbortController>()
  private url: string | null = null
  private inFlightCalls = 0
  private totalCalls = 0
  private failedCalls = 0
  private lastToolName: string | null = null
  private lastCallAt: number | null = null
  private lastError: string | null = null

  constructor(private readonly opts: ReverseMcpBridgeOptions) {
    this.token = randomBytes(32).toString('hex')
    this.blocked = new Set([...DEFAULT_BLOCKED_TOOLS, ...(opts.blockedTools ?? [])])
    this.serverName = opts.serverName ?? 'dsh-tools'
    this.bridgeScriptPath = opts.bridgeScriptPath ?? resolveDefaultBridgeScriptPath()
    this.maxConcurrentCalls = Math.max(1, opts.maxConcurrentCalls ?? DEFAULT_MCP_MAX_CONCURRENT_CALLS)
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

  getMcpServerSpec(): AcpMcpServerSpec | null {
    if (!this.url) return null
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
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    if (!this.verifyAuth(req)) {
      res.writeHead(401)
      res.end('Unauthorized')
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
      res.writeHead(204)
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
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: this.serverName, version: '0.4.1' },
      }
    }

    if (method === 'ping') {
      return {}
    }

    if (method === 'tools/list') {
      const all = await this.opts.listTools()
      const filtered = all
        .filter((t) => !this.blocked.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }))
      return { tools: filtered }
    }

    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!name) {
        throw Object.assign(new Error('Missing tool name'), { code: -32602 })
      }
      if (this.blocked.has(name)) {
        return {
          content: [{ type: 'text', text: `Tool "${name}" is blocked by reverse MCP bridge to prevent recursion.` }],
          isError: true,
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

      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}

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

    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}
