import { decodeMirrorCallId, type AcpRunRecording, type DelegatedMcpResult, type MidTurnMessage } from './run-store.ts'

// Older DSH represented tool results as blocks in a user message. The current host uses
// a separate tool-role message with a top-level call ID and stable message identities.
interface ContinuationBlock {
  readonly type: string
  readonly toolCallId?: unknown
  readonly text?: string
  readonly content?: unknown
  readonly isError?: unknown
}

export interface ContinuationMessage {
  readonly role: string
  readonly id?: string
  readonly source?: { readonly kind?: string; readonly form?: string }
  readonly toolCallId?: unknown
  readonly isError?: unknown
  readonly content: readonly ContinuationBlock[]
}

const STEP_SNAPSHOTS = new Set(['time-context', 'runtime-context', 'ptc-mode'])

function isStepSnapshot(message: ContinuationMessage): boolean {
  return message.source?.form === 'snapshot' || STEP_SNAPSHOTS.has(message.source?.kind ?? '')
}

export function continuationSource(message: ContinuationMessage | undefined): string {
  const kind = message?.source?.kind
  return kind && /^[a-z0-9_-]{1,80}$/i.test(kind) ? kind : 'unknown'
}

function formatResult(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw)) return ''
  return raw.map((block: unknown) => {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' &&
        'text' in block && typeof block.text === 'string') return block.text
    return JSON.stringify(block)
  }).join('\n')
}

interface ToolReceipt {
  readonly itemIndex: number
  readonly result: DelegatedMcpResult
}

interface Continuation {
  readonly toolResults: ToolReceipt[]
  readonly midTurnMessages: MidTurnMessage[]
}

/** Both routing and result delivery use this one scan, bound to the outstanding host step. */
export function detectContinuation(
  messages: readonly ContinuationMessage[],
  rec: AcpRunRecording | undefined,
  hasHostTurn = false,
): Continuation | null {
  if (!rec || rec.isReleased || rec.isCancelled) return null

  const toolResults: ToolReceipt[] = []
  const seenToolResults = new Set<number>()
  let firstResult = messages.length
  const collectResult = (id: unknown, content: unknown, isError: unknown, index: number): boolean => {
    const parsed = typeof id === 'string' ? decodeMirrorCallId(id) : null
    if (!parsed || parsed.runId !== rec.id || !rec.expectsToolResult(parsed.itemIndex)) return false
    firstResult = index
    if (!seenToolResults.has(parsed.itemIndex)) {
      seenToolResults.add(parsed.itemIndex)
      toolResults.push({ itemIndex: parsed.itemIndex, result: {
        content: [{ type: 'text', text: formatResult(content) }],
        isError: Boolean(isError),
      } })
    }
    return true
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'developer' || message.role === 'system') continue
    if (message.role === 'tool') {
      if (!collectResult(message.toolCallId, message.content, message.isError, i)) break
    } else if (message.role === 'user') {
      for (let j = message.content.length - 1; j >= 0; j--) {
        const block = message.content[j]!
        if (block.type === 'tool-result') collectResult(block.toolCallId, block.content, block.isError, i)
      }
    } else {
      break
    }
  }
  if (toolResults.length === 0) return null

  const midTurnMessages: MidTurnMessage[] = []
  const batch = Math.max(...seenToolResults)
  for (let i = firstResult; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role !== 'user' || isStepSnapshot(message)) continue
    const text = message.content.flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n')
    if (!text.trim()) continue
    // Without host events, a settled prompt plus a trailing conversational message cannot
    // prove it is the same turn. A bare outstanding receipt can still drain buffered output.
    if (rec.isSettled && !hasHostTurn) return null
    midTurnMessages.push({
      key: message.id ? `id:${message.id}` : `step:${batch}:${midTurnMessages.length}`,
      source: continuationSource(message),
      text,
    })
  }
  return { toolResults: toolResults.reverse(), midTurnMessages }
}
