import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../src/common/config.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { MultiAccountPool } from '../src/runtime/account-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

// A fake CLI: no real credentials, network or account files are touched.
const printUsage = `console.log(JSON.stringify({event:'command_result',command:{name:'usage',data:{groups:[{name:process.env.TEST_LABEL || 'machine',buckets:[{window:'5h',remaining_fraction:0.4}]}]}}}))`
const testEnv = { SSH_CONNECTION: 'fixture', GEMINI_CLI_HOME: '', ANTIGRAVITY_APP_DATA_DIR: '', ANTIGRAVITY_GEMINI_DIR: '' }

test('manual refresh targets exactly the requested account, deduplicates, and preserves previous sample on failure', async t => {
  const cfg = resolveConfig({ accounts: ['a', 'b'].map(id => ({ id, homeDir: path.resolve(`fake-${id}`), env: { ...testEnv, TEST_LABEL: id } })) })
  const accounts = new MultiAccountPool({ accounts: cfg.accounts })
  accounts.reportFailure('b', 'claude', 'HTTP 429')
  let launches = 0
  let version = '1.5.16'
  let fail = false
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => cfg, resolveBin: () => 'mock-agy', accountProvider: accounts,
    async prepareArgv(argv, policy) {
      assert.equal(policy.mode, 'read-only')
      if (argv[1] === '--version') return [process.execPath, '-e', `console.log('agy ${version}')`]
      launches++
      assert.deepEqual(argv, ['mock-agy', '-p', '/usage', '--output-format', 'stream-json'])
      return [process.execPath, '-e', fail ? 'console.error("private"); process.exit(1)' : printUsage]
    } })
  t.after(() => pool.dispose())
  assert.equal(pool.getStatus().accounts[1]!.quota, undefined)
  await Promise.all([pool.refreshAccountQuota('b'), pool.refreshAccountQuota('b')])
  assert.equal(launches, 1)
  const [a, b] = pool.getStatus().accounts
  assert.equal(b?.quota?.groups[0]?.name, 'b')
  assert.equal(b?.quota?.groups[0]?.fiveHour?.remainingFraction, 0.4)
  assert.ok(b?.quota?.sampledAt)
  assert.ok(b.families.claude?.cooldownUntil)
  assert.equal(b.lastUsedAt, null)
  assert.equal(a?.quota, undefined)
  fail = true
  await assert.rejects(pool.refreshAccountQuota('b'), /查询失败/)
  await assert.rejects(pool.refreshAccountQuota('typo'), /未找到/)
  version = '1.4.99'
  await assert.rejects(pool.refreshAccountQuota('b'), /独立文件凭据模式/)
  pool.clearAccountCooldown('b')
  assert.deepEqual(pool.getStatus().accounts[1]?.quota, b.quota)
  assert.equal(launches, 2)
})

test('ambiguous account environments and disabled accounts cannot invoke the quota helper', async t => {
  const cfg = resolveConfig({ accounts: [{ id: 'proxy-only' }, { id: 'one', homeDir: '/shared', env: testEnv },
    { id: 'two', homeDir: '/shared', env: testEnv }, { id: 'off', enabled: false }] })
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => cfg, resolveBin: () => assert.fail('no probe'), accountProvider: new MultiAccountPool({ accounts: cfg.accounts }) })
  t.after(() => pool.dispose())
  for (const a of pool.getStatus().accounts) {
    assert.ok(a.quotaRefreshUnavailable)
    await assert.rejects(pool.refreshAccountQuota(a.id), { message: a.quotaRefreshUnavailable })
  }
})

test('default machine profile is visible before connection, and quota does not open an ACP session', async t => {
  const pool = new AcpSessionPool({ ...fakeHost, getConfig: () => resolveConfig(), resolveBin: () => 'fake',
    prepareArgv: async () => [process.execPath, '-e', printUsage] })
  t.after(() => pool.dispose())
  assert.equal(pool.getStatus().accounts[0]?.label, '本机默认账号')
  assert.equal(pool.getStatus().accounts[0]?.quota, undefined)
  await pool.refreshAccountQuota('default')
  assert.equal(pool.getStatus().connected, false)
  assert.equal(pool.getStatus().activeSessions, 0)
  assert.ok(pool.getStatus().accounts[0]?.quota?.groups.length)
})
