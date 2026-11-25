import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { RequestPermissionParams } from '../src/acp/protocol.ts'
import { resolveConfig } from '../src/common/config.ts'
import { hostPermissions } from '../src/runtime/host-permissions.ts'
import { decidePermission, extractEditTargets, formatApprovalReason, type SessionPolicy } from '../src/runtime/permission-manager.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { PROVIDER_ID } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
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

test('auxiliary prompt fails closed when read-only sandbox confinement is partial', async () => {
  const agent = { session: { id: 's' } }
  const host: Parameters<typeof hostPermissions>[0] = {
    agents: { get: id => id === 's' ? agent : undefined },
    sandboxPolicy: { resolve: () => ws },
    permissionPresets: { current: () => ws.preset },
    approval: { config: { policy: 'ask' }, overrideOf: () => undefined, request: async () => 'rejected' },
    sandbox: { confine: async (argv) => ({ enforcement: 'partial', argv: [...argv] }) },
  }
  const perms = hostPermissions(host)
  const pool = new AcpSessionPool({
    ...perms,
    egressGuard: fakeHost.egressGuard,
    getConfig: () => resolveConfig({}),
    resolveBin: () => fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url)),
  })
  try {
    await assert.rejects(
      pool.runAuxiliaryPrompt({
        sessionKey: 's',
        systemPromptAppend: 'no tools',
        systemFallbackBlock: { type: 'text', text: 'no tools' },
        prompt: [{ type: 'text', text: 'title please' }],
      }),
      /refusing unconfined startup/,
    )
  } finally {
    pool.dispose()
  }
})

test('workspace-write accepts safe rawInput paths, rejects multi-key/patch/symlink escapes, and never silently denies >8KB edits', async () => {
  const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-perm-'))
  const workDir = path.join(tmpBase, 'workspace')
  const outsideDir = path.join(tmpBase, 'outside')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret')
  const linkPath = path.join(workDir, 'escape-link')
  symlinkSync(outsideDir, linkPath)

  const wsLocal: SessionPolicy = {
    sessionId: 's',
    mode: 'workspace-write',
    approval: 'ask',
    workspaceRoot: workDir,
    preset: 'workspace-write',
  }
  const makeReq = (toolCall: Partial<RequestPermissionParams['toolCall']>): RequestPermissionParams => ({
    sessionId: 's',
    toolCall: { toolCallId: 't1', sessionUpdate: 'tool_call', kind: 'edit', name: 'edit_file', ...toolCall },
    options: [{ optionId: 'ok', kind: 'allow_once', name: 'OK' }, { optionId: 'no', kind: 'reject_once', name: 'No' }],
  })

  try {
    const neverAsk = async () => { assert.fail('should auto-allow safe workspace edit') }
    // 1. Safe edit with path only in rawInput (no locations) auto-allows even for large >10KB content
    assert.deepEqual(
      await decidePermission(
        makeReq({ rawInput: { Path: 'src/big.ts', Target: 'old', Replacement: 'x'.repeat(12_000) } }),
        () => wsLocal,
        neverAsk,
        signal(),
      ),
      outcome('ok'),
    )

    // 2. Conflicting locations (inside) + rawInput (outside) must fail-closed to ask
    let askedReasons: string[] = []
    const recordAsk = async (reason: string) => { askedReasons.push(reason); return 'rejected' }
    assert.deepEqual(
      await decidePermission(
        makeReq({ locations: [{ path: 'src/ok.ts' }], rawInput: { TargetFile: '../outside/secret.txt' } }),
        () => wsLocal,
        recordAsk,
        signal(),
      ),
      outcome('no'),
    )
    assert.equal(askedReasons.length, 1)

    // 3. Malformed array entry & suspicious patch key must fail-closed to ask
    assert.equal(extractEditTargets(makeReq({ rawInput: { paths: ['src/a.ts', 123] } })), null)
    assert.equal(extractEditTargets(makeReq({ rawInput: { Path: 'src/a.ts', patch: '--- a\n+++ /etc/passwd' } })), null)
    assert.equal(extractEditTargets(makeReq({ rawInput: { Path: 'src/a.ts', Target: '/etc/passwd' } })), null)

    // 4. Symlink inside workspace pointing outside must NOT auto-allow
    askedReasons = []
    assert.deepEqual(
      await decidePermission(
        makeReq({ rawInput: { Path: 'escape-link/secret.txt', Content: 'overwrite' } }),
        () => wsLocal,
        recordAsk,
        signal(),
      ),
      outcome('no'),
    )
    assert.equal(askedReasons.length, 1)

    // 5. Large >10KB edit in `auto` mode prompts with readable summary (NOT silent denial!)
    const autoPolicy: SessionPolicy = { ...wsLocal, preset: 'auto' }
    askedReasons = []
    assert.deepEqual(
      await decidePermission(
        makeReq({ rawInput: { Path: 'src/large.ts', Content: 'line\n'.repeat(3000) } }),
        () => autoPolicy,
        async (reason) => { askedReasons.push(reason); return 'allowed-once' },
        signal(),
      ),
      outcome('ok'),
    )
    assert.equal(askedReasons.length, 1)
    assert.match(askedReasons[0]!, /src\/large\.ts/)
    assert.match(askedReasons[0]!, /已截断预览/)

    // 6. Execute reason includes structured args and explicit truncation warning for >16KB commands
    const argsReason = formatApprovalReason(
      makeReq({ kind: 'execute', name: 'exec', rawInput: { command: 'bash', args: ['-c', 'rm -rf /tmp/x'], cwd: '/work' } }),
    )
    assert.match(argsReason, /bash \["-c","rm -rf \/tmp\/x"\]/)
    assert.match(argsReason, /\/work/)

    const hugeCmdReason = formatApprovalReason(
      makeReq({ kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'echo ' + 'z'.repeat(20_000) } }),
    )
    assert.match(hugeCmdReason, /命令超长已截断/)
  } finally {
    rmSync(tmpBase, { recursive: true, force: true })
  }
})

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of stream) items.push(item)
  return items
}

