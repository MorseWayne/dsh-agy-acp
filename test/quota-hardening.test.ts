import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { buildAccountEnv, classifyModelFamily, MultiAccountPool } from '../src/runtime/account-pool.ts'
import { mapQuotaGroupsToFamilies, parseDirectModelsQuota, parseDirectQuotaSummary, readDirectAccountQuota } from '../src/runtime/account-quota.ts'
import { fetchViaEnvProxy } from '../src/runtime/egress-guard.ts'
import { createPrivateProcessTemp, hasPrivateTmpMount } from '../src/runtime/session-cleanup.ts'

const unix = process.platform !== 'win32'
const fixture = (t: TestContext) => {
  const parent = realpathSync(os.tmpdir())
  const root = mkdtempSync(path.join(parent, 'quota-fixture-'))
  const expected = lstatSync(root)
  t.after(() => {
    const actual = lstatSync(root)
    assert.equal(path.dirname(realpathSync(root)), parent)
    assert.equal(expected.ino, actual.ino); assert.equal(expected.dev, actual.dev)
    rmSync(root, { recursive: true })
  })
  const home = path.join(root, 'account')
  const dir = path.join(home, '.gemini', 'antigravity-acp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'antigravity-oauth-token')
  const env = { HOME: home, USERPROFILE: home, SSH_CONNECTION: 'fixture', GEMINI_HOME: path.join(home, '.gemini') }
  const put = (expiry: string | undefined, access = 'test.fake_bearer') => writeFileSync(file, JSON.stringify({ token: { access_token: access, expiry } }), { mode: 0o600 })
  return { root, home, dir, file, env, put }
}
const fresh = () => new Date(Date.now() + 3_600_000).toISOString()
const summary = { groups: [{ displayName: 'external label', buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.71 }] }] }
const signal = new AbortController().signal

test('direct probe reads only an unambiguous, unexpired private CLI sign-in; no real network', { skip: !unix }, async t => {
  const f = fixture(t)
  const calls: string[] = []
  const fetcher: typeof fetchViaEnvProxy = async request => {
    calls.push(request.url)
    assert.deepEqual(request.env, {}); assert.equal(request.method, 'POST')
    assert.equal(request.headers?.Authorization, 'Bearer test.fake_bearer'); assert.equal(request.body, '{}')
    return { statusCode: 200, body: JSON.stringify(summary) }
  }
  const probe = (accountHome = f.home) => readDirectAccountQuota(f.env, signal, { accountHome, fetcher })
  for (const expiry of [undefined, 'not-a-time', '2099-01-01', new Date(Date.now() - 60_000).toISOString()]) {
    f.put(expiry); assert.equal(await probe(), null)
  }
  f.put(fresh(), 'unsafe\r\nheader'); assert.equal(await probe(), null)
  f.put(fresh()); assert.equal(await probe(f.root), null)
  assert.equal(await readDirectAccountQuota(undefined, signal, { accountHome: f.home, fetcher }), null)
  assert.equal(await readDirectAccountQuota(f.env, signal, { fetcher }), null)
  assert.equal(await readDirectAccountQuota({ ...f.env, GEMINI_API_KEY: 'redacted' }, signal, { accountHome: f.home, fetcher }), null)
  const alternate = path.join(f.dir, 'acp_token.json'); writeFileSync(alternate, 'not to be opened')
  assert.equal(await probe(), null); unlinkSync(alternate)
  chmodSync(f.file, 0o644); assert.equal(await probe(), null); chmodSync(f.file, 0o600)
  assert.deepEqual(calls, [])
  assert.deepEqual(await probe(), [{ name: 'Claude & GPT (shared)', sevenDay: { remainingFraction: 0.71 } }])
  assert.deepEqual(calls.sort(), ['https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'])
})

