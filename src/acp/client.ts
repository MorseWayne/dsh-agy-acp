import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcId,
  JsonRpcResponse,
  RequestPermissionParams,
  RequestPermissionResult,
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
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

interface PendingCall {
  method: string
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

/**
 * Bidirectional JSON-RPC 2.0 client over stdio for `agy acp`.
 * Supports concurrent pending requests, server-initiated permission callbacks,
 * and per-session `session/update` streaming subscriptions.
 */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private rl: ReadlineInterface | null = null
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingCall>()
  private readonly sessionListeners = new Map<string, Set<UpdateListener>>()
  private readonly globalListeners = new Set<(notif: SessionUpdateNotification) => void>()
  private stderrRing: string[] = []
  private closed = false

  constructor(private readonly opts: AcpClientOptions) {}

  get isRunning(): boolean {
    return this.child !== null && !this.closed && this.child.exitCode === null
  }

  get recentStderr(): string {
    return this.stderrRing.join('')
  }

  start(): void {
    if (this.child !== null) return
    this.closed = false
    const args = this.opts.args ?? ['acp']
    const child = spawn(this.opts.bin, args, {
      cwd: this.opts.cwd || process.cwd(),
      env: this.opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own the local process group so a sandbox wrapper is not the only process stopped.
      detached: process.platform !== 'win32',
    })
    this.child = child

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrRing.push(text)
      if (this.stderrRing.length > 50) this.stderrRing.shift()
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.rl = rl
    rl.on('line', (line) => this.handleLine(line))

    child.on('error', (err) => {
      this.opts.onLog?.(`agy acp spawn error: ${err.message}`)
      this.failAllPending(err)
    })

    child.on('exit', (code, signal) => {
      this.closed = true
      this.child = null
      this.rl?.close()
      this.rl = null
      const err = new Error(`agy acp exited (code=${String(code)}, signal=${String(signal)})`)
      this.failAllPending(err)
      this.opts.onExit?.(code, signal)
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
      throw new Error(`AcpClient is not running (cannot call ${method})`)
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    const limit = timeoutMs ?? this.opts.defaultTimeoutMs ?? 120_000

    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
      }
      if (limit > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`ACP request "${method}" timed out after ${limit}ms`))
        }, limit)
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          if (entry.timer) clearTimeout(entry.timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.isRunning || !this.child) return
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
    this.child.stdin.write(payload)
  }

  // ---- High-level ACP methods ---------------------------------------------

  initialize(params?: Partial<InitializeParams>): Promise<InitializeResult> {
    return this.request<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-agy-acp', version: '0.1.0' },
      ...params,
    }, 15_000)
  }

  sessionNew(params: SessionNewParams): Promise<SessionNewResult> {
    return this.request<SessionNewResult>('session/new', params, 30_000)
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

  dispose(): void {
    this.closed = true
    this.failAllPending(new Error('AcpClient disposed'))
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

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      this.opts.onLog?.(`non-JSON stdout from agy acp: ${trimmed.slice(0, 200)}`)
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
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    if (!this.isRunning || !this.child) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
  }

  private failAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
      this.pending.delete(id)
    }
  }
}
