import { fakeHost } from './fixtures/session-policy.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { AcpClient, AcpProcessExitError, AcpTimeoutError } from '../src/acp/client.ts'
import { resolveConfig } from '../src/common/config.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../src/common/types.ts'
import { ReverseMcpBridge } from '../src/mcp/server.ts'
import { EgressGuard } from '../src/runtime/egress-guard.ts'
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
    // Manual quota reads have no implicit 'default' account and require a JSON POST.
    for (const [accountId, expected] of [[undefined, 400], ['missing', 404], ['default', 503]] as const) {
      const reply = await fetch(`${baseUrl}/plugins/agy-acp/accounts/quota/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }),
      })
      assert.equal(reply.status, expected)
      assert.equal(typeof (await reply.json()).error, 'string')
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

test('HTTP config save/reset and models/refresh validate input, isolate disk failures, and protect against CSRF', async () => {
  const baseCfg = resolveConfig({ defaultModel: 'base-model', sessionIdleTtlMs: 1_800_000 })
  let cfg = { ...baseCfg }
  let persisted = false
  let failSave = false
  let failProbe = false

  const pool = new AcpSessionPool({
    ...fakeHost,
    getConfig: () => cfg,
    resolveBin: () => process.execPath,
    prepareArgv: async () => {
      if (failProbe) throw new Error('probe down')
      return [process.execPath, new URL('./fixtures/fake-agy.mjs', import.meta.url).pathname]
    },
    hasPersistedConfig: () => persisted,
    onConfigPatch: (patch) => {
      if (failSave) throw new Error('EACCES /secret/path/config.json')
      cfg = { ...cfg, ...patch }
      persisted = true
    },
    onConfigReset: () => {
      cfg = { ...baseCfg }
      persisted = false
    },
  })

  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const webServer: WebServerLike = {
    route(method, routePath, handler) {
      routes.set(`${method} ${routePath}`, handler)
      return () => routes.delete(`${method} ${routePath}`)
    },
  }
  const disposeRoutes = registerAcpRoutes(webServer, pool)
  const server = createServer((req, res) => {
    const handler = routes.get(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
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
    // Rejects array body, host-only keys, unknown keys, and out-of-range timeouts with 400
    for (const rawBody of ['[]', '{"accounts":[]}', '{"unknown":1}', '{"requestTimeoutMs":500}', '{}']) {
      const r = await fetch(`${baseUrl}/plugins/agy-acp/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      })
      assert.equal(r.status, 400, rawBody)
    }

    // Disk failure returns 500 without leaking path and does NOT poison subsequent saves
    failSave = true
    const errRes = await fetch(`${baseUrl}/plugins/agy-acp/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpBridge: true }),
    })
    assert.equal(errRes.status, 500)
    const errJson = await errRes.json() as { error: string }
    assert.equal(errJson.error.includes('/secret/path'), false)
    assert.equal(cfg.mcpBridge, false)

    failSave = false
    const okRes = await fetch(`${baseUrl}/plugins/agy-acp/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpBridge: true, defaultModel: 'gemini-4-neon', sessionIdleTtlMs: 300_000 }),
    })
    assert.equal(okRes.status, 200)
    const okJson = await okRes.json() as { persisted: boolean; status: { hasPersistedConfig: boolean; config: { defaultModel: string } } }
    assert.equal(okJson.persisted, true)
    assert.equal(okJson.status.hasPersistedConfig, true)
    assert.equal(okJson.status.config.defaultModel, 'gemini-4-neon')

    // CSRF protection: reset & models/refresh require application/json
    assert.equal((await fetch(`${baseUrl}/plugins/agy-acp/config/reset`, { method: 'POST', body: '{}' })).status, 415)
    assert.equal((await fetch(`${baseUrl}/plugins/agy-acp/models/refresh`, { method: 'POST', body: '{}' })).status, 415)

    // Config reset restores baseCfg
    const resetCfgRes = await fetch(`${baseUrl}/plugins/agy-acp/config/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(resetCfgRes.status, 200)
    const resetCfgJson = await resetCfgRes.json() as { status: { hasPersistedConfig: boolean; config: { defaultModel: string } } }
    assert.equal(resetCfgJson.status.hasPersistedConfig, false)
    assert.equal(resetCfgJson.status.config.defaultModel, 'base-model')

    // models/refresh succeeds with 200, then returns 502 on failure while keeping cached models
    const refreshOk = await fetch(`${baseUrl}/plugins/agy-acp/models/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(refreshOk.status, 200)
    const refreshOkJson = await refreshOk.json() as { status: { models: unknown[] } }
    assert.ok(refreshOkJson.status.models.length > 0)

    failProbe = true
    const refreshFail = await fetch(`${baseUrl}/plugins/agy-acp/models/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(refreshFail.status, 502)
    const refreshFailJson = await refreshFail.json() as { error: string; status: { models: unknown[]; lastError: string | null } }
    assert.match(refreshFailJson.error, /probe down/)
    assert.ok(refreshFailJson.status.models.length > 0)
    assert.ok(refreshFailJson.status.lastError)
  } finally {
    disposeRoutes()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    pool.dispose()
  }
})

test('HTTP accounts/egress/check enforces JSON Content-Type, validates accountId, rechecks single/all accounts, and pushes SSE', async () => {
  let probeCountry = 'HK'
  let probeCount = 0
  let cfg = resolveConfig({ geoFenceMode: 'block' })
  const sseEvents: unknown[] = []

  const pool = new AcpSessionPool({
    ...fakeHost,
    egressGuard: new EgressGuard({
      probeFn: async () => {
        probeCount++
        return {
          status: probeCountry === 'HK' ? 'unsupported' : 'supported',
          country: probeCountry,
          ipMasked: '203.0.113.*',
          proxyMode: 'proxy',
          probeSource: 'test-probe',
        }
      },
    }),
    getConfig: () => cfg,
    resolveBin: () => null,
    onConfigPatch: (patch) => {
      cfg = { ...cfg, ...patch }
    },
  })
  pool.on('status', (s) => sseEvents.push(s))

  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const webServer: WebServerLike = {
    route(method, routePath, handler) {
      routes.set(`${method} ${routePath}`, handler)
      return () => routes.delete(`${method} ${routePath}`)
    },
  }
  const disposeRoutes = registerAcpRoutes(webServer, pool)
  const server = createServer((req, res) => {
    const handler = routes.get(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
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
    // 1. Missing Content-Type -> 415
    assert.equal(
      (await fetch(`${baseUrl}/plugins/agy-acp/accounts/egress/check`, { method: 'POST', body: '{}' })).status,
      415,
    )

    // 2. Unknown accountId -> 404; empty string accountId -> 400
    assert.equal(
      (await fetch(`${baseUrl}/plugins/agy-acp/accounts/egress/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'non-existent' }),
      })).status,
      404,
    )
    assert.equal(
      (await fetch(`${baseUrl}/plugins/agy-acp/accounts/egress/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: '   ' }),
      })).status,
      400,
    )

    // 3. Single account check returns 200 even when egress is HK (status reflected in accounts[].egress)
    const hkCheck = await fetch(`${baseUrl}/plugins/agy-acp/accounts/egress/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'default' }),
    })
    assert.equal(hkCheck.status, 200)
    const hkJson = await hkCheck.json() as { ok: boolean; status: { accounts: Array<{ egress?: { status: string; country: string } }> } }
    assert.equal(hkJson.ok, true)
    assert.equal(hkJson.status.accounts[0]?.egress?.status, 'unsupported')
    assert.equal(hkJson.status.accounts[0]?.egress?.country, 'HK')
    assert.equal(probeCount, 1)

    // 4. All-accounts force check bypasses cache and updates to US + emits SSE status
    probeCountry = 'US'
    const eventsBefore = sseEvents.length
    const allCheck = await fetch(`${baseUrl}/plugins/agy-acp/accounts/egress/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(allCheck.status, 200)
    const allJson = await allCheck.json() as { status: { accounts: Array<{ egress?: { status: string; country: string } }> } }
    assert.equal(allJson.status.accounts[0]?.egress?.status, 'supported')
    assert.equal(allJson.status.accounts[0]?.egress?.country, 'US')
    assert.equal(probeCount, 2)
    assert.ok(sseEvents.length > eventsBefore)

    // 5. Persisting geoFenceMode via POST /plugins/agy-acp/config
    const badGeo = await fetch(`${baseUrl}/plugins/agy-acp/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geoFenceMode: 'bad' }),
    })
    assert.equal(badGeo.status, 400)

    const okGeo = await fetch(`${baseUrl}/plugins/agy-acp/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geoFenceMode: 'strict' }),
    })
    assert.equal(okGeo.status, 200)
    const okGeoJson = await okGeo.json() as { status: { config: { geoFenceMode: string } } }
    assert.equal(okGeoJson.status.config.geoFenceMode, 'strict')
  } finally {
    disposeRoutes()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    pool.dispose()
  }
})

test('ReverseMcpBridge enforces per-call timeout with AbortSignal, caps concurrency, and records sanitized stats', async () => {
  let slowAborted = false
  let releaseHold!: () => void
  const holdPromise = new Promise<void>((resolve) => {
    releaseHold = resolve
  })

  const bridge = new ReverseMcpBridge({
    callTimeoutMs: 60,
    maxConcurrentCalls: 2,
    listTools: () => [
      { name: 'slow_tool' },
      { name: 'hold_tool' },
      { name: 'secret_err_tool' },
    ],
    callTool: async (name, _args, signal) => {
      if (name === 'slow_tool') {
        signal.addEventListener('abort', () => {
          slowAborted = true
        }, { once: true })
        // Intentionally never resolve to prove Promise.race timeout frees the slot
        return await new Promise(() => {})
      }
      if (name === 'hold_tool') {
        await holdPromise
        return { content: [{ type: 'text', text: 'held ok' }] }
      }
      throw new Error('upstream failed Authorization: Bearer secret_mcp_tok_999')
    },
  })

  const url = await bridge.start()
  const spec = bridge.getMcpServerSpec()!
  const token = spec.env?.find((e) => e.name === 'DSH_MCP_BRIDGE_TOKEN')?.value ?? ''

  const callRpc = async (id: number, name: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: {} },
      }),
    })
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
  }

  try {
    // 1. Slow tool times out with code -32001, aborts signal, and releases inFlightCalls slot
    const timedOut = await callRpc(1, 'slow_tool')
    assert.equal(timedOut.error?.code, -32001)
    assert.equal(slowAborted, true)
    assert.equal(bridge.getStats().inFlightCalls, 0)
    assert.equal(bridge.getStats().failedCalls, 1)
    assert.match(bridge.getStats().lastError ?? '', /超时/)

    // 2. Concurrency limit (maxConcurrentCalls = 2): 3rd concurrent call rejects immediately with -32005
    const p1 = callRpc(2, 'hold_tool')
    const p2 = callRpc(3, 'hold_tool')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(bridge.getStats().inFlightCalls, 2)

    const p3 = await callRpc(4, 'hold_tool')
    assert.equal(p3.error?.code, -32005)
    releaseHold()
    const [r1, r2] = await Promise.all([p1, p2])
    assert.ok(r1.result && r2.result)
    assert.equal(bridge.getStats().inFlightCalls, 0)

    // 3. Tool exception redacts credentials from JSON-RPC error and lastError
    const secretErr = await callRpc(5, 'secret_err_tool')
    assert.equal(secretErr.error?.message.includes('secret_mcp_tok_999'), false)
    assert.equal(bridge.getStats().lastError?.includes('secret_mcp_tok_999'), false)
    assert.equal(bridge.getStats().totalCalls, 5)
  } finally {
    releaseHold()
    await bridge.dispose()
  }
})

test('ReverseMcpBridge stdio bridge.mjs bypasses dead HTTP_PROXY / NODE_USE_ENV_PROXY for loopback calls', async () => {
  const bridge = new ReverseMcpBridge({
    listTools: () => [{ name: 'ping_tool', description: 'Loopback check' }],
    callTool: async (name) => ({
      content: [{ type: 'text', text: `direct:${name}` }],
      isError: false,
    }),
  })

  await bridge.start()
  const spec = bridge.getMcpServerSpec()!
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    http_proxy: 'http://127.0.0.1:1',
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: '',
    no_proxy: '',
  }
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
    const res = await rpc(1, 'tools/call', { name: 'ping_tool', arguments: {} })
    const out = res.result as { content?: Array<{ text: string }>; isError?: boolean }
    assert.equal(out?.isError, false)
    assert.equal(out?.content?.[0]?.text, 'direct:ping_tool')
  } finally {
    rl.close()
    child.kill()
    await bridge.dispose()
  }
})

test('AcpClient slices stderr per-turn so prior-turn noise never leaks into subsequent timeout or crash diagnostics', async () => {
  const fakeBin = new URL('./fixtures/fake-agy.mjs', import.meta.url).pathname
  const client = new AcpClient({
    bin: process.execPath,
    args: [fakeBin],
    defaultTimeoutMs: 5_000,
  })
  client.start()
  try {
    await client.initialize()
    const sess = await client.sessionNew({ cwd: process.cwd(), mcpServers: [] })

    // Turn 1 emits stderr noise and succeeds cleanly on the persistent process
    const offsetBeforeT1 = client.stderrOffset()
    await client.sessionPrompt({
      sessionId: sess.sessionId,
      prompt: [{ type: 'text', text: 'STDERR_NOISE_OK' }],
    })
    // Wait a tick for stderr pipe to flush
    await new Promise((r) => setTimeout(r, 30))
    assert.match(client.readStderrSince(offsetBeforeT1), /OLD_TURN_STDERR_NOISE_MARKER/)
    const offsetAfterT1 = client.stderrOffset()
    assert.equal(client.readStderrSince(offsetAfterT1), '')

    // Turn 2 times out silently -> stderrTail must NOT contain Turn 1's noise
    await assert.rejects(
      client.sessionPrompt(
        { sessionId: sess.sessionId, prompt: [{ type: 'text', text: 'TIMEOUT_SILENT' }] },
        80,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AcpTimeoutError)
        assert.equal(err.stderrTail, '')
        assert.equal(err.message.includes('OLD_TURN_STDERR_NOISE_MARKER'), false)
        return true
      },
    )

    // Turn 3 crashes with its own stderr -> AcpProcessExitError must ONLY include Turn 3's stderr
    await assert.rejects(
      client.sessionPrompt(
        { sessionId: sess.sessionId, prompt: [{ type: 'text', text: 'CRASH_WITH_TURN_STDERR' }] },
        5_000,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AcpProcessExitError)
        assert.match(err.stderrTail, /CURRENT_TURN_CRASH_MARKER/)
        assert.equal(err.stderrTail.includes('OLD_TURN_STDERR_NOISE_MARKER'), false)
        return true
      },
    )
  } finally {
    client.dispose()
  }
})
