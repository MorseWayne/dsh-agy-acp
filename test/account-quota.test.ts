import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/common/config.ts'
import { AccountQuotaError, mapQuotaGroupsToFamilies, parseQuotaOutput, readAccountQuota } from '../src/runtime/account-quota.ts'
import { EgressGuard } from '../src/runtime/egress-guard.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

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

test('refreshAccountQuota blocks locally with HTTP 451 and zero subprocess launches when egress is HK', async (t) => {
  let launches = 0
  const pool = new AcpSessionPool({
    ...fakeHost,
    egressGuard: new EgressGuard({
      probeFn: async () => ({
        status: 'unsupported',
        country: 'HK',
        ipMasked: '203.0.113.*',
        proxyMode: 'direct',
        probeSource: 'mock',
      }),
    }),
    getConfig: () => resolveConfig({ geoFenceMode: 'block' }),
    resolveBin: () => 'fake-agy',
    prepareArgv: async (argv) => {
      launches++
      return argv
    },
  })
  t.after(() => pool.dispose())

  await assert.rejects(
    pool.refreshAccountQuota('default'),
    (err: unknown) => err instanceof AccountQuotaError && err.status === 451 && err.message.includes('HK'),
  )
  assert.equal(launches, 0)
})

test('mapQuotaGroupsToFamilies prioritizes general/family pools over single-variant Argon exhaustion', () => {
  // Dedicated Argon at 0% must NOT override general Gemini Models at 80%
  const mapped1 = mapQuotaGroupsToFamilies([
    { name: 'Gemini Models', fiveHour: { remainingFraction: 0.8 }, sevenDay: { remainingFraction: 0.7 } },
    { name: 'Gemini 4 Argon', fiveHour: { remainingFraction: 0 }, sevenDay: { remainingFraction: 0 } },
  ])
  assert.equal(mapped1['gemini-pro']?.fiveHour?.remainingFraction, 0.8)
  assert.equal(mapped1['gemini-flash']?.fiveHour?.remainingFraction, 0.8)

  // Explicit Gemini Flash overrides general Gemini Models for gemini-flash only
  const mapped2 = mapQuotaGroupsToFamilies([
    { name: 'Gemini Models', fiveHour: { remainingFraction: 0.3 } },
    { name: 'Gemini Flash', fiveHour: { remainingFraction: 0.95 } },
    { name: 'Claude Opus', fiveHour: { remainingFraction: 0 } },
    { name: 'Claude Sonnet', fiveHour: { remainingFraction: 0.6 } },
  ])
  assert.equal(mapped2['gemini-pro']?.fiveHour?.remainingFraction, 0.3)
  assert.equal(mapped2['gemini-flash']?.fiveHour?.remainingFraction, 0.95)
  assert.equal(mapped2.claude?.fiveHour?.remainingFraction, 0.6)
})
