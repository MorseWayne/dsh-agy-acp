import { fakeHost } from './fixtures/session-policy.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { resolveConfig } from '../src/common/config.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../src/common/types.ts'
import { ReverseMcpBridge } from '../src/mcp/server.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { registerAcpRoutes, type WebServerLike } from '../src/transport/sse.ts'

test('ReverseMcpBridge + stdio bridge.mjs enforces auth, filters recursive tools, and executes tools', async () => {
  const bridge = new ReverseMcpBridge({
    listTools: () => [
      { name: 'echo_tool', description: 'Echo input', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
      { name: MIRROR_TOOL_NAME, description: 'Mirror tool' },
      { name: WRAPPER_TOOL_NAME, description: 'Code mode wrapper' },
    ],
    callTool: async (name, args) => ({
      content: [{ type: 'text', text: `${name}:${String(args.msg ?? '')}` }],
      isError: false,
    }),
  })

  const url = await bridge.start()
  const spec = bridge.getMcpServerSpec()
  assert.ok(spec)

  // 1. Direct HTTP without Bearer token must be rejected
  const unauthRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  assert.equal(unauthRes.status, 401)

  // 2. Spawn real zero-dependency stdio bridge.mjs and send MCP JSON-RPC frames
  const env = { ...process.env }
  for (const item of spec.env ?? []) {
    env[item.name] = item.value
  }
  const child = spawn(spec.command, spec.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const replies = new Map<number, (msg: Record<string, unknown>) => void>()

  rl.on('line', (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>
    if (typeof msg.id === 'number' && replies.has(msg.id)) {
      const resolve = replies.get(msg.id)!
      replies.delete(msg.id)
      resolve(msg)
    }
  })

  const rpc = (id: number, method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      replies.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' })
    assert.ok((init.result as { capabilities?: { tools?: unknown } }).capabilities?.tools)

    const list = await rpc(2, 'tools/list')
    const toolNames = ((list.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name)
    assert.deepEqual(toolNames, ['echo_tool'])

    const callOk = await rpc(3, 'tools/call', { name: 'echo_tool', arguments: { msg: 'ping' } })
    const okRes = callOk.result as { content: Array<{ text: string }>; isError?: boolean }
    assert.equal(okRes.isError, false)
    assert.equal(okRes.content[0]?.text, 'echo_tool:ping')

    const callBlocked = await rpc(4, 'tools/call', { name: MIRROR_TOOL_NAME, arguments: {} })
    const blockedRes = callBlocked.result as { isError?: boolean }
    assert.equal(blockedRes.isError, true)
  } finally {
    rl.close()
    child.kill()
    await bridge.dispose()
  }
})

test('HTTP configuration cannot override a DSH session permission or approve ACP requests', async () => {
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => resolveConfig({}), resolveBin: () => null })
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const webServer: WebServerLike = {
    route(method, routePath, handler) {
      routes.set(`${method} ${routePath}`, handler)
      return () => routes.delete(`${method} ${routePath}`)
    },
  }

  const disposeRoutes = registerAcpRoutes(webServer, pool)
  const server = createServer((req, res) => {
    const key = `${req.method ?? 'GET'} ${req.url ?? '/'}`
    const handler = routes.get(key)
    if (!handler) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    void handler(req, res)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    const status = await (await fetch(`${baseUrl}/plugins/agy-acp/status`)).json()
    assert.equal('permissionMode' in status, false)
    for (const [path, expected] of [['config', 400], ['mode', 404], ['permissions/decide', 404]] as const) {
      const res = await fetch(`${baseUrl}/plugins/agy-acp/${path}`, { method: 'POST', body: JSON.stringify({ permissionMode: 'skip' }) })
      assert.equal(res.status, expected)
    }
    // 4. Reset sessions endpoint
    const resetRes = await fetch(`${baseUrl}/plugins/agy-acp/sessions/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(resetRes.status, 200)
  } finally {
    disposeRoutes()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    pool.dispose()
  }
})
