import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { validateLoginCodeInput } from '../common/account-validation.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { AccountLoginSessionSnapshot } from '../common/types.ts'

const OAUTH_URL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/i
const START_TIMEOUT_MS = 25_000
const IDLE_EXPIRY_MS = 10 * 60_000
const EXCHANGE_TIMEOUT_MS = 45_000

export class AccountLoginError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface StartAccountLoginParams {
  accountId: string
  accountLabel: string
  /** True when this OAuth flow is directly adding a brand-new isolated account without a pre-filled form. */
  isNewAccount?: boolean
  /** Redacted proxy URL shown in the login wizard, when configured. */
  proxyDisplay?: string
  bin: string
  env?: NodeJS.ProcessEnv
  cwd: string
  /**
   * Optional hook executed right after `agy acp --login` exits 0, before reporting success.
   * Used by new-account OAuth login to auto-detect the signed-in Google email and commit the account atomically.
   */
  onBeforeSuccess?: (ctx: {
    outputLog: string
  }) => Promise<{ accountId: string; accountLabel: string } | void> | { accountId: string; accountLabel: string } | void
  /** Optional cleanup hook run when an uncommitted login is cancelled, expired, failed, replaced, or disposed. */
  onCleanup?: () => void
}

export interface AccountLoginManagerOptions {
  /** Test seam for spawning `agy acp --login`. */
  spawnFn?: (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  onLoginSuccess?: (accountId: string) => void | Promise<void>
  now?: () => number
  idleExpiryMs?: number
  startTimeoutMs?: number
  exchangeTimeoutMs?: number
  log?: (msg: string) => void
}

interface ActiveLoginHandle {
  snapshot: AccountLoginSessionSnapshot
  child: ChildProcess | null
  expiryTimer: ReturnType<typeof setTimeout> | null
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; outputTail: string; rawOutput: string }>
  onBeforeSuccess?: StartAccountLoginParams['onBeforeSuccess']
  finalizing: boolean
  cleanupOnce: () => void
  markCommitted: () => void
  cancel: (reason?: string) => void
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
}

function killProcess(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
  const hard = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }, 1500)
  hard.unref?.()
}

/**
 * Orchestrates interactive `agy acp --login` OAuth sessions for in-panel Google sign-in.
 * Extracts the official Google OAuth URL from stdout, accepts the pasted authorization code
 * (or callback URL) via stdin, and tears down idle or cancelled subprocesses deterministically.
 */
export class AccountLoginManager extends EventEmitter {
  private active: ActiveLoginHandle | null = null
  private readonly now: () => number
  private readonly idleExpiryMs: number
  private readonly startTimeoutMs: number
  private readonly exchangeTimeoutMs: number

  constructor(private readonly opts: AccountLoginManagerOptions = {}) {
    super()
    this.now = opts.now ?? (() => Date.now())
    this.idleExpiryMs = opts.idleExpiryMs ?? IDLE_EXPIRY_MS
    this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS
    this.exchangeTimeoutMs = opts.exchangeTimeoutMs ?? EXCHANGE_TIMEOUT_MS
  }

  getActiveSnapshot(): AccountLoginSessionSnapshot | null {
    if (!this.active) return null
    return { ...this.active.snapshot }
  }

