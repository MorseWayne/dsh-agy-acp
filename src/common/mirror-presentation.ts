// Pure, platform-neutral (Node + Browser) helpers for classifying and projecting
// Antigravity ACP mirrored tool calls (`agy_acp_tool`) into structured UI cards.

export type MirrorToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

export interface MirrorLocation {
  path: string
  line?: number
}

export interface MirrorFileDiff {
  path: string
  oldText: string | null
  newText: string
}

export interface MirrorReadLine {
  number: number
  text: string
}

export interface MirrorReadCardData {
  path: string
  offset: number
  lines: MirrorReadLine[]
  totalLines: number
  lang?: string
}

export interface MirrorSearchMatch {
  lineNumber: number
  line: string
}

export interface MirrorSearchFileGroup {
  path: string
  matches: MirrorSearchMatch[]
}

export type MirrorSearchCardData =
  | { shape: 'matches'; files: MirrorSearchFileGroup[]; truncated: boolean; total: number }
  | { shape: 'paths'; paths: string[]; truncated: boolean; total: number }

export interface MirrorWebSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

export interface MirrorStepItem {
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed'
}

export interface MirrorAcpContentEntryLike {
  type?: string
  content?: { type?: string; text?: string }
  path?: string
  oldText?: string | null
  newText?: string
}

export const TERMINAL_TOOL_NAMES = new Set([
  'run_command',
  'bash',
  'shell',
  'execute_command',
  'terminal',
  'command_status',
])

export const EDIT_TOOL_NAMES = new Set([
  'edit_file',
  'edit',
  'write_file',
  'write',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'apply_patch',
])

export const WRITE_TOOL_NAMES = new Set(['write_file', 'write', 'write_to_file'])
export const READ_TOOL_NAMES = new Set(['read_file', 'read', 'view_file', 'view_file_outline', 'view_code_item'])
export const SEARCH_TOOL_NAMES = new Set(['grep_search', 'grep', 'glob', 'find_by_name', 'list_dir', 'search_files'])
export const CONTENT_SEARCH_TOOL_NAMES = new Set(['grep_search', 'grep'])
export const PATH_SEARCH_TOOL_NAMES = new Set(['glob', 'find_by_name', 'list_dir', 'search_files'])
export const FETCH_TOOL_NAMES = new Set(['search_web', 'web_search', 'web_fetch', 'read_url_content'])
export const WEB_SEARCH_TOOL_NAMES = new Set(['search_web', 'web_search'])
export const WEB_FETCH_TOOL_NAMES = new Set(['web_fetch', 'read_url_content'])
export const DELETE_TOOL_NAMES = new Set(['delete_file', 'remove_file'])
export const MOVE_TOOL_NAMES = new Set(['move_file', 'rename_file'])
export const STEPS_TOOL_NAMES = new Set(['update_steps', 'todo_write'])
export const SUBAGENT_TOOL_NAMES = new Set([
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'send_message',
  'swarm',
  'run_workflow',
])
export const SCHEDULE_TOOL_NAMES = new Set(['schedule'])
export const TASK_TOOL_NAMES = new Set(['manage_task'])

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.md': 'md',
  '.py': 'py',
  '.sh': 'sh',
  '.bash': 'sh',
  '.zsh': 'sh',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.xml': 'xml',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java',
  '.kt': 'kt',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.sql': 'sql',
  '.rb': 'rb',
  '.php': 'php',
  '.swift': 'swift',
  '.vue': 'vue',
  '.svelte': 'svelte',
}

export const MAX_READ_CARD_LINES = 500
export const MAX_SEARCH_ITEMS = 200
export const MAX_WEB_SOURCES = 20
export const MAX_DIFF_FILES = 16

const RUNTIME_TIMESTAMP_LINE_RE = /^\s*(?:Created|Completed)\s+At:\s+\S/i

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function firstString(obj: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return undefined
}

export function firstNumber(obj: Record<string, unknown> | null, keys: readonly string[]): number | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'number' && Number.isFinite(val)) return val
  }
  return undefined
}

