import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import type { AcpToolCallUpdate } from '../acp/protocol.ts'
import { copyBoundedText, sanitizeToolPayload } from '../acp/payload-bounds.ts'
import path from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  defineTool,
  type DiffCallView,
  type DiffResultView,
  type FileDiff,
  type FileLocation,
  type GenericCallView,
  type GenericResultView,
  type ReadFileLine,
  type ReadResultView,
  type SearchFileMatches,
  type SearchResultView,
  type TerminalCallView,
  type TerminalResultView,
  type ToolCallKind,
  type ToolCallView,
  type ToolDefinition,
  type ToolResult,
  type ToolResultView,
  type WebFetchResultView,
  type WebResultView,
  type WebSearchResultView,
  type WebSource,
} from '@deepseek-ai/dsh-tools'
import { MIRROR_TOOL_NAME } from '../common/types.ts'
import {
  normalizeLocations,
  type AcpRunStore,
  type MergedToolCall,
  type NormalizedLocation,
} from './run-store.ts'

export interface MirrorToolInput {
  run: string
  step: number
  toolCallId?: string
  tool?: string
  title?: string
  kind?: string
  input?: unknown
  locations?: NormalizedLocation[]
}

interface MirrorResultMeta {
  output: string
  isError: boolean
  exitCode?: number
  signal?: string
  tool?: string
  title?: string
  kind?: string
  input?: unknown
  locations?: NormalizedLocation[]
  httpStatus?: number
  webSources?: WebSource[]
}

const TERMINAL_TOOL_NAMES = new Set([
  'run_command',
  'bash',
  'shell',
  'execute_command',
  'terminal',
  'command_status',
])

const EDIT_TOOL_NAMES = new Set([
  'edit_file',
  'edit',
  'write_file',
  'write',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'apply_patch',
])

const READ_TOOL_NAMES = new Set(['read_file', 'read', 'view_file', 'view_file_outline', 'view_code_item'])
const SEARCH_TOOL_NAMES = new Set(['grep_search', 'grep', 'glob', 'find_by_name', 'list_dir', 'search_files'])
const CONTENT_SEARCH_TOOL_NAMES = new Set(['grep_search', 'grep'])
const PATH_SEARCH_TOOL_NAMES = new Set(['glob', 'find_by_name', 'list_dir', 'search_files'])
const FETCH_TOOL_NAMES = new Set(['search_web', 'web_search', 'web_fetch', 'read_url_content'])
const WEB_SEARCH_TOOL_NAMES = new Set(['search_web', 'web_search'])
const WEB_FETCH_TOOL_NAMES = new Set(['web_fetch', 'read_url_content'])
const DELETE_TOOL_NAMES = new Set(['delete_file', 'remove_file'])
const MOVE_TOOL_NAMES = new Set(['move_file', 'rename_file'])

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

const COMPACT_INPUT_KEYS = [
  'CommandLine', 'command', 'cmd', 'script', 'command_line', 'commandLine',
  'Cwd', 'cwd', 'workdir', 'workingDirectory', 'working_dir',
  'Description', 'description', 'toolSummary',
  'Path', 'TargetFile', 'target_file', 'AbsolutePath', 'absolute_path', 'file_path', 'filePath', 'path', 'File', 'file', 'DirectoryPath', 'SearchPath',
  'StartLine', 'EndLine', 'offset', 'line', 'start_line', 'end_line',
  'Query', 'query', 'Pattern', 'pattern',
  'Url', 'url',
  'EmptyFile', 'empty_file',
] as const

const MAX_DISPLAY_INPUT_BYTES = 16 * 1024
const MAX_META_OUTPUT_BYTES = 64 * 1024
const MAX_READ_CARD_LINES = 500
const MAX_SEARCH_ITEMS = 200
const MAX_WEB_SOURCES = 20

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function firstString(obj: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return undefined
}

function firstNumber(obj: Record<string, unknown> | null, keys: readonly string[]): number | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'number' && Number.isFinite(val)) return val
  }
  return undefined
}

function normalizeToolName(tool?: string): string {
  return (tool ?? '').trim().toLowerCase()
}

export type LosslessJson =
  | string
  | number
  | boolean
  | null
  | LosslessJson[]
  | { [key: string]: LosslessJson }

