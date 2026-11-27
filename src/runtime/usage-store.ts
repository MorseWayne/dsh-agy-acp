import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyModelFamily, MODEL_FAMILY_ORDER } from '../common/account-routing.ts'
import { addUsageCounters, emptyUsageCounter, localDateKey, USAGE_RETENTION_DAYS } from '../common/account-usage.ts'
import type { AccountUsageEntry, AccountUsageSnapshot, AccountUsageWindowSnapshot, ModelFamily, UsageCounter } from '../common/types.ts'

const MAX_BYTES = 2 * 1024 * 1024
const ZERO = emptyUsageCounter()
type StoredAccountUsage = Pick<AccountUsageEntry, 'totals' | 'families' | 'lastUsedAt'>
interface Bucket { accounts: Record<string, StoredAccountUsage> }
interface UsageFile {
  version: 1
  allTime: Bucket
  daily: Record<string, Bucket>
  labels: Record<string, string>
  updatedAt: number
}
interface Attribution { accountId: string; accountLabel?: string; model?: string; now?: number }
export interface UsageStoreOptions { filePath?: string; persist?: boolean; log?: (msg: string) => void }

// Account IDs are data, including strings like "constructor", not object properties to inherit.
function dict<T>(): Record<string, T> { return Object.create(null) }
function bucket(): Bucket { return { accounts: dict() } }
function blank(updatedAt = 0): UsageFile {
  return { version: 1, allTime: bucket(), daily: dict(), labels: dict(), updatedAt }
}

export function resolveUsageStorePath(explicitPath?: string): string {
  const raw = explicitPath ?? process.env.DSH_AGY_ACP_USAGE_PATH
  if (raw === undefined) return path.join(os.homedir(), '.dsh', 'agy-acp', 'usage.json')
  if (!raw.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) throw new Error('Invalid usage store path')
  return path.resolve(raw.trim())
}

function firstDay(now: number, days: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() - days + 1) // local calendar arithmetic, including DST
  return localDateKey(date.getTime())
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function uint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function malformed(): never { throw new Error('Invalid usage file') }
function decodeCounter(raw: unknown): UsageCounter {
  if (!object(raw)) return malformed()
  const counter = emptyUsageCounter()
  for (const key of Object.keys(counter) as (keyof UsageCounter)[]) {
    const n = raw[key]
    if (!uint(n)) return malformed()
    counter[key] = n
  }
  if (counter.totalTokens !== counter.inputTokens + counter.cachedReadTokens + counter.cachedWriteTokens + counter.outputTokens) return malformed()
  return counter
}
function decodeBucket(raw: unknown): Bucket {
  if (!object(raw) || !object(raw.accounts)) return malformed()
  const out = bucket()
  for (const [id, row] of Object.entries(raw.accounts)) {
    if (!id || !object(row) || !object(row.families) || !(row.lastUsedAt === null || uint(row.lastUsedAt))) return malformed()
    const families: StoredAccountUsage['families'] = {}
    for (const [key, value] of Object.entries(row.families)) {
      if (!MODEL_FAMILY_ORDER.includes(key as ModelFamily)) return malformed()
      families[key as ModelFamily] = decodeCounter(value)
    }
    out.accounts[id] = { totals: decodeCounter(row.totals), families, lastUsedAt: row.lastUsedAt }
  }
  return out
}
function decode(raw: unknown): UsageFile {
  if (!object(raw) || raw.version !== 1 || !object(raw.daily) || !object(raw.labels) || !uint(raw.updatedAt)) return malformed()
  const file = blank(raw.updatedAt)
  file.allTime = decodeBucket(raw.allTime)
  for (const [day, value] of Object.entries(raw.daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || localDateKey(new Date(`${day}T12:00:00`).getTime()) !== day) return malformed()
    file.daily[day] = decodeBucket(value)
  }
  for (const [id, label] of Object.entries(raw.labels)) {
    if (!id || typeof label !== 'string') return malformed()
    file.labels[id] = label
  }
  return file
}

function mergeRow(bucket: Bucket, id: string, delta: StoredAccountUsage): void {
  const row = bucket.accounts[id] ??= { totals: emptyUsageCounter(), families: {}, lastUsedAt: null }
  row.totals = addUsageCounters(row.totals, delta.totals)
  for (const family of MODEL_FAMILY_ORDER) {
    const usage = delta.families[family]
    if (usage) row.families[family] = addUsageCounters(row.families[family] ?? ZERO, usage)
  }
  if (delta.lastUsedAt !== null) row.lastUsedAt = Math.max(row.lastUsedAt ?? 0, delta.lastUsedAt)
}

export class UsageStore {
  readonly filePath: string
  private data = blank()
  private dirty = false
  private timer?: NodeJS.Timeout
  constructor(private readonly opts: UsageStoreOptions = {}) {
    // The in-memory store does not consult even the host's path override.
    this.filePath = opts.persist === false ? '' : resolveUsageStorePath(opts.filePath)
  }

