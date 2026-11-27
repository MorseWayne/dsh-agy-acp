import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOfficialAgyInstallCommand, validateProxyUrl } from '../common/account-validation.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { AgyInstallTaskSnapshot } from '../common/types.ts'
import { mergeLoopbackNoProxy } from './account-pool.ts'

export const OFFICIAL_AGY_INSTALL_SH_URL = 'https://antigravity.google/cli/install.sh'
export const OFFICIAL_AGY_INSTALL_PS1_URL = 'https://antigravity.google/cli/install.ps1'

const MAX_LOG_LINES = 40
const MAX_SCRIPT_BYTES = 512 * 1024
const INSTALL_TIMEOUT_MS = 180_000

export class EnvSetupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface InstallRunContext {
  action: 'install' | 'update'
  env: NodeJS.ProcessEnv
  binPath: string | null
  signal: AbortSignal
  appendLog: (line: string) => void
}

export interface AgyInstallerOptions {
  resolveBin: () => string | null
  platform?: NodeJS.Platform
  onInstalled?: (binPath: string) => void | Promise<void>
  /** Test seam to replace real subprocess execution. */
  runner?: (ctx: InstallRunContext) => Promise<void>
  log?: (msg: string) => void
}

function buildInstallEnv(proxyUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (proxyUrl) {
    env.HTTPS_PROXY = proxyUrl
    env.HTTP_PROXY = proxyUrl
    env.ALL_PROXY = proxyUrl
    env.https_proxy = proxyUrl
    env.http_proxy = proxyUrl
    env.all_proxy = proxyUrl
    const existingNoProxy = [env.NO_PROXY, env.no_proxy].filter((v): v is string => Boolean(v?.trim())).join(',')
    const merged = mergeLoopbackNoProxy(existingNoProxy)
    env.NO_PROXY = merged
    env.no_proxy = merged
  }
  return env
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
}

function runSubprocess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  onLine: (line: string) => void,
  captureStdout?: { chunks: Buffer[]; maxBytes: number },
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      reject(err)
      return
    }

    let settled = false
    let timedOut = false
    let totalBytes = 0
    let stdoutBuf = ''
    let stderrBuf = ''

    const flushLines = (buf: string, isFinal: boolean): string => {
      const parts = buf.split(/\r?\n/)
      const rest = isFinal ? '' : (parts.pop() ?? '')
      for (const raw of parts) {
        const clean = sanitizeDiagnosticText(stripAnsi(raw), 200)
        if (clean) onLine(clean)
      }
      if (isFinal && rest.trim()) {
        const clean = sanitizeDiagnosticText(stripAnsi(rest), 200)
        if (clean) onLine(clean)
      }
      return rest
    }

    const terminate = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 1500)
      hard.unref?.()
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    timer.unref?.()

    const onAbort = (): void => {
      terminate()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (captureStdout) {
        totalBytes += chunk.length
        if (totalBytes > captureStdout.maxBytes) {
          terminate()
          if (!settled) {
            settled = true
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            reject(new Error('官方安装脚本体积超出安全限制'))
          }
          return
        }
        captureStdout.chunks.push(chunk)
      } else {
        stdoutBuf = flushLines(stdoutBuf + chunk.toString('utf8'), false)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = flushLines(stderrBuf + chunk.toString('utf8'), false)
    })

    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.once('close', (code, exitSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (!captureStdout) flushLines(stdoutBuf, true)
      flushLines(stderrBuf, true)
      if (timedOut) {
        reject(new Error('执行超时，请检查网络连接或填写代理地址后重试'))
        return
      }
      if (signal.aborted) {
        reject(new Error('安装任务已取消'))
        return
      }
      resolve({ code, signal: exitSignal })
    })
  })
}

