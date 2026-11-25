import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'

const MAX_INDEX_FILE_BYTES = 256 * 1024
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const MAX_FIELD_LEN = 2048

export interface PersistedSessionBinding {
  dshSessionKey: string
  acpSessionId: string
  accountId: string
  cwd: string
  policyFingerprint: string
  appliedSystemHash?: string | null
  title?: string
  updatedAt: number
}

export interface SessionIndexOptions {
  filePath?: string
  maxEntries?: number
  maxAgeMs?: number
  now?: () => number
  log?: (msg: string) => void
}

export function resolveSessionIndexPath(explicitPath?: string): string {
  const candidate = explicitPath?.trim() || process.env.DSH_AGY_ACP_SESSIONS_PATH?.trim() || ''
  if (candidate) {
    if (CONTROL_CHAR_RE.test(candidate)) {
      throw new Error('Invalid session index path')
    }
    return path.resolve(candidate)
  }
  return path.join(os.homedir(), '.dsh', 'agy-acp', 'sessions.json')
}

function isSafeString(value: unknown, maxLen = MAX_FIELD_LEN): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && !CONTROL_CHAR_RE.test(value)
}

function sanitizeBinding(raw: unknown, keyFallback: string): PersistedSessionBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const dshSessionKey = isSafeString(rec.dshSessionKey, 512) ? rec.dshSessionKey : keyFallback
  if (!isSafeString(dshSessionKey, 512)) return null
  if (!isSafeString(rec.acpSessionId, 512)) return null
  if (!isSafeString(rec.accountId, 256)) return null
  if (!isSafeString(rec.cwd, MAX_FIELD_LEN)) return null
  if (!isSafeString(rec.policyFingerprint, MAX_FIELD_LEN)) return null
  if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt) || rec.updatedAt <= 0) return null

  const out: PersistedSessionBinding = {
    dshSessionKey,
    acpSessionId: rec.acpSessionId,
    accountId: rec.accountId,
    cwd: rec.cwd,
    policyFingerprint: rec.policyFingerprint,
    updatedAt: Math.round(rec.updatedAt),
  }
  if (typeof rec.appliedSystemHash === 'string' && isSafeString(rec.appliedSystemHash, 256)) {
    out.appliedSystemHash = rec.appliedSystemHash
  } else if (rec.appliedSystemHash === null) {
    out.appliedSystemHash = null
  }
  if (typeof rec.title === 'string' && rec.title.trim()) {
    const cleanTitle = sanitizeDiagnosticText(rec.title, 120)
    if (cleanTitle) out.title = cleanTitle
  }
  return out
}

/**
 * Lightweight, bounded, `0600` atomic session index mapping `dshSessionKey` -> `acpSessionId`
 * for native ACP `session/load` recovery across idle sweeps and restarts.
 * Never persists conversation messages, credentials, or environment variables.
 */
export class SessionIndex {
  readonly filePath: string
  private readonly maxEntries: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly log?: (msg: string) => void
  private readonly entries = new Map<string, PersistedSessionBinding>()
  private loaded = false

  constructor(opts: SessionIndexOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.now = opts.now ?? (() => Date.now())
    this.log = opts.log
    let resolved: string
    try {
      resolved = resolveSessionIndexPath(opts.filePath)
    } catch {
      this.log?.('invalid DSH_AGY_ACP_SESSIONS_PATH ignored; using default sessions index path')
      resolved = path.join(os.homedir(), '.dsh', 'agy-acp', 'sessions.json')
    }
    this.filePath = resolved
  }

  get size(): number {
    this.ensureLoaded()
    this.pruneExpiredInMemory()
    return this.entries.size
  }

