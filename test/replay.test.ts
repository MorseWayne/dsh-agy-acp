import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpClient, AcpTimeoutError, type PermissionHandler } from '../src/acp/client.ts'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { linuxLeaderIdentity, spawnOwnedProcess } from '../src/acp/process-tree.ts'
import { supportsSessionResume } from '../src/acp/protocol.ts'
import { resolveConfig } from '../src/common/config.ts'
import { policyKey } from '../src/runtime/permission-manager.ts'
import { SessionIndex } from '../src/runtime/session-index.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

const file = (name: string) => fileURLToPath(new URL(`./fixtures/replay/${name}`, import.meta.url))
const prompt = { sessionId: 's', prompt: [{ type: 'text' as const, text: 'fixture' }] }
function open(t: TestContext, fixture: string, onPermission?: PermissionHandler) {
  const client = new AcpClient({ bin: process.execPath, args: [file('peer.mjs'), file(`${fixture}.ndjson`)],
    env: {}, clientInfo: { name: 'fixture', version: '0' }, onPermission })
  client.start()
  t.after(() => client.dispose())
  return client
}

// Protocol barriers (and a suite timeout purely as a failure guard), not OS scheduling delays.
test('recorded tool + approval: overlapping tools and human input do not burn the inactivity budget', { timeout: 10_000 }, async t => {
  const asked = Promise.withResolvers<void>()
  const allow = Promise.withResolvers<void>()
  const client = open(t, 'tool-approval', async () => {
    asked.resolve(); await allow.promise
    return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  })
  await client.initialize(); assert.equal((await client.sessionNew({ cwd: '/fixture', mcpServers: [] })).sessionId, 's')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const oneDone = Promise.withResolvers<void>()
  const text: string[] = []
  client.onSessionUpdate('s', u => {
    if ('status' in u && u.status === 'completed') oneDone.resolve()
    if (u.sessionUpdate === 'agent_message_chunk' && 'content' in u) text.push((u.content as {text:string}).text)
  })
  const result = client.sessionPrompt(prompt, 10)
  await asked.promise
  t.mock.timers.tick(1_000_000)
  allow.resolve()
  await oneDone.promise
  t.mock.timers.tick(1_000_000)
  await client.request('replay/advance')
  t.mock.timers.tick(9)
  await client.request('replay/advance')
  assert.deepEqual(await result, { stopReason: 'end_turn' })
  assert.deepEqual(text, ['Fixture complete.'])
})

test('idle watchdog rearms once on completion; another session cannot extend it', { timeout: 10_000 }, async t => {
  const client = open(t, 'idle')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = Promise.withResolvers<void>()
  client.onSessionUpdate('s', () => started.resolve())
  let expired = false
  const result = client.sessionPrompt(prompt, 10).catch(err => { assert.ok(err instanceof AcpTimeoutError); expired = true })
  await started.promise
  t.mock.timers.tick(1000)
  await client.request('replay/advance')
  assert.equal(expired, false)
  t.mock.timers.tick(9)
  await client.request('replay/advance')
  assert.equal(expired, false)
  t.mock.timers.tick(1)
  await result; assert.equal(expired, true)
})

test('session metadata updates do not extend the prompt inactivity timer', { timeout: 10_000 }, async t => {
  const client = open(t, 'idle-metadata')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sawFirst = Promise.withResolvers<void>()
  client.onSessionUpdate('s', () => sawFirst.resolve())
  let expired = false
  const result = client.sessionPrompt(prompt, 10).catch(err => { assert.ok(err instanceof AcpTimeoutError); expired = true })
  await sawFirst.promise
  t.mock.timers.tick(6)
  await client.request('replay/advance')
  assert.equal(expired, false)
  t.mock.timers.tick(4)
  await result; assert.equal(expired, true)
})

test('an orphaned tool cannot keep a prompt alive forever with duplicate in-progress frames', { timeout: 10_000 }, async t => {
  const client = open(t, 'orphaned-tool')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = Promise.withResolvers<void>()
  client.onSessionUpdate('s', () => started.resolve())
  let expired = false
  const result = client.sessionPrompt(prompt, 10).catch(reason => { expired = true; return reason as unknown })
  await started.promise
  t.mock.timers.tick(30 * 60_000 - 1)
  await client.request('replay/advance')
  assert.equal(expired, false)
  t.mock.timers.tick(1)
  assert.ok(await result instanceof AcpTimeoutError)
})

