import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, rmdirSync, statfsSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

// /proc/PID/stat's comm may contain whitespace, ')' and newlines. starttime is field 22.
export function linuxLeaderIdentity(raw: string, pid: number): string | undefined {
  const end = raw.lastIndexOf(') ')
  if (!raw.startsWith(`${pid} (`) || end < 0) return
  const fields = raw.slice(end + 2).trimEnd().split(/\s+/)
  if (fields[2] !== String(pid) || fields[3] !== String(pid) || !/^\d+$/.test(fields[19] ?? '')) return
  return fields[19]
}

function leaderStart(pid: number): string | undefined {
  try { return linuxLeaderIdentity(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid) } catch { return undefined }
}

/** Own only a newly-created leaf, never the caller's cgroup. Keep kill/procs FDs pinned to it. */
function delegatedLeaf() {
  if (process.platform !== 'linux') return
  const root = '/sys/fs/cgroup'
  let leaf: string | undefined
  let procs: number | undefined
  let kill: number | undefined
  try {
    if (statfsSync(root).type !== 0x63677270) return // cgroup v2
    const path = /^0::(\/[^\n]*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1]
    if (!path) return
    // A cgroup namespace may expose the current group at the mount root. Check actual
    // membership; never interpret an outside-namespace "../" path or guess a sibling.
    const candidates = !path.split('/').includes('..') ? [join(root, path), root] : [root]
    const parent = candidates.find(p => {
      try { return readFileSync(join(p, 'cgroup.procs'), 'utf8').split('\n').includes(String(process.pid)) } catch { return false }
    })
    if (!parent) return
    leaf = mkdtempSync(join(parent, 'dsh-acp-'))
    const identity = lstatSync(leaf, { bigint: true })
    kill = openSync(join(leaf, 'cgroup.kill'), constants.O_WRONLY | constants.O_NOFOLLOW)
    procs = openSync(join(leaf, 'cgroup.procs'), constants.O_WRONLY | constants.O_NOFOLLOW)
    const dir = leaf
    return {
      procs,
      releaseProcs() { if (procs !== undefined) { closeSync(procs); procs = undefined } },
      terminate() {
        if (kill === undefined) return
        try { writeSync(kill, '1') } catch { /* verified process group is the fallback */ }
        closeSync(kill); kill = undefined
        const removeEmpty = (remaining: number) => {
          try {
            const current = lstatSync(dir, { bigint: true })
            if (identity.dev === current.dev && identity.ino === current.ino) rmdirSync(dir)
          } catch (err) {
            // cgroup.kill is asynchronous. rmdir only an empty leaf, not descendant dirs.
            if (remaining && (err as NodeJS.ErrnoException).code === 'EBUSY') {
              setTimeout(() => removeEmpty(remaining - 1), 100).unref()
            }
          }
        }
        removeEmpty(20)
      },
    }
  } catch {
    if (procs !== undefined) closeSync(procs)
    if (kill !== undefined) closeSync(kill)
    if (leaf) { try { rmdirSync(leaf) } catch { /* unavailable delegation */ } }
    return undefined
  }
}

/** Start in an owned process group; use cgroup.kill for setsid descendants where delegated.
 * Without delegation no detached descendant PID is signalled: /proc starttime + numeric
 * kill alone cannot close the PID-reuse race. Cleanup is not a containment boundary.
 */
export function spawnOwnedProcess(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  { useDelegation = true }: { useDelegation?: boolean } = {}) {
  const group = useDelegation ? delegatedLeaf() : undefined
  let child: ChildProcessWithoutNullStreams
  try {
    const options = { cwd, env, detached: process.platform !== 'win32' }
    // A child might fork before a parent-side write to cgroup.procs. Join in a fixed
    // bootstrap before exec; user arguments are positional data, never shell source.
    child = group ? spawn('/bin/sh', ['-c',
      `printf '0\\n' >&3 || printf 'ACP cgroup unavailable; process-group cleanup only\\n' >&2; exec 3>&-; exec "$@"`,
      'acp-launch', bin, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe', group.procs] }) as ChildProcessWithoutNullStreams
      : spawn(bin, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) { group?.terminate(); throw err } finally { group?.releaseProcs() }
  const pid = child.pid
  const start = pid && process.platform === 'linux' ? leaderStart(pid) : undefined
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    // libuv has not reaped this owned direct child; it cannot have a recycled PID.
    try {
      if (!pid || child.exitCode !== null || child.signalCode !== null) return
      if (process.platform !== 'win32' && (process.platform !== 'linux' || (start && leaderStart(pid) === start))) {
        try { process.kill(-pid, 'SIGKILL'); return } catch { /* race or inaccessible group */ }
      }
      try { child.kill('SIGKILL') } catch { /* child already exited */ }
    } finally {
      // Stop a not-yet-attached bootstrap before issuing cgroup.kill, not afterward.
      group?.terminate()
    }
  }
  child.once('exit', () => group?.terminate())
  child.once('close', () => group?.terminate()) // includes spawn failure without exit
  return { child, stop }
}
