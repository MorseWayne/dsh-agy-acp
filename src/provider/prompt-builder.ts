import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PromptContentBlock } from '../acp/protocol.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../common/types.ts'

/** Structural message contract supporting both older DSH and newer `role: 'tool'` messages. */
export interface PromptMessage {
  readonly role: string
  readonly source?: { readonly kind?: string }
  readonly toolCallId?: unknown
  readonly content: readonly ContentBlock[]
}

export interface PreparedSystemPrompt {
  append: string
  hash: string
}

const DEFAULT_DIGEST_BUDGET_CHARS = 24_000
const MAX_DIGEST_TEXT_CHARS = 4_000
const MAX_DIGEST_TOOL_RESULT_CHARS = 1_200
const MAX_DIGEST_TOOL_ARGS_CHARS = 400

const SYSTEM_BRIDGE_GUIDANCE = [
  '[Host Bridge Guidance]',
  'Follow the host system instructions, user rules, and language/style preferences above.',
  `When executing actions, use only the tools actually available in this environment; do not invent unavailable tool names or mention internal mirror tools such as ${MIRROR_TOOL_NAME}.`,
].join('\n')

export function prepareSystemPrompt(system?: string): PreparedSystemPrompt | null {
  const trimmed = typeof system === 'string' ? system.trim() : ''
  if (!trimmed) return null
  const append = `${trimmed}\n\n${SYSTEM_BRIDGE_GUIDANCE}`
  const hash = createHash('sha256').update(append).digest('hex')
  return { append, hash }
}

export function buildSystemPromptBlock(append: string, updated: boolean): PromptContentBlock {
  const tag = updated ? 'host_system_instructions_updated' : 'host_system_instructions'
  return { type: 'text', text: `<${tag}>\n${append}\n</${tag}>` }
}

export function prepareAuxiliarySystemPrompt(
  purpose: string,
  system?: string,
): { append: string; fallbackBlock: PromptContentBlock } {
  const base = typeof system === 'string' ? system.trim() : ''
  const guard = [
    `[Auxiliary Task: ${purpose}]`,
    'This is a text-only auxiliary request. Do NOT call any tools, read or write files, or run commands.',
    'Reply directly with the requested text output only.',
  ].join('\n')
  const append = base ? `${base}\n\n${guard}` : guard
  return {
    append,
    fallbackBlock: buildSystemPromptBlock(append, false),
  }
}

/**
 * Extract trailing user messages since the last assistant or tool turn and convert them
 * into native ACP PromptContentBlock[].
 * Because ACP sessions are persistent, earlier turns live inside `agy acp`.
 */
export function buildPromptBlocks(
  messages: readonly PromptMessage[],
  isFirstTurn: boolean,
  digestBudgetChars = DEFAULT_DIGEST_BUDGET_CHARS,
): PromptContentBlock[] {
  const trailingUsers: PromptMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role === 'assistant' || msg.role === 'tool') {
      break
    }
    if (msg.role === 'user') {
      if (isLegacyToolResultOnlyMessage(msg)) {
        break
      }
      trailingUsers.unshift(msg)
    }
  }

  const blocks: PromptContentBlock[] = []

  // On first bind with pre-existing DSH history, prepend a budget-aware transcript digest.
  if (isFirstTurn && messages.length > trailingUsers.length) {
    const earlier = messages.slice(0, messages.length - trailingUsers.length)
    const digest = buildConversationDigest(earlier, digestBudgetChars)
    if (digest) {
      blocks.push({
        type: 'text',
        text: `<prior_conversation_digest>\n${digest}\n</prior_conversation_digest>`,
      })
    }
  }

  for (const msg of trailingUsers) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text.trim() !== '') {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'image') {
        const img = extractInlineImage(part)
        if (img) blocks.push(img)
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: 'Continue.' })
  }

  return blocks
}

/**
 * Format all messages into one-shot ACP PromptContentBlock[] for stateless auxiliary calls
 * such as `session-title` or `compaction`.
 */
export function buildAuxiliaryPromptBlocks(messages: readonly PromptMessage[]): PromptContentBlock[] {
  const blocks: PromptContentBlock[] = []
  for (const msg of messages) {
    if (!msg) continue
    const formatted = formatMessageForDigest(msg)
    if (formatted) {
      blocks.push({ type: 'text', text: formatted })
    }
    for (const part of msg.content) {
      if (part.type === 'image') {
        const img = extractInlineImage(part)
        if (img) blocks.push(img)
      }
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: 'Continue.' })
  }
  return blocks
}

function isLegacyToolResultOnlyMessage(msg: PromptMessage): boolean {
  let hasToolResult = false
  for (const part of msg.content) {
    if (part.type === 'tool-result') {
      hasToolResult = true
    } else if (part.type === 'text' && part.text.trim() !== '') {
      return false
    } else if (part.type === 'image') {
      return false
    }
  }
  return hasToolResult
}

