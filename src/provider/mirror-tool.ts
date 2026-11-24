import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  defineTool,
  type DiffCallView,
  type DiffResultView,
  type FileDiff,
  type FileLocation,
  type GenericCallView,
  type GenericResultView,
  type TerminalCallView,
  type TerminalResultView,
  type ToolCallKind,
  type ToolCallView,
  type ToolDefinition,
  type ToolResult,
  type ToolResultView,
} from '@deepseek-ai/dsh-tools'
import type { AcpToolCallUpdate } from '../acp/protocol.ts'
import { MIRROR_TOOL_NAME } from '../common/types.ts'
import type { AcpRunStore } from './run-store.ts'

export interface MirrorToolInput {
  run: string
  step: number
  tool?: string
  title?: string
  kind?: string
  input?: unknown
}

interface MirrorResultMeta {
  output: string
  isError: boolean
  exitCode?: number
  signal?: string
  title?: string
  kind?: string
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
const FETCH_TOOL_NAMES = new Set(['search_web', 'web_search', 'web_fetch', 'read_url_content'])
const DELETE_TOOL_NAMES = new Set(['delete_file', 'remove_file'])
const MOVE_TOOL_NAMES = new Set(['move_file', 'rename_file'])

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

function extractFilePath(input: Record<string, unknown> | null): string | undefined {
  return firstString(input, [
    'Path',
    'TargetFile',
    'AbsolutePath',
    'file_path',
    'filePath',
    'path',
    'File',
    'file',
    'DirectoryPath',
    'SearchPath',
  ])
}

function extractFileDiffs(tool: string | undefined, input: Record<string, unknown> | null): FileDiff[] {
  if (!input) return []
  const path = extractFilePath(input)
  if (!path) return []

  // Multi-chunk replacement (e.g. multi_replace_file_content)
  const chunks = input.ReplacementChunks ?? input.chunks
  if (Array.isArray(chunks) && chunks.length > 0) {
    const diffs: FileDiff[] = []
    for (const chunk of chunks) {
      const rec = asRecord(chunk)
      if (!rec) continue
      const oldText =
        typeof rec.TargetContent === 'string'
          ? rec.TargetContent
          : typeof rec.oldText === 'string'
            ? rec.oldText
            : typeof rec.old_string === 'string'
              ? rec.old_string
              : null
      const newText =
        typeof rec.ReplacementContent === 'string'
          ? rec.ReplacementContent
          : typeof rec.newText === 'string'
            ? rec.newText
            : typeof rec.new_string === 'string'
              ? rec.new_string
              : undefined
      if (newText !== undefined) {
        diffs.push({ path, oldText, newText })
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
        : typeof input.new_string === 'string'
          ? input.new_string
          : typeof input.newText === 'string'
            ? input.newText
            : undefined
  if (replacement !== undefined) {
    return [{ path, oldText: target ?? null, newText: replacement }]
  }

  // Whole-file write (e.g. write_file, write_to_file, write)
  const content =
    typeof input.Content === 'string'
      ? input.Content
      : typeof input.CodeContent === 'string'
        ? input.CodeContent
        : typeof input.content === 'string'
          ? input.content
          : undefined
  if (content !== undefined) {
    return [{ path, oldText: null, newText: content }]
  }

  // Empty file creation
  if (normalizeToolName(tool).includes('write') && input.EmptyFile === true) {
    return [{ path, oldText: null, newText: '' }]
  }

  return []
}

function buildTerminalCallView(args: MirrorToolInput): TerminalCallView | null {
  const name = normalizeToolName(args.tool)
  const input = asRecord(args.input)
  const command = firstString(input, ['CommandLine', 'command', 'cmd', 'script'])
  const isTerminal = TERMINAL_TOOL_NAMES.has(name) || args.kind === 'execute'
  if (!isTerminal || !command) return null

  const cwd = firstString(input, ['Cwd', 'cwd', 'workdir', 'workingDirectory'])
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

  const diffs = extractFileDiffs(args.tool, input)
  if (diffs.length === 0) return null

  const firstPath = diffs[0]!.path
  const verb = name.includes('write') ? 'Write' : 'Edit'
  const title = args.title || `${verb} ${firstPath}`
  const locations: FileLocation[] = Array.from(new Set(diffs.map((d) => d.path))).map((p) => ({ path: p }))

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
  const path = extractFilePath(input)
  const line = firstNumber(input, ['StartLine', 'offset', 'line', 'start_line'])
  const query = firstString(input, ['Query', 'query', 'Pattern', 'pattern'])
  const url = firstString(input, ['Url', 'url'])

  let title = args.title
  if (!title) {
    if (kind === 'read' && path) {
      title = line ? `Read ${path}:${line}` : `Read ${path}`
    } else if (kind === 'search' && query) {
      title = path ? `Search "${query}" in ${path}` : `Search "${query}"`
    } else if (kind === 'search' && path) {
      title = `List ${path}`
    } else if (kind === 'fetch' && (url || query)) {
      title = url ? `Fetch ${url}` : `Search web "${query}"`
    } else if (path) {
      title = `${args.tool ?? 'tool'} ${path}`
    } else {
      title = args.tool ?? MIRROR_TOOL_NAME
    }
  }

  const locations: FileLocation[] | undefined = path
    ? [{ path, ...(line !== undefined && line >= 1 ? { line: Math.floor(line) } : {}) }]
    : undefined

  return {
    card: 'generic',
    title,
    kind,
    ...(args.input !== undefined ? { rawInput: args.input } : {}),
    ...(locations ? { locations } : {}),
  }
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

function parseResultMeta(meta: unknown): MirrorResultMeta | null {
  const rec = asRecord(meta)
  if (!rec || typeof rec.output !== 'string') return null
  return {
    output: rec.output,
    isError: Boolean(rec.isError),
    ...(typeof rec.exitCode === 'number' ? { exitCode: rec.exitCode } : {}),
    ...(typeof rec.signal === 'string' ? { signal: rec.signal } : {}),
    ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
    ...(typeof rec.kind === 'string' ? { kind: rec.kind } : {}),
  }
}

export function presentMirrorResult(args: MirrorToolInput, result: ToolResult): ToolResultView {
  const meta = parseResultMeta(result.meta)
  const outputText = meta?.output ?? extractResultText(result.content)
  const effectiveArgs: MirrorToolInput = {
    ...args,
    ...(meta?.title && !args.title ? { title: meta.title } : {}),
    ...(meta?.kind && !args.kind ? { kind: meta.kind } : {}),
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

  const genericCall = buildGenericCallView(effectiveArgs)
  const view: GenericResultView = {
    card: 'generic',
    title: genericCall.title,
  }
  return view
}

function formatToolOutput(update: AcpToolCallUpdate): string {
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

function extractExitCode(update: AcpToolCallUpdate): number | undefined {
  const raw = asRecord(update.rawOutput)
  const code = firstNumber(raw, ['exit_code', 'exitCode', 'code'])
  return code !== undefined && Number.isInteger(code) ? code : undefined
}

function extractSignal(update: AcpToolCallUpdate): string | undefined {
  const raw = asRecord(update.rawOutput)
  return firstString(raw, ['signal'])
}

/**
 * Defines the synthetic DSH mirror tool (`agy_acp_tool`).
 * It replays the already-executed ACP tool output back into DSH's session log
 * with native `presentCall` / `presentResult` cards (terminal, diff, generic).
 */
export function defineAgyAcpMirrorTool(runs: AcpRunStore): ToolDefinition {
  return defineTool({
    name: MIRROR_TOOL_NAME,
    description: 'Internal mirror that replays completed Antigravity ACP tool steps into DSH native tool cards.',
    parameters: {
      run: { type: 'string', required: true },
      step: { type: 'integer', required: true },
      tool: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string' },
      input: { type: 'json' },
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
          title: { type: 'string' },
          kind: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.output }]
      },
      presentationMeta(_args, value) {
        return {
          output: value.output,
          isError: value.isError,
          ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
          ...(value.signal !== undefined ? { signal: value.signal } : {}),
          ...(value.title !== undefined ? { title: value.title } : {}),
          ...(value.kind !== undefined ? { kind: value.kind } : {}),
        }
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args) {
      const rec = runs.get(args.run)
      const update = rec?.toolResults.get(args.step)
      if (!update) {
        return {
          output: `[agy_acp_tool] recorded tool result unavailable (run=${args.run}, step=${args.step})`,
          isError: false,
        }
      }
      const exitCode = extractExitCode(update)
      const signal = extractSignal(update)
      return {
        output: formatToolOutput(update),
        isError: update.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(update.title ? { title: update.title } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
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
