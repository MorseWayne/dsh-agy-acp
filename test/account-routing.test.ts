import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyModelFamily, compactModelAccountRouting, equalModelAccountRouting, MODEL_FAMILY_META, MODEL_FAMILY_ORDER, resolveModelAccountRoute, validateModelAccountRoutingInput } from '../src/common/account-routing.ts'
import { resolveConfig, validateConfigPatchInput } from '../src/common/config.ts'
import type { ModelAccountRoutingConfig } from '../src/common/types.ts'
import { MultiAccountPool } from '../src/runtime/account-pool.ts'

const target = { accountId: 'target' }
const model = 'claude-sonnet'

test('route keys and rules are validated before normalization (including nested prototype keys)', () => {
  const siblings = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`id-${i}`, target]))
  for (const k of ['__proto__', 'Prototype', ' CONSTRUCTOR ']) {
    for (const raw of [{ [k]: {} }, { families: { [k]: target } }, { models: { [k]: target } }, { models: { id: { ...target, [k]: 1 } } }]) {
      assert.equal(validateModelAccountRoutingInput(raw).ok, false)
    }
  }
  for (const raw of [[], 'auto', undefined, Object.create({ families: {} }), { families: [] }, { models: null },
    { families: { gemini: target } }, { models: siblings(65) }, { models: { id: target, ID: target } },
    ...['x'.repeat(129), ' ', '\nid', 'id\0'].map(k => ({ models: { [k]: target } })),
    ...[null, {}, [], { foo: 1 }, { accountId: 'x'.repeat(33) }, { accountId: 'bad id' }, { accountId: 'target\t' },
      { accountId: '_bad' }, { accountId: 123 }, { ...target, fallback: 'unknown' }, { ...target, fallback: null },
      { ...target, fallback: 'strict', label: '' }].map(rule => ({ models: { id: rule } })),
  ]) {
    assert.equal(validateModelAccountRoutingInput(raw).ok, false, JSON.stringify(raw))
    assert.equal(validateConfigPatchInput({ modelAccountRouting: raw }).ok, false)
  }
  for (const raw of [{ models: siblings(64) }, { models: { ['x'.repeat(128)]: target } }]) {
    assert.equal(validateModelAccountRoutingInput(raw).ok, true)
  }
})

test('resolution is case insensitive, exact before family, and explicit auto never strict', () => {
  const input: ModelAccountRoutingConfig = {
    families: { claude: { accountId: ' DEFAULT ', fallback: 'strict' } },
    models: { ' SonNet-X ': { accountId: ' AUTO ', fallback: 'strict' }, opus: { accountId: ' OTHER-1 ' } },
  }
  const expected = { families: { claude: { accountId: 'default', fallback: 'strict' } }, models: { opus: { accountId: 'other-1' }, 'sonnet-x': { accountId: 'auto' } } }
  assert.deepEqual(validateModelAccountRoutingInput(input), { ok: true, value: expected })
  assert.deepEqual(compactModelAccountRouting(input), expected)
  assert.ok(equalModelAccountRouting(input, expected as ModelAccountRoutingConfig))
  assert.ok(!equalModelAccountRouting(input, { families: { claude: target } }))
  assert.deepEqual(resolveModelAccountRoute(input, ' SONNET-X'), { source: 'model', key: 'sonnet-x', rule: { accountId: 'auto', fallback: 'auto' } })
  assert.deepEqual(resolveModelAccountRoute(input, 'Haiku'), { source: 'family', key: 'claude', rule: { accountId: 'default', fallback: 'strict' } })
  assert.deepEqual(resolveModelAccountRoute(input, 'OPUS'), { source: 'model', key: 'opus', rule: { accountId: 'other-1', fallback: 'auto' } })
  assert.equal(resolveModelAccountRoute(input, 'unmatched'), null)
  assert.deepEqual(MODEL_FAMILY_ORDER.map(f => classifyModelFamily(f)), MODEL_FAMILY_ORDER)
  assert.ok(MODEL_FAMILY_ORDER.every(f => MODEL_FAMILY_META[f].label && MODEL_FAMILY_META[f].description))
  for (const empty of [null, {}, { models: {}, families: {} }]) {
    assert.equal(compactModelAccountRouting(empty), undefined)
    assert.ok(equalModelAccountRouting(empty, undefined))
    assert.deepEqual(validateConfigPatchInput({ modelAccountRouting: empty }), { ok: true, patch: { modelAccountRouting: {} } })
    assert.ok(!Object.hasOwn(resolveConfig({ modelAccountRouting: empty }), 'modelAccountRouting'))
  }
})

