import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { isUnsupportedGeoCountry, maskIpAddress, normalizeGeoCountryCode } from '../common/geo.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { AccountEgressSnapshot, GeoFenceMode } from '../common/types.ts'

export const DEFAULT_EGRESS_SUPPORTED_TTL_MS = 300_000
export const DEFAULT_EGRESS_UNSUPPORTED_TTL_MS = 60_000
export const DEFAULT_EGRESS_ERROR_TTL_MS = 30_000
export const DEFAULT_EGRESS_PROBE_TIMEOUT_MS = 4_000
export const DEFAULT_EGRESS_MAX_RESPONSE_BYTES = 16 * 1024
export const DEFAULT_EGRESS_REPROBE_INTERVAL_MS = 10_000

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const

export interface EgressProbeEndpoint {
  id: string
  url: string
  parse: (body: string) => { rawCountry: string | null; ip: string | null }
}

export function parseCloudflareTrace(body: string): { rawCountry: string | null; ip: string | null } {
  let rawCountry: string | null = null
  let ip: string | null = null
  for (const line of body.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim()
    const v = line.slice(eq + 1).trim()
    if (k === 'loc' && v) rawCountry = v
    else if (k === 'ip' && v) ip = v
  }
  return { rawCountry, ip }
}

export function parseIpSbGeoIp(body: string): { rawCountry: string | null; ip: string | null } {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { rawCountry: null, ip: null }
    }
    const rec = parsed as Record<string, unknown>
    return {
      rawCountry: typeof rec.country_code === 'string' ? rec.country_code.trim() : null,
      ip: typeof rec.ip === 'string' ? rec.ip.trim() : null,
    }
  } catch {
    return { rawCountry: null, ip: null }
  }
}

export const DEFAULT_EGRESS_PROBES: readonly EgressProbeEndpoint[] = [
  {
    id: 'cloudflare-trace',
    url: 'https://cloudflare.com/cdn-cgi/trace',
    parse: parseCloudflareTrace,
  },
  {
    id: 'ipsb',
    url: 'https://api.ip.sb/geoip',
    parse: parseIpSbGeoIp,
  },
]

export function formatEgressBlockedMessage(accountLabel: string, snapshot: AccountEgressSnapshot): string {
  const label = accountLabel || 'default'
  if (snapshot.status === 'unsupported') {
    const region = snapshot.country ?? (snapshot.probeSource === 'runtime-400' ? '上游 400 地域限制' : '受限区域')
    return `[安全拦截] 已在本地阻断发往 Google 的请求（未发送任何上游流量）：检测到账号“${label}”当前出口位于不受支持的地区（${region}），代理模式=${snapshot.proxyMode}。请切换至 US / JP / SG / TW 等支持区域节点后重试，或在控制台点击「检测出口」刷新状态。`
  }
  const detail = snapshot.reason ? `（${snapshot.reason}）` : ''
  return `[安全拦截] 严格地域防护已在本地阻断发往 Google 的请求（未发送任何上游流量）：无法确认账号“${label}”当前出口地域合规性（状态=${snapshot.status}，代理模式=${snapshot.proxyMode}）${detail}。请检查代理连通性或在控制台点击「检测出口」刷新状态。`
}

export class EgressBlockedError extends Error {
  readonly status = 451
  readonly accountId: string
  readonly snapshot: AccountEgressSnapshot

  constructor(accountId: string, accountLabel: string, snapshot: AccountEgressSnapshot) {
    super(formatEgressBlockedMessage(accountLabel, snapshot))
    this.name = 'EgressBlockedError'
    this.accountId = accountId
    this.snapshot = snapshot
  }
}

export type ResolvedProxyRoute =
  | { kind: 'direct'; proxyMode: 'direct' }
  | { kind: 'http'; proxyMode: 'proxy'; proxyUrl: URL }
  | { kind: 'socks5'; proxyMode: 'proxy'; proxyUrl: URL }
  | { kind: 'invalid'; proxyMode: 'proxy'; reason: string }

function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function splitRuleHostPort(rule: string): { host: string; port: string | null } {
  if (rule.startsWith('[')) {
    const close = rule.indexOf(']')
    if (close !== -1) {
      const host = rule.slice(1, close)
      const rest = rule.slice(close + 1)
      if (rest.startsWith(':') && /^\d+$/.test(rest.slice(1))) {
        return { host, port: rest.slice(1) }
      }
      return { host, port: null }
    }
  }
  const firstColon = rule.indexOf(':')
  const lastColon = rule.lastIndexOf(':')
  if (firstColon !== -1 && firstColon === lastColon) {
    const maybePort = rule.slice(firstColon + 1)
    if (/^\d+$/.test(maybePort)) {
      return { host: rule.slice(0, firstColon), port: maybePort }
    }
  }
  return { host: rule, port: null }
}

