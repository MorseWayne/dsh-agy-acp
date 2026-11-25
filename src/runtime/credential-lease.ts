import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

interface LeaseHolder {
  pid: number
  acquiredAt: number
}

interface SlotStateFile {
  activeAccountId: string | null
  holders: Record<string, LeaseHolder>
  updatedAt: number
}

export interface CredentialLeaseHandle {
  leaseId: string
  accountId: string
  switched: boolean
  /** Releases the lease without blocking the event loop; returns a promise settled once persisted. */
  release: () => Promise<void>
}

export interface CredentialSlotOptions {
  /** Directory storing `.lock` and `slot-state.json`. */
  slotDir: string
  /** Max time to wait when another process holds the slot for a different account (default: 30s). */
  acquireTimeoutMs?: number
  /** Stale mutex lock age after which a dead lock file is reclaimed (default: 10s). */
  staleLockMs?: number
  /** Stale holder lease age fallback if PID liveness cannot be verified (default: 120s). */
  staleLeaseMs?: number
  /** Optional callback invoked when the active slot switches to a different account. */
  onSwitchAccount?: (fromAccountId: string | null, toAccountId: string) => void | Promise<void>
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function sleep(ms: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (unref) timer.unref?.()
  })
}

/**
 * Cross-process file-locked, reference-counted credential slot lease manager.
 *
 * Designed for shared machine credential stores (e.g., Windows Credential Manager / Keychain):
 * - Multiple DSH processes using the SAME account share the slot concurrently via ref-counting.
 * - Switching to a DIFFERENT account waits until all live holders of the previous account release.
 * - Dead process holders are automatically pruned using PID liveness checks.
 * - With `agy acp` persistent connections, callers can release the slot right after `initialize` / `session/new`.
 */
export class CredentialSlotLeaseManager {
  private readonly lockPath: string
  private readonly statePath: string
  private readonly acquireTimeoutMs: number
  private readonly staleLockMs: number
  private readonly staleLeaseMs: number
  private readonly activeLeases = new Set<string>()
  private readonly pendingReleases = new Set<string>()
  private releaseDrainPromise: Promise<void> | null = null
  private exitHookAttached = false
  private readonly onProcessExit = (): void => {
    this.releaseAllSyncBestEffort()
  }

  constructor(private readonly opts: CredentialSlotOptions) {
    mkdirSync(opts.slotDir, { recursive: true })
    this.lockPath = path.join(opts.slotDir, 'credential-slot.lock')
    this.statePath = path.join(opts.slotDir, 'credential-slot.state.json')
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 30_000
    this.staleLockMs = opts.staleLockMs ?? 10_000
    this.staleLeaseMs = opts.staleLeaseMs ?? 120_000
  }

