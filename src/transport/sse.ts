import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PermissionMode, StatusSnapshot } from '../common/types.ts'
import type { PermissionManager } from '../runtime/permission-manager.ts'
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

const VALID_MODES = new Set<PermissionMode>(['skip', 'default', 'accept-edits', 'plan'])

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
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
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Registers HTTP control APIs and real-time SSE event stream endpoints:
 * - GET  /plugins/agy-acp/status              (one-shot JSON snapshot)
 * - GET  /plugins/agy-acp/events              (Server-Sent Events push on state changes)
 * - POST /plugins/agy-acp/mode                (switch permission mode)
 * - POST /plugins/agy-acp/sessions/reset      (close one or all active ACP sessions)
 * - POST /plugins/agy-acp/permissions/decide  (approve/deny pending ACP permission request)
 */
export function registerAcpRoutes(
  webServer: WebServerLike,
  pool: AcpSessionPool,
  permissions?: PermissionManager,
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

  addRoute('POST', '/plugins/agy-acp/mode', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const mode = body.mode
      if (typeof mode !== 'string' || !VALID_MODES.has(mode as PermissionMode)) {
        sendJson(res, 400, { error: 'Invalid permission mode' })
        return
      }
      await pool.setPermissionMode(mode as PermissionMode)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
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
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  addRoute('POST', '/plugins/agy-acp/permissions/decide', async (req, res) => {
    if (!permissions) {
      sendJson(res, 501, { error: 'Interactive permissions not configured' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const requestId = typeof body.requestId === 'string' ? body.requestId : ''
      if (!requestId) {
        sendJson(res, 400, { error: 'Missing requestId' })
        return
      }
      const optionId = typeof body.optionId === 'string' ? body.optionId : undefined
      const cancel = Boolean(body.cancel)
      const handled = permissions.decide(requestId, { optionId, cancel })
      if (!handled) {
        sendJson(res, 404, { error: 'Pending permission request not found' })
        return
      }
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/cooldown/clear', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined
      pool.clearAccountCooldown(accountId)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
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