/**
 * Matches `NO_PROXY` / `no_proxy` rules aligned with Go `golang.org/x/net/http/httpproxy`.
 */
export function shouldBypassProxy(targetUrl: URL, noProxy: string | undefined): boolean {
  if (!noProxy || !noProxy.trim()) return false
  const targetHost = targetUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80')

  for (const rawEntry of noProxy.split(',')) {
    const entry = rawEntry.trim()
    if (!entry) continue
    if (entry === '*') return true

    const { host: rawRuleHost, port: rulePort } = splitRuleHostPort(entry)
    if (rulePort && rulePort !== targetPort) continue

    let ruleHost = rawRuleHost.trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (!ruleHost) continue
    if (ruleHost.startsWith('*.')) {
      ruleHost = ruleHost.slice(1)
    }

    if (ruleHost.startsWith('.')) {
      if (targetHost === ruleHost.slice(1) || targetHost.endsWith(ruleHost)) return true
    } else if (targetHost === ruleHost || targetHost.endsWith(`.${ruleHost}`)) {
      return true
    }
  }

  return false
}

/**
 * Resolves effective proxy route for `targetUrl` using Go `net/http.ProxyFromEnvironment` precedence:
 * `NO_PROXY` -> `HTTPS_PROXY` -> `https_proxy` -> `ALL_PROXY` -> `all_proxy` -> `HTTP_PROXY` -> `http_proxy`.
 * Never embeds raw proxy credentials in error strings.
 */
export function resolveProxyForUrl(targetUrl: URL, env: NodeJS.ProcessEnv | undefined = process.env): ResolvedProxyRoute {
  const effectiveEnv = env ?? process.env
  const noProxy = effectiveEnv.NO_PROXY ?? effectiveEnv.no_proxy
  if (shouldBypassProxy(targetUrl, noProxy)) {
    return { kind: 'direct', proxyMode: 'direct' }
  }

  let rawProxy = ''
  for (const key of PROXY_ENV_KEYS) {
    const candidate = effectiveEnv[key]?.trim()
    if (candidate) {
      rawProxy = candidate
      break
    }
  }
  if (!rawProxy) {
    return { kind: 'direct', proxyMode: 'direct' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawProxy)
  } catch {
    return { kind: 'invalid', proxyMode: 'proxy', reason: '代理地址格式无效，请检查代理环境变量配置' }
  }

  const proto = parsed.protocol.toLowerCase()
  if (proto === 'http:' || proto === 'https:') {
    return { kind: 'http', proxyMode: 'proxy', proxyUrl: parsed }
  }
  if (proto === 'socks5:' || proto === 'socks5h:' || proto === 'socks:') {
    return { kind: 'socks5', proxyMode: 'proxy', proxyUrl: parsed }
  }
  return {
    kind: 'invalid',
    proxyMode: 'proxy',
    reason: `不支持的代理协议 ${proto.replace(/:$/, '')}（仅支持 http/https/socks5）`,
  }
}

function computeEnvCacheKey(accountId: string, env: NodeJS.ProcessEnv | undefined): string {
  const effectiveEnv = env ?? process.env
  const material = JSON.stringify([
    accountId,
    effectiveEnv.HTTPS_PROXY ?? '',
    effectiveEnv.https_proxy ?? '',
    effectiveEnv.ALL_PROXY ?? '',
    effectiveEnv.all_proxy ?? '',
    effectiveEnv.HTTP_PROXY ?? '',
    effectiveEnv.http_proxy ?? '',
    effectiveEnv.NO_PROXY ?? '',
    effectiveEnv.no_proxy ?? '',
  ])
  return createHash('sha256').update(material).digest('hex')
}

