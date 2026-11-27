import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import { resolveConfig } from '../src/common/config.ts'
import { PROVIDER_ID, type StatusSnapshot } from '../src/common/types.ts'
import type { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { registerAcpRoutes, type ConnectionLike, type ExactRouteSpec } from '../src/transport/sse.ts'

function createFakePool() {
  let mutations = 0
  const emitter = new EventEmitter()
  const cfg = resolveConfig({ enabled: true })
  const pool = Object.assign(emitter, {
    getStatus(): StatusSnapshot {
      return {
        providerId: PROVIDER_ID,
        enabled: cfg.enabled,
        connected: false,
        agentName: null,
        agentVersion: null,
        tierName: null,
        activeSessions: 0,
        sessions: [],
        mcpBridgeActive: false,
        usageTotals: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, reasoningTokens: 0 },
        accounts: [],
        models: [],
        reviewProviders: [{ id: PROVIDER_ID, name: 'Antigravity (ACP)' }],
        config: {
          agyBin: cfg.agyBin,
          workspaceRoot: cfg.workspaceRoot,
          defaultModel: cfg.defaultModel,
          defaultEffort: cfg.defaultEffort,
          autoReviewProvider: cfg.autoReviewProvider,
          autoReviewModel: cfg.autoReviewModel,
          autoReviewEffort: cfg.autoReviewEffort,
          mcpBridge: cfg.mcpBridge,
          sessionIdleTtlMs: cfg.sessionIdleTtlMs,
          requestTimeoutMs: cfg.requestTimeoutMs,
          geoFenceMode: cfg.geoFenceMode,
        },
        lastError: null,
        updatedAt: 1,
      }
    },
    async updateConfig() { mutations++ },
    async resetConfig() { mutations++ },
    async forceRefreshModels() { mutations++ },
    async closeSession() { mutations++ },
    async resetAllSessions() { mutations++; return 0 },
    async refreshAccountQuota() { mutations++ },
    async checkAccountEgress() { mutations++ },
    clearAccountCooldown() { mutations++ },
  }) as unknown as AcpSessionPool
  return { pool, getMutations: () => mutations }
}

async function dispatchRoute(
  routes: Map<string, ExactRouteSpec['handler']>,
  method: string,
  url: string,
  headers: IncomingMessage['headers'] = {},
  body?: string,
) {
  const pathname = new URL(url, 'http://127.0.0.1').pathname
  const handler = routes.get(pathname)
  assert.ok(handler, `missing route ${pathname}`)

  const req = new EventEmitter() as IncomingMessage
  req.method = method
  req.url = url
  req.headers = headers

  let statusCode = 200
  let resHeaders: Record<string, string> = {}
  let payload = ''
  const res = {
    writeHead(code: number, h?: Record<string, string>) {
      statusCode = code
      if (h) resHeaders = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]))
      return this
    },
    write(chunk: string) {
      payload += chunk
      return true
    },
    end(chunk?: string) {
      if (chunk) payload += chunk
      return this
    },
  } as unknown as ServerResponse

  const pending = Promise.resolve(handler(req, res))
  if (body !== undefined) {
    req.emit('data', Buffer.from(body, 'utf8'))
  }
  req.emit('end')
  await pending
  return { statusCode, headers: resHeaders, payload }
}

test('registerAcpRoutes enforces DSH connection.requestRejection (401/403) on every GET, SSE, and POST route', async () => {
  const routes = new Map<string, ExactRouteSpec['handler']>()
  const webServer = {
    register(route: ExactRouteSpec) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  let verdict: 401 | 403 | undefined = 403
  const seenHeaders: Array<IncomingMessage['headers']> = []
  const connection: ConnectionLike = {
    requestRejection(req) {
      seenHeaders.push(req.headers)
      return verdict
    },
  }

  const { pool, getMutations } = createFakePool()
  const dispose = registerAcpRoutes(webServer, pool, { connection })

  const allRoutes: Array<[string, string, string?]> = [
    ['GET', '/plugins/agy-acp/status'],
    ['GET', '/plugins/agy-acp/review-models?provider=antigravity-acp'],
    ['GET', '/plugins/agy-acp/events'],
    ['POST', '/plugins/agy-acp/config', '{"mcpBridge":true}'],
    ['POST', '/plugins/agy-acp/config/reset', '{}'],
    ['POST', '/plugins/agy-acp/models/refresh', '{}'],
    ['POST', '/plugins/agy-acp/sessions/reset', '{}'],
    ['POST', '/plugins/agy-acp/accounts/quota/refresh', '{"accountId":"a1"}'],
    ['POST', '/plugins/agy-acp/accounts/egress/check', '{}'],
    ['POST', '/plugins/agy-acp/accounts/cooldown/clear', '{}'],
  ]

  try {
    // 1. Cross-origin / untrusted Host rejected with 403 before touching pool or SSE listeners
    verdict = 403
    for (const [method, url, body] of allRoutes) {
      const res = await dispatchRoute(
        routes,
        method,
        url,
        {
          origin: 'https://evil.example',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
      )
      assert.equal(res.statusCode, 403, `${method} ${url}`)
      assert.equal(res.headers['cache-control'], 'no-store')
    }
    assert.equal(getMutations(), 0)
    assert.equal(pool.listenerCount('status'), 0)

    // 2. Unauthenticated browser request rejected with 401
    verdict = 401
    for (const [method, url, body] of allRoutes) {
      const res = await dispatchRoute(
        routes,
        method,
        url,
        body !== undefined ? { 'content-type': 'application/json' } : {},
        body,
      )
      assert.equal(res.statusCode, 401, `${method} ${url}`)
    }
    assert.equal(getMutations(), 0)
    assert.equal(pool.listenerCount('status'), 0)
    assert.equal(seenHeaders.length, allRoutes.length * 2)

    // 3. Trusted & authenticated request succeeds with Cache-Control: no-store
    verdict = undefined
    const statusOk = await dispatchRoute(routes, 'GET', '/plugins/agy-acp/status', { host: '127.0.0.1:3000' })
    assert.equal(statusOk.statusCode, 200)
    assert.equal(statusOk.headers['cache-control'], 'no-store')

    // 4. Every POST route requires application/json Content-Type (415 otherwise)
    for (const [method, url, body] of allRoutes.filter(([m]) => m === 'POST')) {
      const res = await dispatchRoute(routes, method, url, { 'content-type': 'text/plain' }, body)
      assert.equal(res.statusCode, 415, `${method} ${url} should reject non-JSON`)
    }
    assert.equal(getMutations(), 0)
  } finally {
    dispose()
  }
})