function fitText(text: string, maxBytes: number, json = false): string {
  // Bound both the string inspected and its UTF-8/JSON wire representation.
  const size = (s: string) => Buffer.byteLength(json ? JSON.stringify(s) : s)
  let lo = 0, hi = Math.min(text.length, maxBytes)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (size(text.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return copyBoundedText(text.slice(0, lo).replace(/[\uD800-\uDBFF]$/u, ''))
}

/** Preserve small JSON; for oversized input retain only useful display fields. */
export function compactDisplayInput(raw: unknown, maxBytes = MAX_DISPLAY_INPUT_BYTES): LosslessJson | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) return undefined
  maxBytes = Math.min(maxBytes, 64 * 1024)
  const safe = sanitizeToolPayload(raw, { maxTotalText: maxBytes + 1, perStringLimit: maxBytes + 1 })
  if (safe === undefined) return undefined
  if (Buffer.byteLength(JSON.stringify(safe)) <= maxBytes) return safe as LosslessJson
  if (typeof raw === 'string') return fitText(raw, maxBytes, true)
  const rec = asRecord(safe)
  if (!rec) return undefined
  const compact: { [key: string]: LosslessJson } = {}
  for (const key of COMPACT_INPUT_KEYS) {
    const val = rec[key]
    if (typeof val === 'string') compact[key] = fitText(val, 1024, true)
    else if (typeof val === 'number' || typeof val === 'boolean') compact[key] = val
    if (Buffer.byteLength(JSON.stringify(compact)) > maxBytes) delete compact[key]
  }
  return Object.keys(compact).length ? compact : undefined
}

function classifyToolKind(tool?: string, rawKind?: string): ToolCallKind {
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
  const name = normalizeToolName(tool)
  if (TERMINAL_TOOL_NAMES.has(name)) return 'execute'
  if (EDIT_TOOL_NAMES.has(name)) return 'edit'
  if (READ_TOOL_NAMES.has(name)) return 'read'
  if (SEARCH_TOOL_NAMES.has(name)) return 'search'
  if (FETCH_TOOL_NAMES.has(name)) return 'fetch'
  if (DELETE_TOOL_NAMES.has(name)) return 'delete'
  if (MOVE_TOOL_NAMES.has(name)) return 'move'
  return 'other'
}

function extractFilePath(input: Record<string, unknown> | null, locations?: readonly NormalizedLocation[]): string | undefined {
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

const PRE_EDIT_FILE_MAX_BYTES = 1024 * 1024

interface WorkspaceIdentity { supplied: string; real: string; dev: number; ino: number }

function bindWorkspace(supplied?: string): WorkspaceIdentity | undefined {
  if (!supplied || !path.isAbsolute(supplied) || process.platform !== 'linux') return
  try {
    const real = realpathSync(supplied)
    const st = statSync(real)
    if (!st.isDirectory() || real === path.parse(real).root) return
    return { supplied, real, dev: st.dev, ino: st.ino }
  } catch { return }
}

function sameWorkspace(expected: WorkspaceIdentity): boolean {
  const now = bindWorkspace(expected.supplied)
  return now?.real === expected.real && now.dev === expected.dev && now.ino === expected.ino
}

/** Linux fd-backed verification: never follow a caller path outside the DSH workspace.
 * Without a trustworthy local root and descriptor path, do not open any target.
 * Presenters never call this function; a replay may already be post-edit. */
function readPreEditSnapshot(filePath: string, workspace?: WorkspaceIdentity): string | undefined {
  if (!workspace || !filePath || filePath.length > 4096 || !sameWorkspace(workspace)) return
  const { supplied: workspaceRoot, real: root } = workspace
  let fd: number | undefined
  try {
    const inRoot = (p: string): boolean => {
      const rel = path.relative(root, p)
      return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
    }
    const candidate = path.resolve(workspaceRoot, filePath)
    const relative = path.relative(workspaceRoot, candidate)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return
    const real = realpathSync(candidate)
    if (!inRoot(real) || !lstatSync(candidate).isFile()) return
    // O_PATH pins even a racing special file without activating a device/FIFO.
    // Node does not export Linux O_PATH. Reopen only a verified regular inode.
    fd = openSync(real, 0x200000 /* Linux O_PATH */ | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    const handle = `/proc/self/fd/${fd}`
    if (!st.isFile() || st.nlink !== 1 || st.size > PRE_EDIT_FILE_MAX_BYTES || !inRoot(realpathSync(handle)) || !sameWorkspace(workspace)) return
    const dataFd = openSync(handle, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const buf = Buffer.alloc(st.size + 1)
      let n = 0
      while (n < buf.length) {
        const read = readSync(dataFd, buf, n, buf.length - n, n)
        if (!read) break
        n += read
      }
      const after = fstatSync(dataFd)
      if (n !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs || buf.subarray(0, n).includes(0)) return
      return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n)).replaceAll('\r\n', '\n')
    } finally { closeSync(dataFd) }
  } catch { return } finally { if (fd !== undefined) closeSync(fd) }
}

