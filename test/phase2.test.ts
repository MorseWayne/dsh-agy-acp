import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { resolveConfig } from '../src/common/config.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME, type PermissionMode } from '../src/common/types.ts'
import { ReverseMcpBridge } from '../src/mcp/server.ts'
import { PermissionManager } from '../src/runtime/permission-manager.ts'
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

test('PermissionManager handles interactive approvals, always-allow memory, and mode policies', async () => {
  let mode: PermissionMode = 'default'
  const pm = new PermissionManager({ getMode: () => mode, timeoutMs: 5_000 })

  const sampleReq = (kind: string, name: string) => ({
    sessionId: 'sess_1',
    toolCall: { sessionUpdate: 'tool_call_update' as const, toolCallId: 'tc_1', name, kind, status: 'pending' as const },
    options: [
      { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ],
  })

  try {
    // default mode suspends and waits for decide()
    const pendingPromise = pm.handleRequest(sampleReq('execute', 'run_command'))
    assert.equal(pm.listPending().length, 1)
    const reqId = pm.listPending()[0]!.requestId
    assert.equal(pm.decide(reqId, { optionId: 'allow_always' }), true)
    assert.deepEqual(await pendingPromise, { outcome: { outcome: 'selected', optionId: 'allow_always' } })
    assert.equal(pm.listPending().length, 0)

    // Subsequent call to same tool in same session auto-approves via remembered rule
    const remembered = await pm.handleRequest(sampleReq('execute', 'run_command'))
    assert.deepEqual(remembered, { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    // plan mode rejects execute and allows read
    mode = 'plan'
    const planDenied = await pm.handleRequest(sampleReq('execute', 'bash'))
    assert.deepEqual(planDenied, { outcome: { outcome: 'selected', optionId: 'reject_once' } })
    const planRead = await pm.handleRequest(sampleReq('read', 'read_file'))
    assert.deepEqual(planRead, { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    // accept-edits auto-allows edit but asks for execute
    mode = 'accept-edits'
    pm.clearSessionRules('sess_1')
    const autoEdit = await pm.handleRequest(sampleReq('edit', 'edit_file'))
    assert.deepEqual(autoEdit, { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    const askExec = pm.handleRequest(sampleReq('execute', 'run_command'))
    assert.equal(pm.listPending().length, 1)
    pm.decide(pm.listPending()[0]!.requestId, { cancel: true })
    assert.deepEqual(await askExec, { outcome: { outcome: 'cancelled' } })
  } finally {
    pm.dispose()
  }
})

test('HTTP control routes switch permission mode and decide pending permissions', async () => {
  let cfg = resolveConfig({ enabled: true, permissionMode: 'default' })
  const pm = new PermissionManager({ getMode: () => cfg.permissionMode, timeoutMs: 5_000 })
  const pool = new AcpSessionPool({
    getConfig: () => cfg,
    resolveBin: () => null,
    getPendingPermissions: () => pm.listPending(),
    isMcpBridgeActive: () => true,
    onPermissionModeChange: (m) => {
      cfg = { ...cfg, permissionMode: m }
    },
  })
  pm.on('change', () => pool.notifyStatusChange())

  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const webServer: WebServerLike = {
    route(method, routePath, handler) {
      routes.set(`${method} ${routePath}`, handler)
      return () => routes.delete(`${method} ${routePath}`)
    },
  }

  const disposeRoutes = registerAcpRoutes(webServer, pool, pm)
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
    // 1. Check initial status
    const s1 = (await (await fetch(`${baseUrl}/plugins/agy-acp/status`)).json()) as {
      permissionMode: string
      mcpBridgeActive: boolean
      pendingPermissions: unknown[]
    }
    assert.equal(s1.permissionMode, 'default')
    assert.equal(s1.mcpBridgeActive, true)
    assert.equal(s1.pendingPermissions.length, 0)

    // 2. Suspend a permission request and approve via HTTP API
    const permPromise = pm.handleRequest({
      sessionId: 'sess_http',
      toolCall: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_9', name: 'run_command', kind: 'execute', status: 'pending' },
      options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
    })
    const reqId = pm.listPending()[0]!.requestId

    const decideRes = await fetch(`${baseUrl}/plugins/agy-acp/permissions/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: reqId, optionId: 'allow_once' }),
    })
    assert.equal(decideRes.status, 200)
    assert.deepEqual(await permPromise, { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    // 3. Switch permission mode via HTTP API
    const modeRes = await fetch(`${baseUrl}/plugins/agy-acp/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })
    assert.equal(modeRes.status, 200)
    assert.equal(pool.getStatus().permissionMode, 'plan')

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
    pm.dispose()
    pool.dispose()
  }
})
