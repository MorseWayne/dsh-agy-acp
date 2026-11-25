import { EventEmitter } from 'node:events'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { isGeoUnsupportedError } from '../common/geo.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type {
  AccountHealthSnapshot,
  AccountLease,
  AccountProfileConfig,
  AccountProvider,
  FamilyQuotaState,
  ModelFamily,
  QuotaBucketState,
} from '../common/types.ts'
import type { CredentialSlotLeaseManager } from './credential-lease.ts'

export function classifyModelFamily(model: string): ModelFamily {
  const m = model.trim().toLowerCase()
  if (!m) return 'other'
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
    return 'claude'
  }
  if (m.includes('flash')) {
    return 'gemini-flash'
  }
  if (m.includes('gemini') || m.includes('neon') || m.includes('carbon') || m.includes('hydrogen') || m.includes('pro')) {
    return 'gemini-pro'
  }
  return 'other'
}

const TOS_VIOLATION_PATTERNS: readonly RegExp[] = [
  /\btos[_ -]?violation\b/i,
  /\bterms\s+of\s+service\b[\s\S]{0,60}\b(?:violat|suspend|ban|terminat|disable|restrict)/i,
  /\b(?:violat|suspend|ban|terminat|disable|restrict)\w*\b[\s\S]{0,60}\bterms\s+of\s+service\b/i,
  /\b(?:account|user)\s+(?:has\s+been\s+)?(?:suspended|banned|disabled|terminated|restricted)\b/i,
  /\b(?:validation_required|account_restricted|abuse_detected)\b/i,
]

const LOOPBACK_NO_PROXY_ENTRIES = ['127.0.0.1', 'localhost', '::1'] as const

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
] as const

export type AccountErrorCategory = 'tos' | 'geo' | 'quota' | 'other'

export function isTosViolationError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  if (!msg) return false
  return TOS_VIOLATION_PATTERNS.some((re) => re.test(msg))
}

export function isQuotaOrRateLimitError(error: unknown): boolean {
  if (isTosViolationError(error)) return false
  const msg = error instanceof Error ? error.message : String(error ?? '')
  const lower = msg.toLowerCase()
  return (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('too many requests') ||
    lower.includes('quota') ||
    lower.includes('limit exceeded') ||
    lower.includes('overloaded')
  )
}

/** Classifies an upstream/account failure by strict risk precedence: TOS > geo > quota > other. */
export function classifyAccountError(error: unknown): AccountErrorCategory {
  if (isTosViolationError(error)) return 'tos'
  if (isGeoUnsupportedError(error)) return 'geo'
  if (isQuotaOrRateLimitError(error)) return 'quota'
  return 'other'
}

/** Merges `127.0.0.1,localhost,::1` into a `NO_PROXY` list without duplicating existing entries. */
export function mergeLoopbackNoProxy(existing: string | undefined): string {
  const parts = (existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.includes('*')) return parts.join(',')

  const seen = new Set<string>()
  const out: string[] = []
  const normalize = (entry: string): string => entry.toLowerCase().replace(/^\[|\]$/g, '')

  for (const part of parts) {
    const key = normalize(part)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(part)
    }
  }
  for (const loopback of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!seen.has(loopback)) {
      seen.add(loopback)
      out.push(loopback)
    }
  }
  return out.join(',')
}

interface InternalAccountState {
  profile: AccountProfileConfig
  activeLeases: number
  families: Map<ModelFamily, FamilyQuotaState>
  geoBlockedUntil?: number
  tosBlockedAt?: number
  tosBlockedReason?: string
  lastError: string | null
  lastUsedAt: number | null
}

export interface MultiAccountPoolOptions {
  accounts: AccountProfileConfig[]
  slotManager?: CredentialSlotLeaseManager
  baseCooldownMs?: number
  maxCooldownMs?: number
  now?: () => number
  log?: (msg: string) => void
}