function uniqueSnippetLine(text: string, snippet: string, from: number, to: number): number | undefined {
  if (!snippet || !Number.isSafeInteger(from) || from < 1 || to < from || (to !== Infinity && !Number.isSafeInteger(to))) return
  const needle = snippet.replaceAll('\r\n', '\n')
  let start = 0
  for (let line = 1; line < from; line++) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) return
    start = nl + 1
  }
  let end = text.length
  if (to !== Infinity) {
    let at = start
    for (let line = from; line <= to; line++) {
      const nl = text.indexOf('\n', at)
      if (nl === -1) { at = text.length; break }
      at = nl + 1
    }
    end = at
  }
  const window = text.slice(start, end)
  const index = window.indexOf(needle)
  if (index < 0 || window.indexOf(needle, index + 1) !== -1 || (index && window[index - 1] !== '\n')) return
  const after = index + needle.length
  if (after !== window.length && !needle.endsWith('\n') && window[after] !== '\n') return
  let line = from
  for (let nl = window.indexOf('\n'); nl >= 0 && nl < index; nl = window.indexOf('\n', nl + 1)) line++
  return line
}

export function locateUniqueSnippetLine(filePath: string, snippet: string, from = 1, to = Infinity, workspaceRoot?: string): number | undefined {
  const text = readPreEditSnapshot(filePath, bindWorkspace(workspaceRoot))
  return text === undefined ? undefined : uniqueSnippetLine(text, snippet, from, to)
}

