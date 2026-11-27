import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ACCOUNT_ID_RE,
  DEFAULT_ACCOUNT_ID,
  MAX_ACCOUNT_LABEL_LEN,
  slugifyAccountId,
  slugifyEmailToAccountId,
  validateManagedAccountCreateInput,
  validateManagedAccountUpdateInput,
  validateProxyUrl,
} from '../common/account-validation.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { AccountAuthStatus, AccountProfileConfig, ManagedAccountRecord } from '../common/types.ts'
import { fetchViaEnvProxy } from './egress-guard.ts'

const MAX_ACCOUNTS_FILE_BYTES = 128 * 1024
const MAX_MANAGED_ACCOUNTS = 32
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const PENDING_ID_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/
const PENDING_DIR_PREFIX = '.pending-'
const STALE_PENDING_MS = 60 * 60_000
const EMAIL_CANDIDATE_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
/** Sentinel value that instructs `agy` >= 1.5 to use isolated file-backed OAuth tokens instead of the shared OS keyring. */
export const MANAGED_ACCOUNT_SSH_SENTINEL = '127.0.0.1 0 127.0.0.1 0'

export class AccountStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface AccountStoreOptions {
  filePath?: string
  accountsRootDir?: string
  log?: (msg: string) => void
}

interface PersistedAccountsPayload {
  version: 1
  defaultAccountEnabled: boolean
  defaultAuthVerifiedAt?: number | null
  preferredAccountId?: string | null
  accounts: ManagedAccountRecord[]
}

export function resolveAccountStorePath(explicitPath?: string): string {
  const candidate = explicitPath?.trim() || process.env.DSH_AGY_ACP_ACCOUNTS_PATH?.trim() || ''
  if (candidate) {
    if (CONTROL_CHAR_RE.test(candidate)) throw new Error('Invalid accounts store path')
    return path.resolve(candidate)
  }
  return path.join(os.homedir(), '.dsh', 'agy-acp', 'accounts.json')
}

export function resolveManagedAccountsRootDir(explicitRoot?: string, storeFilePath?: string): string {
  if (explicitRoot?.trim()) {
    if (CONTROL_CHAR_RE.test(explicitRoot)) throw new Error('Invalid accounts root directory')
    return path.resolve(explicitRoot.trim())
  }
  const baseDir = storeFilePath ? path.dirname(storeFilePath) : path.join(os.homedir(), '.dsh', 'agy-acp')
  return path.join(baseDir, 'accounts')
}

/**
 * Inspects whether a given account HOME has a valid local OAuth token file written by `agy`.
 * Never returns or logs token material — only reports boolean login readiness.
 */
export function hasLocalOAuthTokenFile(accountHome: string): boolean {
  for (const { token } of localOAuthFiles(accountHome)) {
    if ([token.access_token, token.refresh_token].some(v => typeof v === 'string' && v.trim())) return true
  }
  return false
}

function* localOAuthFiles(accountHome: string) {
  if (!accountHome || !path.isAbsolute(accountHome)) return
  for (const store of ['antigravity-acp', 'antigravity-cli']) {
    const parsed = readLocalOAuthFile(accountHome, store)
    if (parsed) yield parsed
  }
}

