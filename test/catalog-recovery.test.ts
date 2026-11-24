import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveConfig } from '../src/common/config.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
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