export function normalizeMirrorToolName(tool?: string): string {
  return (tool ?? '').trim().toLowerCase()
}

export function inferLangFromPath(filePath: string): string | undefined {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  return EXT_TO_LANG[base.slice(dot).toLowerCase()]
}

export function classifyMirrorToolKind(tool?: string, rawKind?: string): MirrorToolKind {
  if (
    rawKind === 'read' ||
    rawKind === 'edit' ||
    rawKind === 'delete' ||
    rawKind === 'move' ||
    rawKind === 'search' ||
    rawKind === 'execute' ||
    rawKind === 'fetch' ||
    rawKind === 'other'
  ) {
    return rawKind
  }
  const name = normalizeMirrorToolName(tool)
  if (TERMINAL_TOOL_NAMES.has(name)) return 'execute'
  if (EDIT_TOOL_NAMES.has(name)) return 'edit'
  if (READ_TOOL_NAMES.has(name)) return 'read'
  if (SEARCH_TOOL_NAMES.has(name)) return 'search'
  if (FETCH_TOOL_NAMES.has(name)) return 'fetch'
  if (DELETE_TOOL_NAMES.has(name)) return 'delete'
  if (MOVE_TOOL_NAMES.has(name)) return 'move'
  return 'other'
}

export function extractMirrorFilePath(
  input: Record<string, unknown> | null,
  locations?: readonly MirrorLocation[],
): string | undefined {
  return (
    firstString(input, [
      'Path',
      'TargetFile',
      'target_file',
      'AbsolutePath',
      'absolute_path',
      'file_path',
      'filePath',
      'path',
      'File',
      'file',
      'DirectoryPath',
      'SearchPath',
    ]) ?? locations?.[0]?.path
  )
}

export function extractCommandFromInput(input: Record<string, unknown> | null): string | undefined {
  return firstString(input, ['CommandLine', 'command_line', 'commandLine', 'command', 'cmd', 'script'])
}

export function extractCwdFromInput(input: Record<string, unknown> | null): string | undefined {
  return firstString(input, ['Cwd', 'WorkingDirectory', 'working_dir', 'workingDir', 'cwd', 'workdir', 'workingDirectory'])
}

export function extractCommandDescription(
  input: Record<string, unknown> | null,
  title?: string,
  command?: string,
): string | undefined {
  const fromInput = firstString(input, ['Description', 'description', 'toolSummary'])
  if (fromInput) return fromInput
  if (title && title !== command) return title
  return undefined
}

/** Extracts ACP standard `content: [{ type: 'diff', path, oldText, newText }]` entries. */
export function extractAcpContentDiffs(content?: readonly MirrorAcpContentEntryLike[]): MirrorFileDiff[] {
  if (!Array.isArray(content) || content.length === 0) return []
  const diffs: MirrorFileDiff[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object' || item.type !== 'diff') continue
    if (typeof item.path !== 'string' || item.path.trim() === '') continue
    if (typeof item.newText !== 'string') continue
    const oldText = typeof item.oldText === 'string' ? item.oldText : null
    diffs.push({ path: item.path, oldText, newText: item.newText })
    if (diffs.length >= MAX_DIFF_FILES) break
  }
  return diffs
}

