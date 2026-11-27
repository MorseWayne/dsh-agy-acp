import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AcpUsage } from './protocol.ts'

/**
 * agy reports `inputTokens` as the UNCACHED prompt only (a cached call arrives as e.g. 2,316 input +
 * 35,595 cache read), which is exactly DSH's `inputTokens` bucket, so nothing is subtracted.
 * The total is kept only when DSH's token meter would accept it; otherwise it is derived.
 */
export function mapUsage(raw: AcpUsage): TokenUsage {
  const input = raw.inputTokens ?? 0
  const output = raw.outputTokens ?? 0
  const read = raw.cachedReadTokens ?? 0
  const write = raw.cachedWriteTokens ?? 0
  const known = input + read + write + output
  const reported = raw.totalTokens
  // With both cache buckets present DSH demands `total - output === input + read + write` exactly.
  const bothCacheBuckets = read > 0 && write > 0
  const total = reported !== undefined && reported >= known && (!bothCacheBuckets || reported === known) ? reported : known
  return {
    inputTokens: input,
    outputTokens: output,
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(raw.thoughtTokens && raw.thoughtTokens <= output ? { reasoningTokens: raw.thoughtTokens } : {}),
    totalTokens: total,
  }
}

/**
 * Terminal fallback used only when agy's per-call transcript is unavailable.
 * If a completed prompt has no ACP usage, retain the occupancy-only context sample.
 *
 * DSH derives context occupancy from the prompt side of the latest usage sample, but the ACP
 * `session/prompt` usage is cumulative over every internal model call of the run, so its prompt side
 * can exceed the context window. Scale it down to the live `usage_update.used` occupancy while keeping
 * the run's cache-hit ratio, instead of dropping the cache buckets.
 */
export function mapContextUsage(raw: AcpUsage | undefined, contextUsed: number | undefined): TokenUsage | undefined {
  const mapped = raw ? mapUsage(raw) : undefined
  if (contextUsed === undefined) return mapped
  if (!mapped) return { inputTokens: contextUsed, outputTokens: 0 }
  const read = mapped.cacheReadTokens ?? 0
  const write = mapped.cacheWriteTokens ?? 0
  const pressure = mapped.inputTokens + read + write
  if (pressure <= contextUsed) return mapped
  const scaledRead = Math.round(contextUsed * read / pressure)
  const scaledWrite = Math.min(contextUsed - scaledRead, Math.round(contextUsed * write / pressure))
  const scaledInput = contextUsed - scaledRead - scaledWrite
  return {
    inputTokens: scaledInput,
    outputTokens: mapped.outputTokens,
    ...(scaledRead > 0 ? { cacheReadTokens: scaledRead } : {}),
    ...(scaledWrite > 0 ? { cacheWriteTokens: scaledWrite } : {}),
    ...(mapped.reasoningTokens !== undefined ? { reasoningTokens: mapped.reasoningTokens } : {}),
    totalTokens: contextUsed + mapped.outputTokens,
  }
}
