import { lstatSync, realpathSync, type Stats } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isGeoUnsupportedError } from '../common/geo.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { AcpUsage, SessionPromptResult } from './protocol.ts'
import { antigravityAppDataDirs } from './transcript-usage.ts'

// CORTEX_STEP_TYPE_ERROR_MESSAGE in Antigravity's native trajectory SQLite log.
const ERROR_STEP_TYPE = 17
// CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model replied at least once within this turn.
const PLANNER_RESPONSE_STEP_TYPE = 15
const MAX_ERROR_PAYLOAD_BYTES = 16_384
const NATIVE_SESSION_ID_RE = /^[\w-]+$/

const API_ERROR_RE =
  /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s
// Canonical gRPC status codes matched first so a preceding protobuf length varint byte
// (e.g. 0x4e === 'N' before a 78-byte "RESOURCE_EXHAUSTED (code 429): ..." string) is never captured.
const GRPC_STATUS_NAMES = [
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
].join('|')
const STATUS_ERROR_RE = new RegExp(`(${GRPC_STATUS_NAMES}) \\(code (\\d{3})\\): ([^\\u0000-\\u001f\\u007f]+)`, 'u')
const FALLBACK_STATUS_ERROR_RE = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): ([^\u0000-\u001f\u007f]+)/u
const INLINE_WARNING_RE = /^⚠\s+((?:[A-Z_]+ \(code \d{3}\):|Error \d{3}, Message:)[\s\S]+)$/
const QUOTA_EXHAUSTED_RE = /\breason:QUOTA_EXHAUSTED\b/i
const INVALID_THINKING_SIGNATURE_RE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/
const TOS_VIOLATION_RE =
  /\b(?:tos[_ -]?violation|validation_required|account_restricted|abuse_detected)\b/i
const RESET_TIMESTAMP_RE = /\bquotaResetTimeStamp:([^\s\]]+)/
const RESET_DELAY_RE = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=$|[\s\]])/
const RETRY_DELAY_RE = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=$|[\s\]])/
const GO_DURATION_PART_RE = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g

const GO_DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

export type TurnOutcomeFailureKind =
  | 'quota'
  | 'thinking_signature_corrupt'
  | 'geo'
  | 'tos'
  | 'provider_error'

export interface TurnOutcomeFailure {
  readonly kind: TurnOutcomeFailureKind
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly sessionBroken: boolean
  readonly resetAt?: number
  readonly transientNotFound?: boolean
}

interface ObservedLastStep {
  readonly type: number
  readonly payload: Uint8Array | null
  readonly reachedModel: boolean
}

export interface ManagedPathResult {
  readonly path: string
  readonly info: Stats
}

/**
 * Verifies every segment below canonical `rootDir` exists with expected type and is NOT a symlink.
 * Prevents following a symlink into another session's SQLite DB or an arbitrary host file.
 */
export function resolveManagedProfilePath(
  rootDir: string,
  segments: readonly string[],
  kind: 'file' | 'directory',
): ManagedPathResult | undefined {
  let root: string
  try {
    root = realpathSync(rootDir)
    if (root !== path.resolve(rootDir)) return undefined
  } catch {
    return undefined
  }
  let current = root
  let info: Stats | undefined
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      return undefined
    }
    current = path.join(current, seg)
    try {
      info = lstatSync(current)
    } catch {
      return undefined
    }
    const expectFile = kind === 'file' && i === segments.length - 1
    if (info.isSymbolicLink() || (expectFile ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) {
      return undefined
    }
  }
  if (!info) return undefined
  try {
    return realpathSync(current) === current ? { path: current, info } : undefined
  } catch {
    return undefined
  }
}

/** Parses Go `time.Duration` strings such as `1h2m3.5s` or `450ms` into milliseconds. */
export function parseGoDurationMs(raw: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+$/.test(raw)) return undefined
  let total = 0
  let matched = false
  for (const [, amountStr, unit] of raw.matchAll(GO_DURATION_PART_RE)) {
    const amount = Number(amountStr)
    const mult = unit ? GO_DURATION_UNIT_MS[unit] : undefined
    if (!Number.isFinite(amount) || mult === undefined) return undefined
    total += amount * mult
    matched = true
  }
  return matched && total > 0 && Number.isFinite(total) ? Math.round(total) : undefined
}

export function extractResetAtMs(text: string, nowMs = Date.now()): number | undefined {
  const ts = RESET_TIMESTAMP_RE.exec(text)?.[1]
  if (ts) {
    const parsed = Date.parse(ts)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  const delay = RESET_DELAY_RE.exec(text)?.[1] ?? RETRY_DELAY_RE.exec(text)?.[1]
  if (!delay) return undefined
  const delayMs = parseGoDurationMs(delay)
  return delayMs !== undefined ? nowMs + delayMs : undefined
}

export function isInvalidThinkingSignatureError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return INVALID_THINKING_SIGNATURE_RE.test(text) || /\bINVALID_THINKING_SIGNATURE\b/.test(text)
}