  async acquire(accountId: string): Promise<CredentialLeaseHandle> {
    const deadline = Date.now() + this.acquireTimeoutMs
    const leaseId = `${process.pid}-${randomUUID().slice(0, 8)}`

    while (true) {
      const attempt = await this.withMutex(async () => {
        const state = this.pruneDeadHolders(this.readState())
        // Apply any queued async releases from this process while we already hold the mutex.
        if (this.pendingReleases.size > 0) {
          for (const pendingId of this.pendingReleases) {
            delete state.holders[pendingId]
          }
          this.pendingReleases.clear()
          this.syncExitHook()
        }
        const holderCount = Object.keys(state.holders).length

        // Can acquire immediately if slot is free OR already bound to the same account
        if (holderCount === 0 || state.activeAccountId === accountId) {
          const prevAccount = state.activeAccountId
          const switched = prevAccount !== accountId
          if (switched && this.opts.onSwitchAccount) {
            await this.opts.onSwitchAccount(prevAccount, accountId)
          }
          state.activeAccountId = accountId
          state.holders[leaseId] = { pid: process.pid, acquiredAt: Date.now() }
          state.updatedAt = Date.now()
          this.writeState(state)
          return { acquired: true as const, switched }
        }

        // Write back pruned state if needed
        this.writeState(state)
        return { acquired: false as const, activeAccountId: state.activeAccountId, holderCount }
      })

      if (attempt.acquired) {
        this.activeLeases.add(leaseId)
        this.syncExitHook()
        let released = false
        return {
          leaseId,
          accountId,
          switched: attempt.switched,
          release: () => {
            if (released) return Promise.resolve()
            released = true
            return this.releaseLease(leaseId)
          },
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for credential slot for account "${accountId}" (held by "${attempt.activeAccountId}", refs=${attempt.holderCount})`,
        )
      }
      await sleep(50)
    }
  }

  inspect(): SlotStateFile {
    return this.pruneDeadHolders(this.readState())
  }

  dispose(): void {
    this.releaseAllSyncBestEffort()
    this.activeLeases.clear()
    this.pendingReleases.clear()
    this.syncExitHook()
  }

  private syncExitHook(): void {
    const needHook = this.activeLeases.size > 0 || this.pendingReleases.size > 0
    if (needHook && !this.exitHookAttached) {
      process.on('exit', this.onProcessExit)
      this.exitHookAttached = true
    } else if (!needHook && this.exitHookAttached) {
      process.off('exit', this.onProcessExit)
      this.exitHookAttached = false
    }
  }

  /**
   * Non-blocking fast path + async contended retry.
   * Never busy-spins on the Node.js event loop when the file lock is held by another process.
   */
  private releaseLease(leaseId: string): Promise<void> {
    this.activeLeases.delete(leaseId)
    this.pendingReleases.add(leaseId)
    this.syncExitHook()

    // Uncontended fast path: single non-spinning lock attempt (microseconds, zero loop).
    if (this.drainPendingReleasesOnce()) {
      return Promise.resolve()
    }

    // Contended path: yield immediately and retry asynchronously so HTTP/SSE stay responsive.
    return this.drainPendingReleasesAsync()
  }

  private drainPendingReleasesOnce(): boolean {
    if (this.pendingReleases.size === 0) {
      this.syncExitHook()
      return true
    }
    if (!this.tryLockSync()) return false
    try {
      const state = this.pruneDeadHolders(this.readState())
      for (const id of this.pendingReleases) {
        delete state.holders[id]
      }
      state.updatedAt = Date.now()
      this.writeState(state)
      this.pendingReleases.clear()
    } finally {
      this.unlockSync()
      this.syncExitHook()
    }
    return true
  }

  private drainPendingReleasesAsync(): Promise<void> {
    if (this.releaseDrainPromise) return this.releaseDrainPromise
    const run = (async () => {
      const deadline = Date.now() + Math.max(this.acquireTimeoutMs, 5_000)
      while (this.pendingReleases.size > 0 && Date.now() < deadline) {
        await sleep(20, true)
        if (this.drainPendingReleasesOnce()) return
      }
      // If lock remained held past deadline, drop local pending markers; dead-PID pruning will recover on exit.
      this.pendingReleases.clear()
      this.syncExitHook()
    })().finally(() => {
      if (this.releaseDrainPromise === run) {
        this.releaseDrainPromise = null
      }
    })
    this.releaseDrainPromise = run
    return run
  }

  /** Single-shot non-spinning cleanup for `process.on('exit')` and `dispose()`. */
  private releaseAllSyncBestEffort(): void {
    if (this.activeLeases.size === 0 && this.pendingReleases.size === 0) return
    try {
      if (!this.tryLockSync()) return
      try {
        const state = this.pruneDeadHolders(this.readState())
        for (const id of this.activeLeases) delete state.holders[id]
        for (const id of this.pendingReleases) delete state.holders[id]
        state.updatedAt = Date.now()
        this.writeState(state)
        this.activeLeases.clear()
        this.pendingReleases.clear()
      } finally {
        this.unlockSync()
      }
    } catch {
      // ignore during shutdown; other processes prune dead PIDs automatically
    }
  }

  private async withMutex<T>(fn: () => Promise<T> | T): Promise<T> {
    const deadline = Date.now() + Math.max(this.acquireTimeoutMs, 5_000)
    while (!this.tryLockSync()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring credential slot mutex: ${this.lockPath}`)
      }
      await sleep(20)
    }
    try {
      return await fn()
    } finally {
      this.unlockSync()
    }
  }

  private tryLockSync(): boolean {
    try {
      const fd = openSync(this.lockPath, 'wx')
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      // Reclaim stale lock if owner PID is dead or lock file is older than staleLockMs
      try {
        const st = statSync(this.lockPath)
        let ownerDead = false
        try {
          const info = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: number }
          if (typeof info.pid === 'number' && !isPidAlive(info.pid)) {
            ownerDead = true
          }
        } catch {
          // ignore malformed lock file
        }
        if (ownerDead || Date.now() - st.mtimeMs > this.staleLockMs) {
          unlinkSync(this.lockPath)
        }
      } catch {
        // another process already unlinked it
      }
      return false
    }
  }

  private unlockSync(): void {
    try {
      unlinkSync(this.lockPath)
    } catch {
      // ignore
    }
  }

  private readState(): SlotStateFile {
    if (!existsSync(this.statePath)) {
      return { activeAccountId: null, holders: {}, updatedAt: 0 }
    }
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<SlotStateFile>
      return {
        activeAccountId: typeof raw.activeAccountId === 'string' ? raw.activeAccountId : null,
        holders: raw.holders && typeof raw.holders === 'object' ? raw.holders : {},
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      }
    } catch {
      return { activeAccountId: null, holders: {}, updatedAt: 0 }
    }
  }

  private writeState(state: SlotStateFile): void {
    const tmp = `${this.statePath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, this.statePath)
  }

  private pruneDeadHolders(state: SlotStateFile): SlotStateFile {
    const now = Date.now()
    const nextHolders: Record<string, LeaseHolder> = {}
    for (const [id, holder] of Object.entries(state.holders)) {
      if (!holder || typeof holder.pid !== 'number') continue
      if (now - holder.acquiredAt > this.staleLeaseMs && !isPidAlive(holder.pid)) continue
      if (!isPidAlive(holder.pid)) continue
      nextHolders[id] = holder
    }
    return {
      activeAccountId: state.activeAccountId,
      holders: nextHolders,
      updatedAt: state.updatedAt,
    }
  }
}