function formatHostHeader(hostname: string, port: number, defaultPort: number): string {
  const bracketed = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  return port === defaultPort ? bracketed : `${bracketed}:${port}`
}

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const err = new Error(typeof reason === 'string' && reason ? reason : 'Request aborted')
  err.name = 'AbortError'
  return err
}

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(createAbortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(createAbortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

async function connectHttpTunnel(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
  tlsOptions?: tls.ConnectionOptions,
): Promise<net.Socket> {
  signal.throwIfAborted()
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '')
  const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80)
  const connectAuthority = `${targetHost.includes(':') ? `[${targetHost}]` : targetHost}:${targetPort}`

  const headers: Record<string, string> = {
    Host: connectAuthority,
    'Proxy-Connection': 'Keep-Alive',
  }
  if (proxyUrl.username || proxyUrl.password) {
    const user = safeDecodeURIComponent(proxyUrl.username)
    const pass = safeDecodeURIComponent(proxyUrl.password)
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
  }

  return await new Promise<net.Socket>((resolve, reject) => {
    let settled = false
    const fail = (err: Error, socket?: net.Socket): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket?.destroy()
      req.destroy()
      reject(err)
    }

    const req =
      proxyUrl.protocol === 'https:'
        ? https.request({
            host: proxyHost,
            port: proxyPort,
            method: 'CONNECT',
            path: connectAuthority,
            headers,
            agent: false,
            ...tlsOptions,
          })
        : http.request({
            host: proxyHost,
            port: proxyPort,
            method: 'CONNECT',
            path: connectAuthority,
            headers,
            agent: false,
          })

    const onAbort = (): void => {
      fail(createAbortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    req.once('connect', (res, socket, head) => {
      if (settled) {
        socket.destroy()
        return
      }
      signal.removeEventListener('abort', onAbort)
      if (res.statusCode !== 200) {
        settled = true
        socket.destroy()
        req.destroy()
        const status = res.statusCode ?? 0
        reject(
          new Error(
            status === 407
              ? 'HTTP 代理认证失败（HTTP 407）'
              : `HTTP 代理 CONNECT 握手失败（HTTP ${status}）`,
          ),
        )
        return
      }
      settled = true
      if (head && head.length > 0) {
        socket.unshift(head)
      }
      resolve(socket)
    })

    req.once('error', (err) => {
      fail(new Error(`连接 HTTP 代理失败：${sanitizeDiagnosticText(err.message, 120)}`))
    })

    req.end()
  })
}

function createBufferedSocketReader(socket: net.Socket, signal: AbortSignal) {
  let buffer: Buffer = Buffer.alloc(0)
  let endedError: Error | null = null
  let waiter: { bytes: number; resolve: (chunk: Buffer) => void; reject: (err: Error) => void } | null = null

  const flush = (): void => {
    if (!waiter) return
    if (buffer.length >= waiter.bytes) {
      const current = waiter
      waiter = null
      const out = buffer.subarray(0, current.bytes)
      buffer = buffer.subarray(current.bytes)
      current.resolve(out)
      return
    }
    if (endedError) {
      const current = waiter
      waiter = null
      current.reject(endedError)
    }
  }

  const onData = (chunk: Buffer): void => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    flush()
  }
  const onError = (err: Error): void => {
    endedError = new Error(`SOCKS5 代理连接异常：${sanitizeDiagnosticText(err.message, 120)}`)
    flush()
  }
  const onClose = (): void => {
    if (!endedError) endedError = new Error('SOCKS5 代理连接意外关闭')
    flush()
  }
  const onAbort = (): void => {
    endedError = createAbortError(signal)
    socket.destroy()
    flush()
  }

  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)
  signal.addEventListener('abort', onAbort, { once: true })

  return {
    readExact(bytes: number): Promise<Buffer> {
      if (bytes <= 0) return Promise.resolve(Buffer.alloc(0))
      if (buffer.length >= bytes) {
        const out = buffer.subarray(0, bytes)
        buffer = buffer.subarray(bytes)
        return Promise.resolve(out)
      }
      if (endedError) return Promise.reject(endedError)
      return new Promise<Buffer>((resolve, reject) => {
        waiter = { bytes, resolve, reject }
      })
    },
    detach(): void {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
      if (buffer.length > 0 && !socket.destroyed) {
        socket.unshift(buffer)
        buffer = Buffer.alloc(0)
      }
    },
  }
}

function writeSocketAsync(socket: net.Socket, data: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(data, (err) => {
      if (err) reject(new Error(`写入 SOCKS5 代理失败：${sanitizeDiagnosticText(err.message, 120)}`))
      else resolve()
    })
  })
}

/**
 * Minimal RFC 1928 + RFC 1929 SOCKS5 tunnel client.
 * Always sends `ATYP = 0x03` (Domain Name) so DNS resolution occurs on the proxy side,
 * avoiding local DNS pollution/leaks and matching `socks5h` / Go `agy` behavior.
 */
