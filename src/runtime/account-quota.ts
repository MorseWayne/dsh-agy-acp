import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { AccountQuotaGroup, ModelFamily, QuotaBucketState } from '../common/types.ts'
import { fetchViaEnvProxy } from './egress-guard.ts'
import { createPrivateProcessTemp } from './session-cleanup.ts'

export class AccountQuotaError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

const execute = promisify(execFile)
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)

const DAILY_QUOTA_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'
const PROD_QUOTA_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const WINDOW_DURATION_MS = {
  fiveHour: 5 * 60 * 60_000,
  sevenDay: 7 * 24 * 60 * 60_000,
} as const

/**
 * Untouched full-quota summary buckets report a rolling full-window reset timestamp (`now + window`).
 * Drop that placeholder so the UI does not show a fake countdown for an unused pool.
 */
export function filterUntouchedResetAt(
  fraction: number,
  resetAt: number | undefined,
  windowKey: 'fiveHour' | 'sevenDay',
  requestedAtMs: number,
  hasDescription = false,
): number | undefined {
  if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= 0) return undefined
  if (
    fraction === 1 &&
    !hasDescription &&
    Math.abs(resetAt - requestedAtMs - WINDOW_DURATION_MS[windowKey]) <= 60_000
  ) {
    return undefined
  }
  return resetAt
}

/** Only a usage command result is authoritative, never a token count, diagnostic or model reply. */
export function parseQuotaOutput(stdout: string, requestedAtMs = Date.now()): AccountQuotaGroup[] {
  for (const line of stdout.split(/\r?\n/)) {
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    if (!object(event) || event.event !== 'command_result' || !object(event.command) || event.command.name !== 'usage') continue
    const data = event.command.data
    if (!object(data) || !Array.isArray(data.groups)) continue
    const groups: AccountQuotaGroup[] = []
    for (const raw of data.groups) {
      if (!object(raw) || typeof raw.name !== 'string' || !raw.name.trim() || !Array.isArray(raw.buckets)) continue
      const group: AccountQuotaGroup = { name: raw.name.trim().slice(0, 128) }
      for (const bucket of raw.buckets) {
        if (!object(bucket)) continue
        const fraction = bucket.remaining_fraction ?? bucket.remainingFraction
        if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue
        const window = String(bucket.window || bucket.id || '').toLowerCase()
        const key = /(?:^|[-_ ])(?:weekly|week|7d)$/.test(window) ? 'sevenDay' : /(?:^|[-_ ])5h$/.test(window) ? 'fiveHour' : undefined
        if (!key) continue
        const reset = bucket.reset_time ?? bucket.resetTime
        const parsedResetAt = typeof reset === 'string' ? Date.parse(reset) : NaN
        // The CLI uses a protobuf epoch sentinel for a nonexistent 5h window.
        if (key === 'fiveHour' && Number.isFinite(parsedResetAt) && parsedResetAt <= 86_400_000) continue
        const resetAt = filterUntouchedResetAt(
          fraction,
          Number.isFinite(parsedResetAt) && parsedResetAt > 0 ? parsedResetAt : undefined,
          key,
          requestedAtMs,
          typeof bucket.description === 'string' && bucket.description.trim().length > 0,
        )
        const sample: QuotaBucketState = { remainingFraction: fraction }
        if (resetAt !== undefined) sample.resetAt = resetAt
        group[key] = sample
      }
      groups.push(group)
    }
    if (groups.some(g => g.fiveHour || g.sevenDay)) return groups
  }
  throw new AccountQuotaError('agy 未返回可识别的配额读数')
}

function directBucketGroupName(bucketId: string, groupDisplayName?: string): string {
  const id = bucketId.trim().toLowerCase()
  const display = groupDisplayName?.trim()
  if (id.startsWith('gemini-argon-')) return display || 'Gemini Argon'
  if (id.startsWith('gemini-carbon-')) return display || 'Gemini Carbon'
  if (id.startsWith('gemini-')) return 'Gemini Models'
  if (id.startsWith('3p-')) return 'Claude & GPT (shared)'
  return display || bucketId.trim() || 'Other'
}