function matchStatusError(text: string): readonly [string, string, string, string] | null {
  const m = STATUS_ERROR_RE.exec(text) ?? FALLBACK_STATUS_ERROR_RE.exec(text)
  return m ? ([m[0], m[2]!, m[3]!, m[1]!] as const) : null
}

/**
 * Evaluates a completed `session/prompt` result together with the latest SQLite trajectory step
 * (if any) added during that prompt.
 */
export function evaluateTurnOutcome(
  stopReason: string,
  step: ObservedLastStep | undefined,
  nowMs = Date.now(),
): TurnOutcomeFailure | undefined {
  const errorText =
    step?.type === ERROR_STEP_TYPE
      ? new TextDecoder('utf-8', { fatal: false }).decode(step.payload ?? new Uint8Array())
      : undefined
  if (errorText === undefined && stopReason !== 'refusal') return undefined

  const text = errorText ?? ''
  const apiError = API_ERROR_RE.exec(text) ?? matchStatusError(text)
  const resetAt = extractResetAtMs(text, nowMs)

  if (TOS_VIOLATION_RE.test(text)) {
    return {
      kind: 'tos',
      code: 'TOS_VIOLATION',
      message: sanitizeDiagnosticText(apiError?.[2] ?? text, 240) || 'TOS_VIOLATION',
      retryable: false,
      sessionBroken: true,
    }
  }

  if (isGeoUnsupportedError(text)) {
    return {
      kind: 'geo',
      code: 'FAILED_PRECONDITION',
      message: sanitizeDiagnosticText(apiError?.[2] ?? text, 240) || 'User location is not supported for the API use',
      retryable: true,
      sessionBroken: false,
    }
  }

  if (isInvalidThinkingSignatureError(text)) {
    return {
      kind: 'thinking_signature_corrupt',
      code: 'INVALID_THINKING_SIGNATURE',
      message:
        'Antigravity 历史会话中的 thinking 签名已失效（INVALID_THINKING_SIGNATURE），已自动重置原生会话，下条消息将携带摘要重建新会话。',
      retryable: true,
      sessionBroken: true,
    }
  }

  if (QUOTA_EXHAUSTED_RE.test(text)) {
    return {
      kind: 'quota',
      code: apiError?.[3] ?? 'QUOTA_EXHAUSTED',
      message:
        sanitizeDiagnosticText(apiError?.[2] ?? '', 200) ||
        'Antigravity 配额已耗尽（QUOTA_EXHAUSTED），请稍后重试或切换账号。',
      retryable: true,
      sessionBroken: false,
      ...(resetAt !== undefined ? { resetAt } : {}),
    }
  }

  if (!apiError) {
    return {
      kind: 'provider_error',
      code: stopReason === 'refusal' ? 'REFUSAL' : 'PROVIDER_ERROR',
      message: stopReason === 'refusal' ? '上游拒绝了本轮请求；没有配额耗尽的证据，不切换账号重试。' : 'Antigravity 因上游错误中止了本轮回复。',
      retryable: false,
      sessionBroken: false,
    }
  }

  const httpStatus = apiError[1]!
  const rawMessage = sanitizeDiagnosticText(apiError[2] ?? '', 220) || 'Antigravity upstream API error'
  const statusName = apiError[3] ?? 'PROVIDER_ERROR'
  const rateLimited = httpStatus === '429' || statusName === 'RESOURCE_EXHAUSTED'
  const transientNotFound = httpStatus === '404' && step?.reachedModel === true

  return {
    kind: rateLimited ? 'quota' : 'provider_error',
    code: statusName,
    message: httpStatus !== '404' ? rawMessage : transientNotFound
      ? `上游在模型响应后返回 404；会话可继续：${rawMessage}`
      : `上游未找到所选模型或账号无权访问（404）：${rawMessage}`,
    retryable: rateLimited || transientNotFound || Number(httpStatus) >= 500,
    sessionBroken: false,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(transientNotFound ? { transientNotFound: true } : {}),
  }
}

/**
 * Fallback classifier for turns where `agy` cannot persist `ERROR_MESSAGE` steps into its SQLite
 * trajectory DB (e.g. under `bwrap --ro-bind / /`) and instead emits a single inline
 * `⚠ <STATUS> (code NNN): ...` warning chunk with zero model tokens and `stopReason: "end_turn"`.
 */