export function extractInputFileDiffs(
  tool: string | undefined,
  input: Record<string, unknown> | null,
  locations?: readonly MirrorLocation[],
): MirrorFileDiff[] {
  if (!input) return []
  const filePath = extractMirrorFilePath(input, locations)
  if (!filePath) return []

  const chunks = input.ReplacementChunks ?? input.replacement_chunks ?? input.chunks
  if (Array.isArray(chunks) && chunks.length > 0) {
    const diffs: MirrorFileDiff[] = []
    for (const chunk of chunks.slice(0, 32)) {
      const rec = asRecord(chunk)
      if (!rec) continue
      const oldText =
        typeof rec.TargetContent === 'string'
          ? rec.TargetContent
          : typeof rec.target_content === 'string'
            ? rec.target_content
            : typeof rec.oldText === 'string'
              ? rec.oldText
              : typeof rec.old_string === 'string'
                ? rec.old_string
                : null
      const newText =
        typeof rec.ReplacementContent === 'string'
          ? rec.ReplacementContent
          : typeof rec.replacement_content === 'string'
            ? rec.replacement_content
            : typeof rec.newText === 'string'
              ? rec.newText
              : typeof rec.new_string === 'string'
                ? rec.new_string
                : undefined
      if (newText !== undefined) {
        diffs.push({ path: filePath, oldText, newText })
      }
    }
    if (diffs.length > 0) return diffs
  }

  const target =
    typeof input.Target === 'string'
      ? input.Target
      : typeof input.TargetContent === 'string'
        ? input.TargetContent
        : typeof input.target_content === 'string'
          ? input.target_content
          : typeof input.old_string === 'string'
            ? input.old_string
            : typeof input.oldText === 'string'
              ? input.oldText
              : undefined
  const replacement =
    typeof input.Replacement === 'string'
      ? input.Replacement
      : typeof input.ReplacementContent === 'string'
        ? input.ReplacementContent
        : typeof input.replacement_content === 'string'
          ? input.replacement_content
          : typeof input.new_string === 'string'
            ? input.new_string
            : typeof input.newText === 'string'
              ? input.newText
              : undefined
  if (replacement !== undefined) {
    return [{ path: filePath, oldText: target ?? null, newText: replacement }]
  }

  const content =
    typeof input.Content === 'string'
      ? input.Content
      : typeof input.CodeContent === 'string'
        ? input.CodeContent
        : typeof input.code_content === 'string'
          ? input.code_content
          : typeof input.content === 'string'
            ? input.content
            : undefined
  if (content !== undefined) {
    return [{ path: filePath, oldText: null, newText: content }]
  }

  if (normalizeMirrorToolName(tool).includes('write') && (input.EmptyFile === true || input.empty_file === true)) {
    return [{ path: filePath, oldText: null, newText: '' }]
  }

  return []
}

export function skipLeadingRuntimeTimestamps(lines: readonly string[]): number {
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || RUNTIME_TIMESTAMP_LINE_RE.test(line)) {
      i++
      continue
    }
    break
  }
  return i
}

/** Extracts exit code from agy command output header like `Command exited with code 0.` */
export function extractExitCodeFromText(text: string): number | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = skipLeadingRuntimeTimestamps(lines)
  for (let i = start; i < Math.min(lines.length, start + 6); i++) {
    const m = /^\s*Command exited with code\s+(-?\d+)\.?\s*$/i.exec(lines[i] ?? '')
    if (m) {
      const code = Number(m[1])
      if (Number.isInteger(code)) return code
    }
  }
  const tail = /\n\[exit code:\s*(-?\d+)\]\s*$/i.exec(text)
  if (tail) {
    const code = Number(tail[1])
    if (Number.isInteger(code)) return code
  }
  return undefined
}

/** Strips agy runtime command preamble (`Created At:` / `Completed At:` / `Command exited with code N.` / `Command output:`) for clean terminal cards. */
export function cleanTerminalOutputText(text: string): string {
  const raw = text.replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  let idx = skipLeadingRuntimeTimestamps(lines)
  let strippedHeader = idx > 0

  if (idx < lines.length && /^\s*Command exited with code\s+-?\d+\.?\s*$/i.test(lines[idx] ?? '')) {
    idx++
    strippedHeader = true
    while (idx < lines.length && (lines[idx] ?? '').trim() === '') idx++
  }

  if (strippedHeader && idx < lines.length) {
    const cur = (lines[idx] ?? '').trim()
    if (/^Command output:\s*$/i.test(cur)) {
      idx++
    } else if (/^No output from the command\.?\s*$/i.test(cur)) {
      return ''
    }
  }

  let body = strippedHeader ? lines.slice(idx).join('\n') : raw
  body = body.replace(/\n\[exit code:\s*(?:-?\d+|null)\]\s*$/i, '')
  if (body.trim() === '(no output)') return ''
  return body
}