test('ignored cancel has a fixed deadline independent of approvals, tool updates, and duplicate cancel', { timeout: 10_000 }, async t => {
  const asked = Promise.withResolvers<void>()
  const client = open(t, 'stuck-cancel', () => { asked.resolve(); return new Promise(() => {}) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rejected = assert.rejects(client.sessionPrompt(prompt, 0), /cancel/i)
  await asked.promise
  client.sessionCancel('s')
  t.mock.timers.tick(1999)
  client.sessionCancel('s')
  await client.request('replay/advance')
  assert.equal(client.isRunning, true)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(client.isRunning, false)
})

test('resume accepts only true or an advertised capability object', () => {
  assert.equal(supportsSessionResume({ protocolVersion: 1, agentCapabilities: {
    sessionCapabilities: { resume: {} }, session_capabilities: { resume: false },
  } }), false)
  for (const key of ['sessionCapabilities', 'session_capabilities']) {
    for (const [value, expected] of [[false, false], [null, false], ['', false], [[], false], [{}, true], [true, true]] as const) {
      assert.equal(supportsSessionResume({ protocolVersion: 1, agentCapabilities: { [key]: { resume: value } } }), expected)
    }
  }
})

test('late allow cannot escape cancellation; acknowledged cancel leaves process usable', { timeout: 10_000 }, async t => {
  const asked = Promise.withResolvers<void>(); const allow = Promise.withResolvers<void>()
  const client = open(t, 'permission-cancel', async () => {
    asked.resolve(); await allow.promise
    return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = client.sessionPrompt(prompt, 10)
  await asked.promise
  t.mock.timers.tick(10_000_000)
  client.sessionCancel('s'); allow.resolve()
  assert.equal((await result).stopReason, 'cancelled')
  t.mock.timers.tick(10_000)
  assert.equal((await client.sessionPrompt(prompt)).stopReason, 'end_turn')
})

test('parse and require Linux process-group leader identity with tricky comm and full-width starttime', () => {
  const stat = ['S', 1, 12, 12, ...Array(15).fill(0), '18446744073709551615'].join(' ')
  assert.equal(linuxLeaderIdentity(`12 (a )\nb) ${stat}`, 12), '18446744073709551615')
  assert.equal(linuxLeaderIdentity(`12 (a) ${stat.replace(' 12 12 ', ' 99 12 ')}`, 12), undefined)
  assert.equal(linuxLeaderIdentity(`13 (a) ${stat}`, 12), undefined)
})

for (const useDelegation of [true, false]) test(`owned Linux process tree: ${useDelegation ? 'autodetect cgroup' : 'no delegation'}`,
  { skip: process.platform !== 'linux', timeout: 10_000 }, async t => {
    // stdout stays open until both processes exit. If not delegated, only exercise the
    // documented process-group fallback. Closing stdin in teardown is a separate safety net.
    const helper = `
      const {spawn} = require('node:child_process'); const {readFileSync} = require('node:fs');
      const ours = readFileSync('/proc/self/cgroup', 'utf8');
      const delegated = ours !== readFileSync('/proc/'+process.ppid+'/cgroup','utf8') && /\\/dsh-acp-[a-zA-Z0-9]+\\s*$/.test(ours);
      spawn(process.execPath, ['-e', 'process.stdin.resume(); console.log(' + delegated + ');'],
        { detached: delegated, stdio: ['inherit','inherit','inherit'] });
      process.stdin.resume();
    `
    const { child, stop } = spawnOwnedProcess(process.execPath, ['-e', helper], process.cwd(), {}, { useDelegation })
    t.after(() => { child.stdin.end(); stop() })
    const closed = once(child, 'close')
    const rl = createInterface({ input: child.stdout }); t.after(() => rl.close())
    const [line] = await once(rl, 'line')
    assert.match(line, /^(true|false)$/)
    if (!useDelegation) assert.equal(line, 'false')
    t.diagnostic(line === 'true' ? 'Kernel branch: delegated cgroup.kill + setsid worker' : 'Kernel branch: verified process group (no delegation)')
    stop(); stop()
    const [, signal] = await closed
    assert.equal(signal, 'SIGKILL')
  })

for (const mode of ['dispose', 'spawn-error', 'exit'] as const) {
  test(`close cleanup runs exactly once after ${mode}`, { timeout: 10_000 }, async () => {
    const barrier = Promise.withResolvers<void>(); let closes = 0
    const client = new AcpClient({ bin: process.execPath, env: {},
      ...(mode === 'spawn-error' ? { cwd: file('nonexistent-working-directory') } : {}),
      args: mode === 'dispose' ? ['-e', 'process.stdin.resume()'] : ['-e', ''],
      onClose: () => { closes++; barrier.resolve() },
    })
    try {
      client.start()
      if (mode === 'dispose') { client.dispose(); assert.equal(closes, 0) }
      await barrier.promise
      client.dispose(); assert.equal(closes, 1)
    } finally { client.dispose() }
  })
}

for (const [fixture, via, title] of [['resume', 'resume', 'resumed title'], ['resume-load', 'load', 'loaded title'],
  ['no-resume-new', undefined, undefined]] as const) {
  test(`offline wire negotiation: ${fixture}`, { timeout: 10_000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-replay-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const policy = { ...fakeHost.readPolicy('restore'), workspaceRoot: dir }
    const sessionIndex = new SessionIndex({ filePath: join(dir, 'index.json') })
    sessionIndex.upsert({ dshSessionKey: 'restore', acpSessionId: 'saved', accountId: 'default', cwd: dir, policyFingerprint: policyKey(policy) })
    const pool = new AcpSessionPool({ ...fakeHost, readPolicy: () => policy, getConfig: () => resolveConfig({ enabled: true }),
      resolveBin: () => process.execPath, prepareArgv: async () => [process.execPath, file('peer.mjs'), file(`${fixture}.ndjson`)], sessionIndex })
    t.after(() => pool.dispose())
    const { session, created } = await pool.getOrCreateSession('restore', dir)
    assert.equal(session.resumedVia, via); assert.equal(session.title, title)
    assert.equal(created, !via); assert.equal(session.acpSessionId, via ? 'saved' : 'fresh')
  })
}
