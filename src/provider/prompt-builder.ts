import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { copyBoundedText } from '../acp/payload-bounds.ts'
import type { PromptContentBlock } from '../acp/protocol.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../common/types.ts'

/** Structural message contract supporting both older DSH and newer `role: 'tool'` messages. */
export interface PromptMessage {
  readonly role: string
  readonly source?: { readonly kind?: string }
  readonly toolCallId?: unknown
  readonly content: readonly HostBlock[]
}

// The pinned dev peer predates FileBlock. This structural bridge matches the
// installed DSH FileAttachmentRef exactly at the fields this adapter consumes.
interface HostFileBlock { type: 'file'; attachment: { attachmentId: string; name: string; bytes: number } }
type HostImageBlock = Extract<ContentBlock, { type: 'image' }> & { offloaded?: true }
type HostBlock = ContentBlock | HostFileBlock
type FileRef = HostFileBlock['attachment']
export type ReadPromptFile = (ref: FileRef, signal?: AbortSignal) => AsyncIterable<Uint8Array>
type ImageRef = HostImageBlock['attachment']
export type ReadPromptImage = (ref: ImageRef, signal?: AbortSignal) => Promise<{ data: Uint8Array; ref: ImageRef }>

export interface PreparedSystemPrompt {
  append: string
  hash: string
}

const DEFAULT_DIGEST_BUDGET_CHARS = 24_000
const MAX_RECENT_DIGEST_TEXT_CHARS = 8_000
const MAX_OLDER_DIGEST_TEXT_CHARS = 3_500
const MAX_DIGEST_TOOL_RESULT_CHARS = 1_000
const MAX_DIGEST_TOOL_ARGS_CHARS = 400
const LEGACY_MIRROR_TOOL_NAMES = new Set<string>([MIRROR_TOOL_NAME, 'agy_tool'])

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024
export const MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_PDF_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENTS_BYTES = 50 * 1024 * 1024

export interface PromptBuildCapabilities {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
}

export interface PrepareSystemPromptOptions {
  /** Legacy flag: when true and `replacementGuidance` is omitted, injects DSH subagent routing guidance. */
  hasBridgedSubagentTools?: boolean
  /** Dynamic replacement guidance lines generated from active `'replace'` groups in `mcpToolPolicy`. */
  replacementGuidance?: readonly string[]
  /** Compact catalog of on-demand DSH tools exposed via `dsh_discover_tools` / `dsh_call_tool`. */
  lazyToolCatalog?: string | null
}

const SYSTEM_BRIDGE_GUIDANCE = [
  '[Host Bridge Guidance]',
  'Follow the host system instructions, user rules, and language/style preferences above.',
  `When executing actions, use only the tools actually available in this environment; do not invent unavailable tool names or mention internal mirror tools such as ${MIRROR_TOOL_NAME}.`,
].join('\n')

const SUBAGENT_BRIDGE_GUIDANCE =
  'When host instructions (such as task-category model routing or Agent Teams) direct you to delegate or coordinate via `subagent`, `subagent_fork`, `list_agents`, `wait_agent`, `send_message`, or `list_subagent_models`, call the bridged DSH `dsh-tools` MCP tool (for example `mcp_dsh-tools_subagent`) instead of Antigravity\'s native `invoke_subagent`, so host routing policies and cross-provider models take effect.'

export function extractSystemPrompt(
  system: string | undefined,
  messages?: readonly PromptMessage[],
): string {
  const parts: string[] = []
  const base = typeof system === 'string' ? system.trim() : ''
  if (base) parts.push(base)
  if (messages) {
    for (const msg of messages) {
      if (!msg || msg.role !== 'system') continue
      const text = extractBlocksPlainText(msg.content).trim()
      if (text && !parts.includes(text)) {
        parts.push(text)
      }
    }
  }
  return parts.join('\n\n')
}

