import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { AcpClient } from '../src/acp/client.ts'
import type { AcpConfigOption, SessionNewResult } from '../src/acp/protocol.ts'
import { resolveConfig } from '../src/common/config.ts'
import { PROVIDER_ID } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { MultiAccountPool } from '../src/runtime/account-pool.ts'
import { mergeModelCatalog, modelCatalog, type ModelCatalog } from '../src/runtime/model-catalog.ts'
import { policyKey } from '../src/runtime/permission-manager.ts'
import { SessionIndex } from '../src/runtime/session-index.ts'
import { AcpSessionPool, type ManagedAcpSession } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

function selector(id: string, category: string, currentValue: string, ids: string[]): AcpConfigOption {
  return { id, category, name: category, type: 'select', currentValue, options: [{ groupId: 'group', name: 'Group', options: ids.map(value => ({ value, name: value })) }] }
}
const bases = ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5']
const variants = bases.flatMap(base => (['gemini-4-neon', 'gemini-4-hydrogen'].includes(base) ? ['high', 'xhigh', 'medium', 'low'] : ['medium', 'high', 'low']).map(e => `${base}-${e}`))
const standalone = ['gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon', 'gpt-oss-120b-medium']
const ids = [...variants, ...standalone]
function setup(): SessionNewResult {
  return { sessionId: 's', configOptions: [selector('engine', 'model', bases[0]!, [...bases, bases[0]!]), selector('thinking', 'thought_level', 'medium', ['low', 'medium', 'high', 'xhigh'])], models: { currentModelId: variants[0]!, availableModels: ids.map(modelId => ({ modelId, name: modelId })) } }
}
test('preserves all 27 CLI IDs, grouped base selectors, and independent orchestrators without guessing models', () => {
  const { models, routes } = modelCatalog(setup())
  assert.equal(ids.length, 27)
  assert.deepEqual(new Set(models.map(m => m.value)), new Set([...ids, ...bases]))
  assert.equal(models.length, new Set(models.map(m => m.value)).size)
  assert.deepEqual(models.find(m => m.value === bases[0])?.efforts, ['low', 'medium', 'high', 'xhigh'])
  assert.equal(models.find(m => m.value === bases[0])?.nativeEffort, 'medium')
  assert.deepEqual(models.find(m => m.value === 'gemini-4-hydrogen-xhigh')?.efforts, ['xhigh'])
  assert.deepEqual(models.filter(m => !m.variantOf).map(m => m.value), [...bases, ...standalone])
  assert.deepEqual(models.find(m => m.value === 'claude-opus-5-5')?.efforts, ['low', 'medium', 'high'])
  assert.equal(models.find(m => m.value === 'claude-opus-5-5-high')?.variantOf, 'claude-opus-5-5')
  assert.equal(routes.get('gpt-oss-120b-medium')?.kind, 'legacy')
  assert.equal(routes.has('gpt-oss-120b'), false)
  assert.deepEqual(modelCatalog({ models: setup().models }).models.map(m => m.value), ids)
})

test('routes a fixed variant through the real config IDs and an independent legacy model through set_model', async t => {
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: resolveConfig, resolveBin: () => null })
  t.after(() => pool.dispose())
  const data = setup()
  const options = data.configOptions!
  const calls: unknown[] = []
  const client = {
    async sessionSetConfigOption(p: {configId: string; value: string}) {
      calls.push([p.configId, p.value]); options.find(o => o.id === p.configId)!.currentValue = p.value
      return { configOptions: options }
    },
    async request(method: string, params: unknown) { calls.push([method, params]) },
  } as unknown as AcpClient
  const session: ManagedAcpSession = { models: modelCatalog(data).models, modelRoutes: modelCatalog(data).routes, dshSessionKey: 'd', acpSessionId: 's', accountId: 'a', cwd: '.', currentModel: bases[0]!, currentEffort: 'medium', currentMode: '', configOptions: options, contextUsed: 0, contextSize: 0, lastActiveAt: 0 }
  const sync = pool.syncSessionOptions.bind(pool)
  await sync(client, session, {model: 'gemini-4-hydrogen-xhigh', effort: 'low'})
  await sync(client, session, {model: 'gemini-pro-orchestrator-argon', effort: 'medium'})
  assert.deepEqual(calls, [['engine', 'gemini-4-hydrogen'], ['thinking', 'xhigh'], ['session/set_model', { sessionId: 's', modelId: 'gemini-pro-orchestrator-argon' }]])
  await assert.rejects(sync(client, session, { model: bases[0], effort: 'impossible' }), /did not select reasoning effort/)
  const refusing = { sessionSetConfigOption: async () => ({ configOptions: options }) } as unknown as AcpClient
  await assert.rejects(sync(refusing, session, { model: bases[0], effort: 'low' }), /did not select reasoning effort/)
})