function extractFileDiffs(
  tool: string | undefined,
  input: Record<string, unknown> | null,
  locations?: readonly NormalizedLocation[],
): FileDiff[] {
  if (!input) return []
  const filePath = extractFilePath(input, locations)
  if (!filePath) return []

  // Multi-chunk replacement (supports both PascalCase and snake_case: multi_replace_file_content)
  const chunks = input.ReplacementChunks ?? input.replacement_chunks ?? input.chunks
  if (Array.isArray(chunks) && chunks.length > 0) {
    const diffs: FileDiff[] = []
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

  // Single replacement (e.g. edit_file, replace_file_content, edit)
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

  // Whole-file write (e.g. write_file, write_to_file, write)
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

  // Empty file creation
  if (normalizeToolName(tool).includes('write') && (input.EmptyFile === true || input.empty_file === true)) {
    return [{ path: filePath, oldText: null, newText: '' }]
  }

  return []
}

/** Run once on sanitized start-frame input, before storing mirror locations. */
export function createPreEditLocator(workspaceRoot?: string): (tc: AcpToolCallUpdate) => NormalizedLocation[] | undefined {
  const workspace = bindWorkspace(workspaceRoot)
  return tc => captureLocations(tc, workspace)
}

export function capturePreEditLocations(tc: AcpToolCallUpdate, workspaceRoot?: string): NormalizedLocation[] | undefined {
  return captureLocations(tc, bindWorkspace(workspaceRoot))
}

function captureLocations(tc: AcpToolCallUpdate, workspace?: WorkspaceIdentity): NormalizedLocation[] | undefined {
  if (tc.sessionUpdate !== 'tool_call' || tc.status === 'completed' || tc.status === 'failed' ||
      !(tc.kind === 'edit' || EDIT_TOOL_NAMES.has(normalizeToolName(tc.name)))) return
  const input = asRecord(tc.rawInput ?? tc.args)
  if (!input) return
  const diffs = extractFileDiffs(tc.name, input, tc.locations)
  if (!diffs.some(d => d.oldText)) return
  const chunks = input.ReplacementChunks ?? input.replacement_chunks ?? input.chunks
  // Reject partial/malformed chunk lists rather than aligning hints by the wrong index.
  if (Array.isArray(chunks) && chunks.length !== diffs.length) return
  const text = readPreEditSnapshot(diffs[0]!.path, workspace)
  return diffs.map((diff, i) => {
    const hints = Array.isArray(chunks) ? asRecord(chunks[i]) : input
    const start = firstNumber(hints, ['StartLine', 'start_line'])
    const end = firstNumber(hints, ['EndLine', 'end_line'])
    const exact = diff.oldText && text !== undefined ? uniqueSnippetLine(text, diff.oldText, start ?? 1, end ?? Infinity) : undefined
    const hint = tc.locations?.[i]?.path === diff.path ? tc.locations[i]?.line : undefined
    const line = exact ?? hint ?? start
    return { path: diff.path, ...(line && Number.isSafeInteger(line) && line >= 1 ? { line } : {}) }
  })
}

function buildTerminalCallView(args: MirrorToolInput): TerminalCallView | null {
  const name = normalizeToolName(args.tool)
  const input = asRecord(args.input)
  const command = firstString(input, ['CommandLine', 'command_line', 'commandLine', 'command', 'cmd', 'script'])
  const isTerminal = TERMINAL_TOOL_NAMES.has(name) || args.kind === 'execute'
  if (!isTerminal || !command) return null

  const cwd = firstString(input, ['Cwd', 'WorkingDirectory', 'working_dir', 'workingDir', 'cwd', 'workdir', 'workingDirectory'])
  const description = firstString(input, ['Description', 'description', 'toolSummary']) ??
    (args.title && args.title !== command ? args.title : undefined)

  return {
    card: 'terminal',
    title: command,
    ...(description ? { description } : {}),
    ...(cwd ? { cwd } : {}),
  }
}

function buildDiffCallView(args: MirrorToolInput): DiffCallView | null {
  const name = normalizeToolName(args.tool)
  const input = asRecord(args.input)
  const isEdit = EDIT_TOOL_NAMES.has(name) || args.kind === 'edit'
  if (!isEdit) return null

  const diffs = extractFileDiffs(args.tool, input, args.locations)
  if (diffs.length === 0) return null

  const firstPath = diffs[0]!.path
  const chunks = input?.ReplacementChunks ?? input?.replacement_chunks ?? input?.chunks
  const locations: FileLocation[] = diffs.map((diff, i) => {
    const hint = Array.isArray(chunks) ? asRecord(chunks[i]) : input
    const line = (args.locations?.[i]?.path === diff.path ? args.locations[i]?.line : undefined) ?? firstNumber(hint, ['StartLine', 'start_line'])
    return { path: diff.path, ...(line && Number.isSafeInteger(line) && line >= 1 ? { line } : {}) }
  })
  const locatedLine = locations[0]?.line
  const verb = name.includes('write') ? 'Write' : 'Edit'
  const title = args.title || (locatedLine ? `${verb} ${firstPath}:${locatedLine}` : `${verb} ${firstPath}`)

  return {
    card: 'diff',
    title,
    diffs,
    locations,
  }
}

function buildGenericCallView(args: MirrorToolInput): GenericCallView {
  const input = asRecord(args.input)
  const kind = classifyToolKind(args.tool, args.kind)
  const filePath = extractFilePath(input, args.locations)
  const line = firstNumber(input, ['StartLine', 'offset', 'line', 'start_line']) ?? args.locations?.[0]?.line
  const query = firstString(input, ['Query', 'query', 'Pattern', 'pattern'])
  const url = firstString(input, ['Url', 'url'])

  let title = args.title
  if (!title) {
    if (kind === 'edit' && filePath) {
      title = line ? `Edit ${filePath}:${line}` : `Edit ${filePath}`
    } else if (kind === 'read' && filePath) {
      title = line ? `Read ${filePath}:${line}` : `Read ${filePath}`
    } else if (kind === 'search' && query) {
      title = filePath ? `Search "${query}" in ${filePath}` : `Search "${query}"`
    } else if (kind === 'search' && filePath) {
      title = `List ${filePath}`
    } else if (kind === 'fetch' && (url || query)) {
      title = url ? `Fetch ${url}` : `Search web "${query}"`
    } else if (filePath) {
      title = `${args.tool ?? 'tool'} ${filePath}`
    } else {
      title = args.tool ?? MIRROR_TOOL_NAME
    }
  }

  const locations: FileLocation[] | undefined = args.locations?.length
    ? args.locations.map(l => ({ path: l.path, ...(l.line !== undefined ? { line: l.line } : {}) }))
    : filePath
      ? [{ path: filePath, ...(line !== undefined && line >= 1 ? { line: Math.floor(line) } : {}) }]
      : undefined

  return {
    card: 'generic',
    title,
    kind,
    ...(args.input !== undefined ? { rawInput: args.input } : {}),
    ...(locations ? { locations } : {}),
  }
}

function inferLang(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return ext ? EXT_TO_LANG[ext] : undefined
}

const RUNTIME_TIMESTAMP_LINE_RE = /^\s*(?:Created|Completed)\s+At:\s+\S/i

/** Skips leading agy runtime timestamp headers (often duplicated twice) before parsing tool output. */
function skipLeadingRuntimeTimestamps(lines: readonly string[]): number {
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

function buildReadResultView(args: MirrorToolInput, outputText: string): ReadResultView | null {
  const kind = classifyToolKind(args.tool, args.kind)
  if (kind !== 'read') return null
  const input = asRecord(args.input)
  const filePath = extractFilePath(input, args.locations)
  if (!filePath || !outputText || outputText === '(no output)') return null

  const rawLines = outputText.replace(/\r\n/g, '\n').split('\n')
  let startIdx = skipLeadingRuntimeTimestamps(rawLines)
  let totalLinesHint: number | undefined
  let offsetHint = firstNumber(input, ['StartLine', 'offset', 'line', 'start_line']) ?? args.locations?.[0]?.line ?? 1
  if (!Number.isFinite(offsetHint) || offsetHint < 1) offsetHint = 1
  offsetHint = Math.floor(offsetHint)

  // Optional header like "Showing lines 10 to 30 of 120" or "Showing lines 10-30 of 120"
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

  // Detect uniform line-number prefix (`12: code` or `12\tcode` or `  12| code`)
  const numberedRe = /^\s*(\d+)(?::\s?|\t|\s*\|\s?)(.*)$/
  const nonEmptyCount = bodyLines.filter(l => l.trim() !== '').length
  const numberedMatches = bodyLines.map(l => numberedRe.exec(l))
  const numberedHitCount = numberedMatches.filter(Boolean).length
  const isNumbered = nonEmptyCount > 0 && numberedHitCount >= Math.ceil(nonEmptyCount * 0.8)

  const parsed: ReadFileLine[] = []
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
  const lang = inferLang(filePath)
  const generic = buildGenericCallView(args)

  return {
    card: 'read',
    title: generic.title,
    path: filePath,
    offset,
    lines: parsed,
    totalLines,
    ...(lang ? { lang } : {}),
    content: [{ type: 'text', text: parsed.map(l => l.text).join('\n') }],
  }
}

function buildSearchResultView(args: MirrorToolInput, outputText: string): SearchResultView | null {
  const name = normalizeToolName(args.tool)
  const kind = classifyToolKind(args.tool, args.kind)
  if (kind !== 'search') return null
  if (!outputText || outputText === '(no output)') return null

  const input = asRecord(args.input)
  const hasQuery = Boolean(firstString(input, ['Query', 'query', 'Pattern', 'pattern']))
  const generic = buildGenericCallView(args)

  // 1. Content search (grep / grep_search)
  if (CONTENT_SEARCH_TOOL_NAMES.has(name) || (hasQuery && !PATH_SEARCH_TOOL_NAMES.has(name))) {
    const fileMap = new Map<string, SearchFileMatches>()
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
        card: 'search',
        shape: 'matches',
        title: generic.title,
        files: [...fileMap.values()],
        truncated,
        total,
      }
    }
    return null
  }

  // 2. Path search (glob / find_by_name / list_dir / search_files)
  if (PATH_SEARCH_TOOL_NAMES.has(name) || kind === 'search') {
    const paths: string[] = []
    let truncated = false
    let total = 0

    // Support JSON array of paths or entries with `path`/`name`
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
        // Reject prose lines that clearly aren't paths
        if (line.length > 260 || /\s{2,}/.test(line)) continue
        total++
        if (paths.length < MAX_SEARCH_ITEMS) paths.push(line)
        else truncated = true
      }
    }

    if (paths.length > 0) {
      return {
        card: 'search',
        shape: 'paths',
        title: generic.title,
        paths,
        truncated,
        total,
      }
    }
  }

  return null
}

