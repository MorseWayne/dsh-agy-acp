import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AcpClient } from '../src/acp/client.ts'
import { addUsageCounters, emptyUsageCounter, localDateKey, usageSharePct } from '../src/common/account-usage.ts'
import { resolveConfig } from '../src/common/config.ts'
import { PROVIDER_ID, type StatusSnapshot } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { MultiAccountPool } from '../src/runtime/account-pool.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { resolveUsageStorePath, UsageStore } from '../src/runtime/usage-store.ts'
import { registerAcpRoutes, type ExactRouteSpec } from '../src/transport/sse.ts'
import { fakeHost } from './fixtures/session-policy.ts'

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-account-usage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('shared counters ignore reported totals, preserve safe nonnegative bucket sums and compute a bounded share', () => {
  const zero = emptyUsageCounter()
  const a = addUsageCounters(zero, { inputTokens: 10.8, cachedReadTokens: 20, cachedWriteTokens: 3,
    outputTokens: 8, reasoningTokens: 6, totalTokens: 999, requests: 1 })
  assert.deepEqual(a, { ...zero, inputTokens: 10, cachedReadTokens: 20, cachedWriteTokens: 3,
    outputTokens: 8, reasoningTokens: 6, totalTokens: 41, requests: 1 })
  assert.deepEqual(addUsageCounters(a, { failed: -8, requests: NaN, outputTokens: Infinity }), a)
  const capped = addUsageCounters(a, { inputTokens: 1e99, outputTokens: 1e99, requests: 1e99 })
  assert.ok(Object.values(capped).every(v => v >= 0 && Number.isSafeInteger(v)))
  assert.equal(capped.totalTokens, Number.MAX_SAFE_INTEGER)
  assert.equal(capped.inputTokens + capped.cachedReadTokens + capped.cachedWriteTokens + capped.outputTokens, capped.totalTokens)
  assert.equal(zero.totalTokens, 0)
  assert.equal(usageSharePct(1, 4), 25)
  assert.equal(usageSharePct(2, 0), 0)
  assert.equal(usageSharePct(-1, 1), 0)
  assert.equal(usageSharePct(2, 1), 100)
})

test('local calendar windows cross month/year boundaries; pruning never removes lifetime usage', t => {
  const filePath = path.join(tempDir(t), 'usage.json')
  const store = new UsageStore({ filePath })
  t.after(() => store.dispose())
  const day = (daysAgo: number) => new Date(2026, 0, 3 - daysAgo, 23, 59).getTime()
  assert.equal(localDateKey(day(6)), '2025-12-28')
  for (const age of [30, 29, 7, 6, 1, 0]) {
    store.recordTurn({ accountId: 'a', accountLabel: 'Historical A', model: age === 0 ? 'claude-sonnet' : 'gemini-pro',
      usage: { inputTokens: 1 }, countRequest: true, now: day(age) })
  }
  store.recordFailure({ accountId: 'b', model: 'custom', rateLimited: true, now: day(0) })
  const snap = store.getSnapshot({ now: day(0), liveLabels: new Map([['a', 'Live A']]) })
  assert.equal(snap.retentionDays, 30)
  assert.equal(snap.updatedAt, day(0))
  assert.deepEqual([snap.today, snap.last7Days, snap.allTime].map(w => w.totals.requests), [1, 3, 6])
  assert.equal(snap.last7Days.accounts[0]?.families['gemini-pro']?.inputTokens, 2)
  assert.equal(snap.allTime.accounts[0]?.lastUsedAt, day(0))
  assert.equal(snap.today.accounts[0]?.accountLabel, 'Live A')
  assert.equal(snap.today.accounts[1]?.accountLabel, 'b')
  assert.deepEqual(snap.today.accounts[1]?.families.other, { ...emptyUsageCounter(), rateLimited: 1 })
  snap.today.accounts[0]!.totals.requests = 100
  assert.equal(store.getSnapshot({ now: day(0) }).today.totals.requests, 1)
  store.flush()
  const keys = () => Object.keys(JSON.parse(readFileSync(filePath, 'utf8')).daily).sort()
  assert.deepEqual(keys(), [29, 7, 6, 1, 0].map(n => localDateKey(day(n))))
  const later = store.getSnapshot({ now: day(-30) })
  assert.equal(later.allTime.totals.requests, 6)
  assert.equal(later.allTime.accounts[0]?.accountLabel, 'Historical A')
  assert.deepEqual(later.last7Days.accounts, [])
  store.flush()
  assert.deepEqual(keys(), [])
})