function readLocalOAuthFileAt(baseDir: string, relativeParts: readonly string[]) {
  if (!baseDir || !path.isAbsolute(baseDir)) return null
  const tokenFile = path.join(baseDir, ...relativeParts)
  let fd: number | undefined
  try {
    const info = lstatSync(tokenFile)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > 64 * 1024) return null
    if (process.getuid && info.uid !== process.getuid()) return null
    if (realpathSync(tokenFile) !== path.join(realpathSync(baseDir), ...relativeParts)) return null
    fd = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.uid !== info.uid) return null
    const buf = Buffer.alloc(opened.size)
    try {
      if (readSync(fd, buf, 0, buf.length, 0) !== buf.length || fstatSync(fd).mtimeMs !== opened.mtimeMs) return null
      const parsed: unknown = JSON.parse(buf.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const root = parsed as Record<string, unknown>
      const nested = root.token
      const token = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : root
      return { root, token }
    } finally {
      buf.fill(0)
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readLocalOAuthFile(home: string, store: string) {
  return readLocalOAuthFileAt(home, ['.gemini', store, 'antigravity-oauth-token'])
}

function hasTokenMaterial(parsed: { token: Record<string, unknown> } | null): boolean {
  if (!parsed) return false
  return [parsed.token.access_token, parsed.token.refresh_token].some(v => typeof v === 'string' && v.trim())
}

function hasAmbientLocalOAuthTokenFile(env: NodeJS.ProcessEnv = process.env): boolean {
  const homes = new Set<string>()
  const addAbs = (set: Set<string>, raw: string | undefined): void => {
    const trimmed = raw?.trim()
    if (trimmed && path.isAbsolute(trimmed)) set.add(path.resolve(trimmed))
  }
  addAbs(homes, os.homedir())
  addAbs(homes, env.HOME)
  for (const home of homes) {
    if (hasLocalOAuthTokenFile(home)) return true
  }
  const geminiDirs = new Set<string>()
  addAbs(geminiDirs, env.GEMINI_HOME)
  addAbs(geminiDirs, env.ANTIGRAVITY_GEMINI_DIR)
  for (const dir of geminiDirs) {
    for (const store of ['antigravity-acp', 'antigravity-cli']) {
      if (hasTokenMaterial(readLocalOAuthFileAt(dir, [store, 'antigravity-oauth-token']))) return true
    }
  }
  const appDataDir = env.ANTIGRAVITY_APP_DATA_DIR?.trim()
  if (appDataDir && path.isAbsolute(appDataDir)) {
    if (hasTokenMaterial(readLocalOAuthFileAt(path.resolve(appDataDir), ['antigravity-oauth-token']))) return true
  }
  return false
}

export function inspectAccountAuthStatus(
  profile: AccountProfileConfig,
  opts?: { defaultConnected?: boolean; defaultAuthFailed?: boolean; env?: NodeJS.ProcessEnv },
): AccountAuthStatus {
  if (profile.homeDir) {
    return hasLocalOAuthTokenFile(profile.homeDir) ? 'logged_in' : 'not_logged_in'
  }
  if (hasAmbientLocalOAuthTokenFile(opts?.env)) return 'logged_in'
  if (opts?.defaultAuthFailed) return 'not_logged_in'
  if (opts?.defaultConnected) return 'logged_in'
  return 'unknown'
}

export interface DetectedGoogleIdentity {
  email?: string
  name?: string
}

function cleanIdentityField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (CONTROL_CHAR_RE.test(raw)) return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_ACCOUNT_LABEL_LEN) return undefined
  return trimmed
}

function cleanEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || CONTROL_CHAR_RE.test(raw)) return undefined
  const trimmed = raw.trim()
  return trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
}

function decodeJwtPayload(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function extractEmailFromCliOutput(rawOutput: string | undefined): string | undefined {
  if (!rawOutput) return undefined
  // Strip OAuth URLs first so query parameters cannot yield false matches.
  const withoutUrls = rawOutput.replace(/https?:\/\/\S+/gi, ' ')
  const matches = withoutUrls.match(EMAIL_CANDIDATE_RE)
  if (!matches) return undefined
  for (const candidate of matches) {
    const clean = cleanEmail(candidate.toLowerCase())
    if (clean) return clean
  }
  return undefined
}

/**
 * Best-effort detection of the signed-in Google account's email / display name from an isolated
 * account HOME after `agy acp --login` completes. Never logs or returns raw OAuth tokens and never throws.
 */
export async function detectAccountIdentityFromHome(
  accountHome: string,
  opts?: {
    env?: NodeJS.ProcessEnv
    outputText?: string
    fetcher?: typeof fetchViaEnvProxy
  },
): Promise<DetectedGoogleIdentity> {
  let email: string | undefined
  let name: string | undefined
  let accessToken: string | undefined

  for (const { root, token } of localOAuthFiles(accountHome)) {
    email = cleanEmail(root.email) ?? cleanEmail(token.email)
    name = cleanIdentityField(root.name) ?? cleanIdentityField(token.name)
    if (!email) {
      const claims = decodeJwtPayload(token.id_token ?? root.id_token)
      email = cleanEmail(claims?.email)
      name ??= cleanIdentityField(claims?.name)
    }
    if (email) break
    if (typeof token.access_token === 'string' && token.access_token.trim()) {
      accessToken = token.access_token.trim()
      break
    }
  }

  if (!email) {
    email = extractEmailFromCliOutput(opts?.outputText)
  }

  if (!email && accessToken) {
    const fetcher = opts?.fetcher ?? fetchViaEnvProxy
    const routeEnv: NodeJS.ProcessEnv = {}
    if (opts?.env) {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
        if (opts.env[key] !== undefined) routeEnv[key] = opts.env[key]
      }
    }
    try {
      const res = await fetcher({
        url: GOOGLE_USERINFO_URL,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        env: routeEnv,
        timeoutMs: 4_000,
      })
      if (res.statusCode >= 200 && res.statusCode < 300 && res.body) {
        const info = JSON.parse(res.body) as unknown
        if (info && typeof info === 'object' && !Array.isArray(info)) {
          const rec = info as Record<string, unknown>
          email = cleanEmail(rec.email)
          name = name ?? cleanIdentityField(rec.name)
        }
      }
    } catch {
      // ignore network failure; fallback naming handles it cleanly
    }
  }

  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  }
}

