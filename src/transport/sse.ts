import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StatusSnapshot } from '../common/types.ts'
import type { AcpSessionPool } from '../runtime/session-pool.ts'

export interface WebServerLike {
  route(
    method: string,
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): (() => void) | void
}

/**
 * Registers HTTP status and real-time SSE event stream endpoints:
 * - GET /plugins/agy-acp/status  (one-shot JSON snapshot)
 * - GET /plugins/agy-acp/events  (Server-Sent Events push on state changes)
 */
export function registerAcpRoutes(webServer: WebServerLike, pool: AcpSessionPool): () => void {
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

  const d1 = webServer.route('GET', '/plugins/agy-acp/status', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(pool.getStatus()))
  })
  if (typeof d1 === 'function') disposers.push(d1)

  const d2 = webServer.route('GET', '/plugins/agy-acp/events', (req, res) => {
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
  if (typeof d2 === 'function') disposers.push(d2)

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