function buildAccountEnv(profile: AccountProfileConfig): NodeJS.ProcessEnv | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env }
  let modified = false

  if (profile.homeDir) {
    const absHome = path.resolve(profile.homeDir)
    env.HOME = absHome
    env.USERPROFILE = absHome
    env.XDG_CONFIG_HOME = path.join(absHome, '.config')
    env.XDG_DATA_HOME = path.join(absHome, '.local', 'share')
    env.XDG_CACHE_HOME = path.join(absHome, '.cache')
    modified = true
  }

  let hasProxy = false
  if (profile.env) {
    for (const [k, v] of Object.entries(profile.env)) {
      env[k] = v
      if ((PROXY_ENV_KEYS as readonly string[]).includes(k) && v.trim()) {
        hasProxy = true
      }
      modified = true
    }
  }

  if (hasProxy) {
    const existingNoProxy = [env.NO_PROXY, env.no_proxy].filter((v): v is string => Boolean(v?.trim())).join(',')
    const merged = mergeLoopbackNoProxy(existingNoProxy)
    env.NO_PROXY = merged
    env.no_proxy = merged
    modified = true
  }

  return modified ? env : undefined
}

function canonicalPath(dir: string): string {
  let resolved = path.resolve(dir)
  try { resolved = realpathSync(resolved) } catch { /* agy may not have created it yet */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** A proxy or slot lock alone does not identify an agy credential store. Do not invent SSH markers. */
function quotaUnavailable(profile: AccountProfileConfig, profiles: AccountProfileConfig[]): string | undefined {
  if (profile.enabled === false) return '账号已停用'
  if (profiles.length === 1 && !profile.homeDir) return undefined // one explicitly ambient profile, like the machine default
  if (!profile.homeDir) return '多账号查询需要独立的账号 HOME'
  const env = buildAccountEnv(profile)!
  const home = canonicalPath(profile.homeDir)
  const effectiveHome = (e: NodeJS.ProcessEnv) => process.platform === 'win32' ? e.USERPROFILE : e.HOME
  if (canonicalPath(effectiveHome(env) || '.') !== home) return '账号环境覆盖了独立 HOME'
  const storePaths = (e: NodeJS.ProcessEnv) => {
    const gemini = path.join(effectiveHome(e) || '.', '.gemini')
    return [e.GEMINI_CLI_HOME || gemini, e.ANTIGRAVITY_GEMINI_DIR || gemini, e.ANTIGRAVITY_APP_DATA_DIR || path.join(gemini, 'antigravity-cli')].map(canonicalPath)
  }
  const stores = storePaths(env)
  if (stores.some(dir => dir !== home && !dir.startsWith(home + path.sep))) return '账号凭据目录未隔离'
  if (profiles.some(p => p !== profile && storePaths(buildAccountEnv(p) ?? process.env).some(dir => stores.includes(dir)))) return '多个账号共享凭据目录，无法归属配额'
  // Desktop keyrings are user-wide even when HOME differs. Only accept the CLI's
  // existing file-backed SSH mode, or an explicitly private Linux bus inside this HOME.
  const privateBusPath = /^unix:path=([^,;%]+)$/.exec(env.DBUS_SESSION_BUS_ADDRESS ?? '')?.[1]
  const privateLinuxBus = process.platform === 'linux' && privateBusPath && canonicalPath(privateBusPath).startsWith(home + path.sep)
  if (!env.SSH_CONNECTION?.trim() && !privateLinuxBus) return '无法确认独立凭据环境；请检查该账号的 agy 登录环境'
  return undefined
}

/**
 * Phase 3 multi-account pool implementing `AccountProvider`.
 *
 * Features:
 * - Per-account isolated `HOME` / `XDG_*` sandbox & custom environment injection
 * - Optional cross-process credential slot lease (`CredentialSlotLeaseManager`)
 * - Dual-bucket quota tracking (5h rolling + 7d weekly) per model family
 * - Independent per-model-family cooldown & automatic 429/exhaustion failover
 * - Session-sticky account preference to preserve prompt cache hit rates
 */
export class MultiAccountPool extends EventEmitter implements AccountProvider {
  private readonly accounts = new Map<string, InternalAccountState>()
  private readonly quotaRestrictions = new Map<string, string | undefined>()
  private readonly sessionSticky = new Map<string, string>()
  private readonly baseCooldownMs: number
  private readonly maxCooldownMs: number
  private readonly now: () => number

  constructor(private readonly opts: MultiAccountPoolOptions) {
    super()
    this.baseCooldownMs = opts.baseCooldownMs ?? 30_000
    this.maxCooldownMs = opts.maxCooldownMs ?? 15 * 60_000
    this.now = opts.now ?? (() => Date.now())

    for (const profile of opts.accounts) {
      this.quotaRestrictions.set(profile.id, quotaUnavailable(profile, opts.accounts))
      this.accounts.set(profile.id, {
        profile,
        activeLeases: 0,
        families: new Map(),
        lastError: null,
        lastUsedAt: null,
      })
    }
  }

  async acquireQuotaLease(accountId: string): Promise<AccountLease & { requiresFileCredentialMode: boolean }> {
    const acc = this.accounts.get(accountId)
    if (!acc) throw new Error('未知账号')
    const reason = quotaUnavailable(acc.profile, this.opts.accounts)
    if (reason) throw new Error(reason)
    const slot = await this.opts.slotManager?.acquire(accountId)
    const env = buildAccountEnv(acc.profile)
    return { accountId, env, requiresFileCredentialMode: Boolean(acc.profile.homeDir && env?.SSH_CONNECTION?.trim()), release: () => slot?.release() }
  }

  getAccountEnv(accountId: string): NodeJS.ProcessEnv | undefined {
    const acc = this.accounts.get(accountId)
    return acc ? buildAccountEnv(acc.profile) : undefined
  }

  markGeoBlocked(accountId: string, untilMs: number, reason?: string): void {
    const acc = this.accounts.get(accountId)
    if (!acc) return
    acc.geoBlockedUntil = Math.max(acc.geoBlockedUntil ?? 0, untilMs)
    if (reason) {
      acc.lastError = sanitizeDiagnosticText(reason, 240) || acc.lastError
    }
    this.opts.log?.(
      `account "${accountId}" entered local geo-fence cooldown (${Math.max(1, Math.ceil((untilMs - this.now()) / 1000))}s)`,
    )
    this.emit('change')
  }

  clearGeoBlock(accountId?: string): void {
    let changed = false
    for (const acc of this.accounts.values()) {
      if (accountId && acc.profile.id !== accountId) continue
      if (acc.geoBlockedUntil !== undefined) {
        acc.geoBlockedUntil = undefined
        changed = true
      }
    }
    if (changed) {
      this.emit('change')
    }
  }

  updateQuota(
    accountId: string,
    family: ModelFamily,
    buckets: { fiveHour?: QuotaBucketState; sevenDay?: QuotaBucketState },
  ): void {
    const acc = this.accounts.get(accountId)
    if (!acc) return
    const state = this.getOrCreateFamily(acc, family)
    if (buckets.fiveHour) state.fiveHour = buckets.fiveHour
    if (buckets.sevenDay) state.sevenDay = buckets.sevenDay
    this.emit('change')
  }

  clearQuotaSamples(): void {
    let changed = false
    for (const acc of this.accounts.values()) {
      for (const state of acc.families.values()) {
        if (state.fiveHour || state.sevenDay) {
          state.fiveHour = undefined
          state.sevenDay = undefined
          changed = true
        }
      }
    }
    if (changed) this.emit('change')
  }

  async acquire(
    sessionKey: string,
    model: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<AccountLease> {
    const family = classifyModelFamily(model)
    const now = this.now()

    const candidates: InternalAccountState[] = []
    let earliestReset = Number.POSITIVE_INFINITY
    let tosBlockedCount = 0

    for (const acc of this.accounts.values()) {
      if (acc.profile.enabled === false) continue
      if (excludeAccountIds?.has(acc.profile.id)) continue
      if (acc.tosBlockedAt !== undefined) {
        tosBlockedCount += 1
        continue
      }
      const blockedUntil = this.getBlockedUntil(acc, family, now)
      if (blockedUntil !== null) {
        if (blockedUntil < earliestReset) earliestReset = blockedUntil
        continue
      }
      candidates.push(acc)
    }

    if (candidates.length === 0) {
      if (tosBlockedCount > 0 && !Number.isFinite(earliestReset)) {
        throw new Error(
          `No healthy accounts available for model family "${family}": ${tosBlockedCount} account(s) quarantined due to TOS violation`,
        )
      }
      const waitHint = Number.isFinite(earliestReset)
        ? ` (earliest recovery in ${Math.max(1, Math.ceil((earliestReset - now) / 1000))}s)`
        : ''
      throw new Error(`No healthy accounts available for model family "${family}"${waitHint}`)
    }

    // Prefer sticky account for this session if still healthy
    const stickyId = this.sessionSticky.get(sessionKey)
    let chosen = stickyId ? candidates.find((c) => c.profile.id === stickyId) : undefined

    if (!chosen) {
      candidates.sort((a, b) => {
        const qa = this.effectiveRemainingQuota(a, family, now)
        const qb = this.effectiveRemainingQuota(b, family, now)
        if (Math.abs(qb - qa) > 0.05) return qb - qa
        if (a.activeLeases !== b.activeLeases) return a.activeLeases - b.activeLeases
        return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
      })
      chosen = candidates[0]!
    }

    const slotHandle = this.opts.slotManager ? await this.opts.slotManager.acquire(chosen.profile.id) : null
    chosen.activeLeases += 1
    chosen.lastUsedAt = now
    this.sessionSticky.set(sessionKey, chosen.profile.id)
    this.emit('change')

    let released = false
    const accountId = chosen.profile.id
    return {
      accountId,
      env: buildAccountEnv(chosen.profile),
      release: () => {
        if (released) return
        released = true
        chosen!.activeLeases = Math.max(0, chosen!.activeLeases - 1)
        slotHandle?.release()
        this.emit('change')
      },
    }
  }

  reportSuccess(accountId: string, model: string): void {
    const acc = this.accounts.get(accountId)
    if (!acc) return
    const family = classifyModelFamily(model)
    const state = this.getOrCreateFamily(acc, family)
    state.consecutiveFailures = 0
    state.cooldownUntil = undefined
    acc.lastError = null
    this.emit('change')
  }

  reportFailure(accountId: string, model: string, error: unknown): void {
    const acc = this.accounts.get(accountId)
    if (!acc) return
    const family = classifyModelFamily(model)
    const state = this.getOrCreateFamily(acc, family)
    const message = error instanceof Error ? error.message : String(error)
    const safeMessage = sanitizeDiagnosticText(message, 240)
    acc.lastError = safeMessage || 'Request failed'
    state.consecutiveFailures += 1

    const category = classifyAccountError(error)
    if (category === 'tos') {
      acc.tosBlockedAt = this.now()
      acc.tosBlockedReason = safeMessage || 'TOS_VIOLATION'
      this.opts.log?.(
        `account "${accountId}" quarantined due to TOS/account-restriction violation (failover halted): ${acc.tosBlockedReason}`,
      )
    } else if (category === 'quota') {
      const backoff = Math.min(
        this.maxCooldownMs,
        this.baseCooldownMs * 2 ** Math.min(state.consecutiveFailures - 1, 6),
      )
      state.cooldownUntil = this.now() + backoff
      this.opts.log?.(
        `account "${accountId}" entered ${Math.round(backoff / 1000)}s cooldown for family "${family}": ${safeMessage}`,
      )
    } else if (category === 'geo') {
      acc.geoBlockedUntil = Math.max(acc.geoBlockedUntil ?? 0, this.now() + 60_000)
    }
    this.emit('change')
  }

  clearCooldown(accountId?: string): void {
    for (const acc of this.accounts.values()) {
      if (accountId && acc.profile.id !== accountId) continue
      acc.lastError = null
      acc.geoBlockedUntil = undefined
      acc.tosBlockedAt = undefined
      acc.tosBlockedReason = undefined
      for (const state of acc.families.values()) {
        state.cooldownUntil = undefined
        state.consecutiveFailures = 0
      }
    }
    this.emit('change')
  }

  getHealthSnapshots(): AccountHealthSnapshot[] {
    const list: AccountHealthSnapshot[] = []
    for (const acc of this.accounts.values()) {
      const families: Partial<Record<ModelFamily, FamilyQuotaState>> = {}
      for (const [fam, st] of acc.families) {
        families[fam] = {
          ...(st.fiveHour ? { fiveHour: { ...st.fiveHour } } : {}),
          ...(st.sevenDay ? { sevenDay: { ...st.sevenDay } } : {}),
          ...(st.cooldownUntil !== undefined ? { cooldownUntil: st.cooldownUntil } : {}),
          consecutiveFailures: st.consecutiveFailures,
        }
      }
      list.push({
        id: acc.profile.id,
        label: acc.profile.label ?? acc.profile.id,
        enabled: acc.profile.enabled !== false,
        quotaRefreshUnavailable: this.quotaRestrictions.get(acc.profile.id),
        ...(acc.tosBlockedAt !== undefined
          ? {
              tosBlocked: true,
              tosBlockedAt: acc.tosBlockedAt,
              ...(acc.tosBlockedReason ? { tosBlockedReason: acc.tosBlockedReason } : {}),
            }
          : {}),
        hasSandboxHome: Boolean(acc.profile.homeDir),
        activeLeases: acc.activeLeases,
        families,
        lastError: acc.lastError,
        lastUsedAt: acc.lastUsedAt,
      })
    }
    return list
  }

  dispose(): void {
    this.sessionSticky.clear()
    this.removeAllListeners()
  }

  private getOrCreateFamily(acc: InternalAccountState, family: ModelFamily): FamilyQuotaState {
    let st = acc.families.get(family)
    if (!st) {
      st = { consecutiveFailures: 0 }
      acc.families.set(family, st)
    }
    return st
  }

  private getBlockedUntil(acc: InternalAccountState, family: ModelFamily, now: number): number | null {
    const blocks: number[] = []
    if (acc.geoBlockedUntil !== undefined) {
      if (acc.geoBlockedUntil > now) {
        blocks.push(acc.geoBlockedUntil)
      } else {
        acc.geoBlockedUntil = undefined
      }
    }

    const st = acc.families.get(family)
    if (st) {
      if (st.cooldownUntil !== undefined && st.cooldownUntil > now) {
        blocks.push(st.cooldownUntil)
      }
      if (st.fiveHour && st.fiveHour.remainingFraction <= 0) {
        if (!st.fiveHour.resetAt || st.fiveHour.resetAt > now) {
          blocks.push(st.fiveHour.resetAt ?? now + this.baseCooldownMs)
        }
      }
      if (st.sevenDay && st.sevenDay.remainingFraction <= 0) {
        if (!st.sevenDay.resetAt || st.sevenDay.resetAt > now) {
          blocks.push(st.sevenDay.resetAt ?? now + this.maxCooldownMs)
        }
      }
    }

    return blocks.length > 0 ? Math.max(...blocks) : null
  }

  private effectiveRemainingQuota(acc: InternalAccountState, family: ModelFamily, now: number): number {
    const st = acc.families.get(family)
    if (!st) return 1
    const five =
      st.fiveHour && (!st.fiveHour.resetAt || st.fiveHour.resetAt > now)
        ? st.fiveHour.remainingFraction
        : 1
    const seven =
      st.sevenDay && (!st.sevenDay.resetAt || st.sevenDay.resetAt > now)
        ? st.sevenDay.remainingFraction
        : 1
    return Math.min(five, seven)
  }
}