export function parseReadOutputData(
  filePath: string,
  outputText: string,
  offsetHintRaw?: number,
): MirrorReadCardData | null {
  if (!filePath || !outputText || outputText === '(no output)') return null

  const rawLines = outputText.replace(/\r\n/g, '\n').split('\n')
  let startIdx = skipLeadingRuntimeTimestamps(rawLines)
  let totalLinesHint: number | undefined
  let offsetHint = offsetHintRaw !== undefined && Number.isFinite(offsetHintRaw) && offsetHintRaw >= 1
    ? Math.floor(offsetHintRaw)
    : 1

  const headerMatch = /^\s*Showing lines\s+(\d+)\s*(?:to|-)\s*(\d+)\s+of\s+(\d+)/i.exec(rawLines[startIdx] ?? '')
  if (headerMatch) {
    offsetHint = Math.max(1, Number(headerMatch[1]))
    totalLinesHint = Math.max(1, Number(headerMatch[3]))
    startIdx++
  }

  const bodyLines = rawLines.slice(startIdx)
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop()
  }
  if (bodyLines.length === 0) return null

  const numberedRe = /^\s*(\d+)(?::\s?|\t|\s*\|\s?)(.*)$/
  const nonEmptyCount = bodyLines.filter(l => l.trim() !== '').length
  const numberedMatches = bodyLines.map(l => numberedRe.exec(l))
  const numberedHitCount = numberedMatches.filter(Boolean).length
  const isNumbered = nonEmptyCount > 0 && numberedHitCount >= Math.ceil(nonEmptyCount * 0.8)

  const parsed: MirrorReadLine[] = []
  let runningLine = offsetHint
  for (let i = 0; i < bodyLines.length && parsed.length < MAX_READ_CARD_LINES; i++) {
    const m = isNumbered ? numberedMatches[i] : null
    if (m) {
      const n = Math.max(1, Number(m[1]))
      runningLine = n + 1
      parsed.push({ number: n, text: m[2] ?? '' })
    } else {
      parsed.push({ number: runningLine++, text: bodyLines[i]! })
    }
  }
  if (parsed.length === 0) return null

  const offset = parsed[0]!.number
  const totalLines = Math.max(totalLinesHint ?? 0, offset + bodyLines.length - 1)
  const lang = inferLangFromPath(filePath)

  return {
    path: filePath,
    offset,
    lines: parsed,
    totalLines,
    ...(lang ? { lang } : {}),
  }
}