async function connectSocks5Tunnel(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
): Promise<net.Socket> {
  signal.throwIfAborted()
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '')
  const proxyPort = Number(proxyUrl.port) || 1080
  const hasAuth = proxyUrl.username.length > 0 || proxyUrl.password.length > 0

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const sock = net.connect({ host: proxyHost, port: proxyPort })
    const onAbort = (): void => {
      sock.destroy()
      reject(createAbortError(signal))
    }
    const onError = (err: Error): void => {
      signal.removeEventListener('abort', onAbort)
      sock.destroy()
      reject(new Error(`连接 SOCKS5 代理失败：${sanitizeDiagnosticText(err.message, 120)}`))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    sock.once('error', onError)
    sock.once('connect', () => {
      signal.removeEventListener('abort', onAbort)
      sock.off('error', onError)
      resolve(sock)
    })
  })

  const reader = createBufferedSocketReader(socket, signal)
  try {
    // 1. Greeting
    await writeSocketAsync(socket, hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))
    const methodReply = await reader.readExact(2)
    if (methodReply[0] !== 0x05) {
      throw new Error('SOCKS5 代理协议版本响应异常')
    }
    const chosenMethod = methodReply[1]
    if (chosenMethod === 0xff) {
      throw new Error('SOCKS5 代理拒绝认证方式')
    }
    if (chosenMethod === 0x02) {
      if (!hasAuth) {
        throw new Error('SOCKS5 代理要求用户名密码认证')
      }
      const userBuf = Buffer.from(safeDecodeURIComponent(proxyUrl.username), 'utf8')
      const passBuf = Buffer.from(safeDecodeURIComponent(proxyUrl.password), 'utf8')
      if (userBuf.length > 255 || passBuf.length > 255) {
        throw new Error('SOCKS5 代理认证凭据长度超限')
      }
      await writeSocketAsync(
        socket,
        Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]),
      )
      const authReply = await reader.readExact(2)
      if (authReply[1] !== 0x00) {
        throw new Error('SOCKS5 代理用户名或密码认证失败')
      }
    } else if (chosenMethod !== 0x00) {
      throw new Error('SOCKS5 代理返回不支持的认证方法')
    }

    // 2. CONNECT with ATYP = 0x03 (remote domain name resolution)
    const cleanHost = targetHost.replace(/^\[|\]$/g, '')
    const hostBuf = Buffer.from(cleanHost, 'utf8')
    if (hostBuf.length === 0 || hostBuf.length > 255) {
      throw new Error('探测目标域名长度无效')
    }
    const portBuf = Buffer.alloc(2)
    portBuf.writeUInt16BE(targetPort, 0)
    await writeSocketAsync(
      socket,
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]),
    )

    const connHead = await reader.readExact(4)
    if (connHead[0] !== 0x05) {
      throw new Error('SOCKS5 代理连接响应无效')
    }
    if (connHead[1] !== 0x00) {
      throw new Error(`SOCKS5 代理连接目标失败（code=0x${(connHead[1] ?? 0).toString(16)}）`)
    }
    const atyp = connHead[3]
    if (atyp === 0x01) {
      await reader.readExact(4 + 2)
    } else if (atyp === 0x04) {
      await reader.readExact(16 + 2)
    } else if (atyp === 0x03) {
      const addrLen = (await reader.readExact(1))[0] ?? 0
      await reader.readExact(addrLen + 2)
    } else {
      throw new Error('SOCKS5 代理返回未知绑定地址类型')
    }

    reader.detach()
    return socket
  } catch (err) {
    reader.detach()
    socket.destroy()
    throw err
  }
}

function decodeChunkedBody(raw: Buffer, maxBytes: number): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  let offset = 0
  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset)
    if (lineEnd === -1) break
    const sizeHex = raw.subarray(offset, lineEnd).toString('ascii').split(';')[0]?.trim() ?? ''
    const chunkSize = Number.parseInt(sizeHex, 16)
    if (!Number.isFinite(chunkSize) || chunkSize < 0) break
    offset = lineEnd + 2
    if (chunkSize === 0) break
    if (total + chunkSize > maxBytes) {
      throw new Error('出口探测响应体超出大小上限')
    }
    const end = Math.min(raw.length, offset + chunkSize)
    chunks.push(raw.subarray(offset, end))
    total += end - offset
    offset = end + 2
  }
  return Buffer.concat(chunks)
}

