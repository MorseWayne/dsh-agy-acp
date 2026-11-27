import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/common/config.ts'
import { PROVIDER_ID } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { MultiAccountPool } from '../src/runtime/account-pool.ts'
import { SessionIndex } from '../src/runtime/session-index.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

const fakeAgy = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
const gemini = 'gemini-4-neon'
const claude = 'claude-sonnet-5-5'

test('same conversation switches process, disk identity and MCP bridge only across runnable account bindings', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-model-route-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = resolveConfig({
    modelAccountRouting: { models: { [claude]: { accountId: 'two' }, [`${gemini}-high`]: { accountId: 'two' } } },
    accounts: ['one', 'two'].map(id => ({ id, env: { FAKE_SESSION_STORE_FILE: path.join(dir, `${id}.json`) } })),
  })
  const accountPool = new MultiAccountPool({ accounts: cfg.accounts, preferredAccountId: 'one', modelRouting: cfg.modelAccountRouting })
  const events: string[] = []
  let bridge = 0
  const sessionIndex = new SessionIndex({ filePath: path.join(dir, 'index.json') })
  const pool = new AcpSessionPool({ ...fakeHost, accountProvider: accountPool, getConfig: () => cfg, resolveBin: () => fakeAgy, sessionIndex,
    getMcpServers: async key => {
      events.push(`open-${++bridge}:${key}`)
      return [{ type: 'http', name: `bridge-${bridge}`, url: `http://127.0.0.1/mock/${bridge}` }]
    },
    onSessionClosed: key => { events.push(`close-${bridge}:${key}`) },
  })
  t.after(() => pool.dispose())
  const open = (model: string) => pool.getOrCreateSession('chat', process.cwd(), model)
  const first = await open(gemini)
  assert.ok(first.created && first.session.hasMcpServers)
  assert.equal(first.session.accountId, 'one')
  assert.ok(existsSync(path.join(dir, 'one.json')))
  const second = await open(claude)
  assert.ok(second.created && !second.session.resumed && second.session.hasMcpServers)
  assert.equal(second.session.accountId, 'two')
  assert.ok(existsSync(path.join(dir, 'two.json')), 'the mock subprocess used the second account environment')
  assert.ok(!first.client.isRunning && second.client.isRunning)
  assert.notEqual(first.client.pid, second.client.pid)
  assert.equal(sessionIndex.get('chat')?.accountId, 'two')
  assert.deepEqual(events, ['open-1:chat', 'close-1:chat', 'open-2:chat'])

  const alias = `${gemini}-high`
  const same = await open(alias)
  assert.equal(same.client, second.client)
  assert.equal(same.created, false)
  await pool.syncSessionOptions(same.client, same.session, { model: alias })
  assert.equal(same.session.currentModel, gemini, 'upstream canonical ID differs from routed model alias')
  const turn = pool.beginPrompt(same.session)
  pool.switchActiveAccount('one')
  turn.finish()
  assert.ok(second.client.isRunning, 'changing global primary must not retire an explicitly routed active turn')
  assert.equal(events.length, 3)

  const back = await open(gemini)
  assert.equal(back.created, true)
  assert.equal(back.session.accountId, 'one')
  assert.equal(second.client.isRunning, false)
  assert.deepEqual(events.slice(3), ['close-2:chat', 'open-3:chat'])
  accountPool.reportFailure('two', claude, 'HTTP 429')
  const fallback = await open(claude)
  assert.equal(fallback.created, false)
  assert.equal(fallback.client, back.client, 'healthy shared session is kept while target cools down')
  assert.equal(events.length, 5)
  accountPool.clearCooldown('two')
  const recovered = await open(claude)
  assert.equal(recovered.created, true)
  assert.equal(recovered.session.accountId, 'two')
  assert.equal(back.client.isRunning, false)
})

for (const scenario of ['strict-429', 'strict-geo', 'auto-429', 'auto-tos'] as const) {
  test(`adapter obeys model binding for ${scenario}`, async t => {
    const strict = scenario.startsWith('strict')
    const force = scenario.endsWith('429') ? 'FAKE_FORCE_429' : scenario.endsWith('geo') ? 'FAKE_FORCE_GEO_400' : 'FAKE_FORCE_TOS'
    const cfg = resolveConfig({
      accounts: [{ id: 'primary', env: { [force]: '1' } }, { id: 'spare', env: { FAKE_ACCOUNT_TAG: 'spare' } }],
      modelAccountRouting: { families: { 'gemini-pro': { accountId: 'primary', fallback: strict ? 'strict' : 'auto' } } },
    })
    const accounts = new MultiAccountPool({ accounts: cfg.accounts, preferredAccountId: 'spare', modelRouting: cfg.modelAccountRouting })
    const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => cfg, resolveBin: () => fakeAgy, accountProvider: accounts })
    t.after(() => pool.dispose())
    const logs: string[] = []
    const adapter = new AcpAdapter({ pool, runs: new AcpRunStore(), getConfig: () => cfg, log: msg => logs.push(msg) })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: PROVIDER_ID, model: gemini, sessionId: 'chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as GenerateOptions)) chunks.push(chunk)
    const finish = chunks.find(c => c.type === 'finish')
    assert.ok(finish)
    if (scenario === 'auto-429') {
      assert.equal(finish.reason.kind, 'stop')
      assert.match(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /<spare>/)
    } else {
      assert.ok(finish.reason.kind === 'error')
      assert.match(finish.reason.failure.message, scenario === 'auto-tos' ? /TOS/ : scenario === 'strict-geo' ? /地域/ : /429/)
      assert.ok(!logs.some(s => s.includes('failing over')), 'never make a second attempt')
      assert.equal(accounts.getHealthSnapshots().find(a => a.id === 'spare')?.lastUsedAt, null)
      if (scenario === 'strict-429') assert.equal(pool.getStatus().sessions[0]?.accountId, 'primary', 'clean RPC error preserves process')
      if (scenario === 'auto-tos') assert.equal(accounts.getHealthSnapshots().find(a => a.id === 'primary')?.tosBlocked, true)
    }
  })
}