/** Parses `v1internal:retrieveUserQuotaSummary` response into `AccountQuotaGroup[]`. */
export function parseDirectQuotaSummary(payload: unknown, requestedAtMs = Date.now()): AccountQuotaGroup[] {
  if (!object(payload)) return []
  const rawGroups = Array.isArray(payload.groups) && payload.groups.some((g) => object(g) && Array.isArray(g.buckets) && g.buckets.length > 0)
    ? payload.groups
    : Array.isArray(payload.buckets)
      ? [{ buckets: payload.buckets }]
      : []

  const byName = new Map<string, AccountQuotaGroup>()
  for (const rawGroup of rawGroups) {
    if (!object(rawGroup) || !Array.isArray(rawGroup.buckets)) continue
    const displayName = typeof rawGroup.displayName === 'string' ? rawGroup.displayName : undefined
    for (const bucket of rawGroup.buckets) {
      if (!object(bucket) || bucket.disabled === true) continue
      if (typeof bucket.bucketId !== 'string' || !bucket.bucketId.trim()) continue
      const bucketId = bucket.bucketId
      const fraction = bucket.remainingFraction
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue
      const clamped = Math.max(0, Math.min(1, fraction))
      const key = bucket.window === 'weekly' ? 'sevenDay' : bucket.window === '5h' ? 'fiveHour' : undefined
      if (!key) continue
      const resetRaw = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN
      if (key === 'fiveHour' && Number.isFinite(resetRaw) && resetRaw <= 86_400_000) continue
      const resetAt = filterUntouchedResetAt(
        clamped,
        Number.isFinite(resetRaw) && resetRaw > 0 ? resetRaw : undefined,
        key,
        requestedAtMs,
        typeof bucket.description === 'string' && bucket.description.trim().length > 0,
      )
      const groupName = directBucketGroupName(bucketId, displayName).slice(0, 128)
      let group = byName.get(groupName)
      if (!group) {
        group = { name: groupName }
        byName.set(groupName, group)
      }
      if (!group[key] || clamped < group[key]!.remainingFraction) {
        group[key] = { remainingFraction: clamped, ...(resetAt !== undefined ? { resetAt } : {}) }
      }
    }
  }
  return [...byName.values()].filter((g) => g.fiveHour || g.sevenDay)
}

/** Parses fallback `v1internal:fetchAvailableModels` response into `AccountQuotaGroup[]`. */
export function parseDirectModelsQuota(payload: unknown): AccountQuotaGroup[] {
  if (!object(payload) || !object(payload.models)) return []
  const byName = new Map<string, AccountQuotaGroup>()
  for (const [modelId, rawModel] of Object.entries(payload.models)) {
    if (!object(rawModel)) continue
    const provider = typeof rawModel.modelProvider === 'string' ? rawModel.modelProvider : ''
    const groupName =
      provider === 'MODEL_PROVIDER_GOOGLE' || modelId.startsWith('gemini-')
        ? 'Gemini Models'
        : provider === 'MODEL_PROVIDER_ANTHROPIC' || modelId.startsWith('claude-')
          ? 'Claude Models'
          : provider === 'MODEL_PROVIDER_OPENAI' || modelId.startsWith('gpt-')
            ? 'GPT Models'
            : undefined
    if (!groupName) continue
    // quotaInfo has no duration in the upstream schema; never invent a 5h window.
    const rawQuota = rawModel.weeklyQuotaInfo
    if (!object(rawQuota)) continue
    const fraction = rawQuota.remainingFraction
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue
    const resetRaw = typeof rawQuota.resetTime === 'string' ? Date.parse(rawQuota.resetTime) : NaN
    const sample: QuotaBucketState = {
      remainingFraction: Math.max(0, Math.min(1, fraction)),
      ...(Number.isFinite(resetRaw) && resetRaw > 0 ? { resetAt: resetRaw } : {}),
    }
    const group = byName.get(groupName) ?? { name: groupName }
    if (!group.sevenDay || sample.remainingFraction < group.sevenDay.remainingFraction) group.sevenDay = sample
    byName.set(groupName, group)
  }
  return [...byName.values()].filter((g) => g.fiveHour || g.sevenDay)
}