async function defaultInstallRunner(ctx: InstallRunContext, platform: NodeJS.Platform): Promise<void> {
  if (ctx.action === 'update') {
    if (!ctx.binPath) {
      throw new Error('未检测到已安装的 agy，请先执行一键安装')
    }
    ctx.appendLog('正在调用 agy update 检查并升级到最新版本…')
    const res = await runSubprocess(ctx.binPath, ['update'], ctx.env, ctx.signal, INSTALL_TIMEOUT_MS, ctx.appendLog)
    if (res.code !== 0) {
      throw new Error(`agy update 退出码 ${String(res.code ?? res.signal ?? 'unknown')}，请检查网络或稍后重试`)
    }
    return
  }

  if (platform === 'win32') {
    ctx.appendLog('正在通过官方 PowerShell 安装脚本下载并安装 Antigravity CLI…')
    const res = await runSubprocess(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm '${OFFICIAL_AGY_INSTALL_PS1_URL}' | iex`],
      ctx.env,
      ctx.signal,
      INSTALL_TIMEOUT_MS,
      ctx.appendLog,
    )
    if (res.code !== 0) {
      throw new Error(`Windows 官方安装脚本退出码 ${String(res.code ?? res.signal ?? 'unknown')}`)
    }
    return
  }

  // Unix (macOS / Linux): download official script first, validate basic shell header, then execute via bash.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-install-'))
  try {
    ctx.appendLog('第 1/2 步：正在从 Google 官方源下载安装脚本…')
    const capture = { chunks: [] as Buffer[], maxBytes: MAX_SCRIPT_BYTES }
    let dl: { code: number | null; signal: NodeJS.Signals | null }
    try {
      dl = await runSubprocess(
        'curl',
        ['-fsSL', '--connect-timeout', '20', '--max-time', '90', OFFICIAL_AGY_INSTALL_SH_URL],
        ctx.env,
        ctx.signal,
        100_000,
        ctx.appendLog,
        capture,
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') {
        throw new Error('当前系统缺少 curl 命令，请先安装 curl 或在终端手动安装 agy')
      }
      throw err
    }
    if (dl.code !== 0) {
      throw new Error('下载官方安装脚本失败，请检查网络连接（若需代理请填写代理地址后重试）')
    }

    const scriptContent = Buffer.concat(capture.chunks).toString('utf8')
    if (!scriptContent.trimStart().startsWith('#!')) {
      throw new Error('下载到的安装脚本格式异常（可能被网络拦截），请检查代理或网络设置')
    }

    const scriptPath = path.join(tmpDir, 'install.sh')
    writeFileSync(scriptPath, scriptContent, { encoding: 'utf8', mode: 0o700 })

    ctx.appendLog('第 2/2 步：正在执行官方安装脚本，安装 agy 到本机用户目录…')
    let execRes: { code: number | null; signal: NodeJS.Signals | null }
    try {
      execRes = await runSubprocess('bash', [scriptPath], ctx.env, ctx.signal, INSTALL_TIMEOUT_MS, ctx.appendLog)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') {
        throw new Error('当前系统缺少 bash，无法运行官方安装脚本')
      }
      throw err
    }
    if (execRes.code !== 0) {
      throw new Error(`官方安装脚本执行失败（退出码 ${String(execRes.code ?? execRes.signal ?? 'unknown')}）`)
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore temp cleanup failure
    }
  }
}

/**
 * Safely manages one-click official Antigravity CLI (`agy`) installation and upgrades.
 * Only executes fixed official Google installer URLs — never arbitrary user commands.
 */
export class AgyInstaller extends EventEmitter {
  private readonly platform: NodeJS.Platform
  private task: AgyInstallTaskSnapshot
  private activeController: AbortController | null = null
  private activePromise: Promise<void> | null = null

  constructor(private readonly opts: AgyInstallerOptions) {
    super()
    this.platform = opts.platform ?? process.platform
    this.task = {
      state: 'idle',
      action: 'install',
      message: '',
      logs: [],
      manualCommand: getOfficialAgyInstallCommand(this.platform),
    }
  }

  get manualInstallCommand(): string {
    return getOfficialAgyInstallCommand(this.platform)
  }

  getSnapshot(): AgyInstallTaskSnapshot {
    return {
      ...this.task,
      logs: [...this.task.logs],
    }
  }

  isRunning(): boolean {
    return this.task.state === 'running'
  }

  start(input: { action?: 'install' | 'update'; proxyUrl?: string } = {}): AgyInstallTaskSnapshot {
    if (this.task.state === 'running') {
      throw new EnvSetupError('当前已有安装或升级任务正在进行中，请等待完成', 409)
    }

    const action: 'install' | 'update' = input.action === 'update' ? 'update' : 'install'
    const proxyChecked = validateProxyUrl(input.proxyUrl)
    if (!proxyChecked.ok) {
      throw new EnvSetupError(proxyChecked.error, 400)
    }

    const existingBin = this.opts.resolveBin()
    if (action === 'update' && !existingBin) {
      throw new EnvSetupError('未找到已安装的 agy，请先执行一键安装', 409)
    }

    const controller = new AbortController()
    this.activeController = controller
    const now = Date.now()
    this.task = {
      state: 'running',
      action,
      startedAt: now,
      message: action === 'update' ? '正在升级 Antigravity CLI (agy)…' : '正在安装 Antigravity CLI (agy)…',
      logs: [],
      manualCommand: this.manualInstallCommand,
    }
    this.emit('change')

    const appendLog = (raw: string): void => {
      const clean = sanitizeDiagnosticText(raw, 200)
      if (!clean) return
      this.task.logs.push(clean)
      if (this.task.logs.length > MAX_LOG_LINES) {
        this.task.logs.splice(0, this.task.logs.length - MAX_LOG_LINES)
      }
      this.emit('change')
    }

    const env = buildInstallEnv(proxyChecked.value || undefined)
    const runCtx: InstallRunContext = {
      action,
      env,
      binPath: existingBin,
      signal: controller.signal,
      appendLog,
    }

    const runner = this.opts.runner ?? ((c: InstallRunContext) => defaultInstallRunner(c, this.platform))
    this.activePromise = (async () => {
      try {
        await runner(runCtx)
        const resolved = this.opts.resolveBin()
        if (!resolved) {
          throw new Error('安装脚本已退出，但未能自动检测到 agy 可执行文件，请在配置中手动指定 agyBin 路径')
        }
        appendLog(`已检测到可执行文件：${resolved}`)
        this.task = {
          ...this.task,
          state: 'succeeded',
          finishedAt: Date.now(),
          message: action === 'update' ? 'Antigravity CLI (agy) 升级完成！' : 'Antigravity CLI (agy) 安装成功！',
        }
        this.emit('change')
        await this.opts.onInstalled?.(resolved)
      } catch (err) {
        const msg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 240) || '操作失败'
        this.opts.log?.(`agy ${action} failed: ${msg}`)
        this.task = {
          ...this.task,
          state: 'failed',
          finishedAt: Date.now(),
          message: msg,
        }
        this.emit('change')
      } finally {
        if (this.activeController === controller) {
          this.activeController = null
        }
      }
    })()

    return this.getSnapshot()
  }

  /** Wait for the active task to finish (primarily useful for tests). */
  async waitForCompletion(): Promise<AgyInstallTaskSnapshot> {
    await this.activePromise
    return this.getSnapshot()
  }

  dispose(): void {
    this.activeController?.abort()
    this.activeController = null
    this.removeAllListeners()
  }
}
