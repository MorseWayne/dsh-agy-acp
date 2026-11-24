import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpMcpServerSpec } from '../acp/protocol.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../common/types.ts'

export interface BridgeToolSchema {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface BridgeToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface ReverseMcpBridgeOptions {
  listTools: () => BridgeToolSchema[] | Promise<BridgeToolSchema[]>
  callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<BridgeToolResult>
  blockedTools?: readonly string[]
  serverName?: string
  bridgeScriptPath?: string
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
 * Injected per ACP session via `session/new` `mcpServers` without mutating global config.
 */
export class ReverseMcpBridge {
  private server: Server | null = null
  private readonly token: string
  private readonly blocked: Set<string>
  private readonly serverName: string
  private readonly bridgeScriptPath: string
  private url: string | null = null

  constructor(private readonly opts: ReverseMcpBridgeOptions) {
    this.token = randomBytes(32).toString('hex')
    this.blocked = new Set([...DEFAULT_BLOCKED_TOOLS, ...(opts.blockedTools ?? [])])
    this.serverName = opts.serverName ?? 'dsh-tools'
    this.bridgeScriptPath = opts.bridgeScriptPath ?? resolveDefaultBridgeScriptPath()
  }

  get isRunning(): boolean {
    return this.server !== null && this.url !== null
  }

  get endpointUrl(): string | null {
    return this.url
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
    return {
      name: this.serverName,
      command: process.execPath,
      args: [this.bridgeScriptPath],
      env: [
        { name: 'DSH_MCP_BRIDGE_URL', value: this.url },
        { name: 'DSH_MCP_BRIDGE_TOKEN', value: this.token },
      ],
    }
  }

  async dispose(): Promise<void> {
    const srv = this.server
    this.server = null
    this.url = null
    if (!srv) return
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
    req.once('close', () => ac.abort())

    try {
      const result = await this.dispatchRpc(method, params, ac.signal)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch (err) {
      const code = (err as { code?: number }).code ?? -32603
      const message = err instanceof Error ? err.message : String(err)
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
        serverInfo: { name: this.serverName, version: '0.1.0' },
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
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
      return await this.opts.callTool(name, args, signal)
    }

    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}