export function parseSearchOutputData(
  tool: string | undefined,
  kind: MirrorToolKind,
  input: Record<string, unknown> | null,
  outputText: string,
): MirrorSearchCardData | null {
  if (kind !== 'search') return null
  if (!outputText || outputText === '(no output)') return null

  const name = normalizeMirrorToolName(tool)
  const hasQuery = Boolean(firstString(input, ['Query', 'query', 'Pattern', 'pattern']))

  if (CONTENT_SEARCH_TOOL_NAMES.has(name) || (hasQuery && !PATH_SEARCH_TOOL_NAMES.has(name))) {
    const fileMap = new Map<string, MirrorSearchFileGroup>()
    let total = 0
    let retained = 0
    let truncated = false

    const rawLines = outputText.replace(/\r\n/g, '\n').split('\n')
    const lines = rawLines.slice(skipLeadingRuntimeTimestamps(rawLines))
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (!line) continue
      if (/truncated|showing\s+\d+\s+of/i.test(line)) {
        truncated = true
        continue
      }
      const m = /^([^:\s][^:]*):(\d+):(.*)$/.exec(line)
      if (!m) continue
      const filePath = m[1]!
      const lineNumber = Number(m[2])
      if (!Number.isInteger(lineNumber) || lineNumber < 1) continue
      total++
      if (retained >= MAX_SEARCH_ITEMS) {
        truncated = true
        continue
      }
      let group = fileMap.get(filePath)
      if (!group) {
        group = { path: filePath, matches: [] }
        fileMap.set(filePath, group)
      }
      group.matches.push({ lineNumber, line: m[3] ?? '' })
      retained++
    }

    if (fileMap.size > 0) {
      return {
        shape: 'matches',
        files: [...fileMap.values()],
        truncated,
        total,
      }
    }
    return null
  }

  if (PATH_SEARCH_TOOL_NAMES.has(name) || kind === 'search') {
    const paths: string[] = []
    let truncated = false
    let total = 0

    const trimmed = outputText.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const p =
              typeof item === 'string'
                ? item.trim()
                : firstString(asRecord(item), ['path', 'Path', 'filePath', 'name', 'Name'])
            if (!p) continue
            total++
            if (paths.length < MAX_SEARCH_ITEMS) paths.push(p)
            else truncated = true
          }
        }
      } catch {
        // fall through to line parser
      }
    }

    if (paths.length === 0) {
      const rawLines = outputText.replace(/\r\n/g, '\n').split('\n')
      const pathLines = rawLines.slice(skipLeadingRuntimeTimestamps(rawLines))
      for (const raw of pathLines) {
        const line = raw.trim()
        if (!line) continue
        if (RUNTIME_TIMESTAMP_LINE_RE.test(line)) continue
        if (/truncated|more files|showing\s+\d+/i.test(line)) {
          truncated = true
          continue
        }
        if (line.length > 260 || /\s{2,}/.test(line)) continue
        total++
        if (paths.length < MAX_SEARCH_ITEMS) paths.push(line)
        else truncated = true
      }
    }

    if (paths.length > 0) {
      return {
        shape: 'paths',
        paths,
        truncated,
        total,
      }
    }
  }

  return null
}

export function parseWebSourcesFromText(text: string): MirrorWebSource[] {
  const sources: MirrorWebSource[] = []
  const seen = new Set<string>()
  const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  for (const m of text.matchAll(mdLinkRe)) {
    const title = m[1]?.trim()
    const url = m[2]?.trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    sources.push({ url, ...(title ? { title } : {}) })
    if (sources.length >= MAX_WEB_SOURCES) break
  }
  return sources
}

export function parseWebSourcesArray(raw: unknown): MirrorWebSource[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: MirrorWebSource[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const url = firstString(rec, ['url', 'Url', 'link', 'href'])
    if (!url) continue
    const title = firstString(rec, ['title', 'Title', 'name'])
    const snippet = firstString(rec, ['snippet', 'Snippet', 'summary', 'description'])
    const publishedAt = firstString(rec, ['publishedAt', 'published_at', 'date'])
    out.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    })
    if (out.length >= MAX_WEB_SOURCES) break
  }
  return out.length > 0 ? out : undefined
}

export function extractHttpStatusFromText(text: string): number | undefined {
  const m = /(?:^|\n)\s*(?:HTTP\/[\d.]+\s+|Status(?:\s+Code)?:\s*)([1-5]\d{2})\b/i.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined
}

export function extractStepsFromInput(input: Record<string, unknown> | null): MirrorStepItem[] | null {
  if (!input) return null
  const raw = input.steps ?? input.todos
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: MirrorStepItem[] = []
  for (const entry of raw) {
    const rec = asRecord(entry)
    if (!rec) continue
    const title = firstString(rec, ['title', 'content', 'activeForm', 'text'])
    if (!title) continue
    const rawStatus = typeof rec.status === 'string' ? rec.status.trim().toLowerCase() : 'pending'
    const status: MirrorStepItem['status'] =
      rawStatus === 'done' || rawStatus === 'completed'
        ? 'done'
        : rawStatus === 'in_progress' || rawStatus === 'running'
          ? 'in_progress'
          : rawStatus === 'skipped'
            ? 'skipped'
            : rawStatus === 'failed' || rawStatus === 'error'
              ? 'failed'
              : 'pending'
    out.push({ title, status })
  }
  return out.length > 0 ? out : null
}