test('window sorting uses tokens, requests, failures, then ID; ignored turns create no rows', () => {
  const store = new UsageStore({ persist: false })
  for (const id of ['b', 'a', 'c']) store.recordFailure({ accountId: id, rateLimited: true })
  store.recordFailure({ accountId: 'c', rateLimited: false })
  store.recordTurn({ accountId: 'req', countRequest: true })
  store.recordTurn({ accountId: '__proto__', usage: { cachedReadTokens: 1 }, countRequest: false })
  store.recordTurn({ accountId: 'ignored', usage: { requests: 99, failed: 99, totalTokens: 99 } })
  store.recordTurn({ accountId: 'ignored' })
  assert.deepEqual(store.getSnapshot().allTime.accounts.map(a => a.accountId), ['__proto__', 'req', 'c', 'a', 'b'])
})

test('disk store atomically replaces private files; restart, reset and historical labels are durable', t => {
  const dir = path.join(tempDir(t), 'new-directory')
  const filePath = path.join(dir, 'usage.json')
  const store = new UsageStore({ filePath })
  store.load()
  store.recordTurn({ accountId: 'old', accountLabel: 'Deleted account', model: 'claude', usage: { outputTokens: 4 }, countRequest: true })
  assert.equal(existsSync(filePath), false)
  store.dispose()
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
  const oldIno = statSync(filePath).ino
  const fresh = new UsageStore({ filePath })
  fresh.load()
  assert.deepEqual(fresh.getSnapshot(), store.getSnapshot())
  assert.equal(fresh.getSnapshot().allTime.accounts[0]?.accountLabel, 'Deleted account')
  fresh.recordFailure({ accountId: 'old', rateLimited: false })
  fresh.reset(1234) // Must override pending writes synchronously.
  assert.notEqual(statSync(filePath).ino, oldIno)
  assert.deepEqual(readdirSync(dir), ['usage.json'])
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 1, allTime: { accounts: {} }, daily: {}, labels: {}, updatedAt: 1234 })
  fresh.dispose()
  store.load()
  assert.deepEqual(store.getSnapshot().allTime, { accounts: [], totals: emptyUsageCounter() })
})

test('bursts are coalesced, failed writes preserve pending data, and flush retries without new turns', t => {
  const dir = tempDir(t)
  const parent = path.join(dir, 'private')
  const filePath = path.join(parent, 'usage.json')
  writeFileSync(parent, 'not a directory')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const logs: string[] = []
  const store = new UsageStore({ filePath, log: msg => logs.push(msg) })
  for (let i = 0; i < 4; i++) store.recordTurn({ accountId: 'a', countRequest: true })
  t.mock.timers.tick(499)
  assert.equal(logs.length, 0)
  t.mock.timers.tick(1)
  assert.equal(logs.length, 1)
  assert.throws(() => store.reset())
  assert.equal(store.getSnapshot().today.totals.requests, 4)
  rmSync(parent)
  store.flush()
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).allTime.accounts.a.totals.requests, 4)
  store.recordFailure({ accountId: 'a', rateLimited: true })
  t.mock.timers.tick(500)
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).allTime.accounts.a.totals.rateLimited, 1)
  store.dispose()
})

