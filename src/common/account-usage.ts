import type { UsageCounter } from './types.ts'

export const USAGE_RETENTION_DAYS = 30

export function emptyUsageCounter(): UsageCounter {
  return { requests: 0, rateLimited: 0, failed: 0, inputTokens: 0, cachedReadTokens: 0,
    cachedWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
}

function nonnegativeInt(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n))) : 0
}

export function addUsageCounters(a: UsageCounter, b: Partial<UsageCounter>): UsageCounter {
  const sum = emptyUsageCounter()
  for (const sample of [a, b]) {
    for (const key of ['requests', 'rateLimited', 'failed', 'reasoningTokens'] as const) {
      sum[key] += Math.min(Number.MAX_SAFE_INTEGER - sum[key], nonnegativeInt(sample[key]))
    }
    // Clip new bucket increments to the remaining capacity; never shrink old buckets
    // or accept an upstream total that counts reasoning separately.
    for (const key of ['inputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'outputTokens'] as const) {
      const delta = Math.min(Number.MAX_SAFE_INTEGER - sum.totalTokens, nonnegativeInt(sample[key]))
      sum[key] += delta
      sum.totalTokens += delta
    }
  }
  return sum
}

export function localDateKey(ms: number): string {
  const date = new Date(ms)
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-')
}

export function usageSharePct(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(1, part / total)) * 100
}
