import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { AccountStore } from '../src/runtime/account-store.ts'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const marker = (home: string) => path.join(home, '.gemini', 'antigravity-cli', 'installation_id')
const token = (home: string) => path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
const make = (t: TestContext) => {
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'dsh-agy-installation-'))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const root = path.join(dir, 'accounts')
  const filePath = path.join(dir, 'accounts.json')
  return { dir, root, filePath, store: new AccountStore({ filePath, accountsRootDir: root }) }
}

function assertNewMarker(file: string) {
  const raw = readFileSync(file, 'utf8')
  assert.equal(Buffer.byteLength(raw), 36)
  assert.match(raw, uuidV4)
  const info = lstatSync(file)
  assert.ok(info.isFile())
  assert.equal(info.nlink, 1)
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
  return raw
}

test('new and legacy managed HOMEs get separate persistent agy-compatible IDs', t => {
  const { dir, root, filePath, store } = make(t)
  store.addAccount({ id: 'first', label: 'First' })
  const firstHome = store.resolveManagedAccountHome('first')
  const first = marker(firstHome)
  const firstId = assertNewMarker(first)
  const inode = statSync(first).ino
  assert.equal(store.ensureManagedAccountHome('first'), firstHome)
  assert.equal(statSync(first).ino, inode)
  assert.equal(readFileSync(first, 'utf8'), firstId)

  // Simulate an account persisted by an older plugin that had HOME/token but no marker.
  const oldHome = path.join(root, 'legacy')
  mkdirSync(path.dirname(marker(oldHome)), { recursive: true, mode: 0o700 })
  writeFileSync(token(oldHome), 'fixture-old-token', { mode: 0o600 })
  const raw = JSON.parse(readFileSync(filePath, 'utf8'))
  raw.accounts.push({ id: 'legacy', label: 'Legacy', enabled: true })
  writeFileSync(filePath, JSON.stringify(raw))
  const reload = new AccountStore({ filePath, accountsRootDir: root })
  const hostHome = path.join(dir, 'host-not-managed')
  assert.ok(reload.buildEffectiveProfiles([{ id: 'host-test', label: 'Host', homeDir: hostHome }])
    .some(profile => profile.id === 'legacy' && profile.enabled))
  const oldId = assertNewMarker(marker(oldHome))
  assert.notEqual(oldId, firstId)
  assert.equal(readFileSync(token(oldHome), 'utf8'), 'fixture-old-token')
  assert.equal(existsSync(hostHome), false)
})

test('pending login does not preseed and re-login keeps the managed HOME installation ID', t => {
  const { root, store, filePath } = make(t)
  const pending = store.preparePendingAccountHome('first-login')
  assert.equal(existsSync(marker(pending)), false)
  writeFileSync(token(pending), 'fixture-first-token', { mode: 0o600 })
  const record = store.commitPendingAccount({ pendingId: 'first-login', email: 'tester@example.test' })
  const target = store.resolveManagedAccountHome(record.id)
  const stable = assertNewMarker(marker(target))

  const pendingAgain = store.preparePendingAccountHome('relogin')
  // Exercise a CLI that independently initialized its transient login HOME.
  const transient = '233dcc3d-2dbe-491c-a500-5cc67a0c6438'
  writeFileSync(marker(pendingAgain), transient, { mode: 0o600 })
  writeFileSync(token(pendingAgain), 'fixture-new-token', { mode: 0o600 })

  // Fail metadata publication after the tentative HOME swap, and check both HOMEs roll back.
  unlinkSync(filePath)
  mkdirSync(filePath)
  assert.throws(() => store.commitPendingAccount({ pendingId: 'relogin', email: 'tester@example.test' }))
  assert.equal(assertNewMarker(marker(target)), stable)
  assert.equal(readFileSync(token(target), 'utf8'), 'fixture-first-token')
  assert.equal(readFileSync(marker(pendingAgain), 'utf8'), transient)
  rmSync(filePath, { recursive: true })

  const updated = store.commitPendingAccount({ pendingId: 'relogin', email: 'tester@example.test' })
  assert.equal(updated.id, record.id)
  assert.equal(assertNewMarker(marker(target)), stable)
  assert.equal(readFileSync(token(target), 'utf8'), 'fixture-new-token')
  assert.deepEqual(readdirSync(root), [record.id])
})