export function evaluateInlineWarningFallback(
  stopReason: string,
  inlineText: string | undefined,
  hasThoughtOrTool: boolean,
  usage: AcpUsage | undefined,
  nowMs = Date.now(),
): TurnOutcomeFailure | undefined {
  if (hasThoughtOrTool) return undefined
  if ((usage?.outputTokens ?? 0) > 0 || (usage?.thoughtTokens ?? 0) > 0) return undefined
  if (!inlineText) return undefined
  const trimmed = inlineText.trim()
  if (!trimmed || trimmed.length > 1024) return undefined
  const match = INLINE_WARNING_RE.exec(trimmed)
  if (!match?.[1]) return undefined
  return evaluateTurnOutcome(
    stopReason,
    {
      type: ERROR_STEP_TYPE,
      payload: Buffer.from(match[1], 'utf8'),
      reachedModel: false,
    },
    nowMs,
  )
}

function readDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T | undefined {
  let db: DatabaseSync | undefined
  try {
    for (const suffix of ['-shm', '-wal', '-journal']) {
      const side = lstatSync(dbPath + suffix, { throwIfNoEntry: false })
      if (side && (!side.isFile() || side.nlink !== 1)) return undefined
    }
    db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 100')
    const hasSteps =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get() !== undefined
    return hasSteps ? fn(db) : undefined
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors
    }
  }
}

function readLastStepIndex(db: DatabaseSync): number {
  const row = db.prepare('SELECT max(idx) AS idx FROM steps').get() as { idx?: unknown } | undefined
  return typeof row?.idx === 'number' ? row.idx : -1
}

function readLastStepAfter(db: DatabaseSync, startIndex: number): ObservedLastStep | undefined {
  const row = db
    .prepare(
      'SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1',
    )
    .get(MAX_ERROR_PAYLOAD_BYTES, startIndex) as { type?: unknown; payload?: unknown } | undefined
  if (typeof row?.type !== 'number') return undefined
  const reachedModel =
    db
      .prepare('SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1')
      .get(startIndex, PLANNER_RESPONSE_STEP_TYPE) !== undefined
  return {
    type: row.type,
    payload: row.payload instanceof Uint8Array ? row.payload : null,
    reachedModel,
  }
}

export interface TurnOutcomeWatcher {
  check(result: SessionPromptResult): TurnOutcomeFailure | undefined
}

/**
 * Watches a session's native Antigravity SQLite log across one `session/prompt` turn so upstream
 * API errors disguised as chat text + `end_turn` (or `stopReason: "refusal"`) are surfaced cleanly.
 */
export function createTurnOutcomeWatcher(
  sessionId: string,
  env?: NodeJS.ProcessEnv,
  candidateAppDataDirs?: readonly string[],
): TurnOutcomeWatcher {
  const typedOnly: TurnOutcomeWatcher = {
    check: (result) => evaluateTurnOutcome(result.stopReason, undefined, Date.now()),
  }
  if (!NATIVE_SESSION_ID_RE.test(sessionId)) return typedOnly

  const effective = env ?? process.env
  const cliDirs = antigravityAppDataDirs(effective)
  const dirs = candidateAppDataDirs ?? (effective.ANTIGRAVITY_APP_DATA_DIR?.trim() ? cliDirs.slice(0, 1)
    : [...cliDirs, path.join(path.dirname(cliDirs[0]!), 'antigravity-acp')])
  const segments = ['conversations', `${sessionId}.db`]

  let matchedRoot: string | undefined
  let beforeIdentity: { dev: number; ino: number } | undefined
  let startIndex = -1

  for (const dir of dirs) {
    const convDir = resolveManagedProfilePath(dir, ['conversations'], 'directory')
    if (!convDir) continue
    const dbEntry = resolveManagedProfilePath(dir, segments, 'file')
    if (dbEntry) {
      const idx = readDb(dbEntry.path, readLastStepIndex)
      if (idx === undefined) continue
      matchedRoot = dir
      beforeIdentity = { dev: dbEntry.info.dev, ino: dbEntry.info.ino }
      startIndex = idx
      break
    }
    // File does not exist yet (brand new session): verify no foreign symlink occupies the path.
    try {
      lstatSync(path.join(convDir.path, `${sessionId}.db`))
      continue
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') matchedRoot ??= dir
    }
  }

  if (!matchedRoot) return typedOnly

  return {
    check(result: SessionPromptResult): TurnOutcomeFailure | undefined {
      const afterEntry = resolveManagedProfilePath(matchedRoot!, segments, 'file')
      const sameFile =
        afterEntry !== undefined &&
        (beforeIdentity === undefined ||
          (afterEntry.info.dev === beforeIdentity.dev && afterEntry.info.ino === beforeIdentity.ino))
      const step = sameFile ? readDb(afterEntry.path, (db) => readLastStepAfter(db, startIndex)) : undefined
      return evaluateTurnOutcome(result.stopReason, step, Date.now())
    },
  }
}
