import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * Exact usage of ONE internal agy model call.
 *
 * `agy acp` only streams `usage_update { used, size }` and returns a per-prompt cumulative usage in the
 * `session/prompt` response; neither can be split across the DSH steps a mirrored run produces. agy does
 * write every model call (`PLANNER_RESPONSE`) with its own counters to
 * `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, where `input_tokens` is the
 * UNCACHED part of the prompt and `cache_read_tokens` the cached part.
 */
export interface CallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
}

export interface CallUsageSource {
  /** True once the transcript file has been found. */
  readonly available: boolean
  /** Unseen completed model calls appended since the previous poll. */
  poll(): CallUsage[]
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_READ = 4 * 1024 * 1024

/** agy's app data directories for an account environment, most specific first. */
export function antigravityAppDataDirs(env?: NodeJS.ProcessEnv): string[] {
  const e = env ?? process.env
  const dirs: string[] = []
  const explicit = e.ANTIGRAVITY_APP_DATA_DIR?.trim()
  if (explicit) dirs.push(path.resolve(explicit))
  const home = (process.platform === 'win32' ? e.USERPROFILE : e.HOME)?.trim() || os.homedir()
  dirs.push(path.join(home, '.gemini', 'antigravity-cli'))
  return [...new Set(dirs)]
}

export function transcriptCandidates(conversationId: string, env?: NodeJS.ProcessEnv): string[] {
  if (!SAFE_ID.test(conversationId)) return []
  return antigravityAppDataDirs(env).map(dir =>
    path.join(dir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'))
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function pick(rec: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const n = count(rec[k])
    if (n !== undefined) return n
  }
  return undefined
}

const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens'] as const
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens'] as const
const CACHE_READ_KEYS = ['cache_read_tokens', 'cachedReadTokens', 'cached_content_token_count'] as const
const CACHE_WRITE_KEYS = ['cache_write_tokens', 'cachedWriteTokens'] as const
const THINKING_KEYS = ['thinking_tokens', 'thoughtTokens', 'thoughts_token_count'] as const

/** Counters of one transcript record: flat on the record (agy >= 1.5.12) or nested in a usage object. */
export function extractCallUsage(rec: Record<string, unknown>): CallUsage | null {
  const metadata = obj(rec.metadata)
  const candidates = [rec, obj(rec.usage), obj(rec.token_usage), metadata ? obj(metadata.usage) : null]
  for (const raw of candidates) {
    if (!raw) continue
    const input = pick(raw, INPUT_KEYS)
    const output = pick(raw, OUTPUT_KEYS)
    const cacheRead = pick(raw, CACHE_READ_KEYS)
    if (input === undefined && output === undefined && cacheRead === undefined) continue
    const outputTokens = output ?? 0
    const thinking = pick(raw, THINKING_KEYS)
    return {
      inputTokens: input ?? 0,
      outputTokens,
      cacheReadTokens: cacheRead ?? 0,
      cacheWriteTokens: pick(raw, CACHE_WRITE_KEYS) ?? 0,
      ...(thinking !== undefined && thinking <= outputTokens ? { reasoningTokens: thinking } : {}),
    }
  }
  return null
}

/**
 * Merge model calls that fall into one DSH step: the prompt side takes the LATEST call so DSH's
 * context-pressure reading stays the real occupancy; generation sums across calls.
 */
export function mergeCallUsage(cur: CallUsage | null, next: CallUsage): CallUsage {
  if (!cur) return { ...next }
  const reasoning = (cur.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0)
  return {
    inputTokens: next.inputTokens,
    cacheReadTokens: next.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens,
    outputTokens: cur.outputTokens + next.outputTokens,
    ...(cur.reasoningTokens !== undefined || next.reasoningTokens !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

/** DSH sample with both cache buckets and an exact total, so the per-turn usage disclosure accepts it. */
export function callUsageToTokenUsage(u: CallUsage): TokenUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    totalTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens,
    ...(u.reasoningTokens !== undefined && u.reasoningTokens <= u.outputTokens ? { reasoningTokens: u.reasoningTokens } : {}),
  }
}

/**
 * Incremental tailer over agy's transcript. It starts at the size each candidate had when the turn
 * began, so older turns are never replayed, and splits on raw newline bytes so UTF-8 is never torn.
 */
export class TranscriptUsageTailer implements CallUsageSource {
  private file: string | null = null
  private offset = 0
  private remainder: Buffer = Buffer.alloc(0)
  private readonly baseline = new Map<string, number>()
  private readonly seen = new Set<string>()

  constructor(private readonly candidates: readonly string[]) {
    for (const file of candidates) this.baseline.set(file, sizeOf(file) ?? 0)
  }

  get available(): boolean {
    return this.file !== null
  }

  poll(): CallUsage[] {
    if (!this.file) {
      const found = this.candidates.find(file => existsSync(file))
      if (!found) return []
      this.file = found
      this.offset = this.baseline.get(found) ?? 0
    }
    const size = sizeOf(this.file)
    if (size === undefined) return []
    if (size < this.offset) {
      this.offset = 0
      this.remainder = Buffer.alloc(0)
    }
    const out: CallUsage[] = []
    while (size > this.offset) {
      const chunk = this.read(Math.min(size - this.offset, MAX_READ))
      if (!chunk || chunk.length === 0) break
      this.offset += chunk.length
      const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk
      let start = 0
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0a) continue
        const sample = this.parse(data.subarray(start, i).toString('utf8'))
        if (sample) out.push(sample)
        start = i + 1
      }
      this.remainder = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0)
    }
    return out
  }

  private read(length: number): Buffer | null {
    let fd: number | null = null
    try {
      fd = openSync(this.file!, 'r')
      const buf = Buffer.allocUnsafe(length)
      const n = readSync(fd, buf, 0, length, this.offset)
      return buf.subarray(0, n)
    } catch {
      return null
    } finally {
      if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
    }
  }

  private parse(line: string): CallUsage | null {
    const text = line.trim()
    if (!text.startsWith('{')) return null
    let rec: Record<string, unknown> | null
    try { rec = obj(JSON.parse(text)) } catch { return null }
    if (!rec) return null
    if (String(rec.type ?? '').toUpperCase() !== 'PLANNER_RESPONSE') return null
    const status = String(rec.status ?? '').toUpperCase()
    if (status !== '' && status !== 'DONE' && status !== 'COMPLETED') return null
    const usage = extractCallUsage(rec)
    if (!usage) return null
    const step = rec.step_index ?? rec.stepIndex
    if (step !== undefined && step !== null) {
      const key = String(step)
      if (this.seen.has(key)) return null
      this.seen.add(key)
    }
    return usage
  }
}

function sizeOf(file: string): number | undefined {
  try { return statSync(file).size } catch { return undefined }
}