function accounts(modelRouting?: ModelAccountRoutingConfig) {
  return new MultiAccountPool({ accounts: ['main', 'target', 'spare'].map(id => ({ id })), preferredAccountId: 'main', now: () => 10_000, modelRouting })
}
async function pick(pool: MultiAccountPool, modelId = model, key = 'chat', exclude?: Set<string>) {
  const lease = await pool.acquire(key, modelId, exclude)
  lease.release()
  return lease.accountId
}

test('global primary, explicit automatic rotation, family binding and model override', async () => {
  const pool = accounts({ families: { claude: target, gpt: { accountId: 'auto' } }, models: { [model]: { accountId: 'spare' } } })
  pool.updateQuota('main', 'gpt', { fiveHour: { remainingFraction: .1 } })
  pool.updateQuota('target', 'gpt', { sevenDay: { remainingFraction: .2 } })
  assert.equal(await pick(pool, 'unknown'), 'main')
  assert.equal(await pick(pool, 'haiku'), 'target')
  assert.equal(await pick(pool, model), 'spare')
  assert.equal(await pick(pool, 'gpt-5', 'fresh'), 'spare', 'explicit auto ignores global primary even without stickiness')
  pool.updateQuota('target', 'gpt', { sevenDay: { remainingFraction: 1 } })
  pool.updateQuota('spare', 'gpt', { sevenDay: { remainingFraction: .1 } })
  assert.equal(await pick(pool, 'gpt-5', 'fresh'), 'spare', 'explicit auto preserves healthy sticky binding')
  assert.equal(await pick(pool, 'gpt-5', 'fresh', new Set(['spare'])), 'target')
  pool.setModelRouting(undefined)
  assert.equal(await pick(pool), 'main', 'clearing rules restores global preference')
  pool.setPreferredAccount(null)
  assert.equal(await pick(pool, 'gpt-5'), 'target', 'without either preference quota ranking applies')
})

test('recheck strict binding and quarantine after a cross-process credential slot wait', async () => {
  for (const change of ['reroute', 'quarantine'] as const) {
    const grant = Promise.withResolvers<void>()
    const queued = Promise.withResolvers<void>()
    const released: string[] = []
    const pool = new MultiAccountPool({ accounts: [{ id: 'main' }, { id: 'target' }],
      modelRouting: { families: { claude: { ...target, fallback: 'strict' } } },
      slotManager: { async acquire(accountId) {
        queued.resolve()
        await grant.promise
        return { accountId, leaseId: 'slot', switched: true, release: async () => { released.push(accountId) } }
      } },
    })
    const pending = pool.acquire('chat', model)
    await queued.promise
    if (change === 'reroute') pool.setModelRouting({ families: { claude: { accountId: 'main', fallback: 'strict' } } })
    else pool.reportFailure('target', model, 'TOS_VIOLATION')
    grant.resolve()
    if (change === 'reroute') {
      const lease = await pending
      assert.equal(lease.accountId, 'main')
      lease.release()
      assert.deepEqual(released, ['target', 'main'])
    } else {
      await assert.rejects(pending, /严格锁定.*target.*TOS/)
      assert.deepEqual(released, ['target'])
    }
    assert.ok(pool.getHealthSnapshots().every(acc => acc.activeLeases === 0))
  }
})

