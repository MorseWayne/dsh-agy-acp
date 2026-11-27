import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const AGY_CLI_STORE = 'antigravity-cli'
const ID_FILE = 'installation_id'
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const noEntry = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'
const alreadyExists = (err: unknown) => (err as NodeJS.ErrnoException).code === 'EEXIST'
const samePath = (a: string, b: string) => path.relative(a, b) === ''
const containsPath = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
const unsafe = () => new Error('Unsafe managed account HOME or installation ID')

export class InvalidInstallationIdError extends Error {
  constructor() { super('安装标识为空、不可读或大小异常；未覆盖已有文件') }
}

function physicalPath(value: string): string {
  try { return realpathSync(value) } catch { return path.resolve(value) }
}

/** Managed storage may be below the machine HOME, but must never be that HOME or its agy storage. */
export function assertIndependentAccountHome(home: string): void {
  for (const value of [os.homedir(), process.env.HOME, process.env.USERPROFILE]) {
    if (!value || !path.isAbsolute(value)) continue
    for (const ambient of [path.resolve(value), physicalPath(value)]) {
      const gemini = path.join(ambient, '.gemini')
      if (containsPath(home, ambient) || [gemini, physicalPath(gemini)].some(p =>
        containsPath(p, home) || containsPath(home, p))) throw unsafe()
    }
  }
  for (const value of [process.env.GEMINI_HOME, process.env.GEMINI_CLI_HOME,
    process.env.ANTIGRAVITY_GEMINI_DIR, process.env.ANTIGRAVITY_APP_DATA_DIR]) {
    if (!value || !path.isAbsolute(value)) continue
    for (const ambient of [path.resolve(value), physicalPath(value)]) {
      if (containsPath(home, ambient) || containsPath(ambient, home)) throw unsafe()
    }
  }
}

/** Walk without following symlink components. Linux pins each directory for dirfd-relative
 * operations; elsewhere check the physical pathname and require trusted, non-shared POSIX parents. */
export function withManagedDirectory<T>(
  root: string, directory: string, create: boolean, action: (anchored: string) => T,
): T | undefined {
  if (!path.isAbsolute(root) || !path.isAbsolute(directory) || !containsPath(root, directory)) throw unsafe()
  const volume = path.parse(directory).root
  const parts = path.relative(volume, directory).split(path.sep).filter(Boolean)
  const privateFrom = path.relative(volume, root).split(path.sep).filter(Boolean).length
  const uid = process.getuid?.()
  if (privateFrom === 0) throw unsafe()
  let current = volume
  let fd: number | undefined = process.platform === 'linux' ? openSync(volume, DIRECTORY_FLAGS) : undefined
  try {
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!
      current = path.join(current, name)
      const entry = fd === undefined ? current : `/proc/self/fd/${fd}/${name}`
      let info = lstatSync(entry, { throwIfNoEntry: false })
      if (!info) {
        if (!create) return undefined
        try { mkdirSync(entry, { mode: 0o700 }) } catch (err) { if (!alreadyExists(err)) throw err }
        info = lstatSync(entry)
      }
      const owned = i + 1 >= privateFrom
      if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe()
      if (uid !== undefined) {
        if (owned ? info.uid !== uid || (info.mode & 0o022) !== 0 : info.uid !== uid && info.uid !== 0) throw unsafe()
        // Linux can tolerate group-write on a trusted owner/root ancestor because the next
        // lookup is anchored to this FD and checked again. World-write still requires sticky.
        if (!owned && (info.mode & (fd === undefined ? 0o022 : 0o002)) !== 0 && (info.mode & 0o1000) === 0) throw unsafe()
      }
      if (fd !== undefined) {
        const next = openSync(entry, DIRECTORY_FLAGS)
        const previous = fd
        fd = next
        closeSync(previous)
        const opened = fstatSync(fd)
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.uid !== info.uid || opened.mode !== info.mode) throw unsafe()
      } else if (!samePath(realpathSync(current), current)) throw unsafe()
    }
    const anchored = fd === undefined ? directory : `/proc/self/fd/${fd}`
    if (!samePath(realpathSync(anchored), directory)) throw unsafe()
    return action(anchored)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function installationInfo(file: string) {
  let info = lstatSync(file, { throwIfNoEntry: false })
  if (info?.isFile() && info.nlink === 2) {
    // The atomic publisher may still be removing its private temporary hardlink. Recheck
    // briefly rather than accepting linked files or spuriously failing concurrent callers.
    const pause = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 8 && info?.nlink === 2; attempt++) {
      Atomics.wait(pause, 0, 0, 5)
      info = lstatSync(file, { throwIfNoEntry: false })
    }
  }
  if (info && (!info.isFile() || info.nlink !== 1 || (process.getuid &&
      (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)))) throw unsafe()
  if (info && (info.size < 1 || info.size > 4096 || (process.getuid && (info.mode & 0o400) === 0))) {
    throw new InvalidInstallationIdError()
  }
  return info
}