test('unsafe symlinks and hardlinked markers are not used or replaced', { skip: process.platform === 'win32' }, t => {
  const { dir, root, store } = make(t)
  const external = path.join(dir, 'external')
  mkdirSync(external, { mode: 0o700 })
  const externalFile = path.join(external, 'untouched')
  writeFileSync(externalFile, 'sentinel', { mode: 0o600 })

  // Refuse both the configured root itself and an intermediate ancestor alias.
  symlinkSync(external, root)
  assert.throws(() => store.ensureManagedAccountHome('user'), /安全初始化/)
  const nested = new AccountStore({ filePath: store.filePath, accountsRootDir: path.join(root, 'nested') })
  assert.throws(() => nested.ensureManagedAccountHome('user'), /安全初始化/)
  unlinkSync(root)
  mkdirSync(root, { mode: 0o700 })

  const home = store.resolveManagedAccountHome('user')
  const gemini = path.join(home, '.gemini')
  const cli = path.dirname(marker(home))
  for (const dirLink of [home, gemini, cli]) {
    mkdirSync(path.dirname(dirLink), { recursive: true, mode: 0o700 })
    symlinkSync(external, dirLink)
    assert.throws(() => store.ensureManagedAccountHome('user'), /安全初始化/)
    unlinkSync(dirLink)
  }
  mkdirSync(cli, { mode: 0o700 })
  symlinkSync(externalFile, marker(home))
  assert.throws(() => store.ensureManagedAccountHome('user'), /安全初始化/)
  assert.ok(lstatSync(marker(home)).isSymbolicLink())
  unlinkSync(marker(home))
  linkSync(externalFile, marker(home))
  assert.throws(() => store.ensureManagedAccountHome('user'), /安全初始化/)
  assert.equal(statSync(marker(home)).ino, statSync(externalFile).ino)
  assert.equal(readFileSync(externalFile, 'utf8'), 'sentinel')
  assert.deepEqual(readdirSync(external), ['untouched'])
})

test('Linux permits group-write above, but not inside, the managed accounts root', { skip: process.platform !== 'linux' }, t => {
  const { dir, filePath } = make(t)
  const ancestor = path.join(dir, 'group-owned-parent')
  const root = path.join(ancestor, 'accounts')
  mkdirSync(ancestor)
  chmodSync(ancestor, 0o775)
  const store = new AccountStore({ filePath, accountsRootDir: root })
  const home = store.ensureManagedAccountHome('test')
  assertNewMarker(marker(home))
  assert.equal(statSync(root).mode & 0o777, 0o700)

  chmodSync(root, 0o775)
  assert.throws(() => store.ensureManagedAccountHome('different'), /安全初始化/)
  chmodSync(root, 0o700)
  chmodSync(ancestor, 0o777)
  assert.throws(() => store.ensureManagedAccountHome('different'), /安全初始化/)
  assert.deepEqual(readdirSync(root), ['test'])
})

test('an existing opaque regular marker is left byte-for-byte intact', t => {
  const { store } = make(t)
  const home = store.resolveManagedAccountHome('fixture')
  const file = marker(home)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const raw = Buffer.from('opaque unknown-version installation value\n')
  writeFileSync(file, raw, { mode: 0o600 })
  const ino = statSync(file).ino
  store.ensureManagedAccountHome('fixture')
  assert.deepEqual(readFileSync(file), raw)
  assert.equal(statSync(file).ino, ino)
})

test('empty or oversized existing markers fail closed without replacing the file', t => {
  const { store } = make(t)
  const file = marker(store.ensureManagedAccountHome('damaged'))
  for (const bytes of [0, 4097]) {
    writeFileSync(file, Buffer.alloc(bytes))
    const ino = statSync(file).ino
    assert.throws(() => store.ensureManagedAccountHome('damaged'), /安装标识为空、不可读或大小异常；未覆盖已有文件/)
    assert.equal(statSync(file).size, bytes)
    assert.equal(statSync(file).ino, ino)
  }
})

test('managed initialization rejects overlaps with ambient HOME and its storage', t => {
  const { dir, root, filePath, store } = make(t)
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[key]
  const ambient = store.resolveManagedAccountHome('ambient')
  process.env[key] = ambient
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })

  assert.throws(() => store.ensureManagedAccountHome('ambient'), /安全初始化/)
  assert.equal(existsSync(root), false)
  const nested = new AccountStore({ filePath, accountsRootDir: path.join(ambient, '.gemini') })
  assert.throws(() => nested.ensureManagedAccountHome('never'), /安全初始化/)
  assert.deepEqual(readdirSync(dir), [])
})
