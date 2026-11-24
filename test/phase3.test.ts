import { fakeHost } from './fixtures/session-policy.ts'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/common/config.ts'
import { PROVIDER_ID } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { classifyModelFamily, MultiAccountPool } from '../src/runtime/account-pool.ts'
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

test('MultiAccountPool isolates HOME/proxy, tracks 5h+7d buckets, and cools down per model family', async () => {
  let fakeNow = 1_000_000
  const pool = new MultiAccountPool({
    now: () => fakeNow,
    baseCooldownMs: 30_000,
    accounts: [
      {
        id: 'acct-1',
        homeDir: '/tmp/agy-home-1',
        proxyUrl: 'http://127.0.0.1:8081',
      },
      {
        id: 'acct-2',
        homeDir: '/tmp/agy-home-2',
        proxyUrl: 'http://127.0.0.1:8082',
      },
    ],
  })

  assert.equal(classifyModelFamily('gemini-4-neon'), 'gemini-pro')
  assert.equal(classifyModelFamily('gemini-3.8-flash'), 'gemini-flash')
  assert.equal(classifyModelFamily('claude-sonnet-5-5'), 'claude')

  // First acquire picks acct-1 and injects isolated HOME + proxy
  const lease1 = await pool.acquire('sess-1', 'claude-sonnet-5-5')
  assert.equal(lease1.accountId, 'acct-1')
  assert.equal(lease1.env?.HOME, path.resolve('/tmp/agy-home-1'))
  assert.equal(lease1.env?.HTTPS_PROXY, 'http://127.0.0.1:8081')
  lease1.release()

  // 429 failure on claude cools down acct-1 ONLY for claude family
  pool.reportFailure('acct-1', 'claude-sonnet-5-5', new Error('HTTP 429 RESOURCE_EXHAUSTED'))

  // Next claude request fails over to acct-2
  const leaseClaude = await pool.acquire('sess-1', 'claude-sonnet-5-5')
  assert.equal(leaseClaude.accountId, 'acct-2')
  assert.equal(leaseClaude.env?.HTTPS_PROXY, 'http://127.0.0.1:8082')
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
