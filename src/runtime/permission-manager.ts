import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { AcpToolCallUpdate, PermissionOption, RequestPermissionParams, RequestPermissionResult } from '../acp/protocol.ts'

/** Native Antigravity user questions share `session/request_permission`, identified by `interaction_` id prefix. */
export function isInteractionQuestion(req: RequestPermissionParams): boolean {
  return typeof req.toolCall?.toolCallId === 'string' && req.toolCall.toolCallId.startsWith('interaction_')
}

/** Extracts `agy.security.warning` metadata attached by agy to high-impact approval options. */
export function extractSecurityWarning(option: PermissionOption): string | undefined {
  const meta = option._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const warning = (meta as Record<string, unknown>)['agy.security.warning']
  if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return undefined
  const rec = warning as Record<string, unknown>
  const message = typeof rec.message === 'string' && rec.message.trim() ? rec.message.trim() : undefined
  const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : undefined
  const text = message || title
  return text ? (text.length > 512 ? `${text.slice(0, 509)}...` : text) : undefined
}

const DIRECT_DSH_MCP_NAME_RE = /^mcp_dsh-tools_[A-Za-z0-9_.:-]+$/
const DIRECT_DSH_MCP_TITLE_RE = /^(?:Run\s+)?mcp_dsh-tools_(?<tool>[A-Za-z0-9_.:-]+)\??$/
const PROXIED_MCP_TITLE_RE = /^MCP Tool (?<tool>[A-Za-z0-9_.:-]+)\??$/
const NON_MCP_TOOL_KINDS = new Set(['execute', 'edit', 'delete', 'move'])

/** Strictly identifies ACP tool frames targeting this plugin's own `dsh-tools` reverse MCP server. */
export function isDshReverseMcpToolCall(
  tc: Pick<AcpToolCallUpdate, 'name' | 'title' | 'kind' | 'rawInput' | 'args'>,
): boolean {
  if (tc.kind && NON_MCP_TOOL_KINDS.has(tc.kind)) return false
  const rawInput = asRecord(tc.rawInput) ?? asRecord(tc.args)
  if (typeof rawInput?.CommandLine === 'string') return false
  const name = tc.name?.trim() ?? ''
  if (name && DIRECT_DSH_MCP_NAME_RE.test(name)) return true
  if (name === 'call_mcp_tool') {
    return rawInput?.ServerName === 'dsh-tools'
  }
  const title = tc.title?.trim() ?? ''
  const proxiedTool = PROXIED_MCP_TITLE_RE.exec(title)?.groups?.tool
  if (proxiedTool) {
    return rawInput?.ServerName === 'dsh-tools' && rawInput?.ToolName === proxiedTool
  }
  return DIRECT_DSH_MCP_TITLE_RE.test(title)
}

/** Strictly identifies requests targeting this plugin's own `dsh-tools` reverse MCP server. */
export function isDshReverseMcpRequest(req: RequestPermissionParams): boolean {
  return isDshReverseMcpToolCall(req.toolCall)
}

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

export class SessionPolicyChangedError extends Error {
  constructor() {
    super('会话权限或工作目录已更改，本轮已停止。下一条消息将使用新设置。')
  }
}

/** A confined native turn can finish when the host widens its filesystem boundary.
 * Native permission callbacks must still satisfy both policies. */
export function canFinishConfinedTurn(original: SessionPolicy, current: SessionPolicy): boolean {
  if (original.sessionId !== current.sessionId || original.workspaceRoot !== current.workspaceRoot) return false
  if (original.mode === 'danger-full-access' || original.preset !== original.mode) return false
  return (current.mode === 'danger-full-access' && (current.preset === 'auto' || current.preset === 'danger-full-access')) ||
    (original.mode === 'read-only' && current.mode === 'workspace-write' && current.preset === 'workspace-write')
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
  'SourcePath',
  'DestinationPath',
  'sourcePath',
  'destinationPath',
  'source',
  'destination',
  'from',
  'to',
  'oldPath',
  'newPath',
  'old_path',
  'new_path',
  'src',
  'dest',
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

export interface HighRiskCommandMatch {
  readonly category: string
  readonly reason: string
}

export interface ExtractedExecuteCommand {
  readonly fullCmd: string
  readonly displayCmd: string
  readonly cwd?: string
  readonly bytes: number
  readonly hasDangerousEnv: boolean
}

const DANGEROUS_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
])