test('direct quota accepts a private CLI token alone and rejects competing ACP and CLI tokens without egress', { skip: !unix }, async t => {
  const f = fixture(t)
  const cliDir = path.join(f.home, '.gemini', 'antigravity-cli')
  mkdirSync(cliDir, { mode: 0o700 })
  const cliFile = path.join(cliDir, 'antigravity-oauth-token')
  writeFileSync(cliFile, JSON.stringify({ token: { access_token: 'test.cli_bearer', expiry: fresh() } }), { mode: 0o600 })
  const info = lstatSync(cliFile)
  assert.ok(info.isFile() && !info.isSymbolicLink())
  assert.equal(info.uid, process.getuid!())
  assert.equal(info.mode & 0o777, 0o600)
  assert.equal(existsSync(f.file), false)

  const fetcher = t.mock.fn<typeof fetchViaEnvProxy>(async () => ({ statusCode: 200, body: JSON.stringify(summary) }))
  const probe = () => readDirectAccountQuota(f.env, signal, { accountHome: f.home, fetcher })
  assert.deepEqual(await probe(), [{ name: 'Claude & GPT (shared)', sevenDay: { remainingFraction: 0.71 } }])
  assert.deepEqual(fetcher.mock.calls.map(call => call.arguments[0].headers?.Authorization), [
    'Bearer test.cli_bearer', 'Bearer test.cli_bearer',
  ])

  f.put(fresh())
  fetcher.mock.resetCalls()
  assert.equal(await probe(), null)
  assert.equal(fetcher.mock.callCount(), 0)
})

test('redirect, rejection and conflicting daily/prod readings stop before trying model fallbacks', { skip: !unix }, async t => {
  const f = fixture(t); f.put(fresh())
  for (const statusCode of [302, 401, 403, 200]) {
    const calls: string[] = []
    const result = await readDirectAccountQuota(f.env, signal, { accountHome: f.home, fetcher: async req => {
      calls.push(req.url)
      const fraction = req.url.includes('daily-') ? 0 : 1
      return { statusCode, body: JSON.stringify({ buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: fraction }] }) }
    } })
    assert.equal(result, null)
    assert.ok(calls.length === 2 && calls.every(url => url.endsWith(':retrieveUserQuotaSummary')))
  }
})

test('shared token inode, symlinked file or parent cannot authorize a direct quota or quota lease', { skip: !unix }, async t => {
  const f = fixture(t); f.put(fresh())
  const outside = path.join(f.root, 'other-store'); mkdirSync(outside, { mode: 0o700 })
  const otherToken = path.join(outside, 'antigravity-oauth-token')
  renameSync(f.file, otherToken)
  const check = async () => {
    let calls = 0
    assert.equal(await readDirectAccountQuota(f.env, signal, { accountHome: f.home, fetcher: async () => { calls++; throw Error('offline') } }), null)
    assert.equal(calls, 0)
    const pool = new MultiAccountPool({ accounts: [{ id: 'a', homeDir: f.home, env: f.env }] })
    await assert.rejects(pool.acquireQuotaLease('a'), /未隔离/); pool.dispose()
  }
  symlinkSync(otherToken, f.file); await check(); unlinkSync(f.file)
  linkSync(otherToken, f.file); await check(); unlinkSync(f.file)
  const saved = path.join(f.home, '.gemini', 'owned-dir'); renameSync(f.dir, saved); symlinkSync(outside, f.dir)
  await check()
})

test('t3code summary timing, variant buckets, shared 3p and durationless legacy model windows', () => {
  const now = Date.now(); const resetTime = new Date(now + 5 * 3_600_000).toISOString()
  const groups = parseDirectQuotaSummary({ buckets: [
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime },
    { bucketId: 'gemini-argon-5h', window: '5h', remainingFraction: 0 },
    ...summary.groups[0]!.buckets,
    { bucketId: 'ignored-5h', remainingFraction: 0.2 }, { window: 'weekly', remainingFraction: 0 },
    { bucketId: 'disabled', disabled: true, window: 'weekly', remainingFraction: 0 },
  ] }, now)
  assert.deepEqual(groups, [{ name: 'Gemini Models', fiveHour: { remainingFraction: 1 } },
    { name: 'Gemini Argon', fiveHour: { remainingFraction: 0 } }, { name: 'Claude & GPT (shared)', sevenDay: { remainingFraction: 0.71 } }])
  const mapping = mapQuotaGroupsToFamilies(groups)
  assert.deepEqual(mapping.claude, mapping.gpt); assert.equal(mapping.other, undefined); assert.equal(classifyModelFamily('gpt-oss-120b'), 'gpt')
  assert.equal(mapping['gemini-pro']?.fiveHour?.remainingFraction, 1)
  assert.deepEqual(parseDirectModelsQuota({ models: { 'claude-test': { quotaInfo: { remainingFraction: 0 } }, 'gpt-test': { weeklyQuotaInfo: { remainingFraction: 0 } } } }),
    [{ name: 'GPT Models', sevenDay: { remainingFraction: 0 } }])
})