/**
 * Atomic, 0600-protected JSON persistence for console-managed isolated multi-account profiles.
 * Managed account homes are strictly confined under `<accountsRootDir>/<accountId>`.
 */
export class AccountStore {
  readonly filePath: string
  readonly accountsRootDir: string
  private accounts: ManagedAccountRecord[] = []
  private defaultAccountEnabled = true
  private defaultAuthVerifiedAt: number | null = null
  private preferredAccountId: string | null = null
  private loaded = false
  private readonly log?: (msg: string) => void

  constructor(opts: AccountStoreOptions = {}) {
    this.log = opts.log
    let resolvedFile: string
    try {
      resolvedFile = resolveAccountStorePath(opts.filePath)
    } catch {
      this.log?.('invalid DSH_AGY_ACP_ACCOUNTS_PATH ignored; using default accounts path')
      resolvedFile = path.join(os.homedir(), '.dsh', 'agy-acp', 'accounts.json')
    }
    this.filePath = resolvedFile
    this.accountsRootDir = resolveManagedAccountsRootDir(opts.accountsRootDir, this.filePath)
  }

  load(): { accounts: ManagedAccountRecord[]; defaultAccountEnabled: boolean } {
    this.loaded = true
    this.preferredAccountId = null
    this.defaultAuthVerifiedAt = null
    this.cleanupStalePendingHomes()
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.filePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT') {
        this.log?.(`account store stat warning: ${sanitizeDiagnosticText(String(err), 160)}`)
      }
      this.accounts = []
      this.defaultAccountEnabled = true
      return { accounts: [], defaultAccountEnabled: true }
    }

    if (!stat.isFile() || stat.size > MAX_ACCOUNTS_FILE_BYTES) {
      this.log?.('account store invalid or oversized; falling back to empty list')
      this.accounts = []
      this.defaultAccountEnabled = true
      return { accounts: [], defaultAccountEnabled: true }
    }

    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.accounts = []
        this.defaultAccountEnabled = true
        return { accounts: [], defaultAccountEnabled: true }
      }
      const root = parsed as Record<string, unknown>
      this.defaultAccountEnabled = typeof root.defaultAccountEnabled === 'boolean' ? root.defaultAccountEnabled : true
      const rawList = Array.isArray(root.accounts) ? root.accounts : []
      const seen = new Set<string>()
      const valid: ManagedAccountRecord[] = []
      for (const item of rawList) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const rec = item as Record<string, unknown>
        const id = typeof rec.id === 'string' ? rec.id.trim().toLowerCase() : ''
        if (!id || id === DEFAULT_ACCOUNT_ID || !ACCOUNT_ID_RE.test(id) || seen.has(id)) continue
        const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim().slice(0, 64) : id
        const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : true
        const proxyChecked = validateProxyUrl(rec.proxyUrl)
        const proxyUrl = proxyChecked.ok && proxyChecked.value ? proxyChecked.value : undefined
        const now = Date.now()
        const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : now
        const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : createdAt
        seen.add(id)
        const email = cleanEmail(rec.email) ?? cleanEmail(rec.label)
        valid.push({ id, label, enabled, ...(email ? { email } : {}), ...(proxyUrl ? { proxyUrl } : {}), createdAt, updatedAt })
        if (valid.length >= MAX_MANAGED_ACCOUNTS) break
      }
      this.accounts = valid
      const verifiedAt = root.defaultAuthVerifiedAt
      if (typeof verifiedAt === 'number' && Number.isFinite(verifiedAt) && verifiedAt > 0) {
        this.defaultAuthVerifiedAt = verifiedAt
      }
      const preferred = root.preferredAccountId
      // Host-configured IDs are resolved against effective profiles by the scheduler.
      if (typeof preferred === 'string' && preferred.trim() && !CONTROL_CHAR_RE.test(preferred)) {
        this.preferredAccountId = preferred
      }
      return { accounts: this.listManaged(), defaultAccountEnabled: this.defaultAccountEnabled }
    } catch (err) {
      this.log?.(`account store parse warning: ${sanitizeDiagnosticText(String(err), 160)}`)
      this.accounts = []
      this.defaultAccountEnabled = true
      return { accounts: [], defaultAccountEnabled: true }
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  private persist(
    nextAccounts: ManagedAccountRecord[],
    nextDefaultEnabled: boolean,
    nextPreferred = this.preferredAccountId,
    nextDefaultAuthVerifiedAt = this.defaultAuthVerifiedAt,
  ): void {
    const dir = path.dirname(this.filePath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmpPath = path.join(dir, `.accounts.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
    const payload: PersistedAccountsPayload = {
      version: 1,
      defaultAccountEnabled: nextDefaultEnabled,
      ...(nextDefaultAuthVerifiedAt !== null ? { defaultAuthVerifiedAt: nextDefaultAuthVerifiedAt } : {}),
      preferredAccountId: nextPreferred,
      accounts: nextAccounts,
    }
    const content = JSON.stringify(payload, null, 2) + '\n'
    try {
      writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // ignore
      }
      throw err
    }
    this.accounts = nextAccounts
    this.defaultAccountEnabled = nextDefaultEnabled
    this.preferredAccountId = nextPreferred
    this.defaultAuthVerifiedAt = nextDefaultAuthVerifiedAt
  }

  listManaged(): ManagedAccountRecord[] {
    this.ensureLoaded()
    return this.accounts.map((a) => ({ ...a }))
  }

  isDefaultAuthVerified(): boolean {
    this.ensureLoaded()
    return this.defaultAuthVerifiedAt !== null
  }

  setDefaultAuthVerified(verified: boolean): boolean {
    this.ensureLoaded()
    const currently = this.defaultAuthVerifiedAt !== null
    if (verified === currently) return false
    this.persist(
      this.accounts,
      this.defaultAccountEnabled,
      this.preferredAccountId,
      verified ? Date.now() : null,
    )
    return true
  }

  getPreferredAccountId(): string | null {
    this.ensureLoaded()
    return this.preferredAccountId
  }

  setPreferredAccount(accountId: string | null, validIds?: ReadonlySet<string>): string | null {
    this.ensureLoaded()
    if (accountId !== null) {
      const managed = this.accounts.find(a => a.id === accountId)
      if (validIds ? !validIds.has(accountId) : !managed && accountId !== DEFAULT_ACCOUNT_ID) {
        throw new AccountStoreError('未找到该账号', 404)
      }
      if (managed?.enabled === false || (accountId === DEFAULT_ACCOUNT_ID && !this.defaultAccountEnabled)) {
        throw new AccountStoreError('账号已停用', 409)
      }
    }
    if (this.preferredAccountId !== accountId) this.persist(this.accounts, this.defaultAccountEnabled, accountId)
    return accountId
  }

  isDefaultAccountEnabled(): boolean {
    this.ensureLoaded()
    return this.defaultAccountEnabled
  }

  resolveManagedAccountHome(id: string): string {
    const clean = id.trim().toLowerCase()
    if (!ACCOUNT_ID_RE.test(clean) || clean === DEFAULT_ACCOUNT_ID) {
      throw new AccountStoreError('无效的托管账号 ID', 400)
    }
    const root = path.resolve(this.accountsRootDir)
    const target = path.resolve(root, clean)
    if (!target.startsWith(root + path.sep)) {
      throw new AccountStoreError('账号隔离目录越界，已拒绝操作', 400)
    }
    return target
  }

  ensureManagedAccountHome(id: string): string {
    return this.prepareOAuthHome(this.resolveManagedAccountHome(id))
  }

  resolvePendingAccountHome(pendingId: string): string {
    const clean = pendingId.trim().toLowerCase()
    if (!PENDING_ID_RE.test(clean)) {
      throw new AccountStoreError('无效的临时登录目录标识', 400)
    }
    const root = path.resolve(this.accountsRootDir)
    const target = path.resolve(root, `${PENDING_DIR_PREFIX}${clean}`)
    if (!target.startsWith(root + path.sep)) {
      throw new AccountStoreError('临时登录目录越界，已拒绝操作', 400)
    }
    return target
  }

  preparePendingAccountHome(pendingId: string): string {
    return this.prepareOAuthHome(this.resolvePendingAccountHome(pendingId))
  }

  private prepareOAuthHome(home: string): string {
    for (const store of ['antigravity-acp', 'antigravity-cli']) {
      mkdirSync(path.join(home, '.gemini', store), { recursive: true, mode: 0o700 })
    }
    return home
  }

  cleanupPendingAccountHome(pendingId: string): void {
    try {
      const target = this.resolvePendingAccountHome(pendingId)
      const realRoot = realpathSync(this.accountsRootDir)
      const info = lstatSync(target)
      if (!info.isSymbolicLink() && info.isDirectory() && realpathSync(target).startsWith(realRoot + path.sep)) {
        rmSync(target, { recursive: true, force: true })
      }
    } catch {
      // ignore missing or already-removed pending home
    }
  }

  private cleanupStalePendingHomes(): void {
    try {
      const realRoot = realpathSync(this.accountsRootDir)
      const cutoff = Date.now() - STALE_PENDING_MS
      for (const entry of readdirSync(realRoot)) {
        if (!entry.startsWith(PENDING_DIR_PREFIX)) continue
        const full = path.join(realRoot, entry)
        try {
          const info = lstatSync(full)
          if (!info.isSymbolicLink() && info.isDirectory() && info.mtimeMs < cutoff) {
            rmSync(full, { recursive: true, force: true })
          }
        } catch {
          // ignore individual entry errors
        }
      }
    } catch {
      // ignore when root dir does not exist yet
    }
  }

  /**
   * Commits a successfully signed-in pending isolated HOME into a first-class managed account.
   * Automatically derives label & unique ID from the detected Google email/name (or sequential fallback).
   */
  commitPendingAccount(opts: {
    pendingId: string
    email?: string
    name?: string
    proxyUrl?: string
    reservedHostIds?: ReadonlySet<string>
  }): ManagedAccountRecord {
    this.ensureLoaded()
    const pendingHome = this.resolvePendingAccountHome(opts.pendingId)
    const proxyChecked = validateProxyUrl(opts.proxyUrl)
    if (!proxyChecked.ok) {
      throw new AccountStoreError(proxyChecked.error, 400)
    }

    const email = cleanEmail(opts.email)
    const existing = email ? this.accounts.find(a => (a.email ?? a.label).toLowerCase() === email.toLowerCase()) : undefined
    if (existing && opts.reservedHostIds?.has(existing.id)) throw new AccountStoreError('账号 ID 与宿主配置冲突', 409)
    if (!existing && this.accounts.length >= MAX_MANAGED_ACCOUNTS) {
      throw new AccountStoreError(`最多支持托管 ${MAX_MANAGED_ACCOUNTS} 个账号`, 400)
    }
    const name = cleanIdentityField(opts.name)
    const fallbackNum = this.accounts.length + 1
    const label = (email ?? name ?? `Google 账号 #${fallbackNum}`).slice(0, MAX_ACCOUNT_LABEL_LEN)
    const baseId = email
      ? slugifyEmailToAccountId(email, `g${fallbackNum}`)
      : name
        ? slugifyAccountId(name, `g${fallbackNum}`)
        : `google-${fallbackNum}`

    const reservedHostIds = opts.reservedHostIds ?? new Set<string>()
    const taken = (candidate: string): boolean =>
      candidate === DEFAULT_ACCOUNT_ID || reservedHostIds.has(candidate) || this.accounts.some((a) => a.id === candidate)

    let id = existing?.id ?? baseId
    if (!existing && taken(id)) {
      let found: string | null = null
      for (let i = 2; i <= 99; i++) {
        const suffix = `-${i}`
        const candidate = `${baseId.slice(0, 32 - suffix.length)}${suffix}`
        if (!taken(candidate)) {
          found = candidate
          break
        }
      }
      id = found ?? `acct-${randomUUID().slice(0, 8)}`
    }

    const targetHome = this.resolveManagedAccountHome(id)
    const realRoot = realpathSync(this.accountsRootDir)
    const assertOwnedHome = (home: string): void => {
      const info = lstatSync(home)
      if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) ||
          realpathSync(home) !== path.join(realRoot, path.basename(home))) {
        throw new AccountStoreError('账号隔离目录不安全，已拒绝替换', 409)
      }
    }
    assertOwnedHome(pendingHome)
    const now = Date.now()
    const proxyUrl = opts.proxyUrl === undefined ? existing?.proxyUrl : proxyChecked.value
    const record: ManagedAccountRecord = {
      id,
      label: existing?.label ?? label,
      ...(email ? { email } : {}),
      enabled: true,
      ...(proxyUrl ? { proxyUrl } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const nextList = existing ? this.accounts.map(a => a === existing ? record : a) : [...this.accounts, record]
    // Stage the old (or orphaned) HOME until both renames and the metadata write succeed.
    let backup: string | undefined
    if (lstatSync(targetHome, { throwIfNoEntry: false })) {
      assertOwnedHome(targetHome)
      backup = path.join(realRoot, `.backup-${randomUUID()}`)
      renameSync(targetHome, backup)
    }
    let installed = false
    try {
      renameSync(pendingHome, targetHome)
      installed = true
      this.persist(nextList, this.accounts.length === 0 ? false : this.defaultAccountEnabled, id)
    } catch (err) {
      if (installed) renameSync(targetHome, pendingHome)
      if (backup) renameSync(backup, targetHome)
      throw err
    }
    if (backup) {
      try { rmSync(backup, { recursive: true }) } catch { this.log?.('could not remove superseded managed account HOME backup') }
    }
    return { ...record }
  }

  addAccount(
    body: Record<string, unknown>,
    reservedHostIds: ReadonlySet<string> = new Set(),
  ): ManagedAccountRecord {
    this.ensureLoaded()
    if (this.accounts.length >= MAX_MANAGED_ACCOUNTS) {
      throw new AccountStoreError(`最多支持托管 ${MAX_MANAGED_ACCOUNTS} 个账号`, 400)
    }

    // If user omitted ID and slug already exists, append a numeric suffix automatically.
    const rawIdMissing = body.id === undefined || body.id === null || (typeof body.id === 'string' && !body.id.trim())
    const parsed = validateManagedAccountCreateInput(body)
    if (!parsed.ok) {
      throw new AccountStoreError(parsed.error, 400)
    }

    let id = parsed.value.id
    const taken = (candidate: string): boolean =>
      candidate === DEFAULT_ACCOUNT_ID || reservedHostIds.has(candidate) || this.accounts.some((a) => a.id === candidate)

    if (taken(id)) {
      if (!rawIdMissing) {
        throw new AccountStoreError(`账号 ID "${id}" 已存在，请换一个名称或 ID`, 409)
      }
      let found: string | null = null
      for (let i = 2; i <= 99; i++) {
        const suffix = `-${i}`
        const candidate = `${id.slice(0, 32 - suffix.length)}${suffix}`
        if (!taken(candidate)) {
          found = candidate
          break
        }
      }
      if (!found) {
        throw new AccountStoreError('无法自动生成唯一账号 ID，请手动填写账号 ID', 409)
      }
      id = found
    }

    this.ensureManagedAccountHome(id)
    const now = Date.now()
    const record: ManagedAccountRecord = {
      id,
      label: parsed.value.label,
      enabled: parsed.value.enabled,
      ...(parsed.value.proxyUrl ? { proxyUrl: parsed.value.proxyUrl } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.persist([...this.accounts, record], this.defaultAccountEnabled)
    return { ...record }
  }

  updateAccount(body: Record<string, unknown>): ManagedAccountRecord | { id: typeof DEFAULT_ACCOUNT_ID; enabled: boolean } {
    this.ensureLoaded()
    const parsed = validateManagedAccountUpdateInput(body)
    if (!parsed.ok) {
      throw new AccountStoreError(parsed.error, 400)
    }

    const { accountId, label, enabled, proxyUrl } = parsed.value
    if (accountId === DEFAULT_ACCOUNT_ID) {
      if (enabled === undefined) {
        throw new AccountStoreError('本机默认账号仅支持切换启用/停用状态', 400)
      }
      this.persist(this.accounts, enabled, !enabled && accountId === this.preferredAccountId ? null : this.preferredAccountId)
      return { id: DEFAULT_ACCOUNT_ID, enabled }
    }

    const idx = this.accounts.findIndex((a) => a.id === accountId)
    if (idx === -1) {
      throw new AccountStoreError(`未找到托管账号 "${accountId}"（配置文件托管的账号请在宿主配置中修改）`, 404)
    }

    const current = this.accounts[idx]!
    const nextProxy = proxyUrl === undefined ? current.proxyUrl : proxyUrl || undefined
    const updated: ManagedAccountRecord = {
      ...current,
      label: label ?? current.label,
      enabled: enabled ?? current.enabled,
      updatedAt: Date.now(),
    }
    if (nextProxy) {
      updated.proxyUrl = nextProxy
    } else {
      delete updated.proxyUrl
    }

    const nextList = [...this.accounts]
    nextList[idx] = updated
    this.persist(nextList, this.defaultAccountEnabled, !updated.enabled && accountId === this.preferredAccountId ? null : this.preferredAccountId)
    return { ...updated }
  }

  removeAccount(accountId: string, opts?: { purgeData?: boolean }): boolean {
    this.ensureLoaded()
    const clean = accountId.trim().toLowerCase()
    if (clean === DEFAULT_ACCOUNT_ID) {
      throw new AccountStoreError('本机默认账号不可删除，如需停用请点击「停用」', 400)
    }
    const idx = this.accounts.findIndex((a) => a.id === clean)
    if (idx === -1) {
      throw new AccountStoreError(`未找到托管账号 "${clean}"`, 404)
    }
    const nextList = this.accounts.filter((a) => a.id !== clean)
    this.persist(nextList, this.defaultAccountEnabled, clean === this.preferredAccountId ? null : this.preferredAccountId)

    if (opts?.purgeData) {
      try {
        const target = this.resolveManagedAccountHome(clean)
        const realRoot = realpathSync(this.accountsRootDir)
        const info = lstatSync(target)
        if (!info.isSymbolicLink() && info.isDirectory() && realpathSync(target).startsWith(realRoot + path.sep)) {
          rmSync(target, { recursive: true, force: true })
        }
      } catch {
        // ignore missing or already-removed directory
      }
    }
    return true
  }

  toAccountProfile(rec: ManagedAccountRecord): AccountProfileConfig {
    const homeDir = this.resolveManagedAccountHome(rec.id)
    const env: Record<string, string> = {
      SSH_CONNECTION: MANAGED_ACCOUNT_SSH_SENTINEL,
    }
    if (rec.proxyUrl) {
      env.HTTPS_PROXY = rec.proxyUrl
      env.HTTP_PROXY = rec.proxyUrl
      env.ALL_PROXY = rec.proxyUrl
    }
    return {
      id: rec.id,
      label: rec.label,
      ...(rec.email ? { email: rec.email } : {}),
      enabled: rec.enabled,
      homeDir,
      env,
      source: 'managed',
      ...(rec.proxyUrl ? { proxyUrl: rec.proxyUrl } : {}),
    }
  }

  /**
   * Merges the machine default profile, read-only host config accounts, and console-managed isolated accounts
   * into the effective profile list consumed by `MultiAccountPool`.
   */
  buildEffectiveProfiles(hostAccounts: readonly AccountProfileConfig[] = []): AccountProfileConfig[] {
    this.ensureLoaded()
    const profiles: AccountProfileConfig[] = []
    const seen = new Set<string>()

    const hostHasDefault = hostAccounts.some((a) => a.id === DEFAULT_ACCOUNT_ID)
    if (!hostHasDefault) {
      profiles.push({
        id: DEFAULT_ACCOUNT_ID,
        label: '本机默认账号',
        enabled: this.defaultAccountEnabled,
        source: 'default',
      })
      seen.add(DEFAULT_ACCOUNT_ID)
    }

    for (const hostAcc of hostAccounts) {
      if (!hostAcc.id || seen.has(hostAcc.id)) continue
      seen.add(hostAcc.id)
      profiles.push({
        ...hostAcc,
        source: hostAcc.source ?? 'host',
      })
    }

    for (const managed of this.accounts) {
      if (seen.has(managed.id)) continue
      seen.add(managed.id)
      // Guarantee the isolated home exists on disk so quota checks / logins work immediately.
      try {
        this.ensureManagedAccountHome(managed.id)
      } catch {
        // ignore mkdir failure on read path
      }
      profiles.push(this.toAccountProfile(managed))
    }

    return profiles
  }
}