test('bad versions, malformed counters, oversized files and broken JSON are rejected without blocking startup', t => {
  const filePath = path.join(tempDir(t), 'usage.json')
  const logs: string[] = []
  const store = new UsageStore({ filePath, log: msg => logs.push(msg) })
  const empty = { version: 1, allTime: { accounts: {} }, daily: {}, labels: {}, updatedAt: 0 }
  for (const [i, content] of ['{', JSON.stringify({ ...empty, version: 2 }), JSON.stringify({ ...empty, allTime: {
    accounts: { bad: { lastUsedAt: null, families: {}, totals: { ...emptyUsageCounter(), outputTokens: 1 } } } } }), ' '.repeat(2 * 1024 * 1024 + 1)].entries()) {
    writeFileSync(filePath, content)
    store.load()
    assert.deepEqual(store.getSnapshot().allTime.accounts, [])
    assert.equal(logs.length, i + 1)
  }
  assert.throws(() => resolveUsageStorePath(filePath + '\n'))
})

test('environment override is used only by persistent stores; default pools and memory stores never touch disk', t => {
  const dir = tempDir(t)
  const filePath = path.join(dir, 'override.json')
  const previous = process.env.DSH_AGY_ACP_USAGE_PATH
  process.env.DSH_AGY_ACP_USAGE_PATH = filePath
  t.after(() => { if (previous === undefined) delete process.env.DSH_AGY_ACP_USAGE_PATH; else process.env.DSH_AGY_ACP_USAGE_PATH = previous })
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => resolveConfig(), resolveBin: () => null })
  pool.recordTurnUsage({ inputTokens: 3 }) // Original one-argument API remains a process-only statistic.
  assert.equal(pool.getStatus().usageTotals.inputTokens, 3)
  assert.deepEqual(pool.getStatus().accountUsage?.allTime.accounts, [])
  pool.recordTurnUsage(undefined, { accountId: 'default', countRequest: true })
  pool.reportAccountFailure('default', 'model', new DOMException('cancelled', 'AbortError'))
  pool.reportAccountFailure('default', 'model', new Error('generic'), { code: 'QUOTA_EXHAUSTED' })
  assert.deepEqual(pool.getStatus().accountUsage?.allTime.totals, { ...emptyUsageCounter(), requests: 1, rateLimited: 1 })
  pool.resetUsageStats()
  pool.dispose()
  const memory = new UsageStore({ persist: false, filePath })
  memory.load(); memory.reset(); memory.dispose()
  assert.deepEqual(readdirSync(dir), [])
  new UsageStore().reset()
  assert.deepEqual(readdirSync(dir), ['override.json'])
})

