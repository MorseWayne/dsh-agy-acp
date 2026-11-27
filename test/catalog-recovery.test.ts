import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AcpProcessExitError, AcpTimeoutError } from '../src/acp/client.ts'
import { resolveConfig } from '../src/common/config.ts'
import { PROVIDER_ID } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { EgressGuard } from '../src/runtime/egress-guard.ts'
import { AcpSessionPool, formatCatalogProbeError } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

test('picker recovers after a cold probe failure; expired reads keep the last catalog without notification loops', async t => {
  let unavailable = true
  let launches = 0
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => resolveConfig(), resolveBin: () => process.execPath,
    async prepareArgv(_argv, policy) {
      launches++
      assert.equal(policy.mode, 'read-only')
      if (unavailable) throw new Error('temporary discovery failure')
      return [process.execPath, fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))]
    },
  })
  t.after(() => pool.dispose())
  let updates = 0
  pool.on('models-updated', () => { updates++ })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  await assert.rejects(pool.refreshModels(), /temporary discovery failure/)
  assert.ok(pool.getStatus().lastError)
  assert.equal(updates, 0)
  unavailable = false
  const notified = once(pool, 'models-updated')
  t.mock.timers.tick(5_000)
  await notified
  const good = await pool.refreshModels()
  assert.ok(good.some(m => m.value === 'gemini-4-neon'))
  assert.equal(pool.getStatus().lastError, null)
  assert.equal(updates, 1)
  t.mock.timers.tick(5 * 60_000 + 1)
  unavailable = true
  assert.deepEqual(await pool.refreshModels(), good)
  assert.deepEqual(await pool.refreshModels(), good)
  assert.equal(launches, 3)
  unavailable = false
  const recovered = once(pool, 'models-updated')
  t.mock.timers.tick(5_000)
  await recovered
  assert.equal(updates, 2)
  t.mock.timers.tick(5 * 60_000 + 1)
  await pool.refreshModels()
  assert.equal(updates, 2, 'unchanged healthy metadata must not retrigger host discovery')
})

test('formatCatalogProbeError classifies failure causes clearly without leaking secrets', () => {
  assert.match(formatCatalogProbeError(new Error('agy binary not found')), /未找到 agy 可执行文件/)
  assert.match(formatCatalogProbeError(new Error('refusing unconfined startup')), /宿主只读沙箱不可用/)
  assert.match(formatCatalogProbeError(new AcpTimeoutError('initialize', 15000, 'slow')), /探测超时.*slow/)
  const exitMsg = formatCatalogProbeError(new AcpProcessExitError(1, null, 'bad auth', undefined))
  assert.match(exitMsg, /异常退出.*code=1.*bad auth/)
  const generic = formatCatalogProbeError(new Error('failed with GOOGLE_API_KEY=AIzaSySecretKey1234567890123456789'))
  assert.equal(generic.includes('AIzaSySecretKey'), false)
  assert.match(generic, /\[REDACTED\]/)
})

test('forceRefreshModels emits SSE status on recovery and rejects on failure while preserving cache for refreshModels', async (t) => {
  let unavailable = false
  const statusEvents: Array<{ lastError: string | null; modelsCount: number }> = []
  const pool = new AcpSessionPool({
    ...fakeHost,
    getConfig: () => resolveConfig(),
    resolveBin: () => process.execPath,
    async prepareArgv() {
      if (unavailable) throw new Error('forced outage')
      return [process.execPath, fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))]
    },
  })
  t.after(() => pool.dispose())
  pool.on('status', (s: { lastError: string | null; models: unknown[] }) => {
    statusEvents.push({ lastError: s.lastError, modelsCount: s.models.length })
  })

  const initial = await pool.forceRefreshModels()
  assert.ok(initial.length > 0)
  assert.ok(statusEvents.some(e => e.lastError === null && e.modelsCount > 0))

  unavailable = true
  await assert.rejects(pool.forceRefreshModels(), /forced outage/)
  assert.match(pool.getStatus().lastError ?? '', /forced outage/)
  // Passive refreshModels still returns preserved cache during outage
  const cached = await pool.refreshModels()
  assert.deepEqual(cached, initial)

  // Recovery clears lastError and emits status event
  unavailable = false
  await pool.forceRefreshModels()
  assert.equal(pool.getStatus().lastError, null)
  assert.equal(statusEvents[statusEvents.length - 1]?.lastError, null)
})

test('catalog probe blocked by HK egress launches zero subprocesses, pauses background retry timers, and recovers after checkAccountEgress', async (t) => {
  let launches = 0
  let country: 'HK' | 'US' = 'HK'
  const guard = new EgressGuard({
    probeFn: async () => ({
      status: country === 'HK' ? 'unsupported' : 'supported',
      country,
      ipMasked: '203.0.113.*',
      proxyMode: 'proxy',
      probeSource: 'mock',
    }),
  })
  const pool = new AcpSessionPool({
    ...fakeHost,
    egressGuard: guard,
    getConfig: () => resolveConfig({ geoFenceMode: 'block' }),
    resolveBin: () => process.execPath,
    async prepareArgv() {
      launches++
      return [process.execPath, fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))]
    },
  })
  t.after(() => pool.dispose())
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })

  await assert.rejects(pool.refreshModels(), /\[安全拦截\].*HK/)
  assert.equal(launches, 0)
  assert.match(pool.getStatus().lastError ?? '', /\[安全拦截\].*HK/)

  // Advancing timers across all retry windows (5s / 30s / 60s) must NOT trigger background retries while geo-blocked
  t.mock.timers.tick(5_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(launches, 0)

  // User switches node to US and clicks "检测出口" -> automatically clears error & discovers models
  country = 'US'
  const recovered = once(pool, 'models-updated')
  await pool.checkAccountEgress('default')
  await recovered
  assert.equal(launches, 1)
  assert.equal(pool.getStatus().lastError, null)
  assert.ok(pool.getStatus().models.length > 0)
})

