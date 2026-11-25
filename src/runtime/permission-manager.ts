import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { RequestPermissionParams, RequestPermissionResult } from '../acp/protocol.ts'

export interface FilePolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
  additionalWritableRoots?: readonly string[]
  sessionId: string
}
export interface SessionPolicy extends FilePolicy {
  preset: string
  approval: 'ask' | 'never'
}

/** Only exact, single-use grants are safe: a later request may see a different DSH policy. */
export const cancelled = (): RequestPermissionResult => ({ outcome: { outcome: 'cancelled' } })

export function policyKey(policy: SessionPolicy): string {
  return JSON.stringify([policy.sessionId, policy.mode, policy.workspaceRoot, policy.additionalWritableRoots ?? [], policy.preset, policy.approval])
}

const SINGLE_PATH_KEYS = new Set([
  'Path',
  'TargetFile',
  'AbsolutePath',
  'file_path',
  'filePath',
  'path',
  'File',
  'file',
])

const MULTI_PATH_KEYS = new Set([
  'files',
  'paths',
  'targets',
  'file_paths',
  'filePaths',
])

const SAFE_EDIT_META_KEYS = new Set([
  'Replacement',
  'TargetContent',
  'ReplacementContent',
  'ReplacementChunks',
  'chunks',
  'old_string',
  'new_string',
  'oldText',
  'newText',
  'Content',
  'CodeContent',
  'content',
  'StartLine',
  'EndLine',
  'EmptyFile',
  'Description',
  'description',
  'AllowMultiple',
  'Overwrite',
  'Append',
  'CodeMarkdownLanguage',
  'Instruction',
  'Complexity',
  'WaitForPreviousTools',
])

const SUSPICIOUS_PATH_OR_PATCH_KEY_RE =
  /(?:path|file|dir|root|dest|target|source|src|from|to|patch|diff|edits|changes|rename|move)/i

const MAX_COMMAND_FULL_BYTES = 16_384
const COMMAND_HEAD_CHARS = 8_000
const COMMAND_TAIL_CHARS = 4_000
const MAX_EDIT_PREVIEW_CHARS = 2_000
const EDIT_HEAD_CHARS = 1_200
const EDIT_TAIL_CHARS = 400
const MAX_GENERIC_PREVIEW_CHARS = 4_000

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function isValidPathString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && !v.includes('\0')
}

function extractPathsFromObject(obj: Record<string, unknown>, out: string[]): boolean {
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue
    if (SINGLE_PATH_KEYS.has(key)) {
      if (!isValidPathString(val)) return false
      out.push(val)
      continue
    }
    if (MULTI_PATH_KEYS.has(key)) {
      if (!Array.isArray(val) || val.length === 0) return false
      for (const item of val) {
        if (isValidPathString(item)) {
          out.push(item)
        } else {
          const itemRec = asRecord(item)
          if (!itemRec) return false
          const before = out.length
          if (!extractPathsFromObject(itemRec, out) || out.length === before) return false
        }
      }
      continue
    }
    if (key === 'Target' && typeof obj.Replacement === 'string') {
      continue
    }
    if (SAFE_EDIT_META_KEYS.has(key)) {
      continue
    }
    if (SUSPICIOUS_PATH_OR_PATCH_KEY_RE.test(key)) {
      return false
    }
  }
  return true
}

/**
 * Fail-closed extraction of ALL file targets across `locations`, `rawInput`, and `args`.
 * Returns `null` if any source is malformed, contains unparsed patch/path keys, or yields no targets.
 */
export function extractEditTargets(req: RequestPermissionParams): string[] | null {
  const targets: string[] = []
  const tc = req.toolCall

  if (tc.locations !== undefined) {
    if (!Array.isArray(tc.locations)) return null
    for (const loc of tc.locations) {
      const rec = asRecord(loc)
      if (!rec || !isValidPathString(rec.path)) return null
      targets.push(rec.path)
    }
  }

  for (const src of [tc.rawInput, tc.args]) {
    if (src === undefined) continue
    const rec = asRecord(src)
    if (!rec) return null
    if (!extractPathsFromObject(rec, targets)) return null
  }

  if (targets.length === 0) return null
  return Array.from(new Set(targets))
}

function normalizePathCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** Resolve symlinks up to the nearest existing ancestor so non-existent files are also safely checked. */
function resolveRealPath(absPath: string): string | null {
  if (absPath.includes('\0')) return null
  const resolved = path.resolve(absPath)
  const tail: string[] = []
  let current = resolved

  while (true) {
    try {
      const real = realpathSync(current)
      return normalizePathCase(tail.length > 0 ? path.join(real, ...tail.reverse()) : real)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const parent = path.dirname(current)
      if (parent === current) return null
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function isWithinRoots(targets: readonly string[], workspaceRoot: string, additionalRoots?: readonly string[]): boolean {
  const resolvedRoots: string[] = []
  for (const root of [workspaceRoot, ...(additionalRoots ?? [])]) {
    const realRoot = resolveRealPath(path.resolve(root))
    if (!realRoot) return false
    resolvedRoots.push(realRoot)
  }
  if (resolvedRoots.length === 0) return false

  return targets.every((target) => {
    const absTarget = path.resolve(workspaceRoot, target)
    const realTarget = resolveRealPath(absTarget)
    if (!realTarget) return false
    return resolvedRoots.some((root) => {
      const rel = path.relative(root, realTarget)
      return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
    })
  })
}

function firstString(obj: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return undefined
}

function collectDisplayPaths(req: RequestPermissionParams): string[] {
  const paths: string[] = []
  const tc = req.toolCall
  if (Array.isArray(tc.locations)) {
    for (const loc of tc.locations) {
      const rec = asRecord(loc)
      if (rec && typeof rec.path === 'string' && rec.path.trim()) paths.push(rec.path)
    }
  }
  for (const src of [tc.rawInput, tc.args]) {
    const rec = asRecord(src)
    if (!rec) continue
    for (const key of SINGLE_PATH_KEYS) {
      const val = rec[key]
      if (typeof val === 'string' && val.trim()) paths.push(val)
    }
    for (const key of MULTI_PATH_KEYS) {
      const val = rec[key]
      if (!Array.isArray(val)) continue
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) paths.push(item)
        else {
          const itemRec = asRecord(item)
          const p = firstString(itemRec, [...SINGLE_PATH_KEYS])
          if (p) paths.push(p)
        }
      }
    }
  }
  return Array.from(new Set(paths))
}

function previewText(text: string, maxChars: number, headChars: number, tailChars: number, label: string): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = text.split(/\r?\n/).length
  if (text.length <= maxChars) return text
  return (
    text.slice(0, headChars) +
    `\n...（${label}，共 ${bytes} 字节 / ${lines} 行）...\n` +
    text.slice(text.length - tailChars)
  )
}

