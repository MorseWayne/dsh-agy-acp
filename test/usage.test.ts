import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  callUsageToTokenUsage,
  extractCallUsage,
  mergeCallUsage,
  transcriptCandidates,
  TranscriptUsageTailer,
} from '../src/acp/transcript-usage.ts'
import { mapContextUsage, mapUsage } from '../src/acp/usage.ts'

test('mapUsage keeps agy inputTokens as the uncached prompt (no double cache subtraction)', () => {
  // Real agy result: totalTokens = input + cacheRead + output + thought.
  const u = mapUsage({ inputTokens: 115_476, cachedReadTokens: 740_195, outputTokens: 10_766, thoughtTokens: 6_176, totalTokens: 872_613 })
  assert.deepEqual(u, { inputTokens: 115_476, outputTokens: 10_766, cacheReadTokens: 740_195, reasoningTokens: 6_176, totalTokens: 872_613 })
})

test('mapUsage derives a total DSH accepts when the reported one contradicts both cache buckets', () => {
  const u = mapUsage({ inputTokens: 10, cachedReadTokens: 20, cachedWriteTokens: 5, outputTokens: 3, totalTokens: 99 })
  assert.equal(u.totalTokens, 38)
  assert.equal(mapUsage({ inputTokens: 10, outputTokens: 3, totalTokens: 5 }).totalTokens, 13)
})

test('mapContextUsage keeps mapped buckets when pressure fits the live context', () => {
  const u = mapContextUsage({ inputTokens: 200, cachedReadTokens: 300, outputTokens: 5 }, 900)
  assert.deepEqual(u, { inputTokens: 200, outputTokens: 5, cacheReadTokens: 300, totalTokens: 505 })
})

test('mapContextUsage scales cumulative ACP usage to usage_update.used and keeps the hit ratio', () => {
  const u = mapContextUsage({ inputTokens: 44_965, cachedReadTokens: 109_423, outputTokens: 905 }, 40_559)
  assert.equal(u?.inputTokens! + (u?.cacheReadTokens ?? 0), 40_559)
  assert.equal(Math.round(100 * (u?.cacheReadTokens ?? 0) / 40_559), 71)
  assert.equal(u?.totalTokens, 40_559 + 905)
})

test('mapContextUsage synthesizes a sample at mirror boundaries and stays silent without data', () => {
  assert.deepEqual(mapContextUsage(undefined, 320), { inputTokens: 320, outputTokens: 0 })
  assert.equal(mapContextUsage(undefined, undefined), undefined)
})

test('extractCallUsage reads flat and nested agy transcript counters', () => {
  assert.deepEqual(extractCallUsage({ type: 'PLANNER_RESPONSE', input_tokens: 2316, cache_read_tokens: 35_595, output_tokens: 128 }),
    { inputTokens: 2316, outputTokens: 128, cacheReadTokens: 35_595, cacheWriteTokens: 0 })
  assert.deepEqual(extractCallUsage({ usage: { inputTokens: 5, outputTokens: 4, thoughtTokens: 2 } }),
    { inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 2 })
  assert.equal(extractCallUsage({ type: 'PLANNER_RESPONSE', step_index: 3 }), null)
})

test('mergeCallUsage takes the latest prompt side and sums generation', () => {
  const merged = mergeCallUsage(
    mergeCallUsage(null, { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    { inputTokens: 20, outputTokens: 60, cacheReadTokens: 330, cacheWriteTokens: 0 })
  assert.deepEqual(callUsageToTokenUsage(merged),
    { inputTokens: 20, outputTokens: 100, cacheReadTokens: 330, cacheWriteTokens: 0, totalTokens: 450 })
})

test('transcriptCandidates honours the account environment and rejects unsafe ids', () => {
  const [first, second] = transcriptCandidates('abc-1', { ANTIGRAVITY_APP_DATA_DIR: '/data/agy', HOME: '/home/acct' })
  assert.equal(first, path.join('/data/agy', 'brain', 'abc-1', '.system_generated', 'logs', 'transcript.jsonl'))
  assert.equal(second, path.join('/home/acct', '.gemini', 'antigravity-cli', 'brain', 'abc-1', '.system_generated', 'logs', 'transcript.jsonl'))
  assert.deepEqual(transcriptCandidates('../escape', {}), [])
})

test('TranscriptUsageTailer starts at the pre-turn size, dedupes steps, and waits for complete lines', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-tailer-'))
  const file = path.join(dir, 'transcript.jsonl')
  const line = (rec: object) => JSON.stringify(rec) + '\n'
  try {
    writeFileSync(file, line({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 9, output_tokens: 1 }))
    const tailer = new TranscriptUsageTailer([path.join(dir, 'missing.jsonl'), file])
    assert.equal(tailer.available, false)
    assert.deepEqual(tailer.poll(), [])
    assert.equal(tailer.available, true)

    const rec = line({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', model: '模型', input_tokens: 7, cache_read_tokens: 93, output_tokens: 5 })
    appendFileSync(file, line({ step_index: 2, type: 'USER_INPUT', status: 'DONE' }) + rec.slice(0, 20))
    assert.deepEqual(tailer.poll(), [])
    appendFileSync(file, rec.slice(20) + rec)
    assert.deepEqual(tailer.poll(), [{ inputTokens: 7, outputTokens: 5, cacheReadTokens: 93, cacheWriteTokens: 0 }])
    appendFileSync(file, line({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'RUNNING', input_tokens: 1 }))
    assert.deepEqual(tailer.poll(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
