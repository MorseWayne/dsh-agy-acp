import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcId,
  JsonRpcResponse,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionLoadParams,
  SessionLoadResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionSetConfigOptionParams,
  SessionSetConfigOptionResult,
  SessionUpdateNotification,
  SessionUpdatePayload,
} from './protocol.ts'

export type PermissionHandler = (
  params: RequestPermissionParams,
) => Promise<RequestPermissionResult> | RequestPermissionResult

export type UpdateListener = (update: SessionUpdatePayload) => void

export interface AcpClientOptions {
  bin: string
  /** Exact arguments, including the acp subcommand (possibly wrapped by the DSH sandbox). */
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  defaultTimeoutMs?: number
  onPermission?: PermissionHandler
  onLog?: (msg: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null, client: AcpClient) => void
}

interface PendingCall {
  method: string
  stderrStartOffset: number
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class AcpRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(`ACP RPC error (${code}): ${message}`)
    this.name = 'AcpRpcError'
    this.code = code
    this.data = data
  }
}

export class AcpTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number
  readonly stderrTail: string

  constructor(method: string, timeoutMs: number, stderrTail = '') {
    const suffix = stderrTail ? ` [stderr: ${stderrTail}]` : ''
    super(`ACP request "${method}" timed out after ${timeoutMs}ms${suffix}`)
    this.name = 'AcpTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
    this.stderrTail = stderrTail
  }
}

export class AcpProcessExitError extends Error {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderrTail: string
  readonly causeError?: string

  constructor(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail = '',
    causeError?: string,
  ) {
    const safeCause = causeError ? sanitizeDiagnosticText(causeError, 200) : undefined
    const base = safeCause
      ? `agy acp process error (${safeCause})`
      : `agy acp exited (code=${String(code)}, signal=${String(signal)})`
    const suffix = stderrTail ? ` [stderr: ${stderrTail}]` : ''
    super(`${base}${suffix}`)
    this.name = 'AcpProcessExitError'
    this.code = code
    this.signal = signal
    this.stderrTail = stderrTail
    if (safeCause) this.causeError = safeCause
  }
}

const MAX_STDERR_CHUNKS = 50
const MAX_STDERR_BYTES = 64 * 1024
const EXIT_CLOSE_FALLBACK_MS = 250