function safeJsonPreview(val: unknown, maxChars: number): string {
  let raw: string
  try {
    raw = typeof val === 'string' ? val : JSON.stringify(val, null, 2) ?? String(val)
  } catch {
    raw = String(val)
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (raw.length <= maxChars) return raw
  const head = Math.floor(maxChars * 0.65)
  const tail = Math.max(0, maxChars - head)
  return `${raw.slice(0, head)}\n...（参数已截断预览，共 ${bytes} 字节）...\n${raw.slice(raw.length - tail)}`
}

function extractEditBody(input: Record<string, unknown> | null): { text: string; chunksCount?: number } | null {
  if (!input) return null
  const chunks = input.ReplacementChunks ?? input.chunks
  if (Array.isArray(chunks) && chunks.length > 0) {
    const parts: string[] = []
    for (const c of chunks) {
      const rec = asRecord(c)
      const rep = firstString(rec, ['ReplacementContent', 'newText', 'new_string'])
      if (rep !== undefined) parts.push(rep)
    }
    if (parts.length > 0) return { text: parts.join('\n---\n'), chunksCount: chunks.length }
  }
  const single = firstString(input, [
    'Replacement',
    'ReplacementContent',
    'new_string',
    'newText',
    'Content',
    'CodeContent',
    'content',
    'patch',
    'diff',
  ])
  if (single !== undefined) return { text: single }
  return null
}

/** Human-readable approval reason with explicit truncation warnings and zero silent size denials. */
export function formatApprovalReason(req: RequestPermissionParams): string {
  const tc = req.toolCall
  const kind = tc.kind ?? 'other'
  const toolName = tc.name ?? '工具'
  const inputObj = asRecord(tc.rawInput) ?? asRecord(tc.args)
  const rawPayload = tc.rawInput ?? tc.args
  const lines: string[] = []

  if (kind === 'execute') {
    lines.push(`Antigravity 请求执行命令 (${kind}): ${toolName}`)
    if (tc.title) lines.push(`说明: ${tc.title}`)
    const cwd = firstString(inputObj, ['Cwd', 'cwd', 'workdir', 'workingDirectory'])
    if (cwd) lines.push(`目录: ${cwd}`)
    const cmd = firstString(inputObj, ['CommandLine', 'command', 'cmd', 'script'])
    const rawArgs = inputObj?.args ?? inputObj?.argv ?? inputObj?.Args
    const argsText =
      Array.isArray(rawArgs) && rawArgs.length > 0
        ? JSON.stringify(rawArgs)
        : typeof rawArgs === 'string' && rawArgs.length > 0
          ? rawArgs
          : undefined
    const fullCmd = cmd ? (argsText ? `${cmd} ${argsText}` : cmd) : undefined

    if (fullCmd) {
      const bytes = Buffer.byteLength(fullCmd, 'utf8')
      if (bytes <= MAX_COMMAND_FULL_BYTES) {
        lines.push(`命令:\n${fullCmd}`)
      } else {
        const preview =
          fullCmd.slice(0, COMMAND_HEAD_CHARS) +
          '\n...（省略中间内容）...\n' +
          fullCmd.slice(fullCmd.length - COMMAND_TAIL_CHARS)
        lines.push(`⚠️ 命令超长已截断（共 ${bytes} 字节），请谨慎确认`)
        lines.push(`命令预览:\n${preview}`)
      }
    } else if (rawPayload !== undefined) {
      lines.push(`参数:\n${safeJsonPreview(rawPayload, MAX_GENERIC_PREVIEW_CHARS)}`)
    }
    return lines.join('\n')
  }

  if (kind === 'edit') {
    lines.push(`Antigravity 请求修改文件 (${kind}): ${toolName}`)
    if (tc.title) lines.push(`说明: ${tc.title}`)
    const paths = collectDisplayPaths(req)
    if (paths.length > 0) {
      lines.push(`目标路径 (${paths.length}):\n${paths.map(p => `- ${p}`).join('\n')}`)
    }
    const body = extractEditBody(inputObj)
    if (body) {
      const bytes = Buffer.byteLength(body.text, 'utf8')
      const lineCount = body.text.split(/\r?\n/).length
      const meta = body.chunksCount ? `${body.chunksCount} 处修改，` : ''
      lines.push(`变更规模: ${meta}${bytes} 字节 / ${lineCount} 行`)
      lines.push(`内容预览:\n${previewText(body.text, MAX_EDIT_PREVIEW_CHARS, EDIT_HEAD_CHARS, EDIT_TAIL_CHARS, '已截断预览')}`)
    } else if (rawPayload !== undefined) {
      lines.push(`参数:\n${safeJsonPreview(rawPayload, MAX_EDIT_PREVIEW_CHARS)}`)
    }
    return lines.join('\n')
  }

  lines.push(`Antigravity 请求执行操作 (${kind}): ${toolName}`)
  if (tc.title) lines.push(`说明: ${tc.title}`)
  const paths = collectDisplayPaths(req)
  if (paths.length > 0) lines.push(`目标路径: ${paths.join(', ')}`)
  const url = firstString(inputObj, ['Url', 'url'])
  if (url) lines.push(`URL: ${url}`)
  if (rawPayload !== undefined) {
    lines.push(`参数:\n${safeJsonPreview(rawPayload, MAX_GENERIC_PREVIEW_CHARS)}`)
  }
  return lines.join('\n')
}

function disposition(p: SessionPolicy, req: RequestPermissionParams): 'allow' | 'ask' | 'deny' {
  const kind = req.toolCall.kind
  if (p.preset === 'auto') return 'ask' // native ACP calls do not pass through tools/pre-execute
  if (kind === 'read' || kind === 'search') return 'allow'
  if (p.mode === 'read-only') return 'deny'
  if (p.mode === 'danger-full-access' && p.preset === 'danger-full-access' && p.approval === 'never') return 'allow'
  if (p.mode === 'workspace-write' && p.preset === 'workspace-write' && kind === 'edit') {
    const targets = extractEditTargets(req)
    if (targets && isWithinRoots(targets, p.workspaceRoot, p.additionalWritableRoots)) {
      return 'allow' // the process sandbox, not this classification, enforces actual writes
    }
  }
  return 'ask'
}

export async function decidePermission(
  req: RequestPermissionParams,
  readPolicy: () => SessionPolicy,
  ask: (reason: string) => Promise<string>,
  signal: AbortSignal,
): Promise<RequestPermissionResult> {
  try {
    const p = readPolicy()
    const allow = req.options.find(o => o.kind === 'allow_once')
    const reject = req.options.find(o => o.kind === 'reject_once')
    const denied = (): RequestPermissionResult => reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelled()
    if (signal.aborted || !allow) return denied()
    const action = disposition(p, req)
    if (action === 'deny') return denied()
    if (action === 'ask') {
      if (p.approval !== 'ask') return denied()
      const reason = formatApprovalReason(req)
      if (await ask(reason) !== 'allowed-once') return denied()
    }
    return !signal.aborted && policyKey(readPolicy()) === policyKey(p)
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : denied()
  } catch { return cancelled() }
}
