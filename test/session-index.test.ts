import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SessionIndex } from '../src/runtime/session-index.ts'

test('SessionIndex persists atomically with 0600 mode, enforces LRU cap & TTL expiry, and degrades safely on bad files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-sess-idx-'))
  const filePath = path.join(dir, 'nested', 'sessions.json')
  let fakeNow = 100_000

  try {
    const idx1 = new SessionIndex({
      filePath,
      maxEntries: 3,
      maxAgeMs: 10_000,
      now: () => fakeNow,
    })
    assert.equal(idx1.size, 0)

    idx1.upsert({
      dshSessionKey: 's1',
      acpSessionId: 'acp-1',
      accountId: 'default',
      cwd: '/work/a',
      policyFingerprint: 'fp-1',
      appliedSystemHash: 'h1',
      title: '\u001b[31m标题一\u001b[0m',
    })
    fakeNow += 1_000
    idx1.upsert({
      dshSessionKey: 's2',
      acpSessionId: 'acp-2',
      accountId: 'default',
      cwd: '/work/b',
      policyFingerprint: 'fp-2',
    })
    fakeNow += 1_000
    idx1.upsert({
      dshSessionKey: 's3',
      acpSessionId: 'acp-3',
      accountId: 'acct-2',
      cwd: '/work/c',
      policyFingerprint: 'fp-3',
    })
    fakeNow += 1_000
    // Adding s4 evicts oldest s1 (maxEntries = 3)
    idx1.upsert({
      dshSessionKey: 's4',
      acpSessionId: 'acp-4',
      accountId: 'acct-2',
      cwd: '/work/d',
      policyFingerprint: 'fp-4',
    })

    if (process.platform !== 'win32') {
      assert.equal(statSync(filePath).mode & 0o777, 0o600)
    }

    const idx2 = new SessionIndex({
      filePath,
      maxEntries: 3,
      maxAgeMs: 10_000,
      now: () => fakeNow,
    })
    idx2.load()
    assert.equal(idx2.size, 3)
    assert.equal(idx2.get('s1'), undefined)
    assert.equal(idx2.get('s2')?.acpSessionId, 'acp-2')

    idx2.updateMeta('s2', { title: '更新后标题', appliedSystemHash: 'hash-new', touch: true })
    assert.equal(idx2.get('s2')?.title, '更新后标题')
    assert.equal(idx2.get('s2')?.appliedSystemHash, 'hash-new')

    // Advance past TTL for s3 & s4 while s2 was touched at fakeNow -> advance 9s after updating s2 at +2s
    fakeNow += 2_000
    idx2.updateMeta('s2', { touch: true })
    fakeNow += 9_500
    assert.equal(idx2.get('s3'), undefined)
    assert.equal(idx2.get('s4'), undefined)
    assert.equal(idx2.get('s2')?.acpSessionId, 'acp-2')

    idx2.delete('s2')
    assert.equal(idx2.size, 0)

    // Corrupt JSON and directory path fall back cleanly without throwing
    const badPath = path.join(dir, 'corrupt.json')
    writeFileSync(badPath, '{not valid json', 'utf8')
    const badIdx = new SessionIndex({ filePath: badPath })
    badIdx.load()
    assert.equal(badIdx.size, 0)

    const dirAsFile = path.join(dir, 'dir-file')
    mkdirSync(dirAsFile)
    const dirIdx = new SessionIndex({ filePath: dirAsFile })
    dirIdx.load()
    assert.equal(dirIdx.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