function parseWebSourcesFromText(text: string): WebSource[] {
  const sources: WebSource[] = []
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

function buildWebResultView(
  args: MirrorToolInput,
  outputText: string,
  meta: MirrorResultMeta | null,
): WebResultView | null {
  const name = normalizeToolName(args.tool)
  const kind = classifyToolKind(args.tool, args.kind)
  if (kind !== 'fetch') return null

  const input = asRecord(args.input)
  const generic = buildGenericCallView(args)
  const url = firstString(input, ['Url', 'url'])

  if (WEB_SEARCH_TOOL_NAMES.has(name) || (!WEB_FETCH_TOOL_NAMES.has(name) && !url)) {
    const sources = meta?.webSources?.length ? meta.webSources : parseWebSourcesFromText(outputText)
    if (sources.length === 0) return null
    const view: WebSearchResultView = {
      card: 'web',
      kind: 'search',
      title: generic.title,
      sources,
      truncated: sources.length >= MAX_WEB_SOURCES,
    }
    return view
  }

  // WebFetchResultView requires finite HTTP statusCode (100-599); never fabricate 200.
  const statusCode = meta?.httpStatus ?? extractHttpStatusFromText(outputText)
  if (!url || statusCode === undefined) return null

  const view: WebFetchResultView = {
    card: 'web',
    kind: 'fetch',
    title: generic.title,
    url,
    statusCode,
    truncated: /truncated/i.test(outputText),
  }
  return view
}

export function presentMirrorCall(args: MirrorToolInput): ToolCallView {
  return buildTerminalCallView(args) ?? buildDiffCallView(args) ?? buildGenericCallView(args)
}

function extractResultText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

function parseWebSources(raw: unknown): WebSource[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: WebSource[] = []
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

function parseResultMeta(meta: unknown): MirrorResultMeta | null {
  const rec = asRecord(meta)
  if (!rec || typeof rec.output !== 'string') return null
  const locations = normalizeLocations(rec.locations)
  const webSources = parseWebSources(rec.webSources)
  const httpStatus =
    typeof rec.httpStatus === 'number' && Number.isInteger(rec.httpStatus) && rec.httpStatus >= 100 && rec.httpStatus <= 599
      ? rec.httpStatus
      : undefined
  return {
    output: rec.output,
    isError: Boolean(rec.isError),
    ...(typeof rec.exitCode === 'number' ? { exitCode: rec.exitCode } : {}),
    ...(typeof rec.signal === 'string' ? { signal: rec.signal } : {}),
    ...(typeof rec.tool === 'string' && rec.tool ? { tool: rec.tool } : {}),
    ...(typeof rec.title === 'string' && rec.title ? { title: rec.title } : {}),
    ...(typeof rec.kind === 'string' && rec.kind ? { kind: rec.kind } : {}),
    ...(rec.input !== undefined ? { input: rec.input } : {}),
    ...(locations ? { locations } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(webSources ? { webSources } : {}),
  }
}

function hasEffectiveInput(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'object' && !Array.isArray(v)) return Object.keys(v as Record<string, unknown>).length > 0
  return true
}

export function presentMirrorResult(args: MirrorToolInput, result: ToolResult): ToolResultView {
  const meta = parseResultMeta(result.meta)
  const outputText = meta?.output ?? extractResultText(result.content)
  const isError = Boolean(result.isError || meta?.isError)
  const effectiveArgs: MirrorToolInput = {
    ...args,
    ...(meta?.tool && (!args.tool || args.tool === 'tool') ? { tool: meta.tool } : {}),
    ...(meta?.title && !args.title ? { title: meta.title } : {}),
    ...(meta?.kind && !args.kind ? { kind: meta.kind } : {}),
    ...(meta?.input !== undefined && !hasEffectiveInput(args.input) ? { input: meta.input } : {}),
    ...(meta?.locations?.length && !args.locations?.length ? { locations: meta.locations } : {}),
  }

  const terminalCall = buildTerminalCallView(effectiveArgs)
  if (terminalCall) {
    const view: TerminalResultView = {
      card: 'terminal',
      title: terminalCall.title,
      output: outputText,
      ...(meta?.signal
        ? { signal: meta.signal }
        : meta?.exitCode !== undefined
          ? { exitCode: meta.exitCode }
          : {}),
    }
    return view
  }

  const diffCall = buildDiffCallView(effectiveArgs)
  if (diffCall) {
    const view: DiffResultView = {
      card: 'diff',
      title: diffCall.title,
      diffs: diffCall.diffs,
    }
    return view
  }

  if (!isError) {
    const readView = buildReadResultView(effectiveArgs, outputText)
    if (readView) return readView

    const searchView = buildSearchResultView(effectiveArgs, outputText)
    if (searchView) return searchView

    const webView = buildWebResultView(effectiveArgs, outputText, meta)
    if (webView) return webView
  }

  const genericCall = buildGenericCallView(effectiveArgs)
  const view: GenericResultView = {
    card: 'generic',
    title: genericCall.title,
  }
  return view
}

function formatToolOutput(update: Pick<MergedToolCall, 'content' | 'rawOutput'>): string {
  if (Array.isArray(update.content) && update.content.length > 0) {
    const texts = update.content
      .map((c) => c.content?.text)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (texts.length > 0) return texts.join('\n')
  }
  if (update.rawOutput !== undefined) {
    if (typeof update.rawOutput === 'string') return update.rawOutput
    if (typeof update.rawOutput === 'object' && update.rawOutput !== null && 'output' in update.rawOutput) {
      const out = (update.rawOutput as { output?: unknown }).output
      if (typeof out === 'string') return out
    }
    try {
      return JSON.stringify(update.rawOutput, null, 2)
    } catch {
      return String(update.rawOutput)
    }
  }
  return '(no output)'
}

function extractExitCode(update: Pick<MergedToolCall, 'rawOutput'>): number | undefined {
  const raw = asRecord(update.rawOutput)
  const code = firstNumber(raw, ['exit_code', 'exitCode', 'code'])
  return code !== undefined && Number.isInteger(code) ? code : undefined
}

function extractSignal(update: Pick<MergedToolCall, 'rawOutput'>): string | undefined {
  const raw = asRecord(update.rawOutput)
  return firstString(raw, ['signal'])
}

function extractHttpStatusFromText(text: string): number | undefined {
  const m = /(?:^|\n)\s*(?:HTTP\/[\d.]+\s+|Status(?:\s+Code)?:\s*)([1-5]\d{2})\b/i.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined
}

function extractHttpStatus(update: Pick<MergedToolCall, 'rawOutput'>, outputText: string): number | undefined {
  const raw = asRecord(update.rawOutput)
  const code = firstNumber(raw, ['statusCode', 'status_code', 'httpStatus', 'status'])
  if (code !== undefined && Number.isInteger(code) && code >= 100 && code <= 599) return code
  return extractHttpStatusFromText(outputText)
}

function extractWebSources(update: Pick<MergedToolCall, 'rawOutput'>, outputText: string): WebSource[] | undefined {
  const raw = asRecord(update.rawOutput)
  const fromRaw =
    parseWebSources(raw?.sources) ??
    parseWebSources(raw?.results) ??
    parseWebSources(raw?.items)
  if (fromRaw?.length) return fromRaw
  const fromText = parseWebSourcesFromText(outputText)
  return fromText.length > 0 ? fromText : undefined
}

const LOCATION_ARRAY_SCHEMA = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      path: { type: 'string' as const, required: true as const },
      line: { type: 'integer' as const },
    },
  },
}