  async startLogin(params: StartAccountLoginParams): Promise<AccountLoginSessionSnapshot> {
    // Clean up any prior login attempt before starting a fresh one.
    if (this.active) {
      this.active.cancel('已启动新的登录会话')
      this.active = null
    }

    const loginId = randomUUID().slice(0, 12)
    const startedAt = this.now()
    const expiresAt = startedAt + this.idleExpiryMs
    const snapshot: AccountLoginSessionSnapshot = {
      loginId,
      accountId: params.accountId,
      accountLabel: params.accountLabel,
      ...(params.isNewAccount ? { isNewAccount: true } : {}),
      ...(params.proxyDisplay ? { proxyDisplay: params.proxyDisplay } : {}),
      state: 'starting',
      message: '正在生成 Google 授权登录链接…',
      startedAt,
      expiresAt,
    }

    let cleanedOrCommitted = false
    const cleanupOnce = (): void => {
      if (cleanedOrCommitted) return
      cleanedOrCommitted = true
      try {
        params.onCleanup?.()
      } catch {
        // best-effort cleanup
      }
    }
    const markCommitted = (): void => {
      cleanedOrCommitted = true
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...(params.env ?? process.env),
      AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      BROWSER: 'none',
    }

    let child: ChildProcess
    try {
      child = this.opts.spawnFn
        ? this.opts.spawnFn(params.bin, ['acp', '--login'], { cwd: params.cwd, env: childEnv })
        : spawn(params.bin, ['acp', '--login'], {
            cwd: params.cwd,
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
    } catch (err) {
      cleanupOnce()
      const msg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 180)
      throw new AccountLoginError(msg || '无法启动 agy 登录进程，请先确认已正确安装 agy CLI', 503)
    }

    let outputLog = ''
    let urlFound = false
    const urlDeferred = Promise.withResolvers<string>()
    const exitDeferred = Promise.withResolvers<{
      code: number | null
      signal: NodeJS.Signals | null
      outputTail: string
      rawOutput: string
    }>()

    const handleText = (chunk: Buffer): void => {
      const text = stripAnsi(chunk.toString('utf8'))
      outputLog = (outputLog + text).slice(-4096)
      if (!urlFound) {
        const match = OAUTH_URL_RE.exec(outputLog)
        if (match?.[0]) {
          urlFound = true
          urlDeferred.resolve(match[0])
        }
      }
    }

    child.stdout?.on('data', handleText)
    child.stderr?.on('data', handleText)

    child.once('error', (err) => {
      const msg = sanitizeDiagnosticText(err.message, 180)
      if (!urlFound) {
        urlDeferred.reject(new AccountLoginError(`启动 agy 登录进程失败：${msg || 'spawn error'}`, 503))
      }
      exitDeferred.resolve({ code: null, signal: null, outputTail: msg, rawOutput: outputLog })
    })

    child.once('close', (code, signal) => {
      if (handle.expiryTimer) {
        clearTimeout(handle.expiryTimer)
        handle.expiryTimer = null
      }
      const tail = extractConciseReason(outputLog)
      if (!urlFound) {
        urlDeferred.reject(
          new AccountLoginError(
            tail || `agy 登录进程提前退出（code=${String(code ?? signal ?? 'unknown')}），请确认 agy 版本支持 acp --login`,
            502,
          ),
        )
      }
      exitDeferred.resolve({ code, signal, outputTail: tail, rawOutput: outputLog })
      // If the user hasn't explicitly submitted/cancelled yet and the process exited on its own
      // (for example, desktop OAuth loopback callback completed automatically without stdin paste):
      if (this.active === handle && snapshot.state === 'awaiting_code' && !handle.finalizing) {
        handle.child = null
        if (code === 0) {
          void this.finalizeSuccess(handle, outputLog).catch((err) => {
            handle.cleanupOnce()
            const msg =
              err instanceof AccountLoginError
                ? err.message
                : sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 200)
            handle.snapshot.state = 'failed'
            handle.snapshot.message = msg || '登录验证失败，请重试'
            this.emit('change')
          })
        } else {
          cleanupOnce()
          snapshot.state = 'failed'
          snapshot.message = tail || '登录进程意外终止，请点击重新发起登录'
          this.emit('change')
        }
      }
    })

    const handle: ActiveLoginHandle = {
      snapshot,
      child,
      expiryTimer: null,
      exitPromise: exitDeferred.promise,
      onBeforeSuccess: params.onBeforeSuccess,
      finalizing: false,
      cleanupOnce,
      markCommitted,
      cancel: (reason?: string) => {
        if (handle.expiryTimer) {
          clearTimeout(handle.expiryTimer)
          handle.expiryTimer = null
        }
        killProcess(child)
        handle.child = null
        cleanupOnce()
        if (snapshot.state === 'starting' || snapshot.state === 'awaiting_code' || snapshot.state === 'exchanging') {
          snapshot.state = 'cancelled'
          snapshot.message = reason || '已取消登录'
          this.emit('change')
        }
      },
    }

    this.active = handle
    this.emit('change')

    let startTimer: ReturnType<typeof setTimeout> | null = null
    const startTimeout = new Promise<never>((_, reject) => {
      startTimer = setTimeout(() => {
        reject(new AccountLoginError('等待 agy 输出 Google 授权链接超时，请检查 agy CLI 版本与代理配置', 504))
      }, this.startTimeoutMs)
      startTimer.unref?.()
    })

    try {
      const authUrl = await Promise.race([urlDeferred.promise, startTimeout])
      if (startTimer) clearTimeout(startTimer)
      if (this.active !== handle || snapshot.state === 'cancelled') {
        killProcess(child)
        cleanupOnce()
        throw new AccountLoginError('登录流程已被取消', 409)
      }
      snapshot.authUrl = authUrl
      snapshot.state = 'awaiting_code'
      snapshot.message = params.isNewAccount
        ? '在浏览器完成 Google 授权后，将页面给出的授权码（或跳转后的完整网址）粘贴到下方即可自动添加账号'
        : '请在浏览器完成 Google 授权，然后将授权码或跳转后的完整网址粘贴到下方输入框'
      handle.expiryTimer = setTimeout(() => {
        if (this.active === handle && snapshot.state === 'awaiting_code') {
          handle.cancel('登录会话已超时，请重新获取授权链接')
        }
      }, this.idleExpiryMs)
      handle.expiryTimer.unref?.()
      this.emit('change')
      return { ...snapshot }
    } catch (err) {
      if (startTimer) clearTimeout(startTimer)
      killProcess(child)
      handle.child = null
      cleanupOnce()
      const msg = err instanceof AccountLoginError ? err.message : sanitizeDiagnosticText(String(err), 200)
      snapshot.state = 'failed'
      snapshot.message = msg || '生成登录链接失败'
      this.emit('change')
      throw err instanceof AccountLoginError ? err : new AccountLoginError(snapshot.message, 502)
    }
  }

