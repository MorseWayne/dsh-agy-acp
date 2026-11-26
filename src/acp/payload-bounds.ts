// Bounded projection of untrusted JSON tool frames. Limits are UTF-16 code units,
// including markers and object keys (not estimates of UTF-8 wire size).
const DEFAULT_TEXT_LIMIT = 16_000
const DEFAULT_MAX_NODES = 512
const DEFAULT_MAX_TOTAL_TEXT = 64_000
const DEFAULT_MAX_DEPTH = 12
const TAIL_MARKER = '[Earlier output truncated]\n\n'
const HEAD_MARKER = '\n\n[Command truncated]'
const COMMAND_FIELDS = new Set(['CommandLine', 'command_line', 'commandLine', 'command'])

export function copyBoundedText(text: string): string {
  return text ? Buffer.from(text, 'utf16le').toString('utf16le') : ''
}

function quota(n: number): number { return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0 }

function clip(text: string, limit: number, head: boolean): string {
  limit = quota(limit)
  if (!limit) return ''
  if (text.length <= limit) return copyBoundedText(text)
  const marker = head ? HEAD_MARKER : TAIL_MARKER
  if (limit <= marker.length) return marker.slice(0, limit)
  const keep = limit - marker.length
  const part = head ? text.slice(0, keep).replace(/[\uD800-\uDBFF]$/u, '')
                    : text.slice(-keep).replace(/^[\uDC00-\uDFFF]/u, '')
  return copyBoundedText(head ? part + marker : marker + part)
}

export function boundHeadText(text: string, limit = DEFAULT_TEXT_LIMIT): string { return clip(text, limit, true) }
export function boundTailText(text: string, limit = DEFAULT_TEXT_LIMIT): string { return clip(text, limit, false) }

export interface PayloadBudget { nodes: number; text: number; perStringLimit?: number }

function sanitizeNode(value: unknown, b: PayloadBudget, depth: number, field?: string): unknown {
  if (b.nodes-- <= 0 || depth > DEFAULT_MAX_DEPTH) return undefined
  if (typeof value === 'string') {
    if (/^data:[^,;]{0,128}[;,]/i.test(value) || b.text <= 0) return undefined
    const limit = Math.min(b.perStringLimit ?? DEFAULT_TEXT_LIMIT, b.text)
    const out = field && COMMAND_FIELDS.has(field) ? boundHeadText(value, limit) : boundTailText(value, limit)
    b.text -= out.length
    return out
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) {
    const out = []
    for (const v of value) {
      if (b.nodes <= 0) break
      const next = sanitizeNode(v, b, depth + 1)
      if (next !== undefined) out.push(next)
    }
    return out
  }
  if (typeof value !== 'object') return undefined
  const rec = value as Record<string, unknown>
  const entries: [string, unknown][] = []
  for (const k in rec) {
    if (b.nodes <= 0 || b.text <= 0) break
    // Even discarded keys count towards the visit bound. Never store truncated keys.
    if (!Object.hasOwn(rec, k) || k.length > 256 || k.length > b.text ||
        ((k === 'data' || k === 'blob') && (rec.type === 'image' || rec.type === 'audio' || typeof rec.mimeType === 'string')) ||
        ((k === 'formatted_output' || k === 'formattedOutput') && (rec[k] === rec.combinedOutput || rec[k] === rec.combined_output))) {
      b.nodes--; continue
    }
    b.text -= k.length
    const next = sanitizeNode(rec[k], b, depth + 1, k)
    if (next !== undefined) entries.push([copyBoundedText(k), next])
  }
  return Object.fromEntries(entries)
}

export function sanitizeToolPayload(payload: unknown, opts?: { maxNodes?: number; maxTotalText?: number; perStringLimit?: number }): unknown {
  return sanitizeNode(payload, {
    nodes: quota(opts?.maxNodes ?? DEFAULT_MAX_NODES), text: quota(opts?.maxTotalText ?? DEFAULT_MAX_TOTAL_TEXT),
    perStringLimit: quota(opts?.perStringLimit ?? DEFAULT_TEXT_LIMIT),
  }, 0)
}
