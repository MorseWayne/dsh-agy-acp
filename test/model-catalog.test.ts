import assert from 'node:assert/strict'
import test from 'node:test'
import type { AcpClient } from '../src/acp/client.ts'
import type { AcpConfigOption, SessionNewResult } from '../src/acp/protocol.ts'
import { modelCatalog } from '../src/runtime/model-catalog.ts'
import { AcpSessionPool, type ManagedAcpSession } from '../src/runtime/session-pool.ts'

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
  assert.equal(routes.get('gpt-oss-120b-medium')?.kind, 'legacy')
  assert.equal(routes.has('gpt-oss-120b'), false)
  assert.deepEqual(modelCatalog({ models: setup().models }).models.map(m => m.value), ids)
})

test('routes a fixed variant through the real config IDs and an independent legacy model through set_model', async () => {
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
  const session: ManagedAcpSession = { modelRoutes: modelCatalog(data).routes, dshSessionKey: 'd', acpSessionId: 's', accountId: 'a', cwd: '.', currentModel: bases[0]!, currentEffort: 'medium', currentMode: '', configOptions: options, contextUsed: 0, contextSize: 0, lastActiveAt: 0 }
  const sync = AcpSessionPool.prototype.syncSessionOptions
  await sync(client, session, {model: 'gemini-4-hydrogen-xhigh', effort: 'low'})
  await sync(client, session, {model: 'gemini-pro-orchestrator-argon', effort: 'medium'})
  assert.deepEqual(calls, [['engine', 'gemini-4-hydrogen'], ['thinking', 'xhigh'], ['session/set_model', { sessionId: 's', modelId: 'gemini-pro-orchestrator-argon' }]])
  assert.equal(session.currentModel, 'gemini-pro-orchestrator-argon')
})
