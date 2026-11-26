// Pure view-model derivation for rendering `agy_acp_tool` calls inside DSH's
// conversation panel (`tool.call.toolview` slot) with native DSH aesthetics.

import {
  asRecord,
  classifyMirrorToolKind,
  cleanTerminalOutputText,
  CONTENT_SEARCH_TOOL_NAMES,
  DELETE_TOOL_NAMES,
  EDIT_TOOL_NAMES,
  extractCommandDescription,
  extractCommandFromInput,
  extractCwdFromInput,
  extractExitCodeFromText,
  extractHttpStatusFromText,
  extractInputFileDiffs,
  extractMirrorFilePath,
  extractStepsFromInput,
  firstNumber,
  firstString,
  MAX_WEB_SOURCES,
  MOVE_TOOL_NAMES,
  normalizeMirrorToolName,
  parseReadOutputData,
  parseSearchOutputData,
  parseWebSourcesArray,
  parseWebSourcesFromText,
  PATH_SEARCH_TOOL_NAMES,
  SCHEDULE_TOOL_NAMES,
  STEPS_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  TASK_TOOL_NAMES,
  TERMINAL_TOOL_NAMES,
  WEB_FETCH_TOOL_NAMES,
  WEB_SEARCH_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type MirrorFileDiff,
  type MirrorLocation,
  type MirrorReadLine,
  type MirrorSearchFileGroup,
  type MirrorStepItem,
  type MirrorToolKind,
  type MirrorWebSource,
} from '../common/mirror-presentation.ts'
import { MIRROR_TOOL_NAME } from '../common/types.ts'

export type AgyToolRowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

export type AgyToolCategory =
  | 'terminal'
  | 'diff'
  | 'read'
  | 'search'
  | 'web_search'
  | 'web_fetch'
  | 'steps'
  | 'agent'
  | 'schedule'
  | 'task'
  | 'file_op'
  | 'other'

export interface AgyToolArgsViewLike {
  text?(key: string): string | undefined
  complete?(key: string): boolean
}

export interface AgyToolBlockLike {
  readonly kind?: 'tool-result'
  readonly phase?: 'preparing' | 'start'
  readonly callId: string
  readonly name?: string
  readonly args?: AgyToolArgsViewLike
  readonly argsRaw?: string
  readonly call?: { name: string; argsRaw: string } | null
  readonly content?: ReadonlyArray<{ type: string; text?: string }>
  readonly isError?: boolean
  readonly error?: { name: string; code: string; reason?: string }
  readonly meta?: unknown
}

export interface AgyTerminalCardData {
  command: string
  cwd?: string
  output?: string
  exitCode?: number | null
  signal?: string
  running: boolean
}

export interface AgyDiffCardData {
  diffs: MirrorFileDiff[]
}

export interface AgyReadCardData {
  label: string
  lines: MirrorReadLine[]
  totalLines: number
  lang?: string
}

export type AgySearchCardData =
  | { kind: 'matches'; files: MirrorSearchFileGroup[]; truncated: boolean; total: number }
  | { kind: 'paths'; paths: string[]; truncated: boolean; total: number }

export type AgyWebCardData =
  | { kind: 'search'; sources: MirrorWebSource[]; truncated: boolean }
  | { kind: 'fetch'; url: string; statusCode: number; truncated: boolean }

export interface AgyStepsCardData {
  items: MirrorStepItem[]
  done: number
  total: number
  activeTitle?: string
}

export interface AgyMirrorRowViewModel {
  category: AgyToolCategory
  state: AgyToolRowState
  title: string
  summary: string
  summarySuffix?: string
  exitLabel?: string
  errorSummary?: string
  filePath?: string
  filePathLine?: number
  href?: string
  terminal?: AgyTerminalCardData
  diff?: AgyDiffCardData
  read?: AgyReadCardData
  search?: AgySearchCardData
  web?: AgyWebCardData
  steps?: AgyStepsCardData
  inputText?: string
  outputText?: string
  expandable: boolean
}

export interface MirrorRowDeriveOptions {
  cwd?: string
  home?: string
  locale?: 'zh' | 'en'
}