export function prepareSystemPrompt(
  system?: string,
  messages?: readonly PromptMessage[],
  opts?: PrepareSystemPromptOptions,
): PreparedSystemPrompt | null {
  const merged = extractSystemPrompt(system, messages)
  if (!merged) return null
  const extraLines: string[] = []
  if (opts?.replacementGuidance !== undefined) {
    for (const line of opts.replacementGuidance) {
      const trimmed = line.trim()
      if (trimmed) extraLines.push(trimmed)
    }
  } else if (opts?.hasBridgedSubagentTools) {
    extraLines.push(SUBAGENT_BRIDGE_GUIDANCE)
  }
  if (opts?.lazyToolCatalog?.trim()) {
    extraLines.push(opts.lazyToolCatalog.trim())
  }
  const guidance = extraLines.length > 0
    ? `${SYSTEM_BRIDGE_GUIDANCE}\n${extraLines.join('\n')}`
    : SYSTEM_BRIDGE_GUIDANCE
  const append = `${merged}\n\n${guidance}`
  const hash = createHash('sha256').update(append).digest('hex')
  return { append, hash }
}

export function buildSystemPromptBlock(append: string, updated: boolean): PromptContentBlock {
  const tag = updated ? 'host_system_instructions_updated' : 'host_system_instructions'
  return { type: 'text', text: `<${tag}>\n${append}\n</${tag}>\n` }
}

export function buildMidTurnPromptBlock(messages: readonly { source: string; text: string }[]): { type: 'text'; text: string } {
  const entries = messages.map(({ source, text }) => ({ source, text }))
  return { type: 'text', text: `DSH messages received during this turn (separate from any tool result):\n${JSON.stringify(entries)}` }
}

export function prepareAuxiliarySystemPrompt(
  purpose: string,
  system?: string,
  messages?: readonly PromptMessage[],
): { append: string; fallbackBlock: PromptContentBlock } {
  const base = extractSystemPrompt(system, messages)
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
interface PromptPlan { prefix: PromptContentBlock[]; parts: Array<string | HostImageBlock | HostFileBlock> }
function planPrompt(messages: readonly PromptMessage[], isFirstTurn: boolean, digestBudgetChars: number): PromptPlan {
  // System messages are forwarded via <host_system_instructions>, never treated as prior conversation turns.
  const conversationMessages = messages.filter((m): m is PromptMessage => Boolean(m) && m.role !== 'system')
  const trailingUsers: PromptMessage[] = []
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i]
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
  if (isFirstTurn && conversationMessages.length > trailingUsers.length) {
    const earlier = conversationMessages.slice(0, conversationMessages.length - trailingUsers.length)
    const digest = buildConversationDigest(earlier, digestBudgetChars)
    if (digest) {
      blocks.push({
        type: 'text',
        text: `<prior_conversation_digest>\n${digest}\n</prior_conversation_digest>\n`,
      })
    }
  }

  const parts: PromptPlan['parts'] = []
  for (const msg of trailingUsers) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text.trim()) parts.push(part.text)
      else if (part.type === 'image') parts.push(part)
      else if (part.type === 'file') parts.push(part)
    }
  }
  return { prefix: blocks, parts }
}

function fileNotice(block: HostFileBlock, reason = 'no readable handle supplied'): string {
  // DSH normally projects uploaded files to authoritative text handles upstream.
  // A raw reference has no execution-world path; never interpret a name as one.
  const ref = block.attachment
  return `[file attachment ${JSON.stringify(String(ref?.name ?? 'file').slice(-256).split(/[\\/]/).pop() || 'file')}, ${Number.isSafeInteger(ref?.bytes) ? ref.bytes : 'unknown'} bytes: ${reason}]`
}

function assemble(plan: PromptPlan, resolved?: ReadonlyMap<number, PromptContentBlock>): PromptContentBlock[] {
  const blocks = [...plan.prefix]
  let pending: string[] = []
  const flush = () => { if (pending.length) blocks.push({ type: 'text', text: pending.join('\n\n') }); pending = [] }
  for (const [i, part] of plan.parts.entries()) {
    if (typeof part === 'string') { pending.push(part); continue }
    const block = resolved?.get(i)
    if (block && block.type !== 'text') { flush(); blocks.push(block) }
    else pending.push(block?.text ?? (part.type === 'file' ? fileNotice(part) : '[image attachment omitted: image input unavailable]'))
  }
  flush()
  return blocks.length ? blocks : [{ type: 'text', text: 'Continue.' }]
}

