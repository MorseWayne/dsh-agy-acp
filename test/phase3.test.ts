import { fakeHost } from './fixtures/session-policy.ts'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/common/config.ts'
import { PROVIDER_ID } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import {
  classifyAccountError,
  classifyModelFamily,
  isQuotaOrRateLimitError,
  isTosViolationError,
  mergeLoopbackNoProxy,
  MultiAccountPool,
} from '../src/runtime/account-pool.ts'
import { CredentialSlotLeaseManager } from '../src/runtime/credential-lease.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGY_BIN = path.join(__dirname, 'fixtures', 'fake-agy.mjs')
chmodSync(FAKE_AGY_BIN, 0o755)

test('CredentialSlotLeaseManager supports same-account ref-counting and cross-account exclusion', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-agy-slot-'))
  const switches: string[] = []
  try {
    const mgr = new CredentialSlotLeaseManager({
      slotDir: dir,
      acquireTimeoutMs: 2_000,
      onSwitchAccount: (from, to) => {
        switches.push(`${from ?? 'none'}->${to}`)
      },
    })

    // Two concurrent leases for the same account share the slot without switching
    const l1 = await mgr.acquire('acct-a')
    const l2 = await mgr.acquire('acct-a')
    assert.equal(l1.switched, true)
    assert.equal(l2.switched, false)
    assert.equal(Object.keys(mgr.inspect().holders).length, 2)

    // Acquiring a different account waits until both ref-counted leases release
    let bAcquired = false
    const pendingB = mgr.acquire('acct-b').then((handle) => {
      bAcquired = true
      return handle
    })

    await new Promise((r) => setTimeout(r, 80))
    assert.equal(bAcquired, false)

    l1.release()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(bAcquired, false)

    l2.release()
    const lb = await pendingB
    assert.equal(bAcquired, true)
    assert.equal(lb.switched, true)
    assert.deepEqual(switches, ['none->acct-a', 'acct-a->acct-b'])

    lb.release()
    assert.equal(Object.keys(mgr.inspect().holders).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MultiAccountPool isolates HOME/env, tracks 5h+7d buckets, and cools down per model family', async () => {
  let fakeNow = 1_000_000
  const pool = new MultiAccountPool({
    now: () => fakeNow,
    baseCooldownMs: 30_000,
    accounts: [
      {
        id: 'acct-1',
        homeDir: '/tmp/agy-home-1',
        env: { ACCOUNT_MARKER: 'acct-1' },
      },
      {
        id: 'acct-2',
        homeDir: '/tmp/agy-home-2',
        env: { ACCOUNT_MARKER: 'acct-2' },
      },
    ],
  })

  assert.equal(classifyModelFamily('gemini-4-neon'), 'gemini-pro')
  assert.equal(classifyModelFamily('gemini-3.8-flash'), 'gemini-flash')
  assert.equal(classifyModelFamily('claude-sonnet-5-5'), 'claude')

  // First acquire picks acct-1 and injects isolated HOME + custom env
  const lease1 = await pool.acquire('sess-1', 'claude-sonnet-5-5')
  assert.equal(lease1.accountId, 'acct-1')
  assert.equal(lease1.env?.HOME, path.resolve('/tmp/agy-home-1'))
  assert.equal(lease1.env?.ACCOUNT_MARKER, 'acct-1')
  lease1.release()

  // 429 failure on claude cools down acct-1 ONLY for claude family and redacts secrets in lastError
  pool.reportFailure('acct-1', 'claude-sonnet-5-5', new Error('HTTP 429 RESOURCE_EXHAUSTED via https://u:p@proxy.local Authorization: Bearer secret123456'))
  const snapAfterErr = pool.getHealthSnapshots().find(a => a.id === 'acct-1')
  assert.ok(snapAfterErr?.lastError)
  assert.equal(snapAfterErr!.lastError!.includes('u:p'), false)
  assert.equal(snapAfterErr!.lastError!.includes('secret123456'), false)

  // Next claude request fails over to acct-2
  const leaseClaude = await pool.acquire('sess-1', 'claude-sonnet-5-5')
  assert.equal(leaseClaude.accountId, 'acct-2')
  assert.equal(leaseClaude.env?.ACCOUNT_MARKER, 'acct-2')
  leaseClaude.release()

  // Meanwhile acct-1 is STILL healthy for gemini-pro!
  pool.updateQuota('acct-2', 'gemini-pro', {
    fiveHour: { remainingFraction: 0.1, resetAt: fakeNow + 3600_000 },
  })
  pool.updateQuota('acct-1', 'gemini-pro', {
    fiveHour: { remainingFraction: 0.9, resetAt: fakeNow + 3600_000 },
    sevenDay: { remainingFraction: 0.8, resetAt: fakeNow + 7 * 86400_000 },
  })
  const leaseGemini = await pool.acquire('sess-2', 'gemini-4-neon')
  assert.equal(leaseGemini.accountId, 'acct-1')
  leaseGemini.release()

  // Exhaust acct-1 7d bucket -> falls back to acct-2
  pool.updateQuota('acct-1', 'gemini-pro', {
    sevenDay: { remainingFraction: 0, resetAt: fakeNow + 86400_000 },
  })
  const leaseAfter7d = await pool.acquire('sess-2', 'gemini-4-neon')
  assert.equal(leaseAfter7d.accountId, 'acct-2')
  leaseAfter7d.release()

  // After cooldown elapses, acct-1 recovers for claude
  fakeNow += 31_000
  const leaseRecovered = await pool.acquire('sess-3', 'claude-sonnet-5-5', new Set(['acct-2']))
  assert.equal(leaseRecovered.accountId, 'acct-1')
  leaseRecovered.release()

  pool.dispose()
})

test('AcpAdapter.stream() automatically fails over to secondary account on 429 quota error', async () => {
  const cfg = resolveConfig({
    enabled: true,
    requestTimeoutMs: 10_000,
    accounts: [
      { id: 'primary', env: { FAKE_FORCE_429: '1', FAKE_ACCOUNT_TAG: 'primary' } },
      { id: 'backup', env: { FAKE_ACCOUNT_TAG: 'backup' } },
    ],
  })

  const accountPool = new MultiAccountPool({ accounts: cfg.accounts })
  const runs = new AcpRunStore()
  const pool = new AcpSessionPool({
    ...fakeHost,
    getConfig: () => cfg,
    resolveBin: () => FAKE_AGY_BIN,
    accountProvider: accountPool,
  })
  const adapter = new AcpAdapter({
    getConfig: () => cfg,
    pool,
    runs,
  })

  try {
    const chunks: StreamChunk[] = []
    for await (const c of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello failover' }] } as Message],
      sessionId: 'dsh-failover-conv',
    } as unknown as GenerateOptions)) {
      chunks.push(c)
    }

    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.match(text, /^<backup> \[sess_1#1\] hello failover$/)
    assert.equal(pool.getStatus().sessions.find(s => s.dshSessionKey === 'dsh-failover-conv')?.accountId, 'backup')

    const finish = chunks.find((c) => c.type === 'finish')
    assert.ok(finish && finish.type === 'finish')
    assert.equal(finish.reason.kind, 'stop')

    // Primary account should now be in cooldown for gemini-pro
    const health = pool.getAccountHealthSnapshots()
    const primary = health.find((a) => a.id === 'primary')
    assert.ok(primary?.families['gemini-pro']?.cooldownUntil)
  } finally {
    pool.dispose()
  }
})

test('MultiAccountPool merges loopback NO_PROXY when proxy env is passed via account env', async () => {
  assert.equal(mergeLoopbackNoProxy(undefined), '127.0.0.1,localhost,::1')
  assert.equal(mergeLoopbackNoProxy('internal.corp,LOCALHOST,[::1]'), 'internal.corp,LOCALHOST,[::1],127.0.0.1')
  assert.equal(mergeLoopbackNoProxy('*'), '*')

  const pool = new MultiAccountPool({
    accounts: [
      {
        id: 'env-proxied',
        env: { HTTPS_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: 'corp.internal' },
      },
    ],
  })

  try {
    const env = pool.getAccountEnv('env-proxied')
    assert.equal(env?.HTTPS_PROXY, 'socks5://127.0.0.1:1080')
    assert.ok(env?.NO_PROXY?.includes('corp.internal'))
    assert.ok(env?.NO_PROXY?.includes('127.0.0.1'))
    assert.ok(env?.NO_PROXY?.includes('localhost'))
    assert.ok(env?.NO_PROXY?.includes('::1'))
    assert.equal(env?.no_proxy, env?.NO_PROXY)
  } finally {
    pool.dispose()
  }
})

test('TOS_VIOLATION takes precedence over quota/429, quarantines account, and halts automatic failover', async () => {
  const combinedErr = new Error('HTTP 403 TOS_VIOLATION: account suspended, quota 429 revoked')
  assert.equal(isTosViolationError(combinedErr), true)
  assert.equal(isQuotaOrRateLimitError(combinedErr), false)
  assert.equal(classifyAccountError(combinedErr), 'tos')
  assert.equal(isTosViolationError(new Error('Your account has been suspended due to policy')), true)
  assert.equal(isTosViolationError(new Error('HTTP 429 RESOURCE_EXHAUSTED')), false)

  const cfg = resolveConfig({
    enabled: true,
    requestTimeoutMs: 10_000,
    accounts: [
      { id: 'primary', env: { FAKE_FORCE_TOS: '1', FAKE_ACCOUNT_TAG: 'primary' } },
      { id: 'backup', env: { FAKE_ACCOUNT_TAG: 'backup' } },
    ],
  })

  const accountPool = new MultiAccountPool({ accounts: cfg.accounts })
  const runs = new AcpRunStore()
  const pool = new AcpSessionPool({
    ...fakeHost,
    getConfig: () => cfg,
    resolveBin: () => FAKE_AGY_BIN,
    accountProvider: accountPool,
  })
  const adapter = new AcpAdapter({
    getConfig: () => cfg,
    pool,
    runs,
  })

  try {
    const chunks: StreamChunk[] = []
    for await (const c of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'trigger tos' }] } as Message],
      sessionId: 'dsh-tos-conv',
    } as unknown as GenerateOptions)) {
      chunks.push(c)
    }

    // Must NOT have failed over to backup account!
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text, '')

    const finish = chunks.find((c) => c.type === 'finish')
    assert.ok(finish && finish.type === 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure?.message ?? '', /风控熔断/)
    assert.match(finish.reason.failure?.message ?? '', /TOS_VIOLATION/)

    const primaryHealth = pool.getAccountHealthSnapshots().find((a) => a.id === 'primary')
    const backupHealth = pool.getAccountHealthSnapshots().find((a) => a.id === 'backup')
    assert.equal(primaryHealth?.tosBlocked, true)
    assert.ok(primaryHealth?.tosBlockedAt)
    assert.equal(backupHealth?.lastUsedAt, null)

    // Primary stays excluded across all model families until manually cleared
    const leaseForClaude = await accountPool.acquire('other-sess', 'claude-sonnet-5-5')
    assert.equal(leaseForClaude.accountId, 'backup')
    leaseForClaude.release()

    // Manual clearCooldown lifts quarantine
    accountPool.clearCooldown('primary')
    assert.equal(pool.getAccountHealthSnapshots().find((a) => a.id === 'primary')?.tosBlocked, undefined)
  } finally {
    pool.dispose()
  }
})

