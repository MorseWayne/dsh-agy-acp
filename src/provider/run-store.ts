import { randomUUID } from 'node:crypto'
import type { AcpToolCallUpdate, AcpUsage, SessionUpdatePayload } from '../acp/protocol.ts'

export type RunItem =
  | { kind: 'update'; update: SessionUpdatePayload }
  | { kind: 'done'; stopReason: string; usage?: AcpUsage }
  | { kind: 'error'; error: Error }

/**
 * In-memory live recording of one `session/prompt` turn.
 *
 * When a completed `tool_call_update` cuts a DSH span (finish: tool-calls),
 * the ACP turn keeps streaming in the background and appends items here.
 * DSH dispatches `agy_acp_tool` (which reads the recorded tool output) and then
 * calls `adapter.stream()` again to resume reading from `cursor`.
 */
export class AcpRunRecording {
  readonly id: string
  readonly items: RunItem[] = []
  readonly toolResults = new Map<number, AcpToolCallUpdate>()
  private waiters: Array<() => void> = []
  private settled = false
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

  pushUpdate(update: SessionUpdatePayload): number {
    if (this.settled) return this.items.length - 1
    const idx = this.items.length
    this.items.push({ kind: 'update', update })
    if (
      (update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'tool_call') &&
      (update.status === 'completed' || update.status === 'failed')
    ) {
      this.toolResults.set(idx, update as AcpToolCallUpdate)
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
    this.items.push({ kind: 'error', error })
    this.wakeAll()
  }

  async waitFor(index: number, signal?: AbortSignal): Promise<RunItem | null> {
    while (index >= this.items.length) {
      if (this.settled) return null
      if (signal?.aborted) return null
      await new Promise<void>((resolve) => {
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
    return this.items[index] ?? null
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