export function buildPromptBlocks(messages: readonly PromptMessage[], isFirstTurn: boolean,
  digestBudgetChars = DEFAULT_DIGEST_BUDGET_CHARS, _capabilities?: PromptBuildCapabilities): PromptContentBlock[] {
  return assemble(planPrompt(messages, isFirstTurn, digestBudgetChars))
}

const AUDIO_MIMES: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4' }
const TEXT_EXTENSIONS = new Set('txt text md markdown log json jsonl ndjson csv tsv xml html css js jsx ts tsx yaml yml toml ini py sh go rs java c h cpp patch diff'.split(' '))

function audioMatches(data: Buffer, ext: string): boolean {
  const tag = (offset: number, text: string) => data.toString('latin1', offset, offset + text.length) === text
  switch (ext) {
    case 'wav': return tag(0, 'RIFF') && tag(8, 'WAVE')
    case 'mp3': return tag(0, 'ID3') || (data[0] === 255 && ((data[1] ?? 0) & 0xe0) === 0xe0)
    case 'flac': return tag(0, 'fLaC')
    case 'ogg': case 'opus': return tag(0, 'OggS') && (data.subarray(0, 256).includes('OpusHead') || data.subarray(0, 256).includes('vorbis'))
    case 'm4a': return tag(4, 'ftyp') && tag(8, 'M4A ')
    default: return false
  }
}

async function fileBlock(part: HostFileBlock, caps: PromptBuildCapabilities | undefined, read: ReadPromptFile | undefined,
  reserve: (n: number, max: number) => boolean, signal?: AbortSignal): Promise<PromptContentBlock> {
  const omitted = (why?: string): PromptContentBlock => ({ type: 'text', text: fileNotice(part, why) })
  if (!read) return omitted()
  const ref = part.attachment
  if (!ref || typeof ref.name !== 'string' || ref.name.length > 256 || /[\\/\x00-\x1f]/.test(ref.name) ||
      !/^sha256:[0-9a-f]{64}$/.test(ref.attachmentId)) return omitted('invalid file reference')
  const ext = /\.([a-z0-9]+)$/i.exec(ref.name)?.[1]?.toLowerCase() ?? ''
  const mime = Object.hasOwn(AUDIO_MIMES, ext) ? AUDIO_MIMES[ext] : undefined
  const pdf = ext === 'pdf'
  if (!mime && !pdf && !TEXT_EXTENSIONS.has(ext)) return omitted('unsupported file type')
  if (mime ? caps?.audio !== true : caps?.embeddedContext !== true) return omitted('peer lacks required attachment capability')
  if (!reserve(ref.bytes, mime ? MAX_AUDIO_ATTACHMENT_BYTES : pdf ? MAX_PDF_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES)) return omitted('exceeds attachment limit')
  try {
    // A service may verify the digest only when its iterator reaches EOF. Do
    // not expose partial bytes, invoke caller paths, or collect unbounded chunks.
    const data = Buffer.allocUnsafe(ref.bytes)
    let offset = 0, chunks = 0
    for await (const chunk of read({ attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes }, signal)) {
      signal?.throwIfAborted()
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > ref.bytes - offset || ++chunks > 65_536) return omitted('invalid attachment stream')
      data.set(chunk, offset); offset += chunk.byteLength
    }
    signal?.throwIfAborted()
    if (offset !== data.length || `sha256:${createHash('sha256').update(data).digest('hex')}` !== ref.attachmentId) return omitted('file integrity mismatch')
    if (mime) return audioMatches(data, ext) ? { type: 'audio', mimeType: mime, data: data.toString('base64') } : omitted('audio format mismatch')
    // Identifier for already embedded bytes; not a link, path or fetch request.
    const uri = `urn:dsh:attachment:${ref.attachmentId}`
    if (pdf) return data.toString('latin1', 0, 5) === '%PDF-' ?
      { type: 'resource', resource: { uri, mimeType: 'application/pdf', blob: data.toString('base64') } } : omitted('PDF format mismatch')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    if (text.includes('\0')) return omitted('invalid UTF-8 text file')
    return { type: 'resource', resource: { uri, mimeType: ext === 'md' || ext === 'markdown' ? 'text/markdown' : ext === 'json' ? 'application/json' : 'text/plain', text } }
  } catch { signal?.throwIfAborted(); return omitted('verified file contents unavailable') }
}

