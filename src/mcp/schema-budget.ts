import {
  AGY_PER_TOOL_OVERHEAD_BYTES,
  DEFAULT_MAX_EAGER_SCHEMA_BYTES,
} from '../common/mcp-tool-policy.ts'

export { AGY_PER_TOOL_OVERHEAD_BYTES, DEFAULT_MAX_EAGER_SCHEMA_BYTES }

export interface BridgeToolSchema {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface NormalizedBridgeTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface SchemaBudgetResult {
  tools: NormalizedBridgeTool[]
  compacted: boolean
  originalEstimatedBytes: number
  finalEstimatedBytes: number
}

const TOOL_DESC_GENTLE_CAPS = [600, 420, 300, 220] as const
const TOOL_DESC_GENTLE_FLOOR = 220
const SCHEMA_DESC_CAPS = [240, 140, 80] as const
const SCHEMA_DESC_FLOOR = 80
const TOOL_DESC_TIGHT_CAPS = [140, 80] as const
const TOOL_DESC_TIGHT_FLOOR = 80
const TOOL_DESC_LAST_RESORT_CAP = 48

export function normalizeBridgeTool(tool: BridgeToolSchema): NormalizedBridgeTool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }
}

export function estimateAgyMcpBytes(
  tools: readonly NormalizedBridgeTool[],
  perToolOverhead = AGY_PER_TOOL_OVERHEAD_BYTES,
): number {
  if (tools.length === 0) return 0
  return Buffer.byteLength(JSON.stringify(tools), 'utf8') + tools.length * perToolOverhead
}

export function truncateDescriptionText(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars === 1) return '…'

  const slice = text.slice(0, maxChars - 1)
  const minSentenceCut = Math.floor(slice.length * 0.55)
  const sentenceMatch = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('; '),
    slice.lastIndexOf('。'),
    slice.lastIndexOf('\n'),
  )
  if (sentenceMatch >= minSentenceCut) {
    const ch = slice[sentenceMatch]
    const end = ch === '.' || ch === ';' || ch === '。' ? sentenceMatch + 1 : sentenceMatch
    return `${slice.slice(0, end).trimEnd()}…`
  }

  const minWordCut = Math.floor(slice.length * 0.78)
  const wordMatch = slice.lastIndexOf(' ')
  if (wordMatch >= minWordCut) {
    return `${slice.slice(0, wordMatch).trimEnd()}…`
  }

  return `${slice.trimEnd()}…`
}

function compactSchemaNode(value: unknown, maxDescChars: number, insidePropertiesMap: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactSchemaNode(item, maxDescChars, false))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(src)) {
    if (!insidePropertiesMap && key === 'description' && typeof entry === 'string') {
      if (maxDescChars > 0) {
        out[key] = truncateDescriptionText(entry, maxDescChars)
      }
      continue
    }
    out[key] = compactSchemaNode(entry, maxDescChars, key === 'properties')
  }
  return out
}

function applyCaps(
  source: readonly NormalizedBridgeTool[],
  toolDescCap: number | null,
  schemaDescCap: number | null,
): NormalizedBridgeTool[] {
  return source.map((tool) => ({
    name: tool.name,
    description: toolDescCap === null ? tool.description : truncateDescriptionText(tool.description, toolDescCap),
    inputSchema:
      schemaDescCap === null
        ? tool.inputSchema
        : (compactSchemaNode(tool.inputSchema, schemaDescCap, false) as Record<string, unknown>),
  }))
}

export function compactToolsForAgyBudget(
  tools: readonly NormalizedBridgeTool[],
  maxEstimatedBytes = DEFAULT_MAX_EAGER_SCHEMA_BYTES,
  perToolOverhead = AGY_PER_TOOL_OVERHEAD_BYTES,
): SchemaBudgetResult {
  const originalEstimatedBytes = estimateAgyMcpBytes(tools, perToolOverhead)
  if (!Number.isFinite(maxEstimatedBytes) || maxEstimatedBytes <= 0 || originalEstimatedBytes <= maxEstimatedBytes) {
    return {
      tools: [...tools],
      compacted: false,
      originalEstimatedBytes,
      finalEstimatedBytes: originalEstimatedBytes,
    }
  }

  let current: NormalizedBridgeTool[] = [...tools]
  let currentBytes = originalEstimatedBytes

  // Pass 1: progressively trim verbose top-level tool descriptions (preserves full inputSchema).
  for (const cap of TOOL_DESC_GENTLE_CAPS) {
    current = applyCaps(tools, cap, null)
    currentBytes = estimateAgyMcpBytes(current, perToolOverhead)
    if (currentBytes <= maxEstimatedBytes) {
      return { tools: current, compacted: true, originalEstimatedBytes, finalEstimatedBytes: currentBytes }
    }
  }

  // Pass 2: progressively trim verbose nested parameter descriptions while keeping all schema structure intact.
  for (const schemaCap of SCHEMA_DESC_CAPS) {
    current = applyCaps(tools, TOOL_DESC_GENTLE_FLOOR, schemaCap)
    currentBytes = estimateAgyMcpBytes(current, perToolOverhead)
    if (currentBytes <= maxEstimatedBytes) {
      return { tools: current, compacted: true, originalEstimatedBytes, finalEstimatedBytes: currentBytes }
    }
  }

  // Pass 3: tighten top-level descriptions alongside short parameter descriptions.
  for (const cap of TOOL_DESC_TIGHT_CAPS) {
    current = applyCaps(tools, cap, SCHEMA_DESC_FLOOR)
    currentBytes = estimateAgyMcpBytes(current, perToolOverhead)
    if (currentBytes <= maxEstimatedBytes) {
      return { tools: current, compacted: true, originalEstimatedBytes, finalEstimatedBytes: currentBytes }
    }
  }

  // Pass 4: drop nested parameter descriptions, keeping parameter names/types/enums/required intact.
  current = applyCaps(tools, TOOL_DESC_TIGHT_FLOOR, 0)
  currentBytes = estimateAgyMcpBytes(current, perToolOverhead)
  if (currentBytes <= maxEstimatedBytes) {
    return { tools: current, compacted: true, originalEstimatedBytes, finalEstimatedBytes: currentBytes }
  }

  current = applyCaps(tools, TOOL_DESC_LAST_RESORT_CAP, 0)
  currentBytes = estimateAgyMcpBytes(current, perToolOverhead)
  return { tools: current, compacted: true, originalEstimatedBytes, finalEstimatedBytes: currentBytes }
}