  load(): void {
    this.loaded = true
    this.entries.clear()
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.filePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT') {
        this.log?.(`session index stat warning: ${sanitizeDiagnosticText(String(err), 160)}`)
      }
      return
    }

    if (!stat.isFile() || stat.size > MAX_INDEX_FILE_BYTES) {
      this.log?.('session index skipped (not a regular file or exceeds size cap)')
      return
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const root = parsed as Record<string, unknown>
      const sessionsNode =
        root.sessions && typeof root.sessions === 'object' && !Array.isArray(root.sessions)
          ? (root.sessions as Record<string, unknown>)
          : {}
      const cutoff = this.now() - this.maxAgeMs
      const valid: PersistedSessionBinding[] = []
      for (const [key, raw] of Object.entries(sessionsNode)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
        const item = sanitizeBinding(raw, key)
        if (!item || item.updatedAt < cutoff) continue
        valid.push(item)
      }
      valid.sort((a, b) => b.updatedAt - a.updatedAt)
      for (const item of valid.slice(0, this.maxEntries)) {
        this.entries.set(item.dshSessionKey, item)
      }
    } catch (err) {
      this.log?.(`session index parse warning: ${sanitizeDiagnosticText(String(err), 160)}`)
      this.entries.clear()
    }
  }

  get(dshSessionKey: string): PersistedSessionBinding | undefined {
    this.ensureLoaded()
    const item = this.entries.get(dshSessionKey)
    if (!item) return undefined
    if (this.now() - item.updatedAt > this.maxAgeMs) {
      this.entries.delete(dshSessionKey)
      this.flushBestEffort()
      return undefined
    }
    return { ...item }
  }

  upsert(binding: Omit<PersistedSessionBinding, 'updatedAt'> & { updatedAt?: number }): void {
    this.ensureLoaded()
    const candidate = sanitizeBinding(
      {
        ...binding,
        updatedAt: binding.updatedAt ?? this.now(),
      },
      binding.dshSessionKey,
    )
    if (!candidate) return
    this.entries.delete(candidate.dshSessionKey)
    this.entries.set(candidate.dshSessionKey, candidate)
    this.pruneAndCapInMemory()
    this.flushBestEffort()
  }

  updateMeta(
    dshSessionKey: string,
    patch: { appliedSystemHash?: string | null; title?: string; touch?: boolean },
  ): void {
    this.ensureLoaded()
    const current = this.entries.get(dshSessionKey)
    if (!current) return
    const next: PersistedSessionBinding = {
      ...current,
      ...(patch.appliedSystemHash !== undefined ? { appliedSystemHash: patch.appliedSystemHash } : {}),
      ...(patch.title !== undefined
        ? { title: sanitizeDiagnosticText(patch.title, 120) || undefined }
        : {}),
      updatedAt: patch.touch === false ? current.updatedAt : this.now(),
    }
    this.entries.set(dshSessionKey, next)
    this.flushBestEffort()
  }

  delete(dshSessionKey: string): boolean {
    this.ensureLoaded()
    const existed = this.entries.delete(dshSessionKey)
    if (existed) {
      this.flushBestEffort()
    }
    return existed
  }

  clear(): void {
    this.loaded = true
    this.entries.clear()
    try {
      rmSync(this.filePath, { force: true })
    } catch {
      // ignore
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load()
    }
  }

  private pruneExpiredInMemory(): void {
    const cutoff = this.now() - this.maxAgeMs
    for (const [k, v] of this.entries) {
      if (v.updatedAt < cutoff) {
        this.entries.delete(k)
      }
    }
  }

  private pruneAndCapInMemory(): void {
    this.pruneExpiredInMemory()
    if (this.entries.size <= this.maxEntries) return
    const sorted = Array.from(this.entries.values()).sort((a, b) => b.updatedAt - a.updatedAt)
    this.entries.clear()
    for (const item of sorted.slice(0, this.maxEntries)) {
      this.entries.set(item.dshSessionKey, item)
    }
  }

  private flushBestEffort(): void {
    try {
      const dir = path.dirname(this.filePath)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const sessionsObj: Record<string, PersistedSessionBinding> = {}
      for (const [k, v] of this.entries) {
        sessionsObj[k] = v
      }
      const tmpPath = path.join(dir, `.sessions.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
      const payload = JSON.stringify({ version: 1, sessions: sessionsObj }, null, 2) + '\n'
      try {
        writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        renameSync(tmpPath, this.filePath)
      } catch (err) {
        try {
          rmSync(tmpPath, { force: true })
        } catch {
          // ignore
        }
        throw err
      }
    } catch (err) {
      this.log?.(`session index write warning: ${sanitizeDiagnosticText(String(err), 160)}`)
    }
  }
}