function hasDangerousEnvOverride(obj: Record<string, unknown> | null): boolean {
  if (!obj) return false
  for (const key of ['env', 'Env', 'environment', 'Environment']) {
    const rec = asRecord(obj[key])
    if (!rec) continue
    for (const envKey of Object.keys(rec)) {
      if (DANGEROUS_ENV_KEYS.has(envKey.toUpperCase())) return true
    }
  }
  return false
}

function extractCommandFromObject(obj: Record<string, unknown>): ExtractedExecuteCommand | null {
  const cmd = firstString(obj, ['CommandLine', 'command', 'cmd', 'script'])
  if (!cmd || !cmd.trim()) return null

  const rawArgs = obj.args ?? obj.argv ?? obj.Args
  let argsDisplay: string | undefined
  let argsRiskText: string | undefined

  if (rawArgs !== undefined) {
    if (Array.isArray(rawArgs)) {
      const stringArgs: string[] = []
      for (const item of rawArgs) {
        if (typeof item !== 'string') return null
        stringArgs.push(item)
      }
      if (stringArgs.length > 0) {
        argsDisplay = JSON.stringify(stringArgs)
        argsRiskText = stringArgs.join(' ')
      }
    } else if (typeof rawArgs === 'string') {
      if (rawArgs.length > 0) {
        argsDisplay = rawArgs
        argsRiskText = rawArgs
      }
    } else {
      return null
    }
  }

  const displayCmd = argsDisplay ? `${cmd} ${argsDisplay}` : cmd
  const fullCmd = argsRiskText ? `${cmd} ${argsRiskText}` : cmd
  const cwd = firstString(obj, ['Cwd', 'cwd', 'workdir', 'workingDirectory'])
  return {
    fullCmd,
    displayCmd,
    ...(cwd ? { cwd } : {}),
    bytes: Buffer.byteLength(displayCmd, 'utf8'),
    hasDangerousEnv: hasDangerousEnvOverride(obj),
  }
}

/** Fail-closed extraction of command metadata across `rawInput` and `args`. */
export function extractExecuteCommand(req: RequestPermissionParams): ExtractedExecuteCommand | null {
  const tc = req.toolCall
  const sources: Record<string, unknown>[] = []
  for (const src of [tc.rawInput, tc.args]) {
    if (src === undefined) continue
    const rec = asRecord(src)
    if (!rec) return null
    sources.push(rec)
  }
  if (sources.length === 0) return null

  const extracted = sources.map(extractCommandFromObject).filter((v): v is ExtractedExecuteCommand => v !== null)
  if (extracted.length === 0) return null
  if (extracted.length > 1) {
    const [first, second] = extracted
    if (first!.fullCmd !== second!.fullCmd || first!.cwd !== second!.cwd) return null
  }
  return extracted[0]!
}

