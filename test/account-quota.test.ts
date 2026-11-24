import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseQuotaOutput, readAccountQuota } from '../src/runtime/account-quota.ts'

const usage = (groups: unknown[]) => JSON.stringify({ event: 'command_result', command: { name: 'usage', data: { groups } } })

test('quota reader distinguishes a measured zero, missing buckets, and a dedicated Argon pool', () => {
  const groups = [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0, reset_time: '2026-12-01T00:00:00Z' },
    { window: 'weekly', remaining_fraction: null }] }, { name: 'Gemini 4 Argon', buckets: [{ id: 'argon-weekly', remainingFraction: 0.71 },
    { window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }] }]
  assert.deepEqual(parseQuotaOutput('banner\n{\n' + usage(groups)), [
    { name: 'Gemini Models', fiveHour: { remainingFraction: 0, resetAt: Date.parse('2026-12-01T00:00:00Z') } },
    { name: 'Gemini 4 Argon', sevenDay: { remainingFraction: 0.71 } },
  ])
  for (const fraction of [undefined, null, -1, 1.1, '0']) {
    assert.throws(() => parseQuotaOutput(usage([{ name: 'Gemini', buckets: [{ window: 'weekly', remaining_fraction: fraction }] }])), /未返回/)
  }
  assert.throws(() => parseQuotaOutput('{"usage":{"inputTokens":123}}'), /未返回/)
})

test('quota runner rejects command failure without echoing stderr and respects cancellation', async () => {
  const signal = new AbortController().signal
  await assert.rejects(readAccountQuota([process.execPath, '-e', 'console.error("credential-marker");process.exit(1)'], {}, process.cwd(), signal),
    error => error instanceof Error && !error.message.includes('credential-marker'))
  const abort = new AbortController()
  const reading = readAccountQuota([process.execPath, '-e', 'setInterval(() => {}, 30000)'], {}, process.cwd(), abort.signal)
  abort.abort()
  await assert.rejects(reading)
})