const neon = 'gemini-4-neon'
const carbon = 'gemini-4-carbon'
const carbonOptions = [
  { ...selector('engine', 'model', carbon, []), options: [
    { value: carbon, name: 'Gemini 4 Carbon (updated)' },
    { value: 'new-model', name: 'New Model' },
  ] },
  selector('thinking', 'thought_level', 'low', ['low', 'high']),
]

function assertNeonRetained(actual: ModelCatalog, original = modelCatalog(setup())) {
  for (const id of [neon, ...variants.filter(id => id.startsWith(`${neon}-`)), ...standalone]) {
    assert.deepEqual(actual.models.find(m => m.value === id), original.models.find(m => m.value === id), id)
    assert.deepEqual(actual.routes.get(id), original.routes.get(id), id)
  }
}

test('partial snapshots preserve known routes and rename selectors; complete snapshots replace inventory without forgetting non-current levels', () => {
  const original = modelCatalog(setup())
  const partial = mergeModelCatalog(original, modelCatalog({ configOptions: carbonOptions }))
  assertNeonRetained(partial, original)
  assert.deepEqual(partial.models.find(m => m.value === carbon), {
    value: carbon, name: 'Gemini 4 Carbon (updated)', efforts: ['low', 'medium', 'high'], nativeEffort: 'low',
  })
  assert.deepEqual(partial.models.find(m => m.value === 'new-model'), { value: 'new-model', name: 'New Model', efforts: [] })
  assert.equal(original.models.find(m => m.value === carbon)?.nativeEffort, undefined, 'merge must not mutate its inputs')

  const complete = mergeModelCatalog(partial, modelCatalog({
    configOptions: [selector('engine', 'model', neon, [neon, carbon]), selector('thinking', 'thought_level', 'low', ['low'])],
    models: { currentModelId: neon, availableModels: [{ modelId: 'standalone-v2', name: 'Standalone' }] },
  }))
  assert.deepEqual(complete.models.map(m => [m.value, m.efforts, m.nativeEffort]), [
    [neon, ['low'], 'low'], [carbon, ['low', 'medium', 'high'], 'low'], ['standalone-v2', [], undefined],
  ])
  assert.deepEqual([...complete.routes.keys()], [neon, carbon, 'standalone-v2'])
})