/** Resolve only current, admitted attachment occurrences via DSH's attachment service.
 * Size checks precede both reads and base64 expansion. Capabilities must be explicit. */
export async function buildPromptBlocksWithAttachments(messages: readonly PromptMessage[], isFirstTurn: boolean,
  digestBudgetChars = DEFAULT_DIGEST_BUDGET_CHARS, capabilities?: PromptBuildCapabilities,
  readImage?: ReadPromptImage, signal?: AbortSignal, readFileStream?: ReadPromptFile): Promise<PromptContentBlock[]> {
  const plan = planPrompt(messages, isFirstTurn, digestBudgetChars)
  const resolved = new Map<number, PromptContentBlock>()
  let used = 0, reads = 0
  const reserve = (n: number, max: number): boolean => {
    if (!Number.isSafeInteger(n) || n < 0 || n > max || n > MAX_TOTAL_ATTACHMENTS_BYTES - used || reads >= 64) return false
    used += n; reads++ // failed reads are charged too
    return true
  }
  for (const [i, part] of plan.parts.entries()) {
    if (typeof part === 'string') continue
    signal?.throwIfAborted()
    if (part.type === 'file') {
      resolved.set(i, await fileBlock(part, capabilities, readFileStream, reserve, signal))
      continue
    }
    const ref = part.attachment
    let reason: string
    if (part.offloaded) reason = 'offloaded by DSH'
    else if (capabilities?.image !== true) reason = 'peer does not support image input'
    else if (!readImage) reason = 'attachment service unavailable'
    else if (!ref || !/^sha256:[0-9a-f]{64}$/.test(ref.attachmentId) ||
        !['image/png', 'image/webp', 'image/jpeg', 'image/gif'].includes(ref.mediaType)) reason = 'invalid image reference'
    else if (!ref.bytes || !reserve(ref.bytes, MAX_IMAGE_ATTACHMENT_BYTES)) reason = 'exceeds attachment limit'
    else {
      try {
        const stored = await readImage(ref, signal)
        signal?.throwIfAborted()
        if (stored.ref.attachmentId === ref.attachmentId && stored.ref.mediaType === ref.mediaType &&
            stored.data instanceof Uint8Array && stored.data.byteLength === ref.bytes) {
          resolved.set(i, { type: 'image', data: Buffer.from(stored.data.buffer, stored.data.byteOffset, stored.data.byteLength).toString('base64'), mimeType: ref.mediaType })
          continue
        }
      } catch { signal?.throwIfAborted() }
      reason = 'verified attachment unavailable'
    }
    resolved.set(i, { type: 'text', text: `[image attachment omitted: ${reason}]` })
  }
  return assemble(plan, resolved)
}

/**
 * Format all messages into one-shot ACP PromptContentBlock[] for stateless auxiliary calls
 * such as `session-title` or `compaction`.
 */
export function buildAuxiliaryPromptBlocks(messages: readonly PromptMessage[]): PromptContentBlock[] {
  const blocks: PromptContentBlock[] = []
  for (const msg of messages) {
    if (!msg || msg.role === 'system') continue
    const formatted = formatMessageForDigest(msg)
    if (formatted) {
      blocks.push({ type: 'text', text: formatted })
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
    } else if (part.type === 'image' || part.type === 'file') {
      return false
    }
  }
  return hasToolResult
}

