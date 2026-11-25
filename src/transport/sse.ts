import type { IncomingMessage, ServerResponse } from 'node:http'
import { validateConfigPatchInput } from '../common/config.ts'
import type { StatusSnapshot } from '../common/types.ts'
import { AccountQuotaError } from '../runtime/account-quota.ts'
import type { AcpSessionPool } from '../runtime/session-pool.ts'

export interface ExactRouteSpec {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServerLike {
  /** Native DSH webServer API. */
  register?(route: ExactRouteSpec): (() => void) | void
  /** Legacy / test convenience API. */
  route?(
    method: string,
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): (() => void) | void
}

class HttpInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function requireJsonContentType(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    sendJson(res, 415, { error: '请使用 JSON 请求' })
    return false
  }
  return true
}

function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        fail(new HttpInputError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        reject(new HttpInputError(400, '无效的 JSON 请求'))
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpInputError(400, '请求体必须为 JSON 对象'))
        return
      }
      resolve(parsed as Record<string, unknown>)
    })
    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
  })
}

/**
 * Registers HTTP control APIs and real-time SSE event stream endpoints:
 * - GET  /plugins/agy-acp/status              (one-shot JSON snapshot)
 * - GET  /plugins/agy-acp/events              (Server-Sent Events push on state changes)
 * - POST /plugins/agy-acp/config              (validate & persist safe runtime overrides)
 * - POST /plugins/agy-acp/config/reset        (clear persisted overrides back to host defaults)
 * - POST /plugins/agy-acp/models/refresh      (force-refresh ACP model catalog)
 * - POST /plugins/agy-acp/sessions/reset      (close one or all active ACP sessions)
 * - POST /plugins/agy-acp/accounts/quota/refresh
 * - POST /plugins/agy-acp/accounts/cooldown/clear
 */
export function registerAcpRoutes(
  webServer: WebServerLike,
  pool: AcpSessionPool,
): () => void {
  const disposers: Array<() => void> = []
  const sseClients = new Set<ServerResponse>()

  const pushSnapshot = (snap: StatusSnapshot): void => {
    const payload = `event: status\ndata: ${JSON.stringify(snap)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(payload)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  pool.on('status', pushSnapshot)

  const addRoute = (
    method: string,
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void => {
    if (typeof webServer.register === 'function') {
      const d = webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if ((req.method ?? 'GET').toUpperCase() !== method.toUpperCase()) {
            sendJson(res, 405, { error: `Method ${req.method ?? 'UNKNOWN'} not allowed` })
            return
          }
          return handler(req, res)
        },
      })
      if (typeof d === 'function') disposers.push(d)
      return
    }
    if (typeof webServer.route === 'function') {
      const d = webServer.route(method, path, handler)
      if (typeof d === 'function') disposers.push(d)
    }
  }

  addRoute('GET', '/plugins/agy-acp/status', (_req, res) => {
    sendJson(res, 200, pool.getStatus())
  })

  addRoute('GET', '/plugins/agy-acp/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    res.write(`event: status\ndata: ${JSON.stringify(pool.getStatus())}\n\n`)
    sseClients.add(res)

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n')
      } catch {
        clearInterval(heartbeat)
        sseClients.delete(res)
      }
    }, 25_000)
    heartbeat.unref?.()

    req.on('close', () => {
      clearInterval(heartbeat)
      sseClients.delete(res)
    })
  })

  addRoute('POST', '/plugins/agy-acp/config', async (req, res) => {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }

    const validated = validateConfigPatchInput(body)
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error })
      return
    }

    try {
      await pool.updateConfig(validated.patch)
      sendJson(res, 200, { ok: true, persisted: true, status: pool.getStatus() })
    } catch {
      sendJson(res, 500, { error: '配置写入磁盘失败，未应用更改' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/config/reset', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    try {
      await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    try {
      await pool.resetConfig()
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch {
      sendJson(res, 500, { error: '重置配置失败，请重试' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/models/refresh', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    try {
      await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    try {
      await pool.forceRefreshModels()
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch {
      const status = pool.getStatus()
      sendJson(res, 502, { error: status.lastError || '模型目录刷新失败', status })
    }
  })

  addRoute('POST', '/plugins/agy-acp/sessions/reset', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const sessionKey = typeof body.sessionKey === 'string' && body.sessionKey ? body.sessionKey : undefined
      if (sessionKey) {
        await pool.closeSession(sessionKey)
        sendJson(res, 200, { ok: true, closed: 1, status: pool.getStatus() })
      } else {
        const closed = await pool.resetAllSessions()
        sendJson(res, 200, { ok: true, closed, status: pool.getStatus() })
      }
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/quota/refresh', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try { body = await readJsonBody(req) } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (typeof body.accountId !== 'string' || !body.accountId.trim()) {
      sendJson(res, 400, { error: '请选择要刷新的账号' })
      return
    }
    try {
      await pool.refreshAccountQuota(body.accountId)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      // Never expose child stderr, slot paths, sandbox argv or inherited env values.
      sendJson(res, err instanceof AccountQuotaError ? err.status : 503,
        { error: err instanceof AccountQuotaError ? err.message : '无法在对应账号的只读环境中查询配额' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/cooldown/clear', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined
      pool.clearAccountCooldown(accountId)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  return () => {
    pool.off('status', pushSnapshot)
    for (const res of sseClients) {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
    sseClients.clear()
    for (const d of disposers) d()
  }
}