async function sendHttpGetOverStream(
  stream: net.Socket,
  hostHeader: string,
  requestPath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ statusCode: number; body: string }> {
  signal.throwIfAborted()
  const rawReq =
    `GET ${requestPath} HTTP/1.1\r\n` +
    `Host: ${hostHeader}\r\n` +
    `User-Agent: curl/8.5.0\r\n` +
    `Accept: */*\r\n` +
    `Connection: close\r\n\r\n`

  return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const maxRawBytes = maxBytes + 8 * 1024

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('close', onEnd)
      stream.off('error', onError)
      fn()
    }

    const onAbort = (): void => {
      stream.destroy()
      finish(() => reject(createAbortError(signal)))
    }
    const onError = (err: Error): void => {
      stream.destroy()
      finish(() => reject(new Error(`读取探测响应失败：${sanitizeDiagnosticText(err.message, 120)}`)))
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      if (total > maxRawBytes) {
        stream.destroy()
        finish(() => reject(new Error('出口探测响应体超出大小上限')))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      const full = Buffer.concat(chunks)
      const sep = full.indexOf('\r\n\r\n')
      if (sep === -1) {
        finish(() => reject(new Error('出口探测响应格式不完整')))
        return
      }
      const headText = full.subarray(0, sep).toString('latin1')
      const headLines = headText.split('\r\n')
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(headLines[0] ?? '')
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0
      const isChunked = headLines.some((l) => /^transfer-encoding\s*:.*chunked/i.test(l))
      let bodyBuf: Buffer = full.subarray(sep + 4)
      try {
        if (isChunked) {
          bodyBuf = decodeChunkedBody(bodyBuf, maxBytes)
        } else if (bodyBuf.length > maxBytes) {
          throw new Error('出口探测响应体超出大小上限')
        }
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
        return
      }
      finish(() => resolve({ statusCode, body: bodyBuf.toString('utf8') }))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('close', onEnd)
    stream.once('error', onError)
    stream.write(rawReq, (err) => {
      if (err) onError(err)
    })
  })
}

async function upgradeTlsOverTunnel(
  tunnelSocket: net.Socket,
  servername: string | undefined,
  signal: AbortSignal,
  tlsOptions?: tls.ConnectionOptions,
): Promise<tls.TLSSocket> {
  signal.throwIfAborted()
  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket: tunnelSocket,
      ...(servername ? { servername } : {}),
      ...tlsOptions,
    })
    const onAbort = (): void => {
      tlsSocket.destroy()
      tunnelSocket.destroy()
      reject(createAbortError(signal))
    }
    const onError = (err: Error): void => {
      signal.removeEventListener('abort', onAbort)
      tlsSocket.destroy()
      tunnelSocket.destroy()
      reject(new Error(`代理隧道 TLS 握手失败：${sanitizeDiagnosticText(err.message, 120)}`))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    tlsSocket.once('error', onError)
    tlsSocket.once('secureConnect', () => {
      signal.removeEventListener('abort', onAbort)
      tlsSocket.off('error', onError)
      resolve(tlsSocket)
    })
  })
}

