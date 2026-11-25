import {
  LOW_QUOTA_THRESHOLD,
  type AccountEgressSnapshot,
  type AccountHealthSnapshot,
  type AccountQuotaSample,
  type QuotaBucketState,
  type StatusSnapshot,
} from '../common/types.ts'

export function sessionAccountLabel(accountId: string, accounts: Pick<AccountHealthSnapshot, 'id' | 'label'>[]): string {
  const label = accounts.find(account => account.id === accountId)?.label
  return label && label !== accountId ? `${label} (${accountId})` : accountId || '归属未知'
}

export function activeCooldowns(families: AccountHealthSnapshot['families'], now: number) {
  return Object.entries(families).flatMap(([family, state]) => {
    const until = state?.cooldownUntil
    return until != null && Number.isFinite(until) && until > now ? [{ family, until }] : []
  })
}

export function bucketDisplay(bucket: QuotaBucketState | undefined, now: number): string {
  if (!bucket) return '未获取'
  if (bucket.resetAt != null && bucket.resetAt <= now) return '已过期，待刷新'
  const fraction = bucket.remainingFraction
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return '未获取'
  if (fraction > 0 && fraction < 0.001) return '<0.1%'
  if (fraction < 1 && fraction > 0.999) return '>99.9%'
  return `${Number((fraction * 100).toFixed(1))}%`
}

/** Only local rendering wakes at expiry; timers never request upstream data. */
export function nextAccountExpiry(account: AccountHealthSnapshot, now: number): number | undefined {
  const deadlines = activeCooldowns(account.families, now).map(item => item.until)
  for (const group of account.quota?.groups ?? []) {
    for (const bucket of [group.fiveHour, group.sevenDay]) {
      if (bucket?.resetAt != null && Number.isFinite(bucket.resetAt) && bucket.resetAt > now) deadlines.push(bucket.resetAt)
    }
  }
  return deadlines.length ? Math.min(...deadlines) : undefined
}

const refreshFailureByStatus: Record<number, string> = {
  404: '账号不存在，请检查账号配置。',
  409: '该账号的查询环境不可用，请检查启用状态与凭据隔离设置。',
  451: '当前网络出口位于受限地区，已在本地拦截配额查询以防触发风控。',
  502: 'agy CLI 未能读取配额，请检查该账号的登录状态和 CLI 版本。',
  503: '无法启动只读配额查询，请检查 agy CLI 和账号环境。',
}

const egressFailureByStatus: Record<number, string> = {
  404: '账号不存在，请检查账号配置。',
  409: 'ACP 插件当前未启用，无法执行出口检测。',
}

export type AccountActionKind = 'refresh' | 'clear' | 'egress'

export interface EgressBadgeDisplay {
  label: string
  tone: 'success' | 'error' | 'warn' | 'idle'
}

export interface LowQuotaWarningItem {
  group: string
  windowLabel: '5 小时' | '7 天'
  remainingFraction: number
  exhausted: boolean
}

export function lowQuotaWarnings(
  quota: AccountQuotaSample | undefined,
  now: number,
  threshold = LOW_QUOTA_THRESHOLD,
): LowQuotaWarningItem[] {
  const out: LowQuotaWarningItem[] = []
  for (const group of quota?.groups ?? []) {
    for (const [windowLabel, bucket] of [['5 小时', group.fiveHour], ['7 天', group.sevenDay]] as const) {
      if (!bucket) continue
      if (bucket.resetAt != null && bucket.resetAt <= now) continue
      if (!Number.isFinite(bucket.remainingFraction) || bucket.remainingFraction < 0 || bucket.remainingFraction > threshold) {
        continue
      }
      out.push({
        group: group.name,
        windowLabel,
        remainingFraction: bucket.remainingFraction,
        exhausted: bucket.remainingFraction <= 0,
      })
    }
  }
  return out
}

export function formatEgressBadge(egress: AccountEgressSnapshot | undefined): EgressBadgeDisplay {
  if (!egress) {
    return { label: '出口：待检测', tone: 'idle' }
  }
  const modeLabel = egress.proxyMode === 'proxy' ? '代理' : '直连'
  if (egress.status === 'supported') {
    return {
      label: `出口：${egress.country ?? '合规'}（${modeLabel}）· 合规`,
      tone: 'success',
    }
  }
  if (egress.status === 'unsupported') {
    const region = egress.country ?? (egress.probeSource === 'runtime-400' ? '上游 400' : '受限区')
    return {
      label: `出口：${region}（${modeLabel}）· 不支持 Gemini（已拦截）`,
      tone: 'error',
    }
  }
  return {
    label: `出口：探测异常（${modeLabel}）`,
    tone: 'warn',
  }
}

export async function requestAccountAction(
  action: AccountActionKind,
  accountId: string,
  request = fetch,
): Promise<StatusSnapshot> {
  let failure =
    action === 'refresh'
      ? '配额刷新失败，请稍后重试。'
      : action === 'egress'
        ? '出口检测失败，请稍后重试。'
        : '本地冷却未能清除，请重试。'
  try {
    const endpoint =
      action === 'refresh'
        ? 'quota/refresh'
        : action === 'egress'
          ? 'egress/check'
          : 'cooldown/clear'
    const response = await request(`/plugins/agy-acp/accounts/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }),
    })
    // Do not echo upstream stderr, proxy URLs, credentials or arbitrary error bodies.
    if (response.ok) {
      const { status } = await response.json() as { status?: StatusSnapshot }
      if (status && Number.isFinite(status.updatedAt) && Array.isArray(status.accounts)) return status
    } else if (action === 'refresh') {
      failure = refreshFailureByStatus[response.status] ?? failure
    } else if (action === 'egress') {
      failure = egressFailureByStatus[response.status] ?? failure
    }
  } catch { /* use the same safe failure for network and malformed replies */ }
  throw new Error(failure)
}