  async submitCode(loginId: string, rawCode: string): Promise<AccountLoginSessionSnapshot> {
    const codeChecked = validateLoginCodeInput(rawCode)
    if (!codeChecked.ok) {
      throw new AccountLoginError(codeChecked.error, 400)
    }
    const handle = this.active
    if (!handle || handle.snapshot.loginId !== loginId) {
      throw new AccountLoginError('当前登录会话不存在或已过期，请重新点击「登录」获取新链接', 409)
    }
    if (handle.snapshot.state !== 'awaiting_code' || !handle.child?.stdin || handle.finalizing) {
      throw new AccountLoginError('当前登录会话不在等待输入授权码状态，请重新发起登录', 409)
    }

    handle.finalizing = true
    handle.snapshot.state = 'exchanging'
    handle.snapshot.message = '正在向 Google 验证授权码并保存凭据…'
    this.emit('change')

    try {
      handle.child.stdin.write(`${codeChecked.value}\n`)
      handle.child.stdin.end()
    } catch {
      handle.cancel('写入授权码失败，登录进程已关闭')
      throw new AccountLoginError('登录进程已关闭，请重新获取登录链接', 409)
    }

    let exchangeTimer: ReturnType<typeof setTimeout> | null = null
    const exchangeTimeout = new Promise<never>((_, reject) => {
      exchangeTimer = setTimeout(() => {
        killProcess(handle.child)
        reject(new AccountLoginError('验证授权码超时，请检查该账号的代理设置或网络连通性后重试', 504))
      }, this.exchangeTimeoutMs)
      exchangeTimer.unref?.()
    })

    try {
      const outcome = await Promise.race([handle.exitPromise, exchangeTimeout])
      if (exchangeTimer) clearTimeout(exchangeTimer)
      handle.child = null
      if (outcome.code === 0) {
        return await this.finalizeSuccess(handle, outcome.rawOutput)
      }
      handle.cleanupOnce()
      handle.snapshot.state = 'failed'
      handle.snapshot.message =
        outcome.outputTail || '授权码验证失败或已过期，请点击「重新获取链接」再试一次'
      this.emit('change')
      throw new AccountLoginError(handle.snapshot.message, 400)
    } catch (err) {
      if (exchangeTimer) clearTimeout(exchangeTimer)
      handle.cleanupOnce()
      if (err instanceof AccountLoginError) {
        handle.snapshot.state = 'failed'
        handle.snapshot.message = err.message
        this.emit('change')
        throw err
      }
      const msg = sanitizeDiagnosticText(String(err), 200) || '登录验证失败'
      handle.snapshot.state = 'failed'
      handle.snapshot.message = msg
      this.emit('change')
      throw new AccountLoginError(msg, 502)
    }
  }

  private async finalizeSuccess(handle: ActiveLoginHandle, rawOutput: string): Promise<AccountLoginSessionSnapshot> {
    handle.finalizing = true
    if (handle.onBeforeSuccess) {
      const committed = await handle.onBeforeSuccess({ outputLog: rawOutput })
      if (committed) {
        handle.snapshot.accountId = committed.accountId
        handle.snapshot.accountLabel = committed.accountLabel
      }
    }
    handle.markCommitted()
    handle.snapshot.state = 'succeeded'
    handle.snapshot.message = handle.snapshot.isNewAccount
      ? `已成功登录并添加账号「${handle.snapshot.accountLabel}」！`
      : `账号「${handle.snapshot.accountLabel}」登录成功！`
    delete handle.snapshot.authUrl
    const succeeded = { ...handle.snapshot }
    if (this.active === handle) this.active = null
    try {
      await this.opts.onLoginSuccess?.(succeeded.accountId)
    } catch (err) {
      this.opts.log?.(`onLoginSuccess callback warning: ${sanitizeDiagnosticText(String(err), 160)}`)
    }
    this.emit('change')
    return succeeded
  }

  cancelLogin(loginId?: string): void {
    if (!this.active) return
    if (loginId && this.active.snapshot.loginId !== loginId) return
    this.active.cancel('已取消登录')
    this.active = null
    this.emit('change')
  }

  dispose(): void {
    if (this.active) {
      this.active.cancel('插件已卸载')
      this.active = null
    }
    this.removeAllListeners()
  }
}

function extractConciseReason(rawOutput: string): string {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !OAUTH_URL_RE.test(l) && !/^open this link/i.test(l) && !/^then paste/i.test(l))
  const last = lines.slice(-2).join(' ')
  return sanitizeDiagnosticText(last, 200)
}