  load(): void {
    if (this.opts.persist === false) return
    this.cancelTimer()
    this.dirty = false
    let fd: number | undefined
    try {
      // Inspect and bound the opened file, not a previously statted path.
      fd = openSync(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_BYTES) malformed()
      const buf = Buffer.alloc(stat.size)
      if (readSync(fd, buf, 0, buf.length, 0) !== buf.length || fstatSync(fd).size !== buf.length) malformed()
      this.data = decode(JSON.parse(buf.toString('utf8')))
      this.prune(Date.now())
    } catch (err) {
      this.data = blank()
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') this.opts.log?.('usage store unreadable, oversized or malformed; using empty statistics')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  recordTurn(input: Attribution & { usage?: Partial<UsageCounter>; countRequest?: boolean }): void {
    const totals = addUsageCounters(ZERO, { ...input.usage, requests: input.countRequest ? 1 : 0, rateLimited: 0, failed: 0 })
    if (totals.requests || totals.totalTokens || totals.reasoningTokens) this.record(input, totals)
  }
  recordFailure(input: Attribution & { rateLimited: boolean }): void {
    const totals = emptyUsageCounter()
    totals[input.rateLimited ? 'rateLimited' : 'failed'] = 1
    this.record(input, totals)
  }
  private record(input: Attribution, totals: UsageCounter): void {
    if (!input.accountId) return
    const now = input.now ?? Date.now()
    const family = classifyModelFamily(input.model ?? '')
    const row = { totals, families: { [family]: totals }, lastUsedAt: now }
    mergeRow(this.data.allTime, input.accountId, row)
    const day = localDateKey(now)
    mergeRow(this.data.daily[day] ??= bucket(), input.accountId, row)
    if (input.accountLabel) this.data.labels[input.accountId] = input.accountLabel
    this.data.updatedAt = Math.max(now, this.data.updatedAt)
    this.prune(this.data.updatedAt)
    this.markDirty()
  }
  private prune(now: number): void {
    const start = firstDay(now, USAGE_RETENTION_DAYS), end = localDateKey(now)
    for (const key of Object.keys(this.data.daily)) {
      if (key < start || key > end) {
        delete this.data.daily[key]
        this.markDirty()
      }
    }
  }

  getSnapshot(opts: { now?: number; liveLabels?: ReadonlyMap<string, string> } = {}): AccountUsageSnapshot {
    const now = opts.now ?? Date.now()
    this.prune(now)
    const day = localDateKey(now), weekStart = firstDay(now, 7)
    const window = (buckets: Bucket[]): AccountUsageWindowSnapshot => {
      const merged = bucket()
      for (const b of buckets) for (const [id, row] of Object.entries(b.accounts)) mergeRow(merged, id, row)
      let totals = emptyUsageCounter()
      const accounts = Object.entries(merged.accounts).map(([accountId, row]) => {
        totals = addUsageCounters(totals, row.totals)
        return { ...row, accountId, accountLabel: opts.liveLabels?.get(accountId) ?? this.data.labels[accountId] ?? accountId }
      })
      accounts.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || b.totals.requests - a.totals.requests ||
        (b.totals.rateLimited - a.totals.rateLimited) + (b.totals.failed - a.totals.failed) ||
        (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))
      return { accounts, totals }
    }
    return { today: window([this.data.daily[day] ?? bucket()]),
      last7Days: window(Object.entries(this.data.daily).filter(([key]) => key >= weekStart && key <= day).map(([, b]) => b)),
      allTime: window([this.data.allTime]), retentionDays: USAGE_RETENTION_DAYS, updatedAt: this.data.updatedAt }
  }

  private cancelTimer(): void { clearTimeout(this.timer); this.timer = undefined }
  private markDirty(): void {
    if (this.opts.persist === false) return
    this.dirty = true
    if (!this.timer) this.timer = setTimeout(() => {
      try { this.flush() } catch { this.opts.log?.('usage store write failed; keeping pending statistics in memory') }
    }, 500).unref()
  }
  private save(data: UsageFile): void {
    if (this.opts.persist === false) return
    const payload = JSON.stringify(data) + '\n'
    if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error('Usage statistics exceed file size limit')
    const dir = path.dirname(this.filePath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = path.join(dir, `.usage.${randomUUID()}.tmp`)
    try {
      writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') rmSync(tmp, { force: true })
      throw err
    }
  }
  flush(): void {
    this.cancelTimer()
    if (!this.dirty) return
    this.save(this.data)
    this.dirty = false
  }
  reset(now = Date.now()): void {
    const next = blank(now)
    this.save(next) // Only publish the reset after the atomic replacement succeeds.
    this.cancelTimer()
    this.data = next
    this.dirty = false
  }
  dispose(): void { this.flush() }
}
