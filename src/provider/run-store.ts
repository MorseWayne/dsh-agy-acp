import { randomUUID } from 'node:crypto'
import type { AcpToolCallUpdate, AcpUsage, SessionUpdatePayload } from '../acp/protocol.ts'

export interface NormalizedLocation {
  path: string
  line?: number
}

export interface MergedToolCall {
  toolCallId: string
  step: number
  name?: string
  kind?: string
  title?: string
  rawInput?: unknown
  args?: Record<string, unknown>
  locations?: NormalizedLocation[]
  rawOutput?: unknown
  content?: Array<{ type: string; content?: { type: string; text?: string } }>
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  settled: boolean
}

export interface ToolCompletionResult {
  tool: MergedToolCall | null
  aborted: boolean
  runError?: string
}

export type RunItem =
  | { kind: 'update'; update: SessionUpdatePayload }
  | { kind: 'done'; stopReason: string; usage?: AcpUsage }
  | { kind: 'error'; error: Error }

export function normalizeLocations(raw: unknown, maxItems = 32): NormalizedLocation[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: NormalizedLocation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.path !== 'string' || rec.path.trim() === '') continue
    const loc: NormalizedLocation = { path: rec.path }
    if (typeof rec.line === 'number' && Number.isFinite(rec.line) && rec.line >= 1) {
      loc.line = Math.floor(rec.line)
    }
    out.push(loc)
    if (out.length >= maxItems) break
  }
  return out.length > 0 ? out : undefined
}

function toToolCallUpdate(tc: MergedToolCall): AcpToolCallUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: tc.toolCallId,
    ...(tc.name !== undefined ? { name: tc.name } : {}),
    ...(tc.args !== undefined ? { args: tc.args } : {}),
    status: tc.status,
    ...(tc.kind !== undefined ? { kind: tc.kind } : {}),
    ...(tc.title !== undefined ? { title: tc.title } : {}),
    ...(tc.locations !== undefined ? { locations: tc.locations } : {}),
    ...(tc.rawInput !== undefined ? { rawInput: tc.rawInput } : {}),
    ...(tc.rawOutput !== undefined ? { rawOutput: tc.rawOutput } : {}),
    ...(tc.content !== undefined ? { content: tc.content } : {}),
  }
}

/**
 * In-memory live recording of one `session/prompt` turn.
 *
 * Aggregates incremental `tool_call` / `tool_call_update` frames by `toolCallId`,
 * lets `AcpAdapter` cut a DSH span as soon as a tool starts, and lets `agy_acp_tool`
 * await real completion (propagating cancellation to `session/cancel`).
 */
export class AcpRunRecording {
  readonly id: string
  readonly items: RunItem[] = []
  readonly toolResults = new Map<number, AcpToolCallUpdate>()
  private readonly toolCalls = new Map<string, MergedToolCall>()
  private readonly stepToToolCallId = new Map<number, string>()
  private readonly emittedToolCallIds = new Set<string>()
  private waiters: Array<() => void> = []
  private settled = false
  private runError?: string
  private cancelHandler: (() => void) | null = null

  constructor(id?: string, readonly owner?: string) {
    this.id = id ?? randomUUID().slice(0, 12)
  }

  get isSettled(): boolean {
    return this.settled
  }

  setCancelHandler(fn: (() => void) | null): void {
    this.cancelHandler = fn
  }

  requestCancel(): void {
    this.cancelHandler?.()
  }

  isToolEmitted(toolCallId: string): boolean {
    return this.emittedToolCallIds.has(toolCallId)
  }

  markToolEmitted(toolCallId: string): void {
    this.emittedToolCallIds.add(toolCallId)
  }

  getToolCall(key: string | number): MergedToolCall | undefined {
    if (typeof key === 'number') {
      const id = this.stepToToolCallId.get(key)
      return id ? this.toolCalls.get(id) : undefined
    }
    return this.toolCalls.get(key)
  }