/** Preserve existing values as opaque bytes; only synthesize the format observed in agy 1.5.17. */
export function readInstallationId(store: string): Buffer | undefined {
  const file = path.join(store, ID_FILE)
  const seen = installationInfo(file)
  if (!seen) return undefined
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== seen.dev || opened.ino !== seen.ino || opened.size !== seen.size ||
        opened.nlink !== 1 || opened.mode !== seen.mode || opened.uid !== seen.uid) throw unsafe()
    const content = Buffer.alloc(seen.size)
    if (readSync(fd, content, 0, content.length, 0) !== content.length) throw unsafe()
    const after = fstatSync(fd)
    if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw unsafe()
    return content
  } finally { closeSync(fd) }
}

/** Publish a complete 0600 file without replacing anything at the destination, even on concurrent initialization. */
function publishInstallationId(store: string, value: string | Buffer): boolean {
  const scratch = mkdtempSync(path.join(store, '.installation-id-'))
  const temporary = path.join(scratch, 'new')
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
    try { linkSync(temporary, path.join(store, ID_FILE)); return true } catch (err) {
      if (!alreadyExists(err)) throw err
      return false
    }
  } finally {
    try { unlinkSync(temporary) } catch (err) { if (!noEntry(err)) throw err }
    rmdirSync(scratch)
  }
}

export function ensureInstallationId(store: string): void {
  const file = path.join(store, ID_FILE)
  // Normal initialization/backfill inspects metadata only, never opening an existing marker.
  if (installationInfo(file)) return
  // Compatibility bootstrap by this plugin, not an official agy init command. Observed with
  // agy 1.5.17: lowercase UUID v4, exactly 36 bytes, no newline; readable by sandboxed agy.
  if (!publishInstallationId(store, randomUUID()) && !installationInfo(file)) throw unsafe()
}

/** Pending OAuth HOME is staging only. Keep the destination account's established ID when
 * committing fresh credentials, and restore the pending marker if committing fails. */
export function withPreservedInstallationId<T>(
  store: string, accountsRoot: string, preferred: Buffer | undefined, commit: () => T,
): T {
  if (!preferred) { ensureInstallationId(store); return commit() }
  const previous = readInstallationId(store)
  if (previous?.equals(preferred)) return commit()
  const file = path.join(store, ID_FILE)
  // Put the rollback copy outside the pending HOME so it stays addressable after the HOME is renamed.
  const staging = previous ? mkdtempSync(path.join(accountsRoot, '.installation-id-')) : undefined
  const saved = staging && path.join(staging, 'previous')
  let movedPrevious = false
  let installed = false
  let result: T
  try {
    if (saved) { renameSync(file, saved); movedPrevious = true }
    installed = publishInstallationId(store, preferred)
    if (!installed) throw unsafe()
    result = commit()
  } catch (err) {
    if (installed) unlinkSync(file)
    if (saved && movedPrevious) { linkSync(saved, file); unlinkSync(saved); movedPrevious = false }
    if (staging && !movedPrevious) rmdirSync(staging)
    throw err
  }
  // A cleanup failure must not roll back the now-committed account or unlink its marker.
  if (saved && staging) {
    try { unlinkSync(saved); rmdirSync(staging) } catch { /* leave private scratch if cleanup fails */ }
  }
  return result
}