test('CredentialSlotLeaseManager releases asynchronously without blocking the event loop under lock contention', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-agy-slot-async-'))
  const lockFile = path.join(dir, 'credential-slot.lock')
  const mgr = new CredentialSlotLeaseManager({
    slotDir: dir,
    acquireTimeoutMs: 2_000,
    staleLockMs: 10_000,
  })

  try {
    const lease = await mgr.acquire('acct-a')
    assert.equal(Object.keys(mgr.inspect().holders).length, 1)

    // Simulate another live process holding the mutex lock
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')

    let timerTicks = 0
    const ticker = setInterval(() => {
      timerTicks += 1
    }, 10)

    const start = Date.now()
    const releasePromise = lease.release()
    const syncElapsed = Date.now() - start

    // Must return immediately without synchronous spin-waiting (previously blocked up to 2000ms)
    assert.ok(syncElapsed < 50, `expected non-blocking release, took ${syncElapsed}ms`)

    // Verify event loop stays responsive while lock is held
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(timerTicks >= 2, `expected event loop to keep ticking, got ${timerTicks} ticks`)
    assert.equal(Object.keys(mgr.inspect().holders).length, 1)

    // Free the external lock -> async drain completes and removes the holder
    unlinkSync(lockFile)
    await releasePromise
    clearInterval(ticker)
    assert.equal(Object.keys(mgr.inspect().holders).length, 0)
  } finally {
    mgr.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