  pushUpdate(update: SessionUpdatePayload): number {
    if (this.settled) return this.items.length - 1
    const idx = this.items.length
    this.items.push({ kind: 'update', update })

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const tc = update as AcpToolCallUpdate
      const toolCallId =
        typeof tc.toolCallId === 'string' && tc.toolCallId.trim() !== ''
          ? tc.toolCallId
          : `step:${idx}`
      this.stepToToolCallId.set(idx, toolCallId)

      let merged = this.toolCalls.get(toolCallId)
      if (!merged) {
        const initialStatus = tc.status ?? 'in_progress'
        merged = {
          toolCallId,
          step: idx,
          status: initialStatus,
          settled: initialStatus === 'completed' || initialStatus === 'failed',
        }
        this.toolCalls.set(toolCallId, merged)
      }

      if (typeof tc.name === 'string' && tc.name.trim() !== '') merged.name = tc.name
      if (typeof tc.kind === 'string' && tc.kind.trim() !== '') merged.kind = tc.kind
      if (typeof tc.title === 'string' && tc.title.trim() !== '') merged.title = tc.title
      if (tc.rawInput !== undefined) merged.rawInput = tc.rawInput
      if (tc.args !== undefined && typeof tc.args === 'object' && tc.args !== null && !Array.isArray(tc.args)) {
        merged.args = tc.args
      }
      const locs = normalizeLocations(tc.locations)
      if (locs) merged.locations = locs
      if (tc.rawOutput !== undefined) merged.rawOutput = tc.rawOutput
      if (Array.isArray(tc.content) && tc.content.length > 0) merged.content = tc.content

      if (tc.status) {
        if (!merged.settled || tc.status === 'completed' || tc.status === 'failed') {
          merged.status = tc.status
        }
        if (tc.status === 'completed' || tc.status === 'failed') {
          merged.settled = true
        }
      }

      if (merged.settled) {
        const snapshot = toToolCallUpdate(merged)
        this.toolResults.set(merged.step, snapshot)
        this.toolResults.set(idx, snapshot)
      }
    }

    this.wakeAll()
    return idx
  }

  finish(stopReason: string, usage?: AcpUsage): void {
    if (this.settled) return
    this.settled = true
    this.items.push({ kind: 'done', stopReason, usage })
    this.wakeAll()
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.runError = error.message
    this.items.push({ kind: 'error', error })
    this.wakeAll()
  }

  async waitFor(index: number, signal?: AbortSignal): Promise<RunItem | null> {
    while (index >= this.items.length) {
      if (this.settled) return null
      if (signal?.aborted) return null
      await this.waitOnce(signal)
    }
    return this.items[index] ?? null
  }

  async waitForToolCompletion(key: string | number, signal?: AbortSignal): Promise<ToolCompletionResult> {
    if (signal?.aborted) {
      this.requestCancel()
      return { tool: this.getToolCall(key) ?? null, aborted: true }
    }

    while (true) {
      const current = this.getToolCall(key)
      if (current?.settled) {
        return { tool: current, aborted: false }
      }
      if (this.settled) {
        return {
          tool: current ?? null,
          aborted: false,
          ...(this.runError ? { runError: this.runError } : {}),
        }
      }
      if (signal?.aborted) {
        this.requestCancel()
        return { tool: current ?? null, aborted: true }
      }
      await this.waitOnce(signal)
      if (signal?.aborted) {
        this.requestCancel()
        return { tool: this.getToolCall(key) ?? null, aborted: true }
      }
    }
  }

  private waitOnce(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== done)
        resolve()
      }
      const done = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      this.waiters.push(done)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private wakeAll(): void {
    const list = this.waiters
    this.waiters = []
    for (const w of list) w()
  }
}

export class AcpRunStore {
  private readonly runs = new Map<string, AcpRunRecording>()

  create(owner?: string): AcpRunRecording {
    const rec = new AcpRunRecording(undefined, owner)
    this.runs.set(rec.id, rec)
    // Keep bounded memory (last 64 runs)
    if (this.runs.size > 64) {
      const oldest = this.runs.keys().next().value
      if (oldest) this.runs.delete(oldest)
    }
    return rec
  }

  get(runId: string): AcpRunRecording | undefined {
    return this.runs.get(runId)
  }

  forget(runId: string): void {
    this.runs.delete(runId)
  }
}

const CALL_ID_PREFIX = 'agyacp:'

export function encodeMirrorCallId(runId: string, itemIndex: number): string {
  return `${CALL_ID_PREFIX}${runId}:${itemIndex}`
}

export function decodeMirrorCallId(callId: string): { runId: string; itemIndex: number } | null {
  if (!callId.startsWith(CALL_ID_PREFIX)) return null
  const rest = callId.slice(CALL_ID_PREFIX.length)
  const sep = rest.lastIndexOf(':')
  if (sep <= 0) return null
  const runId = rest.slice(0, sep)
  const itemIndex = Number(rest.slice(sep + 1))
  if (!Number.isInteger(itemIndex) || itemIndex < 0) return null
  return { runId, itemIndex }
}