const gemini = 'gemini-4-neon', claude = 'claude-sonnet-5-5'
const fakeAgy = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
test('adapter and auxiliary turns attribute completions, no-usage turns, failures and charged refusal tokens to the right family/account', async t => {
  const dir = tempDir(t)
  const cfg = resolveConfig({ accounts: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
    modelAccountRouting: { families: { claude: { accountId: 'one', fallback: 'strict' }, 'gemini-pro': { accountId: 'two', fallback: 'strict' } } } })
  const accounts = new MultiAccountPool({ accounts: cfg.accounts, modelRouting: cfg.modelAccountRouting })
  const filePath = path.join(dir, 'usage.json')
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => cfg, resolveBin: () => fakeAgy, accountProvider: accounts, usageStore: new UsageStore({ filePath }) })
  t.after(() => pool.dispose())
  const adapter = new AcpAdapter({ pool, runs: new AcpRunStore(), getConfig: () => cfg })
  const chat = async (model: string, text: string) => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: PROVIDER_ID, model, sessionId: 'chat',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }] } as GenerateOptions)) chunks.push(chunk)
    return chunks.find(c => c.type === 'finish')?.reason.kind
  }
  const auxiliary = (text: string) => pool.runAuxiliaryPrompt({ model: gemini, systemPromptAppend: '',
    systemFallbackBlock: { type: 'text', text: 'Review' }, prompt: [{ type: 'text', text }] })
  assert.equal(await chat(claude, 'hello'), 'stop')
  assert.equal(await chat(gemini, 'STDERR_NOISE_OK'), 'stop') // No usage in the result.
  await auxiliary('hello')
  assert.equal(await chat(gemini, 'RPC_ERR_RECOVERABLE'), 'error')
  assert.equal(await chat(claude, 'MIDTURN_NATIVE_ABORT'), 'aborted')
  // The transport may return a refusal with charged tokens, or reject with an explicit rate limit.
  const mock = t.mock.method(AcpClient.prototype, 'sessionPrompt', async () => ({ stopReason: 'refusal', usage: { inputTokens: 9, outputTokens: 2 } }))
  assert.equal(await chat(claude, 'hidden'), 'error')
  await assert.rejects(auxiliary('hidden'), /refusal/i)
  mock.mock.mockImplementation(async () => { throw new Error('HTTP 429 RESOURCE_EXHAUSTED') })
  assert.equal(await chat(claude, 'blocked'), 'error')
  const snapshot = pool.getStatus().accountUsage!
  const [one, two] = ['one', 'two'].map(id => snapshot.allTime.accounts.find(a => a.accountId === id)!)
  assert.deepEqual(one!.families, { claude: one!.totals })
  assert.deepEqual(two!.families, { 'gemini-pro': two!.totals })
  assert.deepEqual(one!.totals, { ...emptyUsageCounter(), requests: 1, failed: 1, rateLimited: 1,
    inputTokens: 500 + 10 + 9, outputTokens: 25 + 3 + 2, totalTokens: 525 + 13 + 11 })
  assert.deepEqual(two!.totals, { ...emptyUsageCounter(), requests: 2, failed: 2,
    inputTokens: 500 + 9, outputTokens: 25 + 2, totalTokens: 525 + 11 })
  pool.dispose()
  const reopened = new UsageStore({ filePath }); reopened.load()
  assert.deepEqual(reopened.getSnapshot().allTime, snapshot.allTime)
})

test('POST usage/reset authenticates and validates before clearing and publishing the complete new status', async t => {
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => resolveConfig(), resolveBin: () => null })
  t.after(() => pool.dispose())
  const routes = new Map<string, ExactRouteSpec['handler']>()
  let rejection: 401 | 403 | undefined = 401
  const dispose = registerAcpRoutes({ register(route) { routes.set(route.path, route.handler) } }, pool,
    { connection: { requestRejection: () => rejection } })
  t.after(dispose)
  const reset = routes.get('/plugins/agy-acp/usage/reset')!
  assert.ok(reset)
  const post = async (type: string, body: string) => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'content-type': type } }) as IncomingMessage
    let code = 0, text = ''
    const res = { writeHead(status: number) { code = status }, end(s: string) { text = s } } as unknown as ServerResponse
    const pending = reset(req, res)
    req.emit('data', Buffer.from(body)); req.emit('end'); await pending
    return { code, json: JSON.parse(text) }
  }
  pool.recordTurnUsage({ outputTokens: 3 }, { accountId: 'a', countRequest: true })
  let emitted: StatusSnapshot | undefined
  pool.on('status', value => { emitted = value })
  assert.equal((await post('text/plain', '{}')).code, 401)
  rejection = 403
  assert.equal((await post('application/json', '{}')).code, 403)
  rejection = undefined
  assert.equal((await post('text/plain', '{}')).code, 415)
  assert.equal((await post('application/json', '{')).code, 400)
  assert.equal((await post('application/json', '[]')).code, 400)
  assert.equal(pool.getStatus().accountUsage!.allTime.totals.requests, 1)
  const response = await post('application/json; charset=utf-8', '{}')
  assert.equal(response.code, 200)
  assert.equal(response.json.ok, true)
  for (const key of ['today', 'last7Days', 'allTime']) assert.deepEqual(response.json.status.accountUsage[key], { totals: emptyUsageCounter(), accounts: [] })
  assert.ok(emitted)
  assert.deepEqual(emitted.accountUsage, response.json.status.accountUsage)
  assert.equal(response.json.status.usageTotals.outputTokens, 0)
})