const blockedCases: Array<[string, RegExp, (p: MultiAccountPool) => void, Set<string>?]> = [
  ['excluded', /排除/, () => {}, new Set(['target'])],
  ['missing', /不存在/, p => p.syncProfiles([{ id: 'main' }, { id: 'spare' }])],
  ['disabled', /停用/, p => p.syncProfiles([{ id: 'main' }, { id: 'spare' }, { id: 'target', enabled: false }])],
  ['429', /冷却/, p => p.reportFailure('target', model, 'HTTP 429')],
  ['5h quota', /配额耗尽/, p => p.updateQuota('target', 'claude', { fiveHour: { remainingFraction: 0 } })],
  ['7d quota', /配额耗尽/, p => p.updateQuota('target', 'claude', { sevenDay: { remainingFraction: 0, resetAt: 10_100 } })],
  ['geo', /地域熔断/, p => p.markGeoBlocked('target', 10_500)],
  ['TOS', /TOS.*隔离/, p => p.reportFailure('target', model, 'TOS_VIOLATION: HTTP 429')],
]
for (const [reason, diagnostic, block, excluded] of blockedCases) {
  test(`unavailable target (${reason}): strict fails closed, auto shares healthy quota`, async () => {
    const pool = accounts({ families: { claude: { ...target, fallback: 'strict' } } })
    assert.ok(pool.isStrictModelRoute(model))
    assert.equal(await pick(pool), 'target')
    block(pool)
    await assert.rejects(() => pick(pool, model, 'chat', excluded), (err: Error) => {
      assert.match(err.message, /claude-sonnet.*严格锁定.*target/)
      assert.match(err.message, diagnostic)
      return true
    })
    assert.equal(pool.shouldSwitchSessionAccount('main', model, excluded), true)
    pool.setModelRouting({ families: { claude: target } })
    assert.ok(!pool.isStrictModelRoute(model))
    pool.updateQuota('main', 'claude', { sevenDay: { remainingFraction: .25 } })
    assert.equal(await pick(pool, model, 'chat', excluded), 'spare', 'fallback must ignore global primary and respect ranking')
    assert.equal(pool.shouldSwitchSessionAccount('spare', model, excluded), false, 'no pointless cold start while target unavailable')
  })
}

test('session switching considers model-family health, recovery and exclusions, but does not rebalance healthy auto sessions', () => {
  let now = 10_000
  const pool = new MultiAccountPool({ now: () => now, accounts: [{ id: 'main' }, { id: 'target' }], preferredAccountId: 'main', modelRouting: {
    models: { [model]: target, gpt: { accountId: 'auto', fallback: 'strict' } },
  } })
  assert.equal(pool.shouldSwitchSessionAccount('target', '  '), false)
  assert.equal(pool.shouldSwitchSessionAccount('main', model), true)
  assert.equal(pool.shouldSwitchSessionAccount('main', model, new Set(['target'])), false)
  assert.equal(pool.shouldSwitchSessionAccount('target', model), false)
  assert.equal(pool.shouldSwitchSessionAccount('target', 'unknown'), true)
  assert.equal(pool.shouldSwitchSessionAccount('target', 'unknown', new Set(['main'])), false)
  assert.equal(pool.shouldSwitchSessionAccount('target', 'GPT'), false)
  assert.equal(pool.shouldSwitchSessionAccount('target', 'GPT', new Set(['target'])), true)
  pool.updateQuota('target', 'gpt', { fiveHour: { remainingFraction: 0, resetAt: now + 1 } })
  assert.equal(pool.shouldSwitchSessionAccount('target', 'GPT'), true)
  assert.equal(pool.shouldSwitchSessionAccount('main', model), true, 'different-family quota must not block')
  now++
  assert.equal(pool.shouldSwitchSessionAccount('target', 'GPT'), false)
})
