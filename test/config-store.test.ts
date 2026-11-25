import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateConfigPatchInput } from '../src/common/config.ts'
import { ConfigStore } from '../src/runtime/config-store.ts'

test('ConfigStore saves atomically with 0600 mode, preserves keys on lazy savePatch, and resets cleanly', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-cfg-'))
  const filePath = path.join(dir, 'nested', 'config.json')
  try {
    const store1 = new ConfigStore({ filePath })
    assert.deepEqual(store1.load(), { patch: {}, exists: false })
    assert.equal(store1.hasPersistedOverrides, false)

    store1.savePatch({
      mcpBridge: true,
      defaultModel: 'gemini-4-neon',
      defaultEffort: 'high',
      sessionIdleTtlMs: 900_000,
      requestTimeoutMs: 120_000,
    })
    assert.equal(store1.hasPersistedOverrides, true)
    if (process.platform !== 'win32') {
      const mode = statSync(filePath).mode & 0o777
      assert.equal(mode, 0o600)
    }

    // New store instance without calling load() first must preserve existing keys on partial savePatch
    const store2 = new ConfigStore({ filePath })
    store2.savePatch({ defaultEffort: 'low' })

    const store3 = new ConfigStore({ filePath })
    const loaded = store3.load()
    assert.equal(loaded.exists, true)
    assert.deepEqual(loaded.patch, {
      mcpBridge: true,
      defaultModel: 'gemini-4-neon',
      defaultEffort: 'low',
      sessionIdleTtlMs: 900_000,
      requestTimeoutMs: 120_000,
    })

    store3.reset()
    assert.equal(store3.hasPersistedOverrides, false)
    assert.deepEqual(new ConfigStore({ filePath }).load(), { patch: {}, exists: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ConfigStore safely degrades on corrupt, oversized, or directory paths and never corrupts memory on write failure', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-cfg-bad-'))
  try {
    // 1. Corrupt JSON
    const corrupt = path.join(dir, 'corrupt.json')
    writeFileSync(corrupt, '{bad json', 'utf8')
    assert.deepEqual(new ConfigStore({ filePath: corrupt }).load(), { patch: {}, exists: false })

    // 2. Oversized > 64KB file
    const huge = path.join(dir, 'huge.json')
    writeFileSync(huge, JSON.stringify({ config: { defaultModel: 'a'.repeat(70_000) } }), 'utf8')
    assert.deepEqual(new ConfigStore({ filePath: huge }).load(), { patch: {}, exists: false })

    // 3. Directory path instead of file -> load falls back, savePatch throws without flipping hasPersistedOverrides
    const asDir = path.join(dir, 'dir-as-file')
    mkdirSync(asDir)
    const dirStore = new ConfigStore({ filePath: asDir })
    assert.deepEqual(dirStore.load(), { patch: {}, exists: false })
    assert.throws(() => dirStore.savePatch({ mcpBridge: true }))
    assert.equal(dirStore.hasPersistedOverrides, false)

    // 4. Persisted file containing mixed valid + invalid/disallowed fields keeps only valid whitelist keys
    const mixed = path.join(dir, 'mixed.json')
    writeFileSync(
      mixed,
      JSON.stringify({
        version: 1,
        config: {
          mcpBridge: true,
          permissionMode: 'skip',
          accounts: [{ id: 'evil' }],
          defaultEffort: 'bad effort with spaces',
          sessionIdleTtlMs: 500, // below min
          requestTimeoutMs: 60_000,
        },
      }),
      'utf8',
    )
    const loadedMixed = new ConfigStore({ filePath: mixed }).load()
    assert.deepEqual(loadedMixed.patch, { mcpBridge: true, requestTimeoutMs: 60_000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateConfigPatchInput strictly enforces whitelist, bounds, effort format, and prototype safety', () => {
  assert.equal(validateConfigPatchInput({}).ok, false)
  assert.equal(validateConfigPatchInput({ permissionMode: 'skip' }).ok, false)
  assert.equal(validateConfigPatchInput({ accounts: [] }).ok, false)
  assert.equal(validateConfigPatchInput({ credentialSlotDir: '/tmp' }).ok, false)
  assert.equal(validateConfigPatchInput({ unknownKey: 1 }).ok, false)
  assert.equal(validateConfigPatchInput(JSON.parse('{"__proto__": {"polluted": true}}')).ok, false)
  assert.equal(validateConfigPatchInput({ mcpBridge: 'true' }).ok, false)
  assert.equal(validateConfigPatchInput({ defaultModel: 'bad\nline' }).ok, false)
  assert.equal(validateConfigPatchInput({ defaultEffort: 'bad effort!' }).ok, false)
  assert.equal(validateConfigPatchInput({ sessionIdleTtlMs: 59_000 }).ok, false)
  assert.equal(validateConfigPatchInput({ requestTimeoutMs: 9_000 }).ok, false)

  const ok = validateConfigPatchInput({
    mcpBridge: true,
    defaultModel: ' gemini-4-neon ',
    defaultEffort: '',
    sessionIdleTtlMs: 120_000,
    requestTimeoutMs: 30_000,
  })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.patch, {
      mcpBridge: true,
      defaultModel: 'gemini-4-neon',
      defaultEffort: '',
      sessionIdleTtlMs: 120_000,
      requestTimeoutMs: 30_000,
    })
  }
})