test('authenticated transport rejects any non-allowlisted URL before opening a socket', async () => {
  for (const url of ['http://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', 'https://evil.invalid/v1internal:retrieveUserQuotaSummary', 'https://cloudcode-pa.googleapis.com/oauth2/token']) {
    await assert.rejects(fetchViaEnvProxy({ url, headers: { authorization: 'Bearer test' } }), /不允许/)
  }
})

test('isolated environment drops ambient account stores and API keys, respects explicit CA settings', t => {
  for (const [k, v] of Object.entries({ GEMINI_API_KEY: 'host-test', ANTIGRAVITY_APP_DATA_DIR: '/host-only', GEMINI_HOME: '/host' })) {
    const previous = process.env[k]; process.env[k] = v
    t.after(() => { if (previous === undefined) delete process.env[k]; else process.env[k] = previous })
  }
  const f = fixture(t)
  const env = buildAccountEnv({ id: 'a', homeDir: f.home, env: { SSL_CERT_FILE: '/configured/cert', HTTPS_PROXY: 'http://proxy.invalid' } })!
  assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.ANTIGRAVITY_APP_DATA_DIR, undefined)
  assert.equal(env.GEMINI_HOME, path.join(f.home, '.gemini')); assert.equal(env.XDG_STATE_HOME, path.join(f.home, '.local/state'))
  assert.equal(env.SSL_CERT_FILE, '/configured/cert'); assert.match(env.NO_PROXY!, /localhost/)
})

test('cleanup accepts only its pinned per-process root, never caller TMP or a replacement', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t); const keep = path.join(f.root, 'keep'); writeFileSync(keep, 'preserved')
  const temp = createPrivateProcessTemp({ TMPDIR: f.root }); const dir = temp.env.TMPDIR!
  assert.notEqual(dir, f.root); assert.equal(lstatSync(dir).mode & 0o777, 0o700)
  mkdirSync(path.join(dir, 'nested')); writeFileSync(path.join(dir, 'nested', 'owned'), 'data'); symlinkSync(f.root, path.join(dir, 'outside'))
  assert.equal(temp.cleanup(), true); assert.equal(temp.cleanup(), false); assert.equal(existsSync(dir), false); assert.equal(readFileSync(keep, 'utf8'), 'preserved')
  const swapped = createPrivateProcessTemp(); const pathBefore = swapped.env.TMPDIR!
  const moved = path.join(f.root, 'moved'); renameSync(pathBefore, moved); symlinkSync(f.root, pathBefore)
  try { assert.equal(swapped.cleanup(), false); assert.equal(readFileSync(keep, 'utf8'), 'preserved') }
  finally { assert.ok(lstatSync(pathBefore).isSymbolicLink()); unlinkSync(pathBefore) }

  // Under bwrap --tmpfs /tmp, host /tmp/dsh-agy-* is hidden by the fresh tmpfs mount.
  const bwrapArgv = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--', '/usr/local/bin/agy', 'acp']
  assert.equal(hasPrivateTmpMount(bwrapArgv, '/tmp'), true)
  assert.equal(hasPrivateTmpMount(['/usr/local/bin/agy', 'acp', '--tmpfs', '/tmp'], '/tmp'), false)
  assert.equal(hasPrivateTmpMount(['bwrap', '--ro-bind', '/', '/', '--', 'agy', '--tmpfs', '/tmp'], '/tmp'), false)
  const sandboxed = createPrivateProcessTemp({ TMPDIR: f.root }, { argv: bwrapArgv })
  assert.equal(sandboxed.env.TMPDIR, '/tmp')
  assert.equal(sandboxed.env.TMP, '/tmp')
  assert.equal(sandboxed.env.TEMP, '/tmp')
  assert.equal(sandboxed.cleanup(), false)
})