test('switching workspace-write to auto completes the active prompt before replacing its sandbox', async t => {
  let current = ws
  const launches: string[] = []
  const cfg = resolveConfig({})
  const pool = new AcpSessionPool({
    ...fakeHost, getConfig: () => cfg, readPolicy: () => current,
    resolveBin: () => fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url)),
    prepareArgv: async (argv, p) => { launches.push(p.mode); return argv },
    onPermission: async (request, _key, turnSignal, original) => {
      assert.equal(original.mode, 'workspace-write')
      assert.equal(current.preset, 'auto')
      return decidePermission(request, () => current, ask, turnSignal, original)
    },
  })
  t.after(() => pool.dispose())
  const first = await pool.getOrCreateSession('s', ws.workspaceRoot)
  let switched = false
  first.client.onAnyUpdate(() => {
    if (switched) return
    switched = true
    pool.policyChanged('s') // DSH publishes the preset and sandbox knobs separately
    current = { ...ws, mode: 'danger-full-access', preset: 'auto' }
    pool.policyChanged('s')
  })
  const adapter = new AcpAdapter({ pool, runs: new AcpRunStore(), getConfig: () => cfg })
  const send = (text: string) => collect(adapter.stream({
    provider: PROVIDER_ID, model: 'gemini-4-neon', sessionId: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  } as unknown as GenerateOptions))
  const chunks = await send('USE_TOOL')
  assert.deepEqual(chunks.filter(c => c.type === 'finish').map(c => c.reason.kind), ['stop'])
  assert.match(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /Command succeeded/)
  assert.equal(first.client.isRunning, false)
  assert.deepEqual(launches, ['workspace-write'])
  assert.ok((await send('follow up')).some(c => c.type === 'finish' && c.reason.kind === 'stop'))
  assert.deepEqual(launches, ['workspace-write', 'danger-full-access'])
})

test('an in-flight permission tightening is reported as an intentional stop', async t => {
  let current = ws
  const cfg = resolveConfig({})
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => cfg, readPolicy: () => current,
    resolveBin: () => fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url)) })
  t.after(() => pool.dispose())
  const { client } = await pool.getOrCreateSession('s', ws.workspaceRoot)
  client.onAnyUpdate(() => { current = ro; pool.policyChanged('s') })
  const adapter = new AcpAdapter({ pool, runs: new AcpRunStore(), getConfig: () => cfg })
  const chunks = await collect(adapter.stream({ provider: PROVIDER_ID, model: 'gemini-4-neon', sessionId: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'SLOW_CANCEL' }] }],
  } as unknown as GenerateOptions))
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish?.reason.kind === 'aborted')
  assert.match(finish.reason.failure?.message ?? '', /权限或工作目录已更改/)
  assert.equal(client.isRunning, false)
})

test('an old read-only denial and a new auto approval requirement both survive a deferred switch', async () => {
  const auto: SessionPolicy = { ...ws, mode: 'danger-full-access', preset: 'auto' }
  const unexpected = async () => assert.fail('a read-only turn cannot acquire execute permission')
  assert.deepEqual(await decidePermission(req('execute'), () => auto, unexpected, signal(), ro), outcome('no'))
  let asks = 0
  assert.deepEqual(await decidePermission(req('edit', ['src/example']), () => auto, async () => {
    asks++
    return 'rejected'
  }, signal(), ws), outcome('no'))
  assert.equal(asks, 1)
})
