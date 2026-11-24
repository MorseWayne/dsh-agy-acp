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