function createCatalogHarness(t: TestContext, options: {
  full?: SessionNewResult
  restoredVia?: 'resume' | 'load'
} = {}) {
  const probeLaunches: string[] = []
  const { restoredVia, full = setup() } = options
  const key = 'catalog-session'
  const cwd = process.cwd()
  let sessionIndex: SessionIndex | undefined
  if (restoredVia) {
    const dir = mkdtempSync(join(tmpdir(), 'acp-catalog-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    sessionIndex = new SessionIndex({ filePath: join(dir, 'sessions.json') })
    sessionIndex.upsert({ dshSessionKey: key, acpSessionId: full.sessionId,
      accountId: 'default', cwd, policyFingerprint: policyKey(fakeHost.readPolicy(key)) })
  }
  const pool = new AcpSessionPool({
    ...fakeHost, getConfig: resolveConfig, resolveBin: () => process.execPath, sessionIndex,
    async prepareArgv(_argv, policy) {
      if (policy.sessionId === '__catalog__') probeLaunches.push(policy.sessionId)
      return [process.execPath, fileURLToPath(new URL('./fixtures/catalog-peer.mjs', import.meta.url)),
        JSON.stringify({ full, restoredVia, restored: carbonOptions, update: carbonOptions })]
    },
  })
  t.after(() => pool.dispose())
  const adapter = new AcpAdapter({ getConfig: resolveConfig, pool, runs: new AcpRunStore() })
  return { pool, adapter, probeLaunches, open: () => pool.getOrCreateSession(key, cwd) }
}

async function assertResolvedNeon(adapter: AcpAdapter) {
  const { reasoning } = await adapter.resolveModel(PROVIDER_ID, neon)
  assert.deepEqual(reasoning?.efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(reasoning?.defaultEffort, 'medium')
}

test('config_option_update preserves another model and its routes in the session and cache without extending the TTL', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const { pool, adapter, probeLaunches, open } = createCatalogHarness(t)
  const { client, session } = await open()
  now += 4 * 60_000
  await client.request('catalog_test/config_update')
  assert.equal(session.currentModel, carbon)
  assert.equal(session.currentEffort, 'low')
  assertNeonRetained({ models: session.models, routes: session.modelRoutes })
  const cached = await pool.refreshModels()
  for (const model of modelCatalog(setup()).models.filter(m => m.value === neon || m.variantOf === neon || standalone.includes(m.value))) {
    assert.deepEqual(cached.find(m => m.value === model.value), model)
  }
  await assertResolvedNeon(adapter)
  assert.equal(probeLaunches.length, 0, 'regression assertions must read the updated cache, not a new probe')

  now += 60_000 + 1
  await pool.refreshModels()
  assert.equal(probeLaunches.length, 1, 'partial notification must not extend the original TTL')
})

for (const restoredVia of ['resume', 'load'] as const) {
  test(`partial session/${restoredVia} inherits cached levels and routes`, async t => {
    const { pool, adapter, probeLaunches, open } = createCatalogHarness(t, { restoredVia })
    await pool.refreshModels()
    const { session } = await open()
    assert.equal(session.resumedVia, restoredVia)
    assert.equal(session.currentModel, carbon)
    assertNeonRetained({ models: session.models, routes: session.modelRoutes })
    await assertResolvedNeon(adapter)
    assert.equal(probeLaunches.length, 1, 'resolving the restored cache must not require another probe')
  })

  test(`cold partial session/${restoredVia} never suppresses complete discovery`, async t => {
    const { adapter, probeLaunches, open } = createCatalogHarness(t, { restoredVia })
    const { session } = await open()
    assert.equal(session.resumedVia, restoredVia)
    assert.equal(session.currentModel, carbon)
    await assertResolvedNeon(adapter)
    assert.equal(probeLaunches.length, 1)
  })
}

test('syncSessionOptions publishes thought levels learned only after selecting a model', async t => {
  const full = setup()
  full.models!.availableModels = full.models!.availableModels.filter(m => !m.modelId.startsWith(`${carbon}-`))
  const { pool, adapter, probeLaunches, open } = createCatalogHarness(t, { full })
  const { client, session } = await open()
  assert.equal((await adapter.resolveModel(PROVIDER_ID, carbon)).reasoning, undefined)
  const setConfig = t.mock.method(client, 'sessionSetConfigOption', async () => ({ configOptions: carbonOptions }))
  let updates = 0
  pool.on('models-updated', () => { updates++ })
  await pool.syncSessionOptions(client, session, { model: carbon })
  assert.deepEqual(setConfig.mock.calls.map(call => call.arguments[0]), [{ sessionId: session.acpSessionId, configId: 'engine', value: carbon }])
  const observed = session.models.find(m => m.value === carbon)
  assert.deepEqual(observed?.efforts, ['low', 'high'])
  assert.equal(observed?.nativeEffort, 'low')
  assert.deepEqual(pool.getStatus().models.find(m => m.value === carbon), observed)
  const { reasoning } = await adapter.resolveModel(PROVIDER_ID, carbon)
  assert.deepEqual(reasoning?.efforts.map(e => e.id), ['low', 'high'])
  assert.equal(reasoning?.defaultEffort, 'low')
  assert.equal(updates, 1)
  assert.equal(probeLaunches.length, 0)
})

test('prepared calls probe the strict target and never apply another account’s levels on dispatch', async t => {
  const first = setup()
  const second = setup()
  second.sessionId = 'account-two-session'
  second.configOptions![1] = selector('thinking', 'thought_level', 'low', ['low'])
  second.models!.availableModels = second.models!.availableModels.filter(m => !m.modelId.startsWith(`${neon}-`) || m.modelId === `${neon}-low`)
  const cfg = resolveConfig({ accounts: [first, second].map((full, i) => ({
    id: `account-${i + 1}`, env: { FAKE_CATALOG_PEER_SETUP: JSON.stringify({ full }) },
  })) })
  const accounts = new MultiAccountPool({ accounts: cfg.accounts, preferredAccountId: 'account-1' })
  let probeCount = 0
  const pool = new AcpSessionPool({
    ...fakeHost, accountProvider: accounts, getConfig: () => cfg, resolveBin: () => process.execPath,
    async prepareArgv(_argv, policy) {
      if (policy.sessionId === '__catalog__') {
        probeCount++
        assert.equal(policy.mode, 'read-only')
      }
      return [process.execPath, fileURLToPath(new URL('./fixtures/catalog-peer.mjs', import.meta.url))]
    },
  })
  t.after(() => pool.dispose())
  const adapter = new AcpAdapter({ getConfig: () => cfg, pool, runs: new AcpRunStore() })
  const current = await pool.getOrCreateSession('first', process.cwd(), neon)
  assert.equal(current.session.accountId, 'account-1')
  assert.ok(current.session.models.find(m => m.value === neon)?.efforts.includes('high'))

  accounts.setModelRouting({ models: { [neon]: { accountId: 'account-2', fallback: 'strict' } } })
  const strict = await adapter.prepareCall(PROVIDER_ID, neon)
  assert.deepEqual(strict.model.reasoning?.efforts.map(e => e.id), ['low'])
  assert.equal(probeCount, 1, 'must not reuse catalog metadata from account-1')

  accounts.setModelRouting({ models: { [neon]: { accountId: 'account-2' } } })
  await pool.forceRefreshModels() // The menu discovers with account-1. The model route selects account-2.
  const automatic = await adapter.prepareCall(PROVIDER_ID, neon)
  assert.ok(automatic.model.reasoning?.efforts.some(e => e.id === 'high'), 'provisional menu evidence')
  assert.equal(automatic.model.context, undefined)
  await assert.rejects(async () => {
    for await (const _ of automatic.stream({ provider: PROVIDER_ID, model: neon, sessionId: 'actual',
      reasoningEffort: ReasoningEffortId('high'), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    } as GenerateOptions)) { /* No prompt can be sent with unsupported high. */ }
  }, /did not select reasoning effort high/)
  assert.equal(pool.getStatus().sessions.find(s => s.dshSessionKey === 'actual')?.accountId, 'account-2')
  assert.equal(probeCount, 2, 'do not fan out to unrelated accounts')
})

test('strict account discovery and sessions leave the public model menu unchanged', async t => {
  const home = mkdtempSync(join(tmpdir(), 'acp-account-catalog-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const modelsA = [neon, carbon, 'gemini-4-hydrogen']
  const modelsB = [neon]
  const profile = (id: string, models: string[], efforts: string[]) => {
    const full: SessionNewResult = {
      sessionId: `${id}-session`,
      configOptions: [selector('engine', 'model', neon, models), selector('thinking', 'thought_level', efforts[0]!, efforts)],
      models: { currentModelId: neon, availableModels: models.map(modelId => ({ modelId, name: modelId })) },
    }
    return { id, homeDir: join(home, id), env: { FAKE_CATALOG_PEER_SETUP: JSON.stringify({ full }) } }
  }
  const cfg = resolveConfig({
    workspaceRoot: home,
    accounts: [profile('a', modelsA, ['medium', 'high']), profile('b', modelsB, ['low'])],
    modelAccountRouting: { models: { [neon]: { accountId: 'b', fallback: 'strict' } } },
  })
  const accounts = new MultiAccountPool({ accounts: cfg.accounts, preferredAccountId: 'a', modelRouting: cfg.modelAccountRouting })
  const pool = new AcpSessionPool({
    ...fakeHost, accountProvider: accounts, getConfig: () => cfg, resolveBin: () => process.execPath,
    readPolicy: key => ({ ...fakeHost.readPolicy(key), workspaceRoot: home }),
    prepareArgv: async () => [process.execPath, fileURLToPath(new URL('./fixtures/catalog-peer.mjs', import.meta.url))],
  })
  t.after(() => pool.dispose())
  const adapter = new AcpAdapter({ getConfig: () => cfg, pool, runs: new AcpRunStore() })
  const statusIds = () => pool.getStatus().models.map(m => m.value)
  const menuIds = async () => (await adapter.listModels(PROVIDER_ID)).map(m => m.id)
  const menuUpdates: string[][] = []
  pool.on('models-updated', () => menuUpdates.push(statusIds()))
  assert.deepEqual(await menuIds(), modelsA)
  const original = structuredClone(pool.getStatus().models)
  assert.deepEqual(original.map(m => m.value), modelsA)
  assert.deepEqual(original.find(m => m.value === neon)?.efforts, ['medium', 'high'])

  const statusUpdates: (typeof original)[] = []
  pool.on('status', (status: ReturnType<AcpSessionPool['getStatus']>) => statusUpdates.push(structuredClone(status.models)))
  const assertPublicMenuIsA = async () => {
    assert.deepEqual(pool.getStatus().models, original)
    assert.deepEqual(await menuIds(), modelsA)
    assert.deepEqual(menuUpdates, [modelsA], 'only public discovery should publish a menu update')
    for (const models of statusUpdates) assert.deepEqual(models, original)
  }
  const strict = await adapter.prepareCall(PROVIDER_ID, neon)
  assert.deepEqual(strict.model.reasoning?.efforts.map(e => e.id), ['low'])
  assert.equal(strict.model.reasoning?.defaultEffort, 'low')
  await assertPublicMenuIsA()

  const { session } = await pool.getOrCreateSession('strict-chat', home, neon)
  assert.equal(session.accountId, 'b')
  assert.deepEqual(session.models.map(m => m.value), modelsB)
  assert.equal(session.currentEffort, 'low')
  await assertPublicMenuIsA()

  // Once B is selected for ordinary discovery, its identical catalog can replace A's menu.
  pool.switchActiveAccount('b')
  await pool.forceRefreshModels()
  assert.deepEqual(await menuIds(), modelsB)
  assert.deepEqual(statusIds(), modelsB)
  assert.deepEqual(menuUpdates, [modelsA, modelsB])
})