const LOOPBACK_URL_RE = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|\?|#|$)/i
const URL_TOKEN_RE = /https?:\/\/[^\s'"`<>|;&)]+/gi

function hasDangerousRmSegment(command: string): boolean {
  const rmMatches = command.matchAll(/(?:^|[;&|(\n`'"])\s*(?:(?:env\s+[\w.+-]+=\S+\s+)*)?rm\s+([^\n;&|)`'"]+)/g)
  for (const match of rmMatches) {
    const argStr = match[1] ?? ''
    const tokens = argStr.trim().split(/\s+/).filter(Boolean)
    let hasRecursive = false
    let hasForce = false
    const targets: string[] = []
    let afterDoubleDash = false
    for (const raw of tokens) {
      const token = raw.replace(/^['"]|['"]$/g, '')
      if (!afterDoubleDash && token === '--') {
        afterDoubleDash = true
        continue
      }
      if (!afterDoubleDash && token.startsWith('-')) {
        if (/^--recursive$/i.test(token) || /^-[a-zA-Z]*[rR]/.test(token)) hasRecursive = true
        if (/^--force$/i.test(token) || /^-[a-zA-Z]*f/.test(token)) hasForce = true
        continue
      }
      targets.push(token)
    }
    if (!hasRecursive && !hasForce) continue
    for (const t of targets) {
      if (
        t === '/' ||
        t === '/*' ||
        t === '*' ||
        t === '.' ||
        t === './' ||
        t === './*' ||
        t === '..' ||
        t.startsWith('../') ||
        /(?:^|\/)\.\.(?:\/|$)/.test(t) ||
        t === '~' ||
        t.startsWith('~/') ||
        t === '$HOME' ||
        t.startsWith('$HOME/') ||
        t === '${HOME}' ||
        t.startsWith('${HOME}/') ||
        t === '.git' ||
        t.startsWith('.git/') ||
        t.endsWith('/.git') ||
        (t.startsWith('/') && !t.startsWith('/tmp/') && !t.startsWith('/var/tmp/'))
      ) {
        return true
      }
    }
  }
  return false
}

function hasExternalCurlWrite(command: string): boolean {
  const curlMatches = command.matchAll(/(?:^|[;&|(\n`'"])\s*curl\b([^\n;&|)`'"]*)/g)
  for (const match of curlMatches) {
    const args = match[1] ?? ''
    const isWrite =
      /(?:^|\s)(?:-d|--data(?:-(?:raw|binary|urlencode|ascii))?|-F|--form|-T|--upload-file|--json)(?=\s|=|$)/.test(args) ||
      /(?:^|\s)(?:-X|--request)\s*['"]?(?:POST|PUT|PATCH|DELETE)['"]?(?=\s|$)/i.test(args)
    if (!isWrite) continue
    const urls = args.match(URL_TOKEN_RE) ?? []
    // Fail-closed: if a write curl has no clear loopback-only URLs (e.g. variable URL or external host), ask user.
    if (urls.length === 0 || urls.some((u) => !LOOPBACK_URL_RE.test(u))) {
      return true
    }
  }
  return false
}

const HIGH_RISK_COMMAND_RULES: ReadonlyArray<{
  readonly category: string
  readonly reason: string
  readonly pattern: RegExp
}> = [
  {
    category: 'privilege',
    reason: '涉及提权操作（sudo / su / doas / pkexec）',
    pattern: /(?:^|[;&|(\n`'"])\s*(?:sudo|doas|pkexec|su(?:\s+-\s*|\s+[-\w]+))(?=\s|$)/,
  },
  {
    category: 'system',
    reason: '涉及系统级磁盘、分区或开关机操作',
    pattern: /(?:^|[;&|(\n`'"])\s*(?:mkfs(?:\.\w+)?|fdisk|parted|wipefs|shred|shutdown|reboot|poweroff|halt|telinit)\b/,
  },
  {
    category: 'system',
    reason: '涉及直接写入块设备（dd of=/dev/...）',
    pattern: /(?:^|[;&|(\n`'"])\s*dd\b[^\n;&|]*\bof=\/dev\//,
  },
  {
    category: 'system',
    reason: '涉及停止或修改系统服务（systemctl）',
    pattern: /(?:^|[;&|(\n`'"])\s*systemctl\s+(?:stop|disable|mask|reboot|poweroff|halt|daemon-reexec)\b/,
  },
  {
    category: 'system',
    reason: '涉及修改系统目录权限或递归 777 授权',
    pattern: /(?:^|[;&|(\n`'"])\s*(?:chmod|chown)\b[^\n;&|]*(?:\s-[a-zA-Z]*R[a-zA-Z]*\s+777\b|\s(?:\/etc|\/usr|\/var|\/bin|\/sbin|\/root|~\/|\$HOME)(?:\/|\s|$))/,
  },
  {
    category: 'delete',
    reason: '涉及 find 批量删除文件',
    pattern: /(?:^|[;&|(\n`'"])\s*find\b[^\n;&|]*(?:\s-delete\b|\s-exec(?:dir)?\s+rm\b)/,
  },
  {
    category: 'git',
    reason: '涉及 Git 推送到远端仓库（git push）',
    pattern: /(?:^|[;&|(\n`'"])\s*git\b(?:\s+(?:-[Cc]\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)))*\s+push\b/,
  },
  {
    category: 'git',
    reason: '涉及 Git 硬重置（git reset --hard）',
    pattern: /(?:^|[;&|(\n`'"])\s*git\b[^\n;&|]*\breset\s+(?:[^\n;&|]*\s)?--hard\b/,
  },
  {
    category: 'git',
    reason: '涉及 Git 强制清理未跟踪文件（git clean -f）',
    pattern: /(?:^|[;&|(\n`'"])\s*git\b[^\n;&|]*\bclean\s+(?:[^\n;&|]*-[a-zA-Z]*f|--force)/,
  },
  {
    category: 'git',
    reason: '涉及 Git 重写仓库历史（filter-branch / filter-repo）',
    pattern: /(?:^|[;&|(\n`'"])\s*git\b[^\n;&|]*\b(?:filter-branch|filter-repo)\b/,
  },
  {
    category: 'git',
    reason: '涉及批量丢弃工作区改动（git checkout -- . / git restore .）',
    pattern: /(?:^|[;&|(\n`'"])\s*git\b[^\n;&|]*(?:\bcheckout\s+--\s+\.(?:\s|$)|\brestore\s+(?:--worktree\s+|--staged\s+)*\.(?:\s|$))/,
  },
  {
    category: 'git',
    reason: '涉及强制删除 Git 分支（git branch -D）',
    pattern: /(?:^|[;&|(\n`'"])\s*git\b[^\n;&|]*\bbranch\s+(?:[^\n;&|]*\s)?-D\b/,
  },
  {
    category: 'rce',
    reason: '涉及下载远端脚本并直接执行（curl/wget 管道或进程替换）',
    pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:env\s+)?(?:(?:ba|z|da|k|c)?sh|python3?|node|perl|ruby)\b|\b(?:ba|z|da)?sh\s+<\(\s*(?:curl|wget)\b/,
  },
  {
    category: 'network',
    reason: '涉及反弹 Shell 或可疑网络连接执行',
    pattern: /\/dev\/(?:tcp|udp)\/|\b(?:nc|ncat|netcat)\b[^\n;&|]*\s-[a-zA-Z]*e\b|\bsocat\b[^\n;&|]*\bexec:/i,
  },
  {
    category: 'network',
    reason: '涉及连接远端主机或跨主机传输文件（ssh / scp / sftp / rsync）',
    pattern: /(?:^|[;&|(\n`'"])\s*(?:(?:ssh|scp|sftp)\b|rsync\b[^\n;&|]*\s(?:[\w.-]+@)?[\w.-]+:)/,
  },
  {
    category: 'secrets',
    reason: '涉及读取敏感凭据或密钥目录（~/.ssh、~/.aws、~/.gnupg、~/.kube 等）',
    pattern: /(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[^/\s]+)\/\.(?:ssh|aws|gnupg|kube|npmrc|netrc|docker\/config\.json|config\/gh)\b|\/etc\/shadow\b/,
  },
  {
    category: 'publish',
    reason: '涉及对外发布软件包或推送镜像（publish / docker push / twine upload）',
    pattern: /(?:^|[;&|(\n`'"])\s*(?:(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|docker\s+push\b|twine\s+upload\b)/,
  },
  {
    category: 'deploy',
    reason: '涉及高危外部平台或基础设施变更（gh / kubectl / terraform / helm）',
    pattern: /(?:^|[;&|(\n`'"])\s*(?:gh\s+(?:pr\s+merge|release\s+(?:create|delete)|repo\s+delete)\b|kubectl\s+(?:apply|delete|patch|replace|rollout)\b|terraform\s+(?:apply|destroy)\b|helm\s+(?:install|upgrade|uninstall)\b)/,
  },
]

/** Assess whether a shell command hits any high-risk guard requiring human confirmation. */
export function assessCommandRisk(command: string): HighRiskCommandMatch | null {
  if (hasDangerousRmSegment(command)) {
    return {
      category: 'delete',
      reason: '涉及高危强制/递归删除（根路径、家目录、工作区外或 .git 目录）',
    }
  }
  if (hasExternalCurlWrite(command)) {
    return {
      category: 'network',
      reason: '涉及向非本机地址发送 HTTP 写/上传请求（curl）',
    }
  }
  for (const rule of HIGH_RISK_COMMAND_RULES) {
    if (rule.pattern.test(command)) {
      return { category: rule.category, reason: rule.reason }
    }
  }
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

  if (isInteractionQuestion(req)) {
    lines.push('Antigravity 发起交互确认（原生问题选项）')
    if (tc.title) lines.push(`问题: ${tc.title}`)
    if (req.options.length > 0) {
      lines.push('可选项:')
      for (const opt of req.options) {
        const label = opt.name?.trim() || opt.optionId
        lines.push(`- ${label} (${opt.optionId})`)
      }
    }
    return lines.join('\n')
  }

  const securityWarnings = req.options
    .map((o) => extractSecurityWarning(o))
    .filter((w): w is string => Boolean(w))

  if (kind === 'execute') {
    lines.push(`Antigravity 请求执行命令 (${kind}): ${toolName}`)
    if (tc.title) lines.push(`说明: ${tc.title}`)
    const extracted = extractExecuteCommand(req)
    const cwd = extracted?.cwd ?? firstString(inputObj, ['Cwd', 'cwd', 'workdir', 'workingDirectory'])
    if (cwd) lines.push(`目录: ${cwd}`)

    const risk = extracted ? assessCommandRisk(extracted.fullCmd) : null
    if (risk) {
      lines.push(`⚠️ 高危命令拦截: ${risk.reason}`)
    } else if (extracted?.hasDangerousEnv) {
      lines.push('⚠️ 高危环境拦截: 命令携带受限环境变量注入（如 LD_PRELOAD / NODE_OPTIONS）')
    }
    for (const w of securityWarnings) {
      lines.push(`⚠️ 上游安全提示: ${w}`)
    }

    const fullCmd = extracted?.displayCmd
    if (fullCmd) {
      const bytes = extracted.bytes
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
    for (const w of securityWarnings) {
      lines.push(`⚠️ 上游安全提示: ${w}`)
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
  for (const w of securityWarnings) {
    lines.push(`⚠️ 上游安全提示: ${w}`)
  }
  if (rawPayload !== undefined) {
    lines.push(`参数:\n${safeJsonPreview(rawPayload, MAX_GENERIC_PREVIEW_CHARS)}`)
  }
  return lines.join('\n')
}

export interface DecidePermissionOptions {
  /** True only when this plugin attached its own `dsh-tools` reverse MCP bridge to the ACP session. */
  hasReverseMcpBridge?: boolean
}

function disposition(
  p: SessionPolicy,
  req: RequestPermissionParams,
  opts?: DecidePermissionOptions,
): 'allow' | 'ask' | 'deny' {
  // Reverse MCP calls to this plugin's own attached `dsh-tools` server are delegated back into
  // DSH's native tool-call pipeline, which enforces the live preset, auto-review, sandbox policy,
  // guards, and approval chain. Auto-allowing at the ACP layer avoids redundant double-approval
  // and lets read-only/auto DSH tools pass through to DSH's own enforcement.
  if (opts?.hasReverseMcpBridge === true && isDshReverseMcpRequest(req)) {
    return 'allow'
  }
  const kind = req.toolCall.kind
  if (p.preset === 'auto') return 'ask' // native ACP calls do not pass through tools/pre-execute
  if (kind === 'read' || kind === 'search') return 'allow'
  if (p.mode === 'read-only') return 'deny'
  if (p.mode === 'danger-full-access' && p.preset === 'danger-full-access' && p.approval === 'never') return 'allow'
  if (p.mode === 'workspace-write' && p.preset === 'workspace-write') {
    if (opts?.hasReverseMcpBridge !== false && isDshReverseMcpRequest(req)) {
      return 'allow'
    }
    if (kind === 'edit' || kind === 'delete' || kind === 'move') {
      const targets = extractEditTargets(req)
      if (targets && isWithinRoots(targets, p.workspaceRoot, p.additionalWritableRoots)) {
        return 'allow' // the process sandbox, not this classification, enforces actual writes
      }
    }
    if (kind === 'execute') {
      const extracted = extractExecuteCommand(req)
      if (
        extracted &&
        extracted.bytes <= MAX_COMMAND_FULL_BYTES &&
        !extracted.hasDangerousEnv &&
        (!extracted.cwd || isWithinRoots([extracted.cwd], p.workspaceRoot, p.additionalWritableRoots)) &&
        !assessCommandRisk(extracted.fullCmd)
      ) {
        return 'allow' // confined by host full process sandbox; only high-risk commands escalate to human approval
      }
    }
  }
  return 'ask'
}

export async function decidePermission(
  req: RequestPermissionParams,
  readPolicy: () => SessionPolicy,
  ask: (reason: string) => Promise<string>,
  signal: AbortSignal,
  launchPolicy?: SessionPolicy,
  choose?: (req: RequestPermissionParams) => Promise<string | undefined>,
  opts?: DecidePermissionOptions,
): Promise<RequestPermissionResult> {
  try {
    const p = readPolicy()
    if (signal.aborted) return cancelled()

    // Native Antigravity questions (`interaction_*`) are fixed-choice prompts, never auto-answered
    // even in full-access mode. Route through host ask when interactive; cancel when non-interactive.
    if (isInteractionQuestion(req)) {
      const tc = req.toolCall
      const ids = new Set(req.options.map(o => o.optionId))
      if (!choose || !req.options.length || req.options.length > 32 || ids.size !== req.options.length ||
          req.options.some(o => typeof o.optionId !== 'string' || !o.optionId.trim() || o.optionId.length > 256 ||
            o.kind === 'allow_always' || extractSecurityWarning(o)) ||
          (tc.kind && tc.kind !== 'other') || tc.locations?.length ||
          [tc.args, tc.rawInput].some(data => data != null && (!asRecord(data) || Object.keys(data).length)) ||
          p.approval !== 'ask' || launchPolicy?.approval === 'never') return cancelled()
      const answer = await choose(req)
      if (signal.aborted || policyKey(readPolicy()) !== policyKey(p) || !answer || !ids.has(answer)) return cancelled()
      return { outcome: { outcome: 'selected', optionId: answer } }
    }

    const allow = req.options.find(o => o.kind === 'allow_once')
    const reject = req.options.find(o => o.kind === 'reject_once')
    const denied = (): RequestPermissionResult => reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelled()
    if (!allow) return denied()
    const action = disposition(p, req, opts)
    const launchAction = launchPolicy ? disposition(launchPolicy, req, opts) : action
    if (action === 'deny' || launchAction === 'deny') return denied()
    if (action === 'ask' || launchAction === 'ask') {
      if (p.approval !== 'ask' || (launchAction === 'ask' && launchPolicy?.approval === 'never')) return denied()
      const reason = formatApprovalReason(req)
      if (await ask(reason) !== 'allowed-once') return denied()
    }
    return !signal.aborted && policyKey(readPolicy()) === policyKey(p)
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : denied()
  } catch { return cancelled() }
}
