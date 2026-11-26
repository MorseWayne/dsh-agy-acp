import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, opendirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LINUX_CA_BUNDLE_CANDIDATES = [
  '/etc/ssl/certs/ca-bundle.crt',
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
] as const

export function detectLinuxCaBundle(baseEnv: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== 'linux') return undefined
  if (baseEnv.SSL_CERT_FILE || baseEnv.SSL_CERT_DIR) return undefined
  const candidates = [baseEnv.NIX_SSL_CERT_FILE, ...LINUX_CA_BUNDLE_CANDIDATES]
  for (const c of candidates) {
    try { if (c && path.isAbsolute(c) && statSync(c).isFile()) return c } catch { /* try next */ }
  }
  return undefined
}

const PRIVATE_PREFIX = 'dsh-agy-'
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

function linuxMountId(fd: number): string | undefined {
  return /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
}

/** Called after child close. On Linux, resolve child names relative to *open directories*,
 * never via a traversable symlink or a bind mount. Cap traversal; leave uncertain data alone. */
function emptyPrivateDirectory(fd: number, mountId: string, budget: { left: number }, depth = 0): boolean {
  if (depth > 32 || linuxMountId(fd) !== mountId) return false
  const anchored = `/proc/self/fd/${fd}`
  const dir = opendirSync(anchored)
  try {
    for (let item = dir.readSync(); item; item = dir.readSync()) {
      const name = item.name
      if (--budget.left < 0) return false
      const entry = path.join(anchored, name)
      const seen = lstatSync(entry)
      if (seen.isDirectory()) {
        const child = openSync(entry, directoryFlags)
        try {
          if (!sameFile(seen, fstatSync(child)) || !emptyPrivateDirectory(child, mountId, budget, depth + 1) ||
              !sameFile(seen, lstatSync(entry))) return false
          rmdirSync(entry)
        } finally { closeSync(child) }
      } else {
        // unlink removes only this directory entry, including for symlinks and hard links.
        unlinkSync(entry)
      }
    }
  } finally { dir.closeSync() }
  return true
}

/** Detects `bwrap ... --tmpfs /tmp ... -- <cmd>` where host `/tmp` is shadowed by a fresh tmpfs. */
export function hasPrivateTmpMount(argv: readonly string[] | undefined, hostTmpRoot: string): boolean {
  if (!argv?.length || path.basename(argv[0] ?? '') !== 'bwrap') return false
  const resolvedHostTmp = path.resolve(hostTmpRoot)
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') break
    if (arg === '--tmpfs' && i + 1 < argv.length) {
      const mountTarget = path.resolve(argv[++i]!)
      if (mountTarget === resolvedHostTmp || resolvedHostTmp.startsWith(mountTarget === path.sep ? path.sep : mountTarget + path.sep)) {
        return true
      }
    }
  }
  return false
}

/** Each process gets an exclusive temp root. Never use an account's TMP, scan sibling roots,
 * or delete shared agy profile artifacts: a session UUID and matching cwd alone do not prove ownership.
 * When `bwrap --tmpfs /tmp` already isolates `/tmp`, keep `/tmp` inside the mount namespace instead
 * of pointing TMPDIR at a host-only directory invisible inside the sandbox.
 * Call cleanup exactly when the child has exited (or launch definitively failed). */
export function createPrivateProcessTemp(
  baseEnv?: NodeJS.ProcessEnv,
  opts?: { argv?: readonly string[] },
): { env: NodeJS.ProcessEnv; cleanup(): boolean } {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv ?? process.env)) {
    if (!['TMP', 'TEMP', 'TMPDIR'].includes(key.toUpperCase())) env[key] = value
  }
  const ca = detectLinuxCaBundle(env)
  if (ca) env.SSL_CERT_FILE = ca

  const parent = realpathSync(os.tmpdir())
  if (process.platform === 'linux' && hasPrivateTmpMount(opts?.argv, parent)) {
    env.TMPDIR = env.TMP = env.TEMP = '/tmp'
    return { env, cleanup: () => false }
  }

  const parentInfo = lstatSync(parent)
  if (!parentInfo.isDirectory() || (process.getuid &&
      ((parentInfo.uid !== 0 && parentInfo.uid !== process.getuid()) || ((parentInfo.mode & 0o022) && !(parentInfo.mode & 0o1000))))) {
    throw new Error('无法建立私有 agy 临时目录')
  }
  const root = mkdtempSync(path.join(parent, PRIVATE_PREFIX))
  const identity = lstatSync(root)
  if (!identity.isDirectory() || (process.getuid && (identity.uid !== process.getuid() || (identity.mode & 0o077)))) {
    throw new Error('无法确认 agy 临时目录归属')
  }
  // Keep the inode alive until cleanup, including if a path is removed and recreated.
  const pinned = process.platform === 'linux' ? openSync(root, directoryFlags) : undefined
  let closed = false
  env.TMPDIR = env.TMP = env.TEMP = root
  return { env, cleanup() {
    if (closed) return false
    closed = true
    const ours = () => realpathSync(parent) === parent && sameFile(parentInfo, lstatSync(parent)) &&
      realpathSync(root) === root && sameFile(identity, lstatSync(root)) && path.dirname(root) === parent
    try {
      if (!ours()) return false
      if (pinned !== undefined) {
        if (!sameFile(identity, fstatSync(pinned))) return false
        const mount = linuxMountId(pinned)
        if (!mount || !emptyPrivateDirectory(pinned, mount, { left: 40_000 }) || !ours()) return false
      }
      // Without a safe dirfd-relative traversal, clear empty roots only (never recurse by pathname).
      rmdirSync(root)
      return true
    } catch { return false } finally { if (pinned !== undefined) closeSync(pinned) }
  } }
}
