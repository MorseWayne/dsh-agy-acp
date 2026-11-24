import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { RequestPermissionParams } from '../src/acp/protocol.ts'
import { resolveConfig } from '../src/common/config.ts'
import { hostPermissions } from '../src/runtime/host-permissions.ts'
import { decidePermission, type SessionPolicy } from '../src/runtime/permission-manager.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

const ask = async () => 'allowed-once'
const req = (kind: string, paths?: string[]): RequestPermissionParams => ({ sessionId: 's',
  toolCall: { toolCallId: '1', sessionUpdate: 'tool_call', kind, locations: paths?.map(path => ({ path })) },
  options: [{ optionId: 'ok', kind: 'allow_once', name: 'OK' }, { optionId: 'no', kind: 'reject_once', name: 'No' }],
})
const outcome = (id: string) => ({ outcome: { outcome: 'selected', optionId: id } })
const ro: SessionPolicy = { sessionId: 's', mode: 'read-only', approval: 'ask', workspaceRoot: process.cwd(), preset: 'read-only' }
const ws: SessionPolicy = { ...ro, mode: 'workspace-write', preset: 'workspace-write' }
const signal = () => new AbortController().signal

test('read-only refuses commands, writes and unknown operations; workspace edits require known local targets or a host decision', async () => {
  const neverAsk = async () => { assert.fail('unexpected approval request') }
  for (const kind of ['execute', 'edit', 'move', 'delete', 'other']) {
    assert.deepEqual(await decidePermission(req(kind), () => ro, neverAsk, signal()), outcome('no'))
  }
  assert.deepEqual(await decidePermission(req('read'), () => ro, neverAsk, signal()), outcome('ok'))
  assert.deepEqual(await decidePermission(req('edit', ['src/example']), () => ws, neverAsk, signal()), outcome('ok'))
  let asked = 0
  for (const paths of [undefined, ['../outside'], ['inside', '../outside']]) {
    assert.deepEqual(await decidePermission(req('edit', paths), () => ws, async () => { asked++; return 'unavailable' }, signal()), outcome('no'))
  }
  assert.equal(asked, 3)
})

test('changing policy or cancelling a pending host approval invalidates a late allowed-once', async () => {
  for (const change of ['cancel', 'switch']) {
    const ac = new AbortController()
    let policy = ws
    const answer = Promise.withResolvers<string>()
    const waiting = decidePermission(req('execute'), () => policy, () => answer.promise, ac.signal)
    if (change === 'cancel') ac.abort(); else policy = ro
    answer.resolve('allowed-once')
    assert.deepEqual(await waiting, outcome('no'))
  }
})

test('full access grants once; auto does not grant a residual request automatically, never does not mean approve', async () => {
  const full = fakeHost.readPolicy('s')
  const auto: SessionPolicy = { ...full, preset: 'auto', approval: 'ask' }
  assert.deepEqual(await decidePermission(req('execute'), () => full, async () => 'rejected', signal()), outcome('ok'))
  assert.deepEqual(await decidePermission(req('execute'), () => auto, async () => 'rejected', signal()), outcome('no'))
  assert.deepEqual(await decidePermission(req('execute'), () => ({ ...auto, approval: 'never' }), ask, signal()), outcome('no'))
  assert.deepEqual(await decidePermission({ ...req('edit'), options: [{ optionId: 'all', kind: 'allow_always', name: 'Always' }] }, () => full, ask, signal()), { outcome: { outcome: 'cancelled' } })
})

test('host delegates to owning agent, refuses missing ownership and fails closed on partial confinement', async () => {
  const agent = { session: { id: 's' } }
  const host: Parameters<typeof hostPermissions>[0] = {
    agents: { get: id => id === 's' ? agent : undefined }, sandboxPolicy: { resolve: () => ws }, permissionPresets: { current: () => ws.preset },
    approval: { config: { policy: 'ask' }, overrideOf: () => undefined, request: async r => { assert.equal(r.agent, agent); assert.match(r.reason, /execute/); return 'allowed-once' } },
  }
  const adapter = hostPermissions(host)
  assert.throws(() => adapter.readPolicy('other'), /No live DSH/)
  assert.deepEqual(await adapter.onPermission(req('execute'), 's', signal()), outcome('ok'))
  for (const enforcement of ['partial', 'full']) {
    host.sandbox = { confine: async (argv, policy) => { assert.equal(policy.sessionId, 's'); return { enforcement, argv: ['runner', ...argv] } } }
    const launch = adapter.prepareArgv(['agy', 'acp'], ws)
    if (enforcement === 'partial') await assert.rejects(launch, /refusing/)
    else assert.deepEqual(await launch, ['runner', 'agy', 'acp'])
  }
})

test('two sessions with colliding native IDs remain isolated and tightening invalidates only its owner', async () => {
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => resolveConfig({}),
    resolveBin: () => fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url)),
    readPolicy: key => key === 'readonly' ? { ...ro, sessionId: key } : fakeHost.readPolicy(key),
  })
  try {
    const [a, b] = await Promise.all(['readonly', 'full'].map(k => pool.getOrCreateSession(k, path.resolve('.'))))
    assert.ok(a && b)
    assert.equal(a.session.acpSessionId, b.session.acpSessionId)
    assert.notEqual(a.client, b.client)
    const turns = [pool.beginPrompt(a.session), pool.beginPrompt(b.session)]
    const aSignal = pool.activeSignal('readonly')!, bSignal = pool.activeSignal('full')!
    pool.invalidate('full')
    assert.equal(bSignal.aborted, true)
    assert.equal(aSignal.aborted, false)
    assert.equal(b.client.isRunning, false)
    assert.throws(() => pool.beginPrompt(b.session), /changed/)
    turns.forEach(t => t.finish())
  } finally { pool.dispose() }
})