/**
 * Bidirectional JSON-RPC 2.0 client over stdio for `agy acp`.
 * Supports concurrent pending requests, server-initiated permission callbacks,
 * per-session `session/update` streaming subscriptions, and sanitized exit/timeout diagnostics.
 */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private rl: ReadlineInterface | null = null
  private spawnedPid?: number
  get pid(): number | undefined { return this.spawnedPid }

  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingCall>()
  private readonly sessionListeners = new Map<string, Set<UpdateListener>>()
  private readonly globalListeners = new Set<(notif: SessionUpdateNotification) => void>()
  private stderrRing: string[] = []
  private stderrBytes = 0
  private stderrTotalChars = 0
  private stderrBaseOffset = 0
  private closed = false
  private disposedByCaller = false
  private exitSettled = false
  private exitFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private lastExitError: AcpProcessExitError | null = null

  constructor(private readonly opts: AcpClientOptions) {}

  get isRunning(): boolean {
    return this.child !== null && !this.closed && !this.disposedByCaller && this.child.exitCode === null
  }

  get recentStderr(): string {
    return this.stderrRing.join('')
  }

  /** Monotonic character offset into this client's stderr stream for per-turn slicing. */
  stderrOffset(): number {
    return this.stderrTotalChars
  }

  /** Returns retained stderr written since `offset` (clamped if older chunks rolled off the ring). */
  readStderrSince(offset: number): string {
    if (!Number.isFinite(offset) || offset <= this.stderrBaseOffset) {
      return this.recentStderr
    }
    if (offset >= this.stderrTotalChars) {
      return ''
    }
    const rel = Math.floor(offset) - this.stderrBaseOffset
    return rel <= 0 ? this.recentStderr : this.recentStderr.slice(rel)
  }

  start(): void {
    if (this.child !== null) return
    this.closed = false
    this.disposedByCaller = false
    this.exitSettled = false
    this.lastExitError = null
    this.stderrRing = []
    this.stderrBytes = 0
    this.stderrTotalChars = 0
    this.stderrBaseOffset = 0

    const args = this.opts.args ?? ['acp']
    const child = spawn(this.opts.bin, args, {
      cwd: this.opts.cwd || process.cwd(),
      env: this.opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own the local process group so a sandbox wrapper is not the only process stopped.
      detached: process.platform !== 'win32',
    })
    this.spawnedPid = child.pid
    this.child = child

    // Prevent unhandled EPIPE crashes if the child exits while writing notifications/responses.
    child.stdin.on('error', () => {
      // handled per-request or by process exit settlement
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      const bytes = Buffer.byteLength(text, 'utf8')
      this.stderrRing.push(text)
      this.stderrBytes += bytes
      this.stderrTotalChars += text.length
      while (
        this.stderrRing.length > 1 &&
        (this.stderrRing.length > MAX_STDERR_CHUNKS || this.stderrBytes > MAX_STDERR_BYTES)
      ) {
        const dropped = this.stderrRing.shift()!
        this.stderrBytes -= Buffer.byteLength(dropped, 'utf8')
        this.stderrBaseOffset += dropped.length
      }
      if (this.stderrBytes > MAX_STDERR_BYTES && this.stderrRing.length === 1) {
        const only = this.stderrRing[0]!
        const sliceStart = Math.max(0, only.length - MAX_STDERR_BYTES)
        const clipped = only.slice(sliceStart)
        this.stderrRing[0] = clipped
        this.stderrBytes = Buffer.byteLength(clipped, 'utf8')
        this.stderrBaseOffset += sliceStart
      }
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.rl = rl
    rl.on('line', (line) => this.handleLine(line))

    child.on('error', (err) => {
      this.opts.onLog?.(`agy acp spawn error: ${sanitizeDiagnosticText(err.message, 200)}`)
      this.settleProcessTermination(null, null, err)
    })

    child.on('exit', (code, signal) => {
      if (this.disposedByCaller) return
      this.closed = true
      if (!this.exitSettled && !this.exitFallbackTimer) {
        this.exitFallbackTimer = setTimeout(() => {
          this.exitFallbackTimer = null
          this.settleProcessTermination(code, signal)
        }, EXIT_CLOSE_FALLBACK_MS)
        this.exitFallbackTimer.unref?.()
      }
    })

    // Wait for `close` so stdout/stderr pipes are completely drained before building diagnostics.
    child.on('close', (code, signal) => {
      this.settleProcessTermination(code, signal)
    })
  }

  onSessionUpdate(sessionId: string, listener: UpdateListener): () => void {
    let set = this.sessionListeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionListeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.sessionListeners.delete(sessionId)
    }
  }

  onAnyUpdate(listener: (notif: SessionUpdateNotification) => void): () => void {
    this.globalListeners.add(listener)
    return () => {
      this.globalListeners.delete(listener)
    }
  }

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.isRunning || !this.child) {
      if (!this.disposedByCaller) {
        if (this.lastExitError) throw this.lastExitError
        if (this.closed) {
          throw new AcpProcessExitError(
            null,
            null,
            sanitizeDiagnosticText(this.recentStderr),
            `AcpClient is not running (cannot call ${method})`,
          )
        }
      }
      throw new Error(`AcpClient is not running (cannot call ${method})`)
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    const limit = timeoutMs ?? this.opts.defaultTimeoutMs ?? 120_000
    const stderrStartOffset = this.stderrOffset()

    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = {
        method,
        stderrStartOffset,
        resolve: resolve as (v: unknown) => void,
        reject,
      }
      if (limit > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new AcpTimeoutError(method, limit, sanitizeDiagnosticText(this.readStderrSince(entry.stderrStartOffset))))
        }, limit)
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          if (entry.timer) clearTimeout(entry.timer)
          if (!this.pending.delete(id)) return
          if (!this.disposedByCaller) {
            reject(
              new AcpProcessExitError(
                null,
                null,
                sanitizeDiagnosticText(this.readStderrSince(entry.stderrStartOffset)),
                err.message,
              ),
            )
          } else {
            reject(err)
          }
        }
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.isRunning || !this.child) return
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
    try {
      this.child.stdin.write(payload)
    } catch {
      // ignore write error on closing pipe
    }
  }

  // ---- High-level ACP methods ---------------------------------------------

  initialize(params?: Partial<InitializeParams>): Promise<InitializeResult> {
    return this.request<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-agy-acp', version: '0.4.2' },
      ...params,
    }, 15_000)
  }

  sessionNew(params: SessionNewParams): Promise<SessionNewResult> {
    return this.request<SessionNewResult>('session/new', params, 30_000)
  }

  sessionLoad(params: SessionLoadParams): Promise<SessionLoadResult> {
    return this.request<SessionLoadResult>('session/load', params, 30_000)
  }

  sessionSetConfigOption(params: SessionSetConfigOptionParams): Promise<SessionSetConfigOptionResult> {
    return this.request<SessionSetConfigOptionResult>('session/set_config_option', params, 15_000)
  }

  sessionPrompt(params: SessionPromptParams, timeoutMs?: number): Promise<SessionPromptResult> {
    return this.request<SessionPromptResult>('session/prompt', params, timeoutMs)
  }

  sessionCancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId })
  }

  sessionClose(sessionId: string): Promise<Record<string, never>> {
    return this.request<Record<string, never>>('session/close', { sessionId }, 10_000)
  }

  dispose(reason = new Error('AcpClient disposed')): void {
    this.disposedByCaller = true
    this.closed = true
    this.exitSettled = true
    if (this.exitFallbackTimer) {
      clearTimeout(this.exitFallbackTimer)
      this.exitFallbackTimer = null
    }
    this.failAllPending(reason)
    this.rl?.close()
    this.rl = null
    if (this.child) {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGKILL')
        else this.child.kill()
      } catch {
        // ignore
      }
      this.child = null
    }
    this.sessionListeners.clear()
    this.globalListeners.clear()
  }

  // ---- Internal JSON-RPC dispatch -----------------------------------------

  private settleProcessTermination(
    code: number | null,
    signal: NodeJS.Signals | null,
    causeErr?: Error,
  ): void {
    if (this.exitSettled || this.disposedByCaller) return
    this.exitSettled = true
    this.closed = true
    if (this.exitFallbackTimer) {
      clearTimeout(this.exitFallbackTimer)
      this.exitFallbackTimer = null
    }
    this.child = null
    this.rl?.close()
    this.rl = null
    const exitErr = new AcpProcessExitError(
      code,
      signal,
      sanitizeDiagnosticText(this.recentStderr),
      causeErr?.message,
    )
    this.lastExitError = exitErr
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      const turnStderr = sanitizeDiagnosticText(this.readStderrSince(entry.stderrStartOffset))
      entry.reject(new AcpProcessExitError(code, signal, turnStderr, causeErr?.message))
      this.pending.delete(id)
    }
    this.opts.onExit?.(code, signal, this)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      this.opts.onLog?.(`non-JSON stdout from agy acp: ${sanitizeDiagnosticText(trimmed, 200)}`)
      return
    }

    // 1. Server -> Client RPC request (has both `id` and `method`)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.handleServerRequest(msg.id as JsonRpcId, msg.method, msg.params)
      return
    }

    // 2. Response to our pending request
    if (msg.id !== undefined && this.pending.has(msg.id as JsonRpcId)) {
      const id = msg.id as JsonRpcId
      const entry = this.pending.get(id)!
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      const resp = msg as unknown as JsonRpcResponse
      if (resp.error) {
        entry.reject(new AcpRpcError(resp.error.code, resp.error.message, resp.error.data))
      } else {
        entry.resolve(resp.result)
      }
      return
    }

    // 3. Notification (e.g. session/update)
    if (msg.method === 'session/update' && msg.params && typeof msg.params === 'object') {
      const notif = msg.params as SessionUpdateNotification
      if (notif.sessionId && notif.update) {
        const set = this.sessionListeners.get(notif.sessionId)
        if (set) {
          for (const fn of set) {
            try {
              fn(notif.update)
            } catch {
              // isolate listener errors
            }
          }
        }
        for (const fn of this.globalListeners) {
          try {
            fn(notif)
          } catch {
            // isolate listener errors
          }
        }
      }
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      if (method === 'session/request_permission') {
        const req = params as RequestPermissionParams
        let result: RequestPermissionResult
        if (this.opts.onPermission) {
          result = await this.opts.onPermission(req)
        } else {
          result = { outcome: { outcome: 'cancelled' } }
        }
        this.writeResponse(id, result)
        return
      }
      this.writeResponse(id, {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.writeError(id, -32603, message)
    }
  }

  private writeResponse(id: JsonRpcId, result: unknown): void {
    if (!this.isRunning || !this.child) return
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
    } catch {
      // ignore write error on closing pipe
    }
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    if (!this.isRunning || !this.child) return
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
    } catch {
      // ignore write error on closing pipe
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
      this.pending.delete(id)
    }
  }
}
