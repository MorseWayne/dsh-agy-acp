import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AcpUsage } from './protocol.ts'

/** ACP includes cache hits and writes in input; DSH counts the three buckets separately. */
export function mapUsage(raw: AcpUsage): TokenUsage {
  const read = raw.cachedReadTokens ?? 0
  const write = raw.cachedWriteTokens ?? 0
  return {
    inputTokens: Math.max(0, (raw.inputTokens ?? 0) - read - write),
    outputTokens: raw.outputTokens ?? 0,
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(raw.thoughtTokens ? { reasoningTokens: raw.thoughtTokens } : {}),
    ...(raw.totalTokens !== undefined ? { totalTokens: raw.totalTokens } : {}),
  }
}

/**
 * DSH derives context occupancy from prompt-side tokens of the latest usage sample, but the ACP
 * `session/prompt` usage is cumulative over every internal model call of the run, so its cache-read
 * bucket can exceed the context window. Prefer the live `usage_update.used` figure as the pressure.
 */
export function mapContextUsage(raw: AcpUsage | undefined, contextUsed: number | undefined): TokenUsage | undefined {
  const mapped = raw ? mapUsage(raw) : undefined
  if (contextUsed === undefined) return mapped
  if (!mapped) return { inputTokens: contextUsed, outputTokens: 0 }
  const pressure = mapped.inputTokens + (mapped.cacheReadTokens ?? 0) + (mapped.cacheWriteTokens ?? 0)
  if (pressure <= contextUsed) return mapped
  return {
    inputTokens: contextUsed,
    outputTokens: mapped.outputTokens,
    ...(mapped.reasoningTokens !== undefined ? { reasoningTokens: mapped.reasoningTokens } : {}),
  }
}