test('resolveModel reports cold discovery failures and still resolves verified levels from stale cache during an outage', async t => {
  const failure = new Error('refusing unconfined startup')
  let unavailable = true
  let launches = 0
  const pool = new AcpSessionPool({
    ...fakeHost, getConfig: resolveConfig, resolveBin: () => process.execPath,
    async prepareArgv() {
      launches++
      if (unavailable) throw failure
      return [process.execPath, fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))]
    },
  })
  t.after(() => pool.dispose())
  const adapter = new AcpAdapter({ getConfig: resolveConfig, pool, runs: new AcpRunStore() })
  const resolve = () => adapter.resolveModel(PROVIDER_ID, 'gemini-4-neon')
  await assert.rejects(resolve(), err => {
    assert.ok(err instanceof LlmError)
    assert.equal(err.code, 'DISCOVERY_FAILED')
    assert.match(err.message, /宿主只读沙箱不可用/)
    assert.equal(err.cause, failure)
    return true
  })

  unavailable = false
  const expected = await resolve()
  assert.deepEqual(expected.reasoning?.efforts.map(e => e.id), ['low', 'medium', 'high'])
  unavailable = true
  pool.invalidateCatalog()
  assert.deepEqual(await resolve(), expected)
  assert.equal(launches, 3, 'the expired cache is used only after another probe fails')
  assert.match(pool.getStatus().lastError ?? '', /宿主只读沙箱不可用/)
})

test('prepareCall aborts its own wait promptly without cancelling a shared catalog probe', async t => {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let launches = 0
  const pool = new AcpSessionPool({
    ...fakeHost, getConfig: resolveConfig, resolveBin: () => process.execPath,
    async prepareArgv(_argv, _policy, signal) {
      launches++
      entered.resolve()
      await resume.promise
      assert.equal(signal?.aborted, false)
      return [process.execPath, fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))]
    },
  })
  t.after(() => { resume.resolve(); pool.dispose() })
  const adapter = new AcpAdapter({ getConfig: resolveConfig, pool, runs: new AcpRunStore() })
  const model = 'gemini-4-neon'
  const reason = new Error('caller cancelled discovery')
  await assert.rejects(adapter.resolveModel(PROVIDER_ID, model, AbortSignal.abort(reason)), err => err === reason)
  assert.equal(launches, 0)

  const controller = new AbortController()
  const cancelled = assert.rejects(adapter.prepareCall(PROVIDER_ID, model, controller.signal), err => err === reason)
  await entered.promise
  const other = adapter.resolveModel(PROVIDER_ID, model)
  controller.abort(reason)
  await cancelled
  resume.resolve()
  assert.deepEqual((await other).reasoning?.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.equal(pool.getStatus().lastError, null)
})

test('prepareCall uses verified exact abilities without a new probe, while the menu still performs strict discovery', async t => {
  const launches: string[] = []
  const fail = Object.assign(new Error('EROFS: account startup needs a writable path'), { code: 'EROFS' })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const pool = new AcpSessionPool({
    ...fakeHost, getConfig: resolveConfig, resolveBin: () => process.execPath,
    async prepareArgv(_argv, policy) {
      launches.push(policy.sessionId)
      if (policy.sessionId === '__catalog__') {
        assert.equal(policy.mode, 'read-only')
        throw fail
      }
      return [process.execPath, fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))]
    },
  })
  t.after(() => pool.dispose())
  const adapter = new AcpAdapter({ getConfig: resolveConfig, pool, runs: new AcpRunStore() })
  const model = 'gemini-4-neon'
  await assert.rejects(adapter.prepareCall(PROVIDER_ID, model), err => {
    assert.ok(err instanceof LlmError)
    assert.equal(err.code, 'DISCOVERY_FAILED')
    assert.equal(err.cause, fail)
    return true
  })
  assert.deepEqual(launches, ['__catalog__'], 'cold lookup never starts under the conversation policy')

  const key = 'warm-call'
  await pool.getOrCreateSession(key, fakeHost.readPolicy(key).workspaceRoot, model)
  now += 5 * 60_000 + 1
  const prepared = await adapter.prepareCall(PROVIDER_ID, model)
  assert.deepEqual(prepared.model.reasoning?.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.deepEqual(launches, ['__catalog__', key], 'the call reuses verified evidence even after the menu TTL')

  const missing = await adapter.prepareCall(PROVIDER_ID, 'gemini-unverified')
  assert.equal(missing.model.reasoning, undefined, 'do not synthesize levels for an unverified ID')
  assert.deepEqual(launches, ['__catalog__', key, '__catalog__'])
  await assert.rejects(pool.forceRefreshModels(), err => err === fail)
  const afterProbeFailure = await adapter.prepareCall(PROVIDER_ID, model)
  assert.deepEqual(afterProbeFailure.model.reasoning, prepared.model.reasoning)
  assert.deepEqual(launches, ['__catalog__', key, '__catalog__', '__catalog__'])
})
