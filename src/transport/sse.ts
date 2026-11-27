import type { IncomingMessage, ServerResponse } from 'node:http'
import { validateConfigPatchInput } from '../common/config.ts'
import {
  PROVIDER_ID,
  type AccountLoginSessionSnapshot,
  type AgyInstallTaskSnapshot,
  type EnvironmentCheckReport,
  type ManagedAccountRecord,
  type StatusSnapshot,
} from '../common/types.ts'
import { AccountLoginError } from '../runtime/account-login.ts'
import { AccountQuotaError } from '../runtime/account-quota.ts'
import { AccountStoreError } from '../runtime/account-store.ts'
import { EnvSetupError } from '../runtime/env-setup.ts'
import { EgressCheckError, type AcpSessionPool } from '../runtime/session-pool.ts'

export interface ReviewModelChoice {
  id: string
  name: string
}

export interface ConnectionLike {
  /** DSH browser-trust & authentication fence (Host/Origin + login cookie). */
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

export interface AcpRoutesOptions {
  /** DSH host connection service guarding every HTTP/SSE route. */
  connection?: ConnectionLike
  listReviewModels?: (provider: string) => Promise<ReviewModelChoice[] | null>
  /** Coalesce bursty SSE status broadcasts within this window (ms). Defaults to 180ms; 0 disables throttling. */
  sseThrottleMs?: number
  runEnvCheck?: () => Promise<EnvironmentCheckReport>
  startAgyInstall?: (input: { action?: 'install' | 'update'; proxyUrl?: string }) => AgyInstallTaskSnapshot
  addAccount?: (body: Record<string, unknown>) => Promise<ManagedAccountRecord>
  updateAccount?: (body: Record<string, unknown>) => Promise<unknown>
  selectAccount?: (accountId: string | null) => Promise<void> | void
  removeAccount?: (accountId: string, opts?: { purgeData?: boolean }) => Promise<void>
  startAccountLogin?: (input: { accountId?: string; proxyUrl?: string }) => Promise<AccountLoginSessionSnapshot>
  submitAccountLoginCode?: (loginId: string, code: string) => Promise<AccountLoginSessionSnapshot>
  cancelAccountLogin?: (loginId?: string) => void
}

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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
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
 * - POST /plugins/agy-acp/accounts/egress/check
 * - POST /plugins/agy-acp/accounts/cooldown/clear
 */
export function registerAcpRoutes(
  webServer: WebServerLike,
  pool: AcpSessionPool,
  opts?: AcpRoutesOptions,
): () => void {
  const disposers: Array<() => void> = []
  const sseClients = new Set<ServerResponse>()
  const throttleMs = Math.max(0, opts?.sseThrottleMs ?? 180)
  let listeningPoolStatus = false
  let lastPushAt = 0
  let pendingSnapshot: StatusSnapshot | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const clearPendingBroadcast = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pendingSnapshot = null
  }

  const detachStatusListenerIfIdle = (): void => {
    if (sseClients.size > 0 || !listeningPoolStatus) return
    pool.off('status', pushSnapshot)
    listeningPoolStatus = false
    clearPendingBroadcast()
  }

  const attachStatusListener = (): void => {
    if (listeningPoolStatus) return
    pool.on('status', pushSnapshot)
    listeningPoolStatus = true
  }

