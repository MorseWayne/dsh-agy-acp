import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { PromptContentBlock } from '../acp/protocol.ts'

/**
 * Extract trailing user messages since the last assistant turn and convert them
 * into native ACP PromptContentBlock[].
 * Because ACP sessions are persistent, earlier turns live inside `agy acp`.
 */
export function buildPromptBlocks(messages: readonly Message[], isFirstTurn: boolean): PromptContentBlock[] {
  const trailingUsers: Message[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role === 'user') {
      trailingUsers.unshift(msg)
    } else if (msg.role === 'assistant') {
      break
    }
  }

  const blocks: PromptContentBlock[] = []

  // On first bind with pre-existing DSH history, prepend a concise transcript digest.
  if (isFirstTurn && messages.length > trailingUsers.length) {
    const earlier = messages.slice(0, messages.length - trailingUsers.length)
    const digestLines: string[] = []
    for (const msg of earlier.slice(-10)) {
      const text = extractPlainText(msg.content).trim()
      if (!text) continue
      const clipped = text.length > 600 ? text.slice(0, 600) + '...' : text
      digestLines.push(`[${msg.role}]: ${clipped}`)
    }
    if (digestLines.length > 0) {
      blocks.push({
        type: 'text',
        text: `<prior_conversation_digest>\n${digestLines.join('\n')}\n</prior_conversation_digest>`,
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

function extractPlainText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const b of content) {
    if (b.type === 'text') parts.push(b.text)
  }
  return parts.join('\n')
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