async function fetchTextViaRoute(
  targetUrl: URL,
  route: Exclude<ResolvedProxyRoute, { kind: 'invalid' }>,
  timeoutMs: number,
  maxBytes: number,
  outerSignal?: AbortSignal,
  tlsOptions?: tls.ConnectionOptions,
): Promise<{ statusCode: number; body: string }> {
  const attemptAc = new AbortController()
  const onOuterAbort = (): void => attemptAc.abort(createAbortError(outerSignal))
  if (outerSignal?.aborted) throw createAbortError(outerSignal)
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })

  const timer = setTimeout(() => {
    attemptAc.abort(new Error('出口探测请求超时'))
  }, timeoutMs)
  timer.unref?.()

  const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, '')
  const isHttps = targetUrl.protocol === 'https:'
  const defaultPort = isHttps ? 443 : 80
  const targetPort = Number(targetUrl.port) || defaultPort
  const requestPath = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`
  const sniServername = net.isIP(targetHost) === 0 ? targetHost : undefined
  const hostHeader = formatHostHeader(targetHost, targetPort, defaultPort)

  let tunnelSocket: net.Socket | undefined
  let activeStream: net.Socket | undefined
  try {
    if (route.kind === 'http') {
      tunnelSocket = await connectHttpTunnel(route.proxyUrl, targetHost, targetPort, attemptAc.signal, tlsOptions)
    } else if (route.kind === 'socks5') {
      tunnelSocket = await connectSocks5Tunnel(route.proxyUrl, targetHost, targetPort, attemptAc.signal)
    }

    attemptAc.signal.throwIfAborted()

    if (tunnelSocket) {
      activeStream = isHttps
        ? await upgradeTlsOverTunnel(tunnelSocket, sniServername, attemptAc.signal, tlsOptions)
        : tunnelSocket
      return await sendHttpGetOverStream(activeStream, hostHeader, requestPath, maxBytes, attemptAc.signal)
    }

    return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        attemptAc.signal.removeEventListener('abort', onAttemptAbort)
        fn()
      }

      const headers: Record<string, string> = {
        Host: hostHeader,
        'User-Agent': 'curl/8.5.0',
        Accept: '*/*',
        Connection: 'close',
      }

      const req = isHttps
        ? https.request({
            protocol: 'https:',
            hostname: targetHost,
            port: targetPort,
            path: requestPath,
            method: 'GET',
            headers,
            agent: false,
            ...(sniServername ? { servername: sniServername } : {}),
            ...tlsOptions,
          })
        : http.request({
            protocol: 'http:',
            hostname: targetHost,
            port: targetPort,
            path: requestPath,
            method: 'GET',
            headers,
            agent: false,
          })

      const onAttemptAbort = (): void => {
        req.destroy()
        const reason = attemptAc.signal.reason
        done(() => reject(reason instanceof Error ? reason : new Error('出口探测已中止')))
      }
      attemptAc.signal.addEventListener('abort', onAttemptAbort, { once: true })

      req.once('response', (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > maxBytes) {
            req.destroy()
            res.destroy()
            done(() => reject(new Error('出口探测响应体超出大小上限')))
            return
          }
          chunks.push(chunk)
        })
        res.once('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          done(() => resolve({ statusCode: res.statusCode ?? 0, body }))
        })
        res.once('error', (err) => {
          done(() => reject(new Error(`读取探测响应失败：${sanitizeDiagnosticText(err.message, 120)}`)))
        })
      })

      req.once('error', (err) => {
        done(() => reject(new Error(`出口探测请求失败：${sanitizeDiagnosticText(err.message, 120)}`)))
      })

      req.end()
    })
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
    activeStream?.destroy()
    tunnelSocket?.destroy()
  }
}

export interface EgressGuardOptions {
  probes?: readonly EgressProbeEndpoint[]
  /** Optional custom probe override for deterministic unit tests without network sockets. */
  probeFn?: (
    accountId: string,
    env: NodeJS.ProcessEnv | undefined,
    signal: AbortSignal,
  ) => Promise<Omit<AccountEgressSnapshot, 'checkedAt' | 'expiresAt'>>
  probeTimeoutMs?: number
  maxResponseBytes?: number
  supportedTtlMs?: number
  unsupportedTtlMs?: number
  errorTtlMs?: number
  reprobeMinIntervalMs?: number
  now?: () => number
  tlsOptions?: tls.ConnectionOptions
  log?: (msg: string) => void
}

/**
 * Proxy-consistent egress geo-location probe & local circuit breaker.
 *
 * Ensures that pre-flight probes follow the exact same `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` / `NO_PROXY`
 * and HTTP CONNECT / SOCKS5(h) / direct TUN routing semantics as the Go `agy` binary.
 */
export class EgressGuard {
  private readonly probes: readonly EgressProbeEndpoint[]
  private readonly probeTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly supportedTtlMs: number
  private readonly unsupportedTtlMs: number
  private readonly errorTtlMs: number
  private readonly reprobeMinIntervalMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, AccountEgressSnapshot>()
  private readonly latestByAccount = new Map<string, { cacheKey: string; snapshot: AccountEgressSnapshot }>()
  private readonly inFlight = new Map<string, Promise<AccountEgressSnapshot>>()
  private readonly lastBgReprobeAt = new Map<string, number>()
  private readonly lifetime = new AbortController()

  constructor(private readonly opts: EgressGuardOptions = {}) {
    this.probes = opts.probes ?? DEFAULT_EGRESS_PROBES
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_EGRESS_PROBE_TIMEOUT_MS
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_EGRESS_MAX_RESPONSE_BYTES
    this.supportedTtlMs = opts.supportedTtlMs ?? DEFAULT_EGRESS_SUPPORTED_TTL_MS
    this.unsupportedTtlMs = opts.unsupportedTtlMs ?? DEFAULT_EGRESS_UNSUPPORTED_TTL_MS
    this.errorTtlMs = opts.errorTtlMs ?? DEFAULT_EGRESS_ERROR_TTL_MS
    this.reprobeMinIntervalMs = opts.reprobeMinIntervalMs ?? DEFAULT_EGRESS_REPROBE_INTERVAL_MS
    this.now = opts.now ?? (() => Date.now())
  }

  getSnapshot(accountId: string, env?: NodeJS.ProcessEnv): AccountEgressSnapshot | undefined {
    if (env !== undefined) {
      const cacheKey = computeEnvCacheKey(accountId, env)
      const exact = this.cache.get(cacheKey)
      if (exact) return { ...exact }
    }
    const latest = this.latestByAccount.get(accountId)
    if (!latest) return undefined
    if (env !== undefined && latest.cacheKey !== computeEnvCacheKey(accountId, env)) {
      return undefined
    }
    return { ...latest.snapshot }
  }

  async check(
    accountId: string,
    env?: NodeJS.ProcessEnv,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<AccountEgressSnapshot> {
    options?.signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()

    const cacheKey = computeEnvCacheKey(accountId, env)
    const now = this.now()

    if (!options?.force) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > now) {
        return { ...cached }
      }
      const existingFlight = this.inFlight.get(cacheKey)
      if (existingFlight) {
        return { ...(await raceSignal(existingFlight, options?.signal)) }
      }
    } else {
      this.cache.delete(cacheKey)
    }

    const task = this.executeProbe(accountId, cacheKey, env).finally(() => {
      if (this.inFlight.get(cacheKey) === task) {
        this.inFlight.delete(cacheKey)
      }
    })
    this.inFlight.set(cacheKey, task)
    return { ...(await raceSignal(task, options?.signal)) }
  }

  async assertAllowed(params: {
    accountId: string
    accountLabel?: string
    env?: NodeJS.ProcessEnv
    mode: GeoFenceMode
    signal?: AbortSignal
  }): Promise<AccountEgressSnapshot | null> {
    if (params.mode === 'off') return null
    const snapshot = await this.check(params.accountId, params.env, { signal: params.signal })
    const label = params.accountLabel || params.accountId

    if (snapshot.status === 'supported') {
      return snapshot
    }

    if (snapshot.status === 'unsupported') {
      if (params.mode === 'warn') {
        this.opts.log?.(
          `[egress-warn] account "${params.accountId}" egress is in unsupported region (${snapshot.country ?? 'restricted'}, mode=${snapshot.proxyMode}); proceeding because geoFenceMode=warn`,
        )
        return snapshot
      }
      throw new EgressBlockedError(params.accountId, label, snapshot)
    }

    // status === 'unknown' | 'error'
    if (params.mode === 'strict') {
      throw new EgressBlockedError(params.accountId, label, snapshot)
    }

    this.opts.log?.(
      `[egress-warn] account "${params.accountId}" egress check degraded (${snapshot.status}${snapshot.reason ? `: ${snapshot.reason}` : ''}); allowing request under geoFenceMode=${params.mode}`,
    )
    return snapshot
  }

  /**
   * Immediately invalidates any cached `supported` state upon upstream Google 400 location rejection,
   * installs a 60s `runtime-400` protective block, and triggers a rate-limited background re-probe.
   */
  recordGeoRejection(
    accountId: string,
    env?: NodeJS.ProcessEnv,
    onBackgroundUpdate?: (snapshot: AccountEgressSnapshot) => void,
  ): AccountEgressSnapshot {
    const cacheKey = computeEnvCacheKey(accountId, env)
    const now = this.now()
    const defaultProbeUrl = new URL(this.probes[0]?.url ?? 'https://cloudflare.com/cdn-cgi/trace')
    const route = resolveProxyForUrl(defaultProbeUrl, env)
    const prev = this.cache.get(cacheKey)

    const synthetic: AccountEgressSnapshot = {
      status: 'unsupported',
      country: prev?.status === 'unsupported' ? prev.country : null,
      ipMasked: prev?.status === 'unsupported' ? prev.ipMasked : null,
      proxyMode: route.proxyMode,
      probeSource: 'runtime-400',
      checkedAt: now,
      expiresAt: now + this.unsupportedTtlMs,
      reason: '上游 Google API 返回地域不受支持（400），已即时触发本地保护熔断',
    }
    this.storeSnapshot(accountId, cacheKey, synthetic)

    const lastReprobe = this.lastBgReprobeAt.get(cacheKey) ?? 0
    if (!this.lifetime.signal.aborted && now - lastReprobe >= this.reprobeMinIntervalMs) {
      this.lastBgReprobeAt.set(cacheKey, now)
      void this.probeRaw(accountId, env)
        .then((probed) => {
          if (this.lifetime.signal.aborted) return
          const current = this.cache.get(cacheKey)
          // Only refine if the synthetic runtime-400 entry is still active (user hasn't manually force-checked).
          if (!current || current.probeSource !== 'runtime-400') return
          const completedAt = this.now()
          if (probed.status === 'unsupported') {
            const refined: AccountEgressSnapshot = {
              ...probed,
              checkedAt: completedAt,
              expiresAt: Math.max(current.expiresAt, completedAt + this.unsupportedTtlMs),
              reason: `上游触发 400 地域限制，复测确认当前出口为不受支持地区（${probed.country ?? '未知'}）`,
            }
            this.storeSnapshot(accountId, cacheKey, refined)
            onBackgroundUpdate?.(refined)
          } else if (probed.status === 'supported') {
            // Keep the 60s circuit breaker armed in case `*.googleapis.com` bypassed proxy split-tunnel rules!
            const splitHint: AccountEgressSnapshot = {
              ...current,
              ipMasked: probed.ipMasked,
              reason: `上游 Google API 返回地域不受支持（400），已本地熔断 60 秒（通用探针出口为 ${probed.country}，请检查 *.googleapis.com 代理分流规则）`,
            }
            this.storeSnapshot(accountId, cacheKey, splitHint)
            onBackgroundUpdate?.(splitHint)
          }
        })
        .catch(() => {
          // ignore background reprobe failure
        })
    }

    return { ...synthetic }
  }

  dispose(): void {
    this.lifetime.abort()
    this.inFlight.clear()
  }

  private ttlForStatus(status: AccountEgressSnapshot['status']): number {
    if (status === 'supported') return this.supportedTtlMs
    if (status === 'unsupported') return this.unsupportedTtlMs
    return this.errorTtlMs
  }

  private storeSnapshot(accountId: string, cacheKey: string, snapshot: AccountEgressSnapshot): void {
    this.cache.set(cacheKey, snapshot)
    this.latestByAccount.set(accountId, { cacheKey, snapshot })
  }

  private async executeProbe(
    accountId: string,
    cacheKey: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<AccountEgressSnapshot> {
    const raw = await this.probeRaw(accountId, env)
    const checkedAt = this.now()
    const snapshot: AccountEgressSnapshot = {
      ...raw,
      checkedAt,
      expiresAt: checkedAt + this.ttlForStatus(raw.status),
    }
    this.storeSnapshot(accountId, cacheKey, snapshot)
    return snapshot
  }

  private async probeRaw(
    accountId: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<Omit<AccountEgressSnapshot, 'checkedAt' | 'expiresAt'>> {
    if (this.opts.probeFn) {
      return await this.opts.probeFn(accountId, env, this.lifetime.signal)
    }

    if (this.probes.length === 0) {
      return {
        status: 'error',
        country: null,
        ipMasked: null,
        proxyMode: 'direct',
        probeSource: null,
        reason: '未配置可用的出口探测源',
      }
    }

    let unknownFallback: Omit<AccountEgressSnapshot, 'checkedAt' | 'expiresAt'> | null = null
    let lastFailureReason = '出口探测失败'
    let lastProxyMode: 'proxy' | 'direct' = 'direct'

    for (const endpoint of this.probes) {
      let targetUrl: URL
      try {
        targetUrl = new URL(endpoint.url)
      } catch {
        lastFailureReason = `探测源 URL 配置无效（${endpoint.id}）`
        continue
      }

      const route = resolveProxyForUrl(targetUrl, env)
      lastProxyMode = route.proxyMode
      if (route.kind === 'invalid') {
        return {
          status: 'error',
          country: null,
          ipMasked: null,
          proxyMode: 'proxy',
          probeSource: endpoint.id,
          reason: sanitizeDiagnosticText(route.reason, 160),
        }
      }

      try {
        const { statusCode, body } = await fetchTextViaRoute(
          targetUrl,
          route,
          this.probeTimeoutMs,
          this.maxResponseBytes,
          this.lifetime.signal,
          this.opts.tlsOptions,
        )
        if (statusCode !== 200) {
          lastFailureReason = `探测源 ${endpoint.id} 返回 HTTP ${statusCode}`
          continue
        }

        const parsed = endpoint.parse(body)
        const ipMasked = parsed.ip ? maskIpAddress(parsed.ip) : null
        const normalized = normalizeGeoCountryCode(parsed.rawCountry)

        if (normalized.kind === 'valid') {
          const unsupported = isUnsupportedGeoCountry(normalized.country)
          return {
            status: unsupported ? 'unsupported' : 'supported',
            country: normalized.country,
            ipMasked: ipMasked === 'unknown' ? null : ipMasked,
            proxyMode: route.proxyMode,
            probeSource: endpoint.id,
            ...(unsupported
              ? { reason: `当前出口位于不受 Google 支持的地区（${normalized.country}）` }
              : {}),
          }
        }

        if (normalized.kind === 'placeholder') {
          unknownFallback = {
            status: 'unknown',
            country: null,
            ipMasked: ipMasked === 'unknown' ? null : ipMasked,
            proxyMode: route.proxyMode,
            probeSource: endpoint.id,
            reason: `出口探测返回未识别地区标识（${normalized.raw}）`,
          }
          continue
        }

        lastFailureReason = `探测源 ${endpoint.id} 未返回有效国家代码`
      } catch (err) {
        if (this.lifetime.signal.aborted) throw err
        const msg = err instanceof Error ? err.message : String(err)
        lastFailureReason = sanitizeDiagnosticText(msg, 160) || '出口探测网络请求失败'
      }
    }

    if (unknownFallback) {
      return unknownFallback
    }

    return {
      status: 'error',
      country: null,
      ipMasked: null,
      proxyMode: lastProxyMode,
      probeSource: null,
      reason: sanitizeDiagnosticText(lastFailureReason, 160) || '出口探测失败',
    }
  }
}