function buildConversationDigest(earlier: readonly PromptMessage[], budgetChars: number): string {
  const selectedReversed: string[] = []
  let usedChars = 0
  let recentConversationMessages = 0

  for (let i = earlier.length - 1; i >= 0; i--) {
    const msg = earlier[i]
    if (!msg || msg.role === 'system') continue
    if (msg.source?.kind === 'runtime-context') continue

    const isRecentTextTurn = (msg.role === 'assistant' || msg.role === 'user') && recentConversationMessages < 2
    const maxTextChars = isRecentTextTurn ? MAX_RECENT_DIGEST_TEXT_CHARS : MAX_OLDER_DIGEST_TEXT_CHARS
    const line = formatMessageForDigest(msg, maxTextChars)
    if (!line) continue
    if (msg.role === 'assistant' || msg.role === 'user') {
      recentConversationMessages++
    }

    const cost = line.length + (selectedReversed.length > 0 ? 1 : 0)
    if (usedChars + cost > budgetChars) {
      if (selectedReversed.length === 0 && budgetChars > 16) {
        selectedReversed.push(clipHeadTail(line, budgetChars))
      }
      break
    }
    selectedReversed.push(line)
    usedChars += cost
  }

  return selectedReversed.reverse().join('\n')
}

function formatMessageForDigest(msg: PromptMessage, maxTextChars = MAX_OLDER_DIGEST_TEXT_CHARS): string {
  if (msg.role === 'tool') {
    const body = extractBlocksPlainText(msg.content).trim()
    if (!body) return ''
    return `[tool_result]: ${clipHeadTail(body, MAX_DIGEST_TOOL_RESULT_CHARS)}`
  }

  const pieces: string[] = []
  for (const part of msg.content) {
    if (part.type === 'text') {
      const t = part.text.trim()
      if (t) pieces.push(clipHeadTail(t, maxTextChars))
    } else if (part.type === 'image') {
      pieces.push('[image attachment]')
    } else if (part.type === 'file') {
      pieces.push(fileNotice(part))
    } else if (part.type === 'tool-call') {
      pieces.push(formatToolCallForDigest(part.name, part.arguments))
    } else if (part.type === 'tool-result') {
      const body = extractBlocksPlainText(part.content).trim()
      if (body) pieces.push(`[tool_result]: ${clipHeadTail(body, MAX_DIGEST_TOOL_RESULT_CHARS)}`)
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
  if (LEGACY_MIRROR_TOOL_NAMES.has(name)) {
    payload = safeParseRecord(rawArgs)
  } else if (name === WRAPPER_TOOL_NAME) {
    const outer = safeParseRecord(rawArgs)
    const code = typeof outer?.code === 'string' ? outer.code : ''
    for (const mirrorName of LEGACY_MIRROR_TOOL_NAMES) {
      const prefix = `await tools[${JSON.stringify(mirrorName)}](`
      if (code.startsWith(prefix) && code.endsWith(')')) {
        payload = safeParseRecord(code.slice(prefix.length, -1))
        break
      }
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

function extractBlocksPlainText(content: readonly HostBlock[]): string {
  const parts: string[] = []
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'image') parts.push('[image attachment]')
    else if (b.type === 'file') parts.push(fileNotice(b))
  }
  return parts.join('\n')
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return copyBoundedText(text)
  if (maxChars <= 3) return '.'.repeat(Math.max(0, maxChars))
  return copyBoundedText(text.slice(0, maxChars - 3).replace(/[\uD800-\uDBFF]$/u, '') + '...')
}

/** Keeps both head (60%) and tail (40%) so summaries and action checklists at the end survive truncation. */
function clipHeadTail(text: string, maxChars: number, headRatio = 0.6): string {
  if (text.length <= maxChars) return copyBoundedText(text)
  if (maxChars <= 64) return clipText(text, maxChars)
  const omitted = text.length - maxChars
  const marker = `\n...（省略约 ${omitted} 字符）...\n`
  const available = maxChars - marker.length
  if (available <= 16) return clipText(text, maxChars)
  const headLen = Math.max(8, Math.floor(available * headRatio))
  const tailLen = Math.max(8, available - headLen)
  return copyBoundedText(`${text.slice(0, headLen).replace(/[\uD800-\uDBFF]$/u, '')}${marker}${text.slice(-tailLen).replace(/^[\uDC00-\uDFFF]/u, '')}`)
}
