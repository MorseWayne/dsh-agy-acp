import assert from 'node:assert/strict'
import test from 'node:test'
import { mapContextUsage } from '../src/acp/usage.ts'

test('mapContextUsage keeps mapped buckets when pressure fits the live context', () => {
  const u = mapContextUsage({ inputTokens: 500, cachedReadTokens: 300, outputTokens: 5 }, 900)
  assert.deepEqual(u, { inputTokens: 200, outputTokens: 5, cacheReadTokens: 300 })
})

test('mapContextUsage clamps cumulative ACP usage to usage_update.used', () => {
  const u = mapContextUsage({ inputTokens: 0, cachedReadTokens: 740_195, outputTokens: 10, thoughtTokens: 7, totalTokens: 9 }, 120_000)
  assert.deepEqual(u, { inputTokens: 120_000, outputTokens: 10, reasoningTokens: 7 })
})

test('mapContextUsage synthesizes a sample at mirror boundaries and stays silent without data', () => {
  assert.deepEqual(mapContextUsage(undefined, 320), { inputTokens: 320, outputTokens: 0 })
  assert.equal(mapContextUsage(undefined, undefined), undefined)
})
