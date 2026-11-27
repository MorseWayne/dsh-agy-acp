import { createHash, randomUUID } from 'node:crypto'
import { boundTailText, copyBoundedText, sanitizeToolPayload } from '../acp/payload-bounds.ts'
import type { AcpToolCallContentEntry, AcpToolCallUpdate, AcpUsage, SessionUpdatePayload } from '../acp/protocol.ts'
import { mergeCallUsage, type CallUsage, type CallUsageSource } from '../acp/transcript-usage.ts'
import { isDshReverseMcpToolCall } from '../runtime/permission-manager.ts'

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
  content?: AcpToolCallContentEntry[]
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  settled: boolean
}

export interface ToolCompletionResult {
  tool: MergedToolCall | null
  aborted: boolean
  runError?: string
}

export interface DelegatedMcpResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface MidTurnMessage {
  readonly key: string
  readonly source: string
  readonly text: string
}

export interface PendingMcpCall {
  readonly itemIndex: number
  readonly name: string
  readonly args: Record<string, unknown>
  emitted: boolean
  settled: boolean
  resolve: (result: DelegatedMcpResult) => void
  reject: (err: Error) => void
  cleanupAbort?: () => void
}

export type RunItem =
  | { kind: 'update'; update: SessionUpdatePayload }
  | { kind: 'mcp-call'; call: PendingMcpCall }
  | { kind: 'done'; stopReason: string; usage?: AcpUsage }
  | { kind: 'error'; error: Error }

