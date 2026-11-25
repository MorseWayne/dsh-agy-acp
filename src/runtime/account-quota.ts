import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { AccountQuotaGroup, ModelFamily, QuotaBucketState } from '../common/types.ts'

export class AccountQuotaError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

const execute = promisify(execFile)
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)

/** Only a usage command result is authoritative, never a token count, diagnostic or model reply. */
export function parseQuotaOutput(stdout: string): AccountQuotaGroup[] {
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
        const resetAt = typeof reset === 'string' ? Date.parse(reset) : NaN
        // The CLI uses a protobuf epoch sentinel for a nonexistent 5h window.
        if (key === 'fiveHour' && Number.isFinite(resetAt) && resetAt <= 86_400_000) continue
        const sample: QuotaBucketState = { remainingFraction: fraction }
        if (Number.isFinite(resetAt) && resetAt > 0) sample.resetAt = resetAt
        group[key] = sample
      }
      groups.push(group)
    }
    if (groups.some(g => g.fiveHour || g.sevenDay)) return groups
  }
  throw new AccountQuotaError('agy 未返回可识别的配额读数')
}

/** argv is prepared by the host's read-only sandbox; never retry it unconfined. */
async function runCommand(argv: string[], env: NodeJS.ProcessEnv | undefined, cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const [command, ...args] = argv
  if (!command) throw new AccountQuotaError('无法启动配额查询')
  let stdout: string
  try {
    const run = execute(command, args, { cwd, env: { ...(env ?? process.env), AGY_CLI_DISABLE_AUTO_UPDATE: '1', CI: '1', BROWSER: 'none' },
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20_000, killSignal: 'SIGKILL', signal, windowsHide: true })
    run.child.stdin?.end()
    stdout = (await run).stdout
  } catch {
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
    const selectedTier: GroupSpecificity | null =
      tiers.family.length > 0
        ? 'family'
        : tiers.general.length > 0
          ? 'general'
          : tiers.variant.length > 0
            ? 'variant'
            : null
    if (!selectedTier) continue
    const list = tiers[selectedTier]
    const combineMode = selectedTier === 'variant' ? 'max' : 'min'
    const fiveHour = mergeBucketList(
      list.flatMap((g) => (g.fiveHour ? [g.fiveHour] : [])),
      combineMode,
    )
    const sevenDay = mergeBucketList(
      list.flatMap((g) => (g.sevenDay ? [g.sevenDay] : [])),
      combineMode,
    )
    if (fiveHour || sevenDay) {
      out[family] = {
        ...(fiveHour ? { fiveHour } : {}),
        ...(sevenDay ? { sevenDay } : {}),
      }
    }
  }

  return out
}