interface ParsedMirrorPayload {
  tool?: string
  title?: string
  kind?: string
  input?: unknown
  locations?: MirrorLocation[]
}

interface ParsedMirrorMeta {
  output?: string
  isError?: boolean
  exitCode?: number
  signal?: string
  tool?: string
  title?: string
  kind?: string
  input?: unknown
  locations?: MirrorLocation[]
  diffs?: MirrorFileDiff[]
  httpStatus?: number
  webSources?: MirrorWebSource[]
  stopped?: boolean
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

export function relativizeDisplayPath(text: string, cwd?: string, home?: string): string {
  let out = text
  if (cwd && cwd.length > 0) {
    const root = cwd.replace(/[/\\]+$/, '')
    if (out === root) {
      out = '.'
    } else if (out.startsWith(`${root}/`) || out.startsWith(`${root}\\`)) {
      out = out.slice(root.length + 1)
    }
  }
  if (home && home.length > 0 && !isWindowsStylePath(out) && !isWindowsStylePath(home)) {
    const homeRoot = home.replace(/\/+$/, '')
    if (homeRoot.length > 0 && homeRoot !== '/') {
      if (out.replace(/\/+$/, '') === homeRoot) return '~'
      if (out.startsWith(`${homeRoot}/`)) return `~${out.slice(homeRoot.length)}`
    }
  }
  return out
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return (nl === -1 ? text : text.slice(0, nl)).trim()
}

function normalizeLocations(raw: unknown): MirrorLocation[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: MirrorLocation[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec || typeof rec.path !== 'string' || !rec.path.trim()) continue
    const line = typeof rec.line === 'number' && Number.isFinite(rec.line) && rec.line >= 1 ? Math.floor(rec.line) : undefined
    out.push({ path: rec.path, ...(line !== undefined ? { line } : {}) })
  }
  return out.length > 0 ? out : undefined
}

function parseMetaDiffs(raw: unknown): MirrorFileDiff[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: MirrorFileDiff[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec || typeof rec.path !== 'string' || !rec.path) continue
    if (rec.oldText !== null && typeof rec.oldText !== 'string') continue
    if (typeof rec.newText !== 'string') continue
    out.push({ path: rec.path, oldText: rec.oldText, newText: rec.newText })
  }
  return out.length > 0 ? out : undefined
}