// Only this exact CLI file under the leased account's HOME may authorize a direct probe.
// Never inspect the keyring, ambient home, transcript directories or alternative sign-ins.
function readAccountAccessToken(accountHome: string, env: NodeJS.ProcessEnv): { bearer: string; expiry: number } | null {
  if (!path.isAbsolute(accountHome) || !env.SSH_CONNECTION?.trim()) return null
  const home = path.resolve(accountHome)
  const profile = path.join(home, '.gemini')
  const effectiveHome = process.platform === 'win32' ? env.USERPROFILE : env.HOME
  // Cannot prove a Windows file's owner/DACL with mode bits; use the isolated CLI there.
  if (process.getuid === undefined || effectiveHome !== home || home === path.parse(home).root ||
      home === path.resolve(os.homedir()) || (env.GEMINI_HOME && env.GEMINI_HOME !== profile)) return null
  if (['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI',
    'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'AGY_ACP_CCPA_PROJECT',
    'ANTIGRAVITY_APP_DATA_DIR', 'ANTIGRAVITY_GEMINI_DIR', 'GEMINI_CLI_HOME'].some(k => env[k]?.trim())) return null
  let fd: number | undefined
  try {
    const uid = process.getuid()
    const safeDir = (dir: string, info = lstatSync(dir)) =>
      info.isDirectory() && info.uid === uid && !(info.mode & 0o022) && realpathSync(dir) === dir
    if (!safeDir(home) || !safeDir(profile)) return null
    // Never open competing sign-ins. A missing store is fine; inaccessible or linked is not.
    let tokenFile: string | undefined
    for (const store of ['antigravity-acp', 'antigravity-cli']) {
      const dir = path.join(profile, store)
      const parent = lstatSync(dir, { throwIfNoEntry: false })
      if (!parent) continue
      if (!safeDir(dir, parent) || lstatSync(path.join(dir, 'acp_token.json'), { throwIfNoEntry: false })) return null
      const file = path.join(dir, 'antigravity-oauth-token')
      if (!lstatSync(file, { throwIfNoEntry: false })) continue
      if (tokenFile) return null
      tokenFile = file
    }
    if (!tokenFile) return null
    const observed = lstatSync(tokenFile)
    if (!observed.isFile() || observed.uid !== uid || observed.nlink !== 1 || (observed.mode & 0o077) ||
        observed.size <= 0 || observed.size > 64 * 1024) return null
    fd = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (info.dev !== observed.dev || info.ino !== observed.ino || info.size !== observed.size ||
        info.mtimeMs !== observed.mtimeMs || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o077) ||
        realpathSync(tokenFile) !== tokenFile) return null
    const buf = Buffer.alloc(info.size)
    let parsed: unknown
    try {
      if (readSync(fd, buf, 0, buf.length, 0) !== buf.length || fstatSync(fd).mtimeMs !== info.mtimeMs) return null
      parsed = JSON.parse(buf.toString('utf8'))
    } finally { buf.fill(0) }
    if (!object(parsed)) return null
    const token = parsed.token === undefined ? parsed : parsed.token
    if (!object(token)) return null
    const bearer = token.access_token
    const expiry = typeof token.expiry === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(token.expiry)
      ? Date.parse(token.expiry) : NaN
    if (typeof bearer !== 'string' || !/^[A-Za-z0-9._~+/-]{1,8192}=*$/.test(bearer) || !(expiry > Date.now() + 60_000)) return null
    return { bearer, expiry }
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

function buildDirectUserAgent(): string {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`
}

/**
 * Fast, zero-subprocess quota probe using locally stored OAuth credentials over the account's
 * configured proxy environment. Returns `null` when unavailable/expired so callers fall back
 * cleanly to the read-only sandboxed `agy -p /usage` helper.
 */
export async function readDirectAccountQuota(
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal,
  opts?: { accountHome?: string; fetcher?: typeof fetchViaEnvProxy },
): Promise<AccountQuotaGroup[] | null> {
  signal.throwIfAborted()
  if (!opts?.accountHome || !env) return null
  const token = readAccountAccessToken(opts.accountHome, env)
  if (!token) return null
  const fetcher = opts.fetcher ?? fetchViaEnvProxy
  const endpoints = [DAILY_QUOTA_ENDPOINT, PROD_QUOTA_ENDPOINT] as const
  const body = '{}'
  const routeEnv: NodeJS.ProcessEnv = {}
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (env[key] !== undefined) routeEnv[key] = env[key]
  }
  const headers = {
    Authorization: `Bearer ${token.bearer}`,
    'Content-Type': 'application/json',
    'User-Agent': buildDirectUserAgent(),
  }

  const fetchOperation = async (
    operation: 'retrieveUserQuotaSummary' | 'fetchAvailableModels',
    parser: (data: unknown, requestedAtMs: number) => AccountQuotaGroup[],
  ): Promise<AccountQuotaGroup[] | null> => {
    const settled = await Promise.all(
      endpoints.map(async (endpoint) => {
        const requestedAt = Date.now()
        if (signal.aborted || token.expiry <= requestedAt + 60_000) return []
        try {
          const res = await fetcher({
            url: `${endpoint}/v1internal:${operation}`,
            method: 'POST',
            headers,
            body,
            env: routeEnv,
            timeoutMs: 8_000,
            signal,
          })
          if ((res.statusCode >= 300 && res.statusCode < 400) || res.statusCode === 401 || res.statusCode === 403) return null
          if (res.statusCode < 200 || res.statusCode >= 300) return []
          return parser(JSON.parse(res.body), requestedAt)
        } catch {
          return []
        }
      }),
    )
    signal.throwIfAborted()
    if (settled.includes(null)) return null
    const merged = new Map<string, AccountQuotaGroup>()
    for (const group of settled.flatMap(groups => groups ?? [])) {
      const existing = merged.get(group.name)
      if (!existing) {
        merged.set(group.name, { ...group })
      } else {
        for (const window of ['fiveHour', 'sevenDay'] as const) {
          const next = group[window]
          const prior = existing[window]
          // Without an explicit personal/business tier we do not know which host meters
          // this account. Never schedule on whichever conflicting host answered first.
          if (prior && next && (prior.remainingFraction !== next.remainingFraction ||
              (prior.resetAt !== undefined && next.resetAt !== undefined && Math.abs(prior.resetAt - next.resetAt) > 60_000))) return null
          if (!prior && next) existing[window] = next
        }
      }
    }
    return [...merged.values()]
  }

  const summary = await fetchOperation('retrieveUserQuotaSummary', parseDirectQuotaSummary)
  if (summary === null || summary.length > 0) return summary
  const models = await fetchOperation('fetchAvailableModels', parseDirectModelsQuota)
  return models?.length ? models : null
}

/** argv is prepared by the host's read-only sandbox; never retry it unconfined. */
async function runCommand(argv: string[], env: NodeJS.ProcessEnv | undefined, cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const [command, ...args] = argv
  if (!command) throw new AccountQuotaError('无法启动配额查询')
  let stdout: string
  const temp = createPrivateProcessTemp(env, { argv })
  let launched = false
  try {
    const run = execute(command, args, { cwd, env: { ...temp.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1', CI: '1', BROWSER: 'none' },
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20_000, killSignal: 'SIGKILL', signal, windowsHide: true })
    run.child.once('close', temp.cleanup)
    launched = true
    run.child.stdin?.end()
    stdout = (await run).stdout
  } catch {
    if (!launched) temp.cleanup()
    // execFile errors may include the full command, stderr, proxy URL or login details.
    throw new AccountQuotaError('agy 配额查询失败或超时，请检查对应账号的 CLI 登录环境')
  }
  return stdout
}

export async function requireFileCredentialMode(argv: string[], env: NodeJS.ProcessEnv | undefined, cwd: string, signal: AbortSignal): Promise<void> {
  const version = await runCommand(argv, env, cwd, signal)
  const match = /\b(?:v)?(\d+)\.(\d+)\.\d+\b/i.exec(version)
  if (!match || !(Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 5))) {
    throw new AccountQuotaError('无法确认此 agy 版本支持独立文件凭据模式', 409)
  }
}

export async function readCliVersion(
  argv: string[],
  env: NodeJS.ProcessEnv | undefined,
  cwd: string,
  signal: AbortSignal,
): Promise<{ version: string | null; supportsFileCredentials: boolean; summary: string }> {
  const raw = await runCommand(argv, env, cwd, signal)
  const match = /\b(?:v)?((\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i.exec(raw)
  const version = match?.[1] ?? null
  const major = match ? Number(match[2]) : 0
  const minor = match ? Number(match[3]) : 0
  const supportsFileCredentials = Boolean(match && (major > 1 || (major === 1 && minor >= 5)))
  return {
    version,
    supportsFileCredentials,
    summary: sanitizeDiagnosticText(raw, 120),
  }
}

export async function readAccountQuota(argv: string[], env: NodeJS.ProcessEnv | undefined, cwd: string, signal: AbortSignal): Promise<AccountQuotaGroup[]> {
  return parseQuotaOutput(await runCommand(argv, env, cwd, signal))
}

type GroupSpecificity = 'family' | 'general' | 'variant'

function classifyQuotaGroup(name: string): Array<{ family: ModelFamily; specificity: GroupSpecificity }> {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return []
  if (/^claude\s*&\s*gpt\b/.test(normalized)) {
    return [{ family: 'claude', specificity: 'general' }, { family: 'gpt', specificity: 'general' }]
  }
  if (/^gpt\b/.test(normalized)) return [{ family: 'gpt', specificity: 'general' }]
  if (/^claude(?:\s+models)?$/.test(normalized)) {
    return [{ family: 'claude', specificity: 'general' }]
  }
  if (normalized.includes('claude') || normalized.includes('opus') || normalized.includes('sonnet') || normalized.includes('haiku')) {
    return [{ family: 'claude', specificity: 'variant' }]
  }
  if (normalized.includes('flash')) {
    return [{ family: 'gemini-flash', specificity: 'family' }]
  }
  if (/^gemini(?:\s+models)?$/.test(normalized)) {
    return [
      { family: 'gemini-pro', specificity: 'general' },
      { family: 'gemini-flash', specificity: 'general' },
    ]
  }
  if (/^gemini\s+pro$/.test(normalized)) {
    return [{ family: 'gemini-pro', specificity: 'family' }]
  }
  if (
    normalized.includes('gemini') ||
    normalized.includes('neon') ||
    normalized.includes('carbon') ||
    normalized.includes('argon') ||
    normalized.includes('hydrogen') ||
    normalized.includes('orchestrator')
  ) {
    return [{ family: 'gemini-pro', specificity: 'variant' }]
  }
  return [{ family: 'other', specificity: 'variant' }]
}

function mergeBucketList(
  buckets: QuotaBucketState[],
  mode: 'min' | 'max',
): QuotaBucketState | undefined {
  if (buckets.length === 0) return undefined
  let chosen = buckets[0]!
  for (let i = 1; i < buckets.length; i++) {
    const next = buckets[i]!
    if (
      mode === 'min'
        ? next.remainingFraction < chosen.remainingFraction
        : next.remainingFraction > chosen.remainingFraction
    ) {
      chosen = next
    }
  }
  return { ...chosen }
}

/**
 * Maps upstream CLI quota groups onto `MultiAccountPool` model families.
 * Explicit family/general pools take precedence over dedicated variant sub-pools (e.g. `Gemini 4 Argon`),
 * preventing a single exhausted experimental variant from falsely exhausting the whole `gemini-pro` family.
 */
export function mapQuotaGroupsToFamilies(
  groups: readonly AccountQuotaGroup[],
): Partial<Record<ModelFamily, { fiveHour?: QuotaBucketState; sevenDay?: QuotaBucketState }>> {
  const byFamily = new Map<
    ModelFamily,
    Record<GroupSpecificity, AccountQuotaGroup[]>
  >()

  for (const group of groups) {
    if (!group.fiveHour && !group.sevenDay) continue
    for (const { family, specificity } of classifyQuotaGroup(group.name)) {
      let entry = byFamily.get(family)
      if (!entry) {
        entry = { family: [], general: [], variant: [] }
        byFamily.set(family, entry)
      }
      entry[specificity].push(group)
    }
  }

  const out: Partial<Record<ModelFamily, { fiveHour?: QuotaBucketState; sevenDay?: QuotaBucketState }>> = {}
  for (const [family, tiers] of byFamily) {
    const choose = (window: 'fiveHour' | 'sevenDay'): QuotaBucketState | undefined => {
      for (const tier of ['family', 'general', 'variant'] as const) {
        const candidates = tiers[tier].flatMap(group => group[window] ? [group[window]!] : [])
        if (candidates.length) return mergeBucketList(candidates, tier === 'variant' ? 'max' : 'min')
      }
      return undefined
    }
    const fiveHour = choose('fiveHour')
    const sevenDay = choose('sevenDay')
    if (fiveHour || sevenDay) {
      out[family] = {
        ...(fiveHour ? { fiveHour } : {}),
        ...(sevenDay ? { sevenDay } : {}),
      }
    }
  }

  return out
}