const WEB_SOURCES_SCHEMA = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      url: { type: 'string' as const, required: true as const },
      title: { type: 'string' as const },
      snippet: { type: 'string' as const },
      publishedAt: { type: 'string' as const },
    },
  },
}

/**
 * Defines the synthetic DSH mirror tool (`agy_acp_tool`).
 * Awaits live completion of the underlying ACP tool call and projects native DSH cards
 * (`terminal`, `diff`, `read`, `search`, `web`, `generic`).
 */
export function defineAgyAcpMirrorTool(runs: AcpRunStore): ToolDefinition {
  return defineTool({
    name: MIRROR_TOOL_NAME,
    description: 'Internal mirror that replays Antigravity ACP tool steps into DSH native tool cards.',
    parameters: {
      run: { type: 'string', required: true },
      step: { type: 'integer', required: true },
      toolCallId: { type: 'string' },
      tool: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string' },
      input: { type: 'json' },
      locations: LOCATION_ARRAY_SCHEMA,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          isError: { type: 'boolean', required: true },
          exitCode: { type: 'integer' },
          signal: { type: 'string' },
          tool: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string' },
          input: { type: 'json' },
          locations: LOCATION_ARRAY_SCHEMA,
          httpStatus: { type: 'integer' },
          webSources: WEB_SOURCES_SCHEMA,
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.output }]
      },
      presentationMeta(_args, value) {
        const cappedOutput = fitText(value.output, MAX_META_OUTPUT_BYTES)
        return {
          output: cappedOutput,
          isError: value.isError,
          ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
          ...(value.signal !== undefined ? { signal: value.signal } : {}),
          ...(value.tool !== undefined ? { tool: value.tool } : {}),
          ...(value.title !== undefined ? { title: value.title } : {}),
          ...(value.kind !== undefined ? { kind: value.kind } : {}),
          ...(value.input !== undefined ? { input: value.input } : {}),
          ...(value.locations !== undefined ? { locations: value.locations } : {}),
          ...(value.httpStatus !== undefined ? { httpStatus: value.httpStatus } : {}),
          ...(value.webSources !== undefined ? { webSources: value.webSources } : {}),
        }
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args, exec) {
      const rec = runs.get(args.run)
      if (rec?.owner && rec.owner !== exec.agent?.session.id) {
        throw new Error('ACP recording belongs to another DSH session')
      }
      if (!rec) {
        return {
          output: `[agy_acp_tool] recorded tool result unavailable (run=${args.run}, step=${args.step})`,
          isError: false,
        }
      }

      const key = args.toolCallId ?? args.step
      const completion = await rec.waitForToolCompletion(key, exec.signal)
      const merged = completion.tool

      if (completion.aborted) {
        const compactInput = merged ? compactDisplayInput(merged.rawInput ?? merged.args) : undefined
        const locations = merged ? normalizeLocations(merged.locations) : undefined
        return {
          output: 'Tool execution aborted by caller',
          isError: true,
          ...(merged?.name ? { tool: merged.name } : {}),
          ...(merged?.title ? { title: merged.title } : {}),
          ...(merged?.kind ? { kind: merged.kind } : {}),
          ...(compactInput !== undefined ? { input: compactInput } : {}),
          ...(locations ? { locations } : {}),
        }
      }

      if (!merged) {
        return {
          output: completion.runError ?? `[agy_acp_tool] recorded tool result unavailable (run=${args.run}, step=${args.step})`,
          isError: Boolean(completion.runError),
        }
      }

      const exitCode = extractExitCode(merged)
      const signal = extractSignal(merged)
      const output = !merged.settled && completion.runError ? completion.runError : formatToolOutput(merged)
      const isError =
        merged.status === 'failed' ||
        Boolean(completion.runError && !merged.settled) ||
        (exitCode !== undefined && exitCode !== 0)
      const compactInput = compactDisplayInput(merged.rawInput ?? merged.args)
      const locations = normalizeLocations(merged.locations)
      const kind = classifyToolKind(merged.name ?? args.tool, merged.kind ?? args.kind)
      const httpStatus = kind === 'fetch' ? extractHttpStatus(merged, output) : undefined
      const webSources = kind === 'fetch' ? extractWebSources(merged, output) : undefined

      return {
        output,
        isError,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(merged.name ? { tool: merged.name } : {}),
        ...(merged.title ? { title: merged.title } : {}),
        ...(merged.kind ? { kind: merged.kind } : {}),
        ...(compactInput !== undefined ? { input: compactInput } : {}),
        ...(locations ? { locations } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(webSources ? { webSources } : {}),
      }
    },
    presentCall(args) {
      return presentMirrorCall(args)
    },
    presentResult(args, result) {
      return presentMirrorResult(args, result)
    },
  })
}