function parseMirrorPayload(argsRaw: string | null): ParsedMirrorPayload | null {
  if (!argsRaw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  const rec = asRecord(parsed)
  if (!rec) return null
  return {
    ...(typeof rec.tool === 'string' && rec.tool.trim() ? { tool: rec.tool.trim() } : {}),
    ...(typeof rec.title === 'string' && rec.title.trim() ? { title: rec.title.trim() } : {}),
    ...(typeof rec.kind === 'string' && rec.kind.trim() ? { kind: rec.kind.trim() } : {}),
    ...(rec.input !== undefined ? { input: rec.input } : {}),
    ...(normalizeLocations(rec.locations) ? { locations: normalizeLocations(rec.locations) } : {}),
  }
}

function parseMirrorMeta(meta: unknown): ParsedMirrorMeta | null {
  const rec = asRecord(meta)
  if (!rec) return null
  const locations = normalizeLocations(rec.locations)
  const diffs = parseMetaDiffs(rec.diffs)
  const webSources = parseWebSourcesArray(rec.webSources)
  const httpStatus =
    typeof rec.httpStatus === 'number' && Number.isInteger(rec.httpStatus) && rec.httpStatus >= 100 && rec.httpStatus <= 599
      ? rec.httpStatus
      : undefined
  return {
    ...(typeof rec.output === 'string' ? { output: rec.output } : {}),
    ...(typeof rec.isError === 'boolean' ? { isError: rec.isError } : {}),
    ...(typeof rec.exitCode === 'number' && Number.isInteger(rec.exitCode) ? { exitCode: rec.exitCode } : {}),
    ...(typeof rec.signal === 'string' && rec.signal ? { signal: rec.signal } : {}),
    ...(typeof rec.tool === 'string' && rec.tool.trim() ? { tool: rec.tool.trim() } : {}),
    ...(typeof rec.title === 'string' && rec.title.trim() ? { title: rec.title.trim() } : {}),
    ...(typeof rec.kind === 'string' && rec.kind.trim() ? { kind: rec.kind.trim() } : {}),
    ...(rec.input !== undefined ? { input: rec.input } : {}),
    ...(locations ? { locations } : {}),
    ...(diffs ? { diffs } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(webSources ? { webSources } : {}),
    ...(rec.stopped === true ? { stopped: true } : {}),
  }
}

function flattenResultContent(block: AgyToolBlockLike): string {
  const parts: string[] = []
  if (Array.isArray(block.content)) {
    for (const entry of block.content) {
      if (entry.type === 'text' && typeof entry.text === 'string') {
        parts.push(entry.text)
      } else {
        try {
          parts.push(JSON.stringify(entry, null, 2))
        } catch {
          // ignore
        }
      }
    }
  }
  if (parts.length === 0 && block.error) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n')
}

function isPlaceholderToolName(name?: string): boolean {
  const n = normalizeMirrorToolName(name)
  return !n || n === 'tool' || n === MIRROR_TOOL_NAME
}

function hasEffectiveInput(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'object' && !Array.isArray(v)) return Object.keys(v as Record<string, unknown>).length > 0
  return true
}

/** Infers real tool name, command, or path from ACP `title` when `tool` is omitted or `'tool'`. */
function inferHintsFromTitle(
  tool: string | undefined,
  kind: MirrorToolKind,
  title: string | undefined,
): { tool?: string; command?: string; path?: string; cleanedTitle?: string } {
  if (!title) return {}
  const trimmed = title.trim()
  if (!trimmed) return {}

  // e.g. `Run update_steps`, `Run manage_task`
  const runToolMatch = /^Run\s+([a-z][a-z0-9_.-]{1,63})$/i.exec(trimmed)
  if (runToolMatch && isPlaceholderToolName(tool)) {
    return { tool: runToolMatch[1] }
  }

  // e.g. `Run \`git status\`` or `Run command \`git status\``
  const runBacktickMatch = /^Run(?:\s+command)?\s+`([^`]+)`$/i.exec(trimmed)
  if (runBacktickMatch) {
    return { command: runBacktickMatch[1], cleanedTitle: runBacktickMatch[1] }
  }

  // e.g. `File src/index.ts`, `Read src/index.ts`, `View src/index.ts`, `Edit src/index.ts`, `Write src/index.ts`
  const fileVerbMatch = /^(?:File|Read|View|Edit|Write)\s+(.+)$/i.exec(trimmed)
  if (fileVerbMatch && (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move')) {
    const target = fileVerbMatch[1]!.trim()
    if (target && !/\s{2,}/.test(target)) {
      return { path: target, cleanedTitle: target }
    }
  }

  return {}
}

function safeHttpUrl(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : undefined
  } catch {
    return undefined
  }
}

function humanizeToolName(name: string, zh: boolean): string {
  const n = normalizeMirrorToolName(name)
  if (!n || n === 'tool' || n === MIRROR_TOOL_NAME) return zh ? '工具调用' : 'Tool call'
  if (n === 'invoke_subagent') return zh ? '子代理' : 'Subagent'
  if (n === 'define_subagent') return zh ? '定义子代理' : 'Define subagent'
  if (n === 'manage_subagents') return zh ? '管理子代理' : 'Manage subagents'
  if (n === 'send_message') return zh ? '发送消息' : 'Send message'
  if (n === 'swarm') return zh ? '协同集群' : 'Swarm'
  if (n === 'run_workflow') return zh ? '运行工作流' : 'Run workflow'
  if (n === 'manage_task') return zh ? '后台任务' : 'Background task'
  if (n === 'schedule') return zh ? '定时任务' : 'Schedule'
  if (n === 'ask_question') return zh ? '提问' : 'Ask question'
  if (n === 'call_mcp_tool') return zh ? 'MCP 工具' : 'MCP tool'
  if (n === 'list_resources') return zh ? '列出资源' : 'List resources'
  if (n === 'read_resource') return zh ? '读取资源' : 'Read resource'
  if (n.startsWith('mcp_')) return n.slice(4)
  return name
}

function summarizeGenericInput(
  input: Record<string, unknown> | null,
  cwd?: string,
  home?: string,
): string | undefined {
  if (!input) return undefined
  const preferred = firstString(input, [
    'toolSummary',
    'Description',
    'description',
    'Role',
    'role',
    'Action',
    'action',
    'ToolName',
    'Name',
    'name',
    'Query',
    'query',
    'Pattern',
    'pattern',
    'Prompt',
    'prompt',
    'Message',
    'message',
    'Url',
    'url',
    'CronExpression',
    'TaskId',
  ])
  if (preferred) return firstLine(preferred)
  const filePath = extractMirrorFilePath(input)
  if (filePath) return relativizeDisplayPath(filePath, cwd, home)
  for (const [k, v] of Object.entries(input)) {
    if (k === 'run' || k === 'step' || k === 'toolCallId') continue
    if (typeof v === 'string' && v.trim()) return firstLine(v)
  }
  return undefined
}

function formatUnwrappedInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'string') {
    return input.trim() ? input : undefined
  }
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0) {
    return undefined
  }
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function cleanGenericOutput(outputText: string, state: AgyToolRowState): string | undefined {
  const trimmed = outputText.trim()
  if (!trimmed) return undefined
  if (state === 'ok' && trimmed === '(no output)') return undefined
  return outputText
}

export function deriveAgyMirrorRowModel(
  block: AgyToolBlockLike,
  options: MirrorRowDeriveOptions = {},
): AgyMirrorRowViewModel {
  const zh = options.locale !== 'en'
  const cwd = options.cwd
  const home = options.home
  const isResult = block.kind === 'tool-result'
  const isPreparing = !isResult && block.phase === 'preparing'

  if (isPreparing) {
    const streamTool = block.args?.text?.('tool')?.trim()
    const streamTitle = block.args?.text?.('title')?.trim()
    const streamKind = block.args?.text?.('kind')?.trim()
    const kind = classifyMirrorToolKind(streamTool, streamKind)
    const { category, title } = resolveCategoryAndTitle(streamTool, kind, undefined, false, zh)
    return {
      category,
      state: 'preparing',
      title,
      summary: streamTitle ? relativizeDisplayPath(firstLine(streamTitle), cwd, home) : '',
      expandable: false,
    }
  }

  const argsRaw = isResult ? block.call?.argsRaw ?? null : block.argsRaw ?? null
  const payload = parseMirrorPayload(argsRaw)
  const meta = isResult ? parseMirrorMeta(block.meta) : null

  let tool = !isPlaceholderToolName(payload?.tool)
    ? payload?.tool
    : !isPlaceholderToolName(meta?.tool)
      ? meta?.tool
      : payload?.tool ?? meta?.tool
  const rawTitle = payload?.title ?? meta?.title
  const rawKind = payload?.kind ?? meta?.kind
  const rawInput = hasEffectiveInput(payload?.input) ? payload?.input : meta?.input
  const inputRec = asRecord(rawInput)
  const locations = payload?.locations?.length ? payload.locations : meta?.locations

  let kind = classifyMirrorToolKind(tool, rawKind)
  const titleHints = inferHintsFromTitle(tool, kind, rawTitle)
  if (titleHints.tool && isPlaceholderToolName(tool)) {
    tool = titleHints.tool
    kind = classifyMirrorToolKind(tool, rawKind)
  }

  const rawOutputText = isResult ? (meta?.output ?? flattenResultContent(block)) : ''
  const name = normalizeMirrorToolName(tool)

  const isTerminal = TERMINAL_TOOL_NAMES.has(name) || kind === 'execute'
  const exitCode = isResult
    ? (meta?.exitCode ?? (isTerminal ? extractExitCodeFromText(rawOutputText) : undefined))
    : undefined
  const signal = isResult ? meta?.signal : undefined

  const isStopped = isResult && (block.error?.code === 'interrupted' || meta?.stopped === true)
  const hasExitFailure = isResult && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
  const isError = isResult && !isStopped && (Boolean(block.isError) || Boolean(meta?.isError) || hasExitFailure)
  const state: AgyToolRowState = !isResult
    ? 'running'
    : isStopped
      ? 'stopped'
      : isError
        ? 'error'
        : 'ok'

  const filePath = extractMirrorFilePath(inputRec, locations) ?? titleHints.path
  const startLine = firstNumber(inputRec, ['StartLine', 'offset', 'line', 'start_line']) ?? locations?.[0]?.line
  const endLine = firstNumber(inputRec, ['EndLine', 'end_line'])
  const command = extractCommandFromInput(inputRec) ?? (isTerminal ? titleHints.command : undefined)
  const url = firstString(inputRec, ['Url', 'url'])
  const query = firstString(inputRec, ['Query', 'query', 'Pattern', 'pattern'])

  // 1. Terminal / Command execution
  if (isTerminal) {
    const cmdCwd = extractCwdFromInput(inputRec) ?? cwd
    const desc = extractCommandDescription(inputRec, titleHints.cleanedTitle ?? rawTitle, command)
    const summaryText = firstLine(desc ?? command ?? rawTitle ?? '')
    const exitLabel =
      signal !== undefined
        ? (zh ? `信号 ${signal}` : `signal ${signal}`)
        : exitCode !== undefined && exitCode !== 0
          ? (zh ? `退出码 ${exitCode}` : `exit code ${exitCode}`)
          : undefined
    const cleanedOut = isResult ? cleanTerminalOutputText(rawOutputText) : undefined
    const terminal: AgyTerminalCardData | undefined = command
      ? {
          command,
          ...(cmdCwd ? { cwd: cmdCwd } : {}),
          ...(isResult ? { output: cleanedOut } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(signal !== undefined ? { signal } : {}),
          running: !isResult,
        }
      : undefined

    const inputText = terminal ? undefined : formatUnwrappedInput(rawInput)
    const outputText = terminal ? undefined : cleanGenericOutput(rawOutputText, state)
    const errorSummary =
      state === 'error' && !exitLabel && cleanedOut ? firstLine(cleanedOut) : undefined

    return {
      category: 'terminal',
      state,
      title: zh ? '运行命令' : 'Bash',
      summary: summaryText,
      ...(exitLabel ? { exitLabel } : {}),
      ...(errorSummary ? { errorSummary } : {}),
      ...(terminal ? { terminal } : {}),
      ...(inputText ? { inputText } : {}),
      ...(outputText ? { outputText } : {}),
      expandable: Boolean(terminal || inputText || outputText),
    }
  }

  // 2. File Edit / Write (Diff)
  const metaDiffs = meta?.diffs
  const inputDiffs = extractInputFileDiffs(tool, inputRec, locations)
  const resolvedDiffs = metaDiffs?.length ? metaDiffs : inputDiffs
  const isEdit = EDIT_TOOL_NAMES.has(name) || kind === 'edit' || resolvedDiffs.length > 0
  if (isEdit) {
    const isWrite =
      WRITE_TOOL_NAMES.has(name) ||
      (resolvedDiffs.length > 0 && resolvedDiffs.every(d => d.oldText === null) && !name.includes('edit') && !name.includes('replace'))
    const targetPath = filePath ?? resolvedDiffs[0]?.path
    const displayPath = targetPath ? relativizeDisplayPath(targetPath, cwd, home) : firstLine(rawTitle ?? '')
    const diff: AgyDiffCardData | undefined =
      resolvedDiffs.length > 0
        ? {
            diffs: resolvedDiffs.map(d => ({
              ...d,
              path: relativizeDisplayPath(d.path, cwd, home),
            })),
          }
        : undefined
    const outputText = cleanGenericOutput(rawOutputText, state)
    const inputText = diff ? undefined : formatUnwrappedInput(rawInput)
    const errorSummary = state === 'error' && outputText ? firstLine(outputText) : undefined

    return {
      category: 'diff',
      state,
      title: isWrite ? (zh ? '写入' : 'Write') : (zh ? '编辑' : 'Edit'),
      summary: displayPath,
      ...(errorSummary ? { errorSummary } : {}),
      ...(targetPath ? { filePath: targetPath } : {}),
      ...(startLine && startLine >= 1 ? { filePathLine: Math.floor(startLine) } : {}),
      ...(diff ? { diff } : {}),
      ...(inputText ? { inputText } : {}),
      ...(outputText ? { outputText } : {}),
      expandable: Boolean(diff || inputText || outputText),
    }
  }

  // 3. File Read
  if (kind === 'read') {
    const displayPath = filePath ? relativizeDisplayPath(filePath, cwd, home) : firstLine(rawTitle ?? '')
    const lineRange =
      startLine && startLine >= 1
        ? endLine && endLine >= startLine
          ? `:${Math.floor(startLine)}–${Math.floor(endLine)}`
          : `:${Math.floor(startLine)}`
        : ''
    const summaryText = filePath ? `${displayPath}${lineRange}` : displayPath

    let readCard: AgyReadCardData | undefined
    if (isResult && !isError && !isStopped && filePath) {
      const parsedRead = parseReadOutputData(filePath, rawOutputText, startLine)
      if (parsedRead) {
        readCard = {
          label: relativizeDisplayPath(parsedRead.path, cwd, home),
          lines: parsedRead.lines,
          totalLines: parsedRead.totalLines,
          ...(parsedRead.lang ? { lang: parsedRead.lang } : {}),
        }
      }
    }
    const outputText = readCard ? undefined : cleanGenericOutput(rawOutputText, state)
    const errorSummary = state === 'error' && outputText ? firstLine(outputText) : undefined

    return {
      category: 'read',
      state,
      title: zh ? '读取' : 'Read',
      summary: summaryText,
      ...(errorSummary ? { errorSummary } : {}),
      ...(filePath ? { filePath } : {}),
      ...(startLine && startLine >= 1 ? { filePathLine: Math.floor(startLine) } : {}),
      ...(readCard ? { read: readCard } : {}),
      ...(outputText ? { outputText } : {}),
      expandable: Boolean(readCard || outputText),
    }
  }

  // 4. Search (grep / glob / list_dir / find_by_name)
  if (kind === 'search') {
    const isContentSearch = CONTENT_SEARCH_TOOL_NAMES.has(name) || (Boolean(query) && !PATH_SEARCH_TOOL_NAMES.has(name))
    const displayScope = filePath ? relativizeDisplayPath(filePath, cwd, home) : undefined
    let summaryText = ''
    if (query && displayScope) {
      summaryText = `${query} · ${displayScope}`
    } else if (query) {
      summaryText = query
    } else if (displayScope) {
      summaryText = displayScope
    } else if (rawTitle) {
      summaryText = firstLine(rawTitle)
    }

    let searchCard: AgySearchCardData | undefined
    if (isResult && !isError && !isStopped) {
      const parsedSearch = parseSearchOutputData(tool, kind, inputRec, rawOutputText)
      if (parsedSearch) {
        if (parsedSearch.shape === 'matches') {
          searchCard = {
            kind: 'matches',
            files: parsedSearch.files.map(g => ({
              path: relativizeDisplayPath(g.path, cwd, home),
              matches: g.matches,
            })),
            truncated: parsedSearch.truncated,
            total: parsedSearch.total,
          }
        } else {
          searchCard = {
            kind: 'paths',
            paths: parsedSearch.paths.map(p => relativizeDisplayPath(p, cwd, home)),
            truncated: parsedSearch.truncated,
            total: parsedSearch.total,
          }
        }
      }
    }
    const outputText = searchCard ? undefined : cleanGenericOutput(rawOutputText, state)
    const inputText = searchCard ? undefined : formatUnwrappedInput(rawInput)
    const errorSummary = state === 'error' && outputText ? firstLine(outputText) : undefined

    return {
      category: 'search',
      state,
      title: isContentSearch
        ? (zh ? '搜索文件内容' : 'Grep')
        : PATH_SEARCH_TOOL_NAMES.has(name)
          ? (zh ? '查找文件' : 'Glob')
          : (zh ? '搜索' : 'Search'),
      summary: summaryText,
      ...(errorSummary ? { errorSummary } : {}),
      ...(searchCard ? { search: searchCard } : {}),
      ...(inputText ? { inputText } : {}),
      ...(outputText ? { outputText } : {}),
      expandable: Boolean(searchCard || inputText || outputText),
    }
  }

  // 5. Web Search / Web Fetch
  if (kind === 'fetch') {
    const isWebSearch = WEB_SEARCH_TOOL_NAMES.has(name) || (!WEB_FETCH_TOOL_NAMES.has(name) && !url)
    const href = !isWebSearch ? safeHttpUrl(url) : undefined
    const summaryText = firstLine(isWebSearch ? (query ?? rawTitle ?? '') : (url ?? rawTitle ?? ''))

    let webCard: AgyWebCardData | undefined
    if (isResult && !isError && !isStopped) {
      if (isWebSearch) {
        const sources = meta?.webSources?.length ? meta.webSources : parseWebSourcesFromText(rawOutputText)
        if (sources.length > 0) {
          webCard = {
            kind: 'search',
            sources,
            truncated: sources.length >= MAX_WEB_SOURCES,
          }
        }
      } else {
        const statusCode = meta?.httpStatus ?? extractHttpStatusFromText(rawOutputText)
        if (url && statusCode !== undefined) {
          webCard = {
            kind: 'fetch',
            url,
            statusCode,
            truncated: /truncated/i.test(rawOutputText),
          }
        }
      }
    }
    const outputText = webCard ? undefined : cleanGenericOutput(rawOutputText, state)
    const inputText = webCard ? undefined : formatUnwrappedInput(rawInput)
    const errorSummary = state === 'error' && outputText ? firstLine(outputText) : undefined

    return {
      category: isWebSearch ? 'web_search' : 'web_fetch',
      state,
      title: isWebSearch ? (zh ? '网页搜索' : 'Search') : (zh ? '网页获取' : 'Fetch'),
      summary: summaryText,
      ...(href ? { href } : {}),
      ...(errorSummary ? { errorSummary } : {}),
      ...(webCard ? { web: webCard } : {}),
      ...(inputText ? { inputText } : {}),
      ...(outputText ? { outputText } : {}),
      expandable: Boolean(webCard || inputText || outputText),
    }
  }

  // 6. Step Checklist (`update_steps` / `todo_write`)
  const stepItems = extractStepsFromInput(inputRec)
  if (STEPS_TOOL_NAMES.has(name) || stepItems) {
    if (stepItems) {
      const doneCount = stepItems.filter(s => s.status === 'done').length
      const total = stepItems.length
      const activeItems = stepItems.filter(s => s.status === 'in_progress')
      const activeTitle = activeItems[0]?.title
      const head = zh ? `${doneCount}/${total} 已完成` : `${doneCount}/${total} completed`
      const summaryText = activeTitle ? `${head} · ${activeTitle}` : head
      const extraSuffix = activeItems.length > 1 ? `+${activeItems.length - 1}` : undefined
      return {
        category: 'steps',
        state,
        title: zh ? '更新进度' : 'Update steps',
        summary: summaryText,
        ...(extraSuffix ? { summarySuffix: extraSuffix } : {}),
        steps: {
          items: stepItems,
          done: doneCount,
          total,
          ...(activeTitle ? { activeTitle } : {}),
        },
        expandable: true,
      }
    }
    const outputText = cleanGenericOutput(rawOutputText, state)
    const inputText = formatUnwrappedInput(rawInput)
    return {
      category: 'steps',
      state,
      title: zh ? '更新进度' : 'Update steps',
      summary: rawTitle && !/^Run\s+update_steps$/i.test(rawTitle) ? firstLine(rawTitle) : '',
      ...(inputText ? { inputText } : {}),
      ...(outputText ? { outputText } : {}),
      expandable: Boolean(inputText || outputText),
    }
  }

  // 7. Delete / Move File
  if (kind === 'delete' || kind === 'move' || DELETE_TOOL_NAMES.has(name) || MOVE_TOOL_NAMES.has(name)) {
    const isDelete = kind === 'delete' || DELETE_TOOL_NAMES.has(name)
    const summaryText = filePath ? relativizeDisplayPath(filePath, cwd, home) : firstLine(rawTitle ?? '')
    const outputText = cleanGenericOutput(rawOutputText, state)
    const inputText = formatUnwrappedInput(rawInput)
    const errorSummary = state === 'error' && outputText ? firstLine(outputText) : undefined
    return {
      category: 'file_op',
      state,
      title: isDelete ? (zh ? '删除文件' : 'Delete') : (zh ? '移动文件' : 'Move'),
      summary: summaryText,
      ...(errorSummary ? { errorSummary } : {}),
      ...(inputText ? { inputText } : {}),
      ...(outputText ? { outputText } : {}),
      expandable: Boolean(inputText || outputText),
    }
  }

  // 8. Subagents / Schedule / Background Tasks / Other Tools
  const { category, title } = resolveCategoryAndTitle(tool, kind, rawTitle, false, zh)
  const genericSummary =
    summarizeGenericInput(inputRec, cwd, home) ??
    (rawTitle && !/^Run\s+[a-z][a-z0-9_.-]+$/i.test(rawTitle) ? firstLine(rawTitle) : '')
  const inputText = formatUnwrappedInput(rawInput)
  const outputText = cleanGenericOutput(rawOutputText, state)
  const errorSummary = state === 'error' && outputText ? firstLine(outputText) : undefined

  return {
    category,
    state,
    title,
    summary: genericSummary,
    ...(errorSummary ? { errorSummary } : {}),
    ...(filePath ? { filePath } : {}),
    ...(startLine && startLine >= 1 ? { filePathLine: Math.floor(startLine) } : {}),
    ...(inputText ? { inputText } : {}),
    ...(outputText ? { outputText } : {}),
    expandable: Boolean(inputText || outputText),
  }
}

function resolveCategoryAndTitle(
  tool: string | undefined,
  kind: MirrorToolKind,
  rawTitle: string | undefined,
  isWrite: boolean,
  zh: boolean,
): { category: AgyToolCategory; title: string } {
  const n = normalizeMirrorToolName(tool)
  if (TERMINAL_TOOL_NAMES.has(n) || kind === 'execute') {
    return { category: 'terminal', title: zh ? '运行命令' : 'Bash' }
  }
  if (EDIT_TOOL_NAMES.has(n) || kind === 'edit') {
    const write = isWrite || WRITE_TOOL_NAMES.has(n)
    return { category: 'diff', title: write ? (zh ? '写入' : 'Write') : (zh ? '编辑' : 'Edit') }
  }
  if (kind === 'read') {
    return { category: 'read', title: zh ? '读取' : 'Read' }
  }
  if (kind === 'search') {
    return {
      category: 'search',
      title: CONTENT_SEARCH_TOOL_NAMES.has(n)
        ? (zh ? '搜索文件内容' : 'Grep')
        : PATH_SEARCH_TOOL_NAMES.has(n)
          ? (zh ? '查找文件' : 'Glob')
          : (zh ? '搜索' : 'Search'),
    }
  }
  if (kind === 'fetch') {
    const isSearch = WEB_SEARCH_TOOL_NAMES.has(n)
    return {
      category: isSearch ? 'web_search' : 'web_fetch',
      title: isSearch ? (zh ? '网页搜索' : 'Search') : (zh ? '网页获取' : 'Fetch'),
    }
  }
  if (STEPS_TOOL_NAMES.has(n)) {
    return { category: 'steps', title: zh ? '更新进度' : 'Update steps' }
  }
  if (SUBAGENT_TOOL_NAMES.has(n)) {
    return { category: 'agent', title: humanizeToolName(tool ?? '', zh) }
  }
  if (SCHEDULE_TOOL_NAMES.has(n)) {
    return { category: 'schedule', title: zh ? '定时任务' : 'Schedule' }
  }
  if (TASK_TOOL_NAMES.has(n)) {
    return { category: 'task', title: zh ? '后台任务' : 'Background task' }
  }
  if (kind === 'delete' || kind === 'move') {
    return { category: 'file_op', title: kind === 'delete' ? (zh ? '删除文件' : 'Delete') : (zh ? '移动文件' : 'Move') }
  }
  if (!isPlaceholderToolName(tool)) {
    return { category: 'other', title: humanizeToolName(tool!, zh) }
  }
  if (rawTitle) {
    return { category: 'other', title: zh ? '工具调用' : 'Tool call' }
  }
  return { category: 'other', title: zh ? '工具调用' : 'Tool call' }
}