  const broadcastNow = (snap: StatusSnapshot): void => {
    if (sseClients.size === 0) return
    lastPushAt = Date.now()
    const payload = `event: status\ndata: ${JSON.stringify(snap)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(payload)
      } catch {
        sseClients.delete(res)
      }
    }
    detachStatusListenerIfIdle()
  }

  const pushSnapshot = (snap: StatusSnapshot): void => {
    if (sseClients.size === 0) {
      detachStatusListenerIfIdle()
      return
    }
    if (throttleMs <= 0) {
      broadcastNow(snap)
      return
    }
    const elapsed = Date.now() - lastPushAt
    if (flushTimer === null && elapsed >= throttleMs) {
      broadcastNow(snap)
      return
    }
    pendingSnapshot = snap
    if (flushTimer === null) {
      const delay = Math.max(1, throttleMs - elapsed)
      flushTimer = setTimeout(() => {
        flushTimer = null
        const next = pendingSnapshot
        pendingSnapshot = null
        if (next) broadcastNow(next)
      }, delay)
      flushTimer.unref?.()
    }
  }

  const checkAccess = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = opts?.connection?.requestRejection(req)
    if (rejection === undefined) return true
    sendJson(res, rejection, {
      error: rejection === 401 ? '未通过 DSH 访问认证' : '拒绝非同源或不受信任的请求',
    })
    return false
  }

  const addRoute = (
    method: string,
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void => {
    const guarded = (req: IncomingMessage, res: ServerResponse): void | Promise<void> => {
      if (!checkAccess(req, res)) return
      if ((req.method ?? 'GET').toUpperCase() !== method.toUpperCase()) {
        sendJson(res, 405, { error: `Method ${req.method ?? 'UNKNOWN'} not allowed` })
        return
      }
      return handler(req, res)
    }
    if (typeof webServer.register === 'function') {
      const d = webServer.register({
        kind: 'exact',
        path,
        handler: guarded,
      })
      if (typeof d === 'function') disposers.push(d)
      return
    }
    if (typeof webServer.route === 'function') {
      const d = webServer.route(method, path, guarded)
      if (typeof d === 'function') disposers.push(d)
    }
  }

  addRoute('GET', '/plugins/agy-acp/status', (_req, res) => {
    sendJson(res, 200, pool.getStatus())
  })

  addRoute('GET', '/plugins/agy-acp/review-models', async (req, res) => {
    let provider = ''
    try {
      const parsed = new URL(req.url ?? '/plugins/agy-acp/review-models', 'http://127.0.0.1')
      provider = (parsed.searchParams.get('provider') ?? '').trim()
    } catch {
      sendJson(res, 400, { error: '无效的查询参数' })
      return
    }
    if (!provider || provider === PROVIDER_ID) {
      const models = pool.getStatus().models.map(m => ({ id: m.value, name: m.name }))
      sendJson(res, 200, { ok: true, provider: PROVIDER_ID, models })
      return
    }
    if (!opts?.listReviewModels) {
      sendJson(res, 200, { ok: true, provider, models: [] })
      return
    }
    try {
      const models = await opts.listReviewModels(provider)
      if (!models) {
        sendJson(res, 404, { error: `未找到已注册的 Provider "${provider}"` })
        return
      }
      sendJson(res, 200, { ok: true, provider, models })
    } catch {
      sendJson(res, 502, { error: `获取 Provider "${provider}" 模型列表失败，可手动输入模型 ID` })
    }
  })

  addRoute('GET', '/plugins/agy-acp/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    res.write(`event: status\ndata: ${JSON.stringify(pool.getStatus())}\n\n`)
    sseClients.add(res)
    attachStatusListener()

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n')
      } catch {
        clearInterval(heartbeat)
        sseClients.delete(res)
        detachStatusListenerIfIdle()
      }
    }, 25_000)
    heartbeat.unref?.()

    req.on('close', () => {
      clearInterval(heartbeat)
      sseClients.delete(res)
      detachStatusListenerIfIdle()
    })
  })

  addRoute('POST', '/plugins/agy-acp/config', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
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

    const currentCfg = pool.getStatus().config
    const effectiveReviewProvider = validated.patch.autoReviewProvider ?? currentCfg.autoReviewProvider ?? ''
    const effectiveReviewModel = validated.patch.autoReviewModel ?? currentCfg.autoReviewModel ?? ''
    if (effectiveReviewProvider && effectiveReviewProvider !== PROVIDER_ID && !effectiveReviewModel) {
      sendJson(res, 400, { error: '选择外部自动审查 Provider 时请同时指定审查模型' })
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
    if (!requireJsonContentType(req, res)) return
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
    const maxAgeMs =
      typeof body.maxAgeMs === 'number' && Number.isFinite(body.maxAgeMs) && body.maxAgeMs > 0
        ? Math.min(3_600_000, Math.max(1_000, Math.floor(body.maxAgeMs)))
        : undefined
    try {
      await pool.refreshAccountQuota(body.accountId, maxAgeMs ? { maxAgeMs } : undefined)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      // Never expose child stderr, slot paths, sandbox argv or inherited env values.
      sendJson(res, err instanceof AccountQuotaError ? err.status : 503,
        { error: err instanceof AccountQuotaError ? err.message : '无法在对应账号的只读环境中查询配额' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/egress/check', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    let accountId: string | undefined
    if (Object.hasOwn(body, 'accountId') && body.accountId !== undefined) {
      if (typeof body.accountId !== 'string' || !body.accountId.trim()) {
        sendJson(res, 400, { error: '请选择有效的账号标识' })
        return
      }
      accountId = body.accountId.trim()
    }
    try {
      await pool.checkAccountEgress(accountId)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      sendJson(
        res,
        err instanceof EgressCheckError ? err.status : 503,
        { error: err instanceof EgressCheckError ? err.message : '无法完成网络出口检测，请稍后重试' },
      )
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/cooldown/clear', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
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

  addRoute('POST', '/plugins/agy-acp/env/check', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    try {
      await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (!opts?.runEnvCheck) {
      sendJson(res, 501, { error: '当前运行环境不支持面板内环境检查' })
      return
    }
    try {
      const report = await opts.runEnvCheck()
      sendJson(res, 200, { ok: true, report, status: pool.getStatus() })
    } catch {
      sendJson(res, 500, { error: '环境检查未能完成，请稍后重试' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/env/install', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (!opts?.startAgyInstall) {
      sendJson(res, 501, { error: '当前运行环境不支持一键安装' })
      return
    }
    const action = body.action === 'update' ? 'update' : 'install'
    const proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl : undefined
    try {
      const task = opts.startAgyInstall({ action, proxyUrl })
      sendJson(res, 200, { ok: true, task, status: pool.getStatus() })
    } catch (err) {
      const status = err instanceof EnvSetupError ? err.status : 500
      sendJson(res, status, { error: err instanceof EnvSetupError ? err.message : '无法启动安装任务，请稍后重试' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/add', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (!opts?.addAccount) {
      sendJson(res, 501, { error: '当前运行环境不支持控制台托管账号' })
      return
    }
    try {
      const account = await opts.addAccount(body)
      sendJson(res, 200, { ok: true, account, status: pool.getStatus() })
    } catch (err) {
      const status = err instanceof AccountStoreError ? err.status : 500
      sendJson(res, status, { error: err instanceof AccountStoreError ? err.message : '添加账号失败，请稍后重试' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/select', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    try {
      const { accountId } = await readJsonBody(req)
      if (accountId !== null && typeof accountId !== 'string') throw new HttpInputError(400, '请指定账号 ID 或 null')
      if (!opts?.selectAccount) throw new HttpInputError(501, '当前运行环境不支持切换账号')
      const id = accountId?.trim() || null
      if (id !== null) {
        const account = pool.getStatus().accounts.find(a => a.id === id)
        if (!account) throw new AccountStoreError('未找到该账号', 404)
        if (!account.enabled) throw new AccountStoreError('账号已停用', 409)
      }
      await opts.selectAccount(id)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      if (err instanceof AccountStoreError || err instanceof HttpInputError) sendJson(res, err.status, { error: err.message })
      else sendJson(res, 500, { error: '切换账号失败，请稍后重试' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/update', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (!opts?.updateAccount) {
      sendJson(res, 501, { error: '当前运行环境不支持编辑账号' })
      return
    }
    try {
      await opts.updateAccount(body)
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      const status = err instanceof AccountStoreError ? err.status : 500
      sendJson(res, status, { error: err instanceof AccountStoreError ? err.message : '更新账号失败，请稍后重试' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/remove', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (!opts?.removeAccount) {
      sendJson(res, 501, { error: '当前运行环境不支持删除账号' })
      return
    }
    if (typeof body.accountId !== 'string' || !body.accountId.trim()) {
      sendJson(res, 400, { error: '请指定要删除的账号 ID' })
      return
    }
    try {
      await opts.removeAccount(body.accountId, { purgeData: body.purgeData === true })
      sendJson(res, 200, { ok: true, status: pool.getStatus() })
    } catch (err) {
      const status = err instanceof AccountStoreError ? err.status : 500
      sendJson(res, status, { error: err instanceof AccountStoreError ? err.message : '删除账号失败，请稍后重试' })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/login/start', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (!opts?.startAccountLogin) {
      sendJson(res, 501, { error: '当前运行环境不支持面板内引导登录' })
      return
    }
    const accountId =
      typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : undefined
    const proxyUrl =
      typeof body.proxyUrl === 'string' && body.proxyUrl.trim() ? body.proxyUrl.trim() : undefined
    try {
      const login = await opts.startAccountLogin({
        ...(accountId ? { accountId } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
      })
      sendJson(res, 200, { ok: true, login, status: pool.getStatus() })
    } catch (err) {
      const status =
        err instanceof AccountLoginError || err instanceof AccountStoreError ? err.status : 502
      sendJson(res, status, {
        error:
          err instanceof AccountLoginError || err instanceof AccountStoreError
            ? err.message
            : '无法启动账号登录流程，请检查 agy CLI 是否已安装',
        status: pool.getStatus(),
      })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/login/submit', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    if (!opts?.submitAccountLoginCode) {
      sendJson(res, 501, { error: '当前运行环境不支持提交登录授权码' })
      return
    }
    if (typeof body.loginId !== 'string' || !body.loginId.trim()) {
      sendJson(res, 400, { error: '缺少登录会话标识，请重新发起登录' })
      return
    }
    if (typeof body.code !== 'string') {
      sendJson(res, 400, { error: '请粘贴 Google 授权码或回调网址' })
      return
    }
    try {
      const login = await opts.submitAccountLoginCode(body.loginId.trim(), body.code)
      sendJson(res, 200, { ok: true, login, status: pool.getStatus() })
    } catch (err) {
      const status = err instanceof AccountLoginError ? err.status : 502
      sendJson(res, status, {
        error: err instanceof AccountLoginError ? err.message : '登录验证失败，请重试',
        status: pool.getStatus(),
      })
    }
  })

  addRoute('POST', '/plugins/agy-acp/accounts/login/cancel', async (req, res) => {
    if (!requireJsonContentType(req, res)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const status = err instanceof HttpInputError ? err.status : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : '无效的 JSON 请求' })
      return
    }
    const loginId = typeof body.loginId === 'string' && body.loginId.trim() ? body.loginId.trim() : undefined
    opts?.cancelAccountLogin?.(loginId)
    sendJson(res, 200, { ok: true, status: pool.getStatus() })
  })

  return () => {
    if (listeningPoolStatus) {
      pool.off('status', pushSnapshot)
      listeningPoolStatus = false
    }
    clearPendingBroadcast()
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