export function normalizeLocations(raw: unknown, maxItems = 32): NormalizedLocation[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: NormalizedLocation[] = []
  for (const item of raw.slice(0, maxItems)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.path !== 'string' || rec.path.length > 4096 || rec.path.trim() === '') continue
    const loc: NormalizedLocation = { path: copyBoundedText(rec.path) }
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
  private readonly preEditCalls = new Set<string>()
  private readonly stepToToolCallId = new Map<number, string>()
  private readonly emittedToolCallIds = new Set<string>()
  private readonly mcpCalls = new Map<number, PendingMcpCall>()
  private readonly suppressedMcpToolCallIds = new Set<string>()
  private readonly deferredNativeToolIds = new Set<string>()
  private readonly pendingToolResults = new Set<number>()
  private readonly seenMidTurnMessages = new Set<string>()
  private readonly pendingMidTurnMessages = new Map<string, MidTurnMessage>()
  private waiters: Array<() => void> = []
  private recovery?: { toolId: string; policy: string }
  private cancelled = false
  private settled = false
  private runError?: string
  private cancelHandler: (() => void) | null = null

  /** True when this recording delegates `dsh-tools` reverse MCP calls as native DSH tool steps. */
  delegatesMcp = false
  /** Monotonic next-to-consume index into `items`, preserved across deferred native tool spans. */
  cursor = 0

  private released = false
  constructor(id?: string, readonly owner?: string, private readonly preEdit?: (tc: AcpToolCallUpdate) => NormalizedLocation[] | undefined) {
    this.id = id ?? randomUUID().slice(0, 12)
  }

  /** Explicitly release only after the adapter consumes (or abandons) the final span. */
  releaseRecording(): void {
    this.released = true
    this.pendingToolResults.clear()
    this.seenMidTurnMessages.clear()
    this.pendingMidTurnMessages.clear()
    this.failAllPendingMcpCalls(new Error('ACP recording released before delegated MCP call resolved'))
  }

  get isReleased(): boolean { return this.released }

  get isCancelled(): boolean { return this.cancelled }

  get canEvict(): boolean { return this.settled && this.released && !this.waiters.length }

  get isSettled(): boolean {
    return this.settled
  }

  setCancelHandler(fn: (() => void) | null): void {
    this.cancelHandler = fn
  }

  requestCancel(reason?: Error): void {
    if (this.cancelled) return
    this.cancelled = true
    this.failAllPendingMcpCalls(reason ?? new Error('ACP turn cancelled before delegated MCP call resolved'))
    this.cancelHandler?.()
    this.wakeAll()
  }

  expectToolResult(itemIndex: number): void {
    this.pendingToolResults.add(itemIndex)
  }

  expectsToolResult(itemIndex: number): boolean {
    return this.pendingToolResults.has(itemIndex)
  }

  acknowledgeToolResults(): void {
    this.pendingToolResults.clear()
  }

  canResolveMcpCall(itemIndex: number): boolean {
    const call = this.mcpCalls.get(itemIndex)
    return Boolean(call?.emitted && !call.settled)
  }

  collectMidTurnMessages(messages: readonly MidTurnMessage[]): void {
    for (const message of messages) {
      if (this.seenMidTurnMessages.has(message.key)) continue
      this.seenMidTurnMessages.add(message.key)
      this.pendingMidTurnMessages.set(message.key, message)
    }
  }

  inheritMidTurnMessageKeys(previous: AcpRunRecording): void {
    // Only host IDs are stable across physical prompts; fallback step keys are run-local.
    for (const key of previous.seenMidTurnMessages) if (key.startsWith('id:')) this.seenMidTurnMessages.add(key)
  }

  undeliveredMidTurnMessages(): MidTurnMessage[] {
    return [...this.pendingMidTurnMessages.values()]
  }

  markMidTurnMessagesDelivered(): void {
    this.pendingMidTurnMessages.clear()
  }

  allowApprovalRecovery(toolId: string, policy: string): void {
    const tool = this.toolCalls.get(toolId)
    if (tool && !tool.settled && this.toolCalls.size === 1) this.recovery = { toolId, policy }
  }

  claimApprovalRecovery(step: number): string | undefined {
    const recovery = this.recovery
    if (!recovery || this.cancelled ||
        this.getToolCall(step)?.toolCallId !== recovery.toolId || !this.isToolEmitted(recovery.toolId)) return undefined
    this.recovery = undefined
    return recovery.policy
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

  isSuppressedMcpTool(toolCallId: string): boolean {
    return this.suppressedMcpToolCallIds.has(toolCallId)
  }

  hasUnsettledSuppressedMcpTool(): boolean {
    if (this.settled) return false
    for (const id of this.suppressedMcpToolCallIds) {
      if (!this.toolCalls.get(id)?.settled) return true
    }
    for (const call of this.mcpCalls.values()) {
      if (!call.settled) return true
    }
    return false
  }

  hasPendingUnemittedMcpCall(): boolean {
    if (this.settled) return false
    for (const call of this.mcpCalls.values()) {
      if (!call.emitted && !call.settled) return true
    }
    return false
  }

  deferNativeTool(toolCallId: string): void {
    if (!this.emittedToolCallIds.has(toolCallId) && !this.suppressedMcpToolCallIds.has(toolCallId)) {
      this.deferredNativeToolIds.add(toolCallId)
    }
  }

  takeReadyDeferredNativeTools(): MergedToolCall[] {
    if (this.deferredNativeToolIds.size === 0) return []
    const mcpBusy = this.hasUnsettledSuppressedMcpTool()
    const ready: MergedToolCall[] = []
    for (const id of [...this.deferredNativeToolIds]) {
      if (this.emittedToolCallIds.has(id) || this.suppressedMcpToolCallIds.has(id)) {
        this.deferredNativeToolIds.delete(id)
        continue
      }
      const merged = this.toolCalls.get(id)
      if (!merged) {
        this.deferredNativeToolIds.delete(id)
        continue
      }
      if (!mcpBusy || merged.settled) {
        this.deferredNativeToolIds.delete(id)
        ready.push(merged)
      }
    }
    return ready
  }

  enqueueMcpCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DelegatedMcpResult> {
    if (this.settled || this.cancelled || this.released) {
      return Promise.reject(new Error('ACP turn is no longer active for delegated MCP call'))
    }
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : new Error('Delegated MCP call aborted')
      return Promise.reject(reason)
    }
    this.sawThoughtOrTool = true
    this.flushUsage()
    const itemIndex = this.items.length
    return new Promise<DelegatedMcpResult>((resolve, reject) => {
      const call: PendingMcpCall = {
        itemIndex,
        name,
        args,
        emitted: false,
        settled: false,
        resolve,
        reject,
      }
      if (signal) {
        const onAbort = (): void => {
          if (call.settled) return
          call.settled = true
          call.cleanupAbort = undefined
          const reason = signal.reason instanceof Error ? signal.reason : new Error('Delegated MCP call aborted')
          call.reject(reason)
          this.wakeAll()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        call.cleanupAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.mcpCalls.set(itemIndex, call)
      this.items.push({ kind: 'mcp-call', call })
      this.wakeAll()
    })
  }

  resolveMcpCall(itemIndex: number, result: DelegatedMcpResult): boolean {
    const call = this.mcpCalls.get(itemIndex)
    if (!call || call.settled) return false
    call.settled = true
    call.cleanupAbort?.()
    call.cleanupAbort = undefined
    call.resolve(result)
    this.wakeAll()
    return true
  }

  rejectMcpCall(itemIndex: number, error: Error): boolean {
    const call = this.mcpCalls.get(itemIndex)
    if (!call || call.settled) return false
    call.settled = true
    call.cleanupAbort?.()
    call.cleanupAbort = undefined
    call.reject(error)
    this.wakeAll()
    return true
  }

  failAllPendingMcpCalls(error: Error): void {
    let changed = false
    for (const call of this.mcpCalls.values()) {
      if (call.settled) continue
      call.settled = true
      call.cleanupAbort?.()
      call.cleanupAbort = undefined
      call.reject(error)
      changed = true
    }
    if (changed) this.wakeAll()
  }

  /** Latest `usage_update.used` seen during this run: the real live context occupancy. */
  contextUsed: number | undefined
  /** Last fallback occupancy already reported to DSH when transcript usage is unavailable. */
  lastFallbackContextUsed: number | undefined

  private usageSource: CallUsageSource | null = null
  private pendingUsage: CallUsage | null = null
  private hasModelOutputSinceLastUsage = true
  private spanUsageCount = 0
  private compacted = false
  private inlineMessageAcc = ''
  private inlineMessageOverflow = false
  private sawThoughtOrTool = false

  get hasThoughtOrTool(): boolean {
    return this.sawThoughtOrTool
  }

  get inlineMessageText(): string | undefined {
    return this.inlineMessageOverflow || !this.inlineMessageAcc ? undefined : this.inlineMessageAcc
  }

  /** Attach agy's per-call usage source (the transcript tailer) for this run. */
  attachUsageSource(source: CallUsageSource): void {
    this.usageSource = source
  }

  get hasUsageSource(): boolean {
    return this.usageSource?.available === true
  }

  get consumedSpanUsageCount(): number {
    return this.spanUsageCount
  }

  /** Pull newly completed model calls into the current DSH step; returns how many arrived. */
  flushUsage(): number {
    if (!this.usageSource) return 0
    const samples = this.usageSource.poll()
    for (const s of samples) this.pendingUsage = mergeCallUsage(this.pendingUsage, s)
    return samples.length
  }

  get hasPendingUsage(): boolean {
    return this.pendingUsage !== null
  }

  /**
   * Whether a new model call is expected before this tool-call batch.
   * When a single model call streams multiple concurrent tool calls split across consecutive DSH spans,
   * subsequent spans see neither new model text/thought nor all prior tools settled, so waiting 160ms
   * polling the transcript would only burn wall-clock latency with zero new PLANNER_RESPONSE records.
   */
  expectsNewCallUsage(currentBatchToolCallIds: ReadonlySet<string>): boolean {
    if (this.hasPendingUsage || this.hasModelOutputSinceLastUsage) return true
    let priorEmittedCount = 0
    for (const id of this.emittedToolCallIds) {
      if (currentBatchToolCallIds.has(id)) continue
      priorEmittedCount++
      if (!this.toolCalls.get(id)?.settled) return false
    }
    for (const call of this.mcpCalls.values()) {
      const id = `mcp:${call.itemIndex}`
      if (!call.emitted || currentBatchToolCallIds.has(id)) continue
      priorEmittedCount++
      if (!call.settled) return false
    }
    return priorEmittedCount > 0
  }

  /** Usage of the model calls since the previous DSH step, or null when none arrived (never re-billed). */
  consumeSpanUsage(): CallUsage | null {
    const out = this.pendingUsage
    this.pendingUsage = null
    if (out) {
      this.hasModelOutputSinceLastUsage = false
      this.spanUsageCount++
    }
    return out
  }

  /** Release intermediate streaming frames once this run is settled and no longer active. */
  compactSettled(): void {
    if (!this.canEvict || this.compacted) return
    this.compacted = true
    this.items.length = 0
    this.toolResults.clear()
    this.mcpCalls.clear()
    this.suppressedMcpToolCallIds.clear()
    this.deferredNativeToolIds.clear()
    this.usageSource = null
    this.pendingUsage = null
    this.inlineMessageAcc = ''
  }

  pushUpdate(update: SessionUpdatePayload): number {
    if (this.settled) return this.items.length - 1
    const idx = this.items.length
    let storedUpdate: SessionUpdatePayload = { sessionUpdate: boundTailText(update.sessionUpdate, 128) }
    if (update.sessionUpdate === 'usage_update') {
      const used = (update as { used?: unknown }).used
      if (typeof used === 'number' && Number.isSafeInteger(used) && used >= 0) {
        this.contextUsed = used
        storedUpdate = { sessionUpdate: 'usage_update', used }
        if (typeof update.size === 'number' && Number.isSafeInteger(update.size) && update.size >= 0) storedUpdate.size = update.size
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'agent_message_chunk') {
      this.hasModelOutputSinceLastUsage = true
      if (update.sessionUpdate === 'agent_thought_chunk') {
        this.sawThoughtOrTool = true
      }
      const c = update.content
      if (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string') {
        if (update.sessionUpdate === 'agent_message_chunk' && !this.inlineMessageOverflow) {
          if (this.inlineMessageAcc.length + c.text.length > 1024) {
            this.inlineMessageOverflow = true
            this.inlineMessageAcc = ''
          } else {
            this.inlineMessageAcc += c.text
          }
        }
        storedUpdate = { sessionUpdate: update.sessionUpdate, content: { type: 'text', text: copyBoundedText(c.text) } }
      }
    }

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.sawThoughtOrTool = true
      const rawTc = update as AcpToolCallUpdate
      const id = rawTc.toolCallId
      const toolCallId = typeof id !== 'string' || !id.length ? `step:${idx}` :
        id.length > 512 ? `long:${createHash('sha256').update(id).digest('hex')}` : copyBoundedText(id)
      // Whitelist protocol fields, never spread a raw peer frame. Dropped values stay dropped.
      const tc: AcpToolCallUpdate = { sessionUpdate: rawTc.sessionUpdate, toolCallId }
      if (typeof rawTc.name === 'string') tc.name = boundTailText(rawTc.name, 256)
      if (typeof rawTc.kind === 'string') tc.kind = boundTailText(rawTc.kind, 64)
      if (typeof rawTc.title === 'string') tc.title = boundTailText(rawTc.title, 2048)
      if (rawTc.status && ['pending', 'in_progress', 'completed', 'failed'].includes(rawTc.status)) tc.status = rawTc.status
      if (rawTc.args && typeof rawTc.args === 'object' && !Array.isArray(rawTc.args)) {
        tc.args = sanitizeToolPayload(rawTc.args) as Record<string, unknown>
      }
      if (rawTc.rawInput !== undefined) tc.rawInput = sanitizeToolPayload(rawTc.rawInput)
      if (rawTc.rawOutput !== undefined) tc.rawOutput = sanitizeToolPayload(rawTc.rawOutput)
      if (Array.isArray(rawTc.content)) tc.content = sanitizeToolPayload(rawTc.content, { maxTotalText: 32_000 }) as AcpToolCallContentEntry[]
      tc.locations = normalizeLocations(rawTc.locations)
      if (tc.sessionUpdate === 'tool_call' && !this.toolCalls.has(toolCallId) && tc.status !== 'completed' && tc.status !== 'failed') {
        const captured = this.preEdit?.(tc)
        if (captured) { tc.locations = captured; this.preEditCalls.add(toolCallId) }
      }
      storedUpdate = tc
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
      if (locs && (!merged.locations || !this.preEditCalls.has(toolCallId))) merged.locations = locs
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
      if (this.delegatesMcp && isDshReverseMcpToolCall(merged)) {
        this.suppressedMcpToolCallIds.add(toolCallId)
        this.deferredNativeToolIds.delete(toolCallId)
      }
    }

    this.items.push({ kind: 'update', update: storedUpdate })
    this.wakeAll()
    return idx
  }

  finish(stopReason: string, usage?: AcpUsage): void {
    if (this.settled) return
    this.settled = true
    this.failAllPendingMcpCalls(new Error('ACP turn finished before delegated MCP call resolved'))
    this.items.push({ kind: 'done', stopReason, usage })
    this.wakeAll()
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.runError = error.message
    this.failAllPendingMcpCalls(error)
    this.items.push({ kind: 'error', error })
    this.wakeAll()
  }

  async waitFor(index: number, signal?: AbortSignal): Promise<RunItem | null> {
    while (index >= this.items.length) {
      if (this.settled || this.cancelled || this.released || signal?.aborted) return null
      await this.waitOnce(signal)
    }
    return this.items[index] ?? null
  }

  /** Wait up to `timeoutMs` for an item at `index` to arrive; returns null immediately on timeout/settle/abort. */
  async waitForWithin(index: number, timeoutMs: number, signal?: AbortSignal): Promise<RunItem | null> {
    if (index < this.items.length) return this.items[index] ?? null
    if (this.settled || signal?.aborted || timeoutMs <= 0) return null
    const deadline = Date.now() + timeoutMs
    while (index >= this.items.length) {
      if (this.settled || signal?.aborted) return null
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      await this.waitOnceWithTimeout(remaining, signal)
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

  private waitOnceWithTimeout(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        signal?.removeEventListener('abort', onAbort)
        this.waiters = this.waiters.filter((w) => w !== done)
      }
      const onAbort = (): void => {
        cleanup()
        resolve()
      }
      const done = (): void => {
        cleanup()
        resolve()
      }
      this.waiters.push(done)
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(done, timeoutMs)
      timer.unref?.()
    })
  }

  private wakeAll(): void {
    const list = this.waiters
    this.waiters = []
    for (const w of list) w()
  }
}

const MAX_RETAINED_RUNS = 32
const MAX_FULL_SETTLED_RUNS = 8

export class AcpRunStore {
  private readonly runs = new Map<string, AcpRunRecording>()
  private readonly latestByOwner = new Map<string, AcpRunRecording>()
  private readonly superseded = new WeakSet<AcpRunRecording>()
  private readonly hostTurns = new Map<string, number>()
  private readonly recordingTurns = new WeakMap<AcpRunRecording, number>()

  beginHostTurn(owner: string, turn: number): void {
    if (this.hostTurns.get(owner) === turn) return
    this.closeOwnerTurn(owner)
    this.hostTurns.set(owner, turn)
  }

  endHostTurn(owner: string, turn: number): void {
    const current = this.hostTurns.get(owner)
    if (current !== undefined && current !== turn) return
    this.closeOwnerTurn(owner)
  }

  closeOwnerTurn(owner: string): void {
    const rec = this.latestByOwner.get(owner)
    const belongsToTurn = rec && this.hostTurns.get(owner) === this.recordingTurns.get(rec)
    this.hostTurns.delete(owner)
    if (rec && belongsToTurn && !rec.isReleased) {
      if (!rec.isSettled) rec.requestCancel(new Error('DSH turn ended'))
      rec.releaseRecording()
    }
  }

  create(owner?: string, preEdit?: (tc: AcpToolCallUpdate) => NormalizedLocation[] | undefined): AcpRunRecording {
    const rec = new AcpRunRecording(undefined, owner, preEdit)
    for (const run of this.runs.values()) if (run.owner === owner) this.superseded.add(run)
    this.runs.set(rec.id, rec)
    if (owner) {
      this.latestByOwner.set(owner, rec)
      const turn = this.hostTurns.get(owner)
      if (turn !== undefined) this.recordingTurns.set(rec, turn)
    }
    // The cap applies to eligible history only: waking a waiter or finishing the
    // ACP producer does not mean DSH has consumed the remaining continuation.
    const history = [...this.runs.values()].filter(run => run.canEvict)
    for (const old of history.slice(0, Math.max(0, history.length - MAX_FULL_SETTLED_RUNS))) old.compactSettled()
    for (const old of history.slice(0, Math.max(0, this.runs.size - MAX_RETAINED_RUNS))) {
      this.runs.delete(old.id)
      if (old.owner && this.latestByOwner.get(old.owner) === old) this.latestByOwner.delete(old.owner)
    }
    return rec
  }

  get(runId: string): AcpRunRecording | undefined {
    return this.runs.get(runId)
  }

  getActiveForOwner(owner: string): AcpRunRecording | undefined {
    const rec = this.getContinuationForOwner(owner)
    return rec?.isSettled ? undefined : rec
  }

  /** A finished ACP producer may still have output to drain after a tool receipt in the same DSH turn. */
  getContinuationForOwner(owner: string): AcpRunRecording | undefined {
    const rec = this.latestByOwner.get(owner)
    if (!rec || rec.isReleased || rec.isCancelled || this.hostTurns.get(owner) !== this.recordingTurns.get(rec)) {
      return undefined
    }
    return rec
  }

  hasHostTurn(run: AcpRunRecording): boolean {
    return this.recordingTurns.has(run) && run.owner !== undefined && this.getContinuationForOwner(run.owner) === run
  }

  cancelActiveForOwner(owner: string, reason?: Error): void {
    const rec = this.getActiveForOwner(owner)
    if (rec) rec.requestCancel(reason)
  }

  isLatestForOwner(run: AcpRunRecording): boolean {
    return this.runs.get(run.id) === run && !this.superseded.has(run)
  }

  forget(runId: string): void {
    const old = this.runs.get(runId)
    this.runs.delete(runId)
    if (old?.owner && this.latestByOwner.get(old.owner) === old) this.latestByOwner.delete(old.owner)
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