function buildConversationDigest(earlier: readonly PromptMessage[], budgetChars: number): string {
  const selectedReversed: string[] = []
  let usedChars = 0

  for (let i = earlier.length - 1; i >= 0; i--) {
    const msg = earlier[i]
    if (!msg) continue
    if (msg.source?.kind === 'runtime-context') continue

    const line = formatMessageForDigest(msg)
    if (!line) continue

    const cost = line.length + (selectedReversed.length > 0 ? 1 : 0)
    if (usedChars + cost > budgetChars) {
      if (selectedReversed.length === 0 && budgetChars > 16) {
        selectedReversed.push(clipText(line, budgetChars))
      }
      break
    }
    selectedReversed.push(line)
    usedChars += cost
  }

  return selectedReversed.reverse().join('\n')
}

function formatMessageForDigest(msg: PromptMessage): string {
  if (msg.role === 'tool') {
    const body = extractBlocksPlainText(msg.content).trim()
    if (!body) return ''
    return `[tool_result]: ${clipText(body, MAX_DIGEST_TOOL_RESULT_CHARS)}`
  }

  const pieces: string[] = []
  for (const part of msg.content) {
    if (part.type === 'text') {
      const t = part.text.trim()
      if (t) pieces.push(clipText(t, MAX_DIGEST_TEXT_CHARS))
    } else if (part.type === 'image') {
      pieces.push('[image attachment]')
    } else if (part.type === 'tool-call') {
      pieces.push(formatToolCallForDigest(part.name, part.arguments))
    } else if (part.type === 'tool-result') {
      const body = extractBlocksPlainText(part.content).trim()
      if (body) pieces.push(`[tool_result]: ${clipText(body, MAX_DIGEST_TOOL_RESULT_CHARS)}`)
    }
  }

  if (pieces.length === 0) return ''
  return `[${msg.role}]: ${pieces.join('\n')}`
}

function formatToolCallForDigest(name: string, rawArgs: string): string {
  const unwrapped = unwrapMirrorCall(name, rawArgs)
  if (unwrapped) {
    const detail = unwrapped.summary ? ` ${clipText(unwrapped.summary, MAX_DIGEST_TOOL_ARGS_CHARS)}` : ''
    return `[tool_call: ${unwrapped.tool}]${detail}`
  }
  const argPreview = rawArgs.trim() ? ` ${clipText(rawArgs.trim(), MAX_DIGEST_TOOL_ARGS_CHARS)}` : ''
  return `[tool_call: ${name}]${argPreview}`
}

function unwrapMirrorCall(name: string, rawArgs: string): { tool: string; summary?: string } | null {
  let payload: Record<string, unknown> | null = null
  if (name === MIRROR_TOOL_NAME) {
    payload = safeParseRecord(rawArgs)
  } else if (name === WRAPPER_TOOL_NAME) {
    const outer = safeParseRecord(rawArgs)
    const code = typeof outer?.code === 'string' ? outer.code : ''
    const prefix = `await tools[${JSON.stringify(MIRROR_TOOL_NAME)}](`
    if (code.startsWith(prefix) && code.endsWith(')')) {
      payload = safeParseRecord(code.slice(prefix.length, -1))
    }
  }
  if (!payload) return null
  const realTool = typeof payload.tool === 'string' && payload.tool.trim() ? payload.tool.trim() : 'tool'
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : undefined
  if (title) return { tool: realTool, summary: title }
  if (payload.input !== undefined) {
    try {
      return { tool: realTool, summary: JSON.stringify(payload.input) }
    } catch {
      return { tool: realTool }
    }
  }
  return { tool: realTool }
}

function safeParseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function extractBlocksPlainText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'image') parts.push('[image attachment]')
  }
  return parts.join('\n')
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, Math.max(0, maxChars - 3)) + '...'
}

function extractInlineImage(part: ContentBlock): PromptContentBlock | null {
  if (part.type !== 'image') return null
  const att = part.attachment as unknown as {
    data?: string | Uint8Array
    bytes?: Uint8Array
    mimeType?: string
    mediaType?: string
  } | undefined
  if (!att) return null
  const mimeType = att.mimeType ?? att.mediaType ?? 'image/png'
  if (typeof att.data === 'string' && att.data.length > 0) {
    return { type: 'image', data: att.data, mimeType }
  }
  const rawBytes = att.bytes ?? (att.data instanceof Uint8Array ? att.data : undefined)
  if (rawBytes && rawBytes.byteLength > 0) {
    return { type: 'image', data: Buffer.from(rawBytes).toString('base64'), mimeType }
  }
  return null
}
