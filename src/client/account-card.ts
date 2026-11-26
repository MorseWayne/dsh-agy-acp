// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import { LOW_QUOTA_THRESHOLD, type AccountHealthSnapshot, type GeoFenceMode, type QuotaBucketState, type StatusSnapshot } from '../common/types.ts'
import {
  activeCooldowns,
  bucketDisplay,
  formatEgressBadge,
  formatEgressProbeSource,
  lowQuotaWarnings,
  nextAccountExpiry,
  requestAccountAction,
  type AccountActionKind,
} from './account-display.ts'
import { accountAttention } from './runtime-display.ts'
import { theme } from './theme.ts'
import { ProgressBar } from './ui-primitives.ts'

const h = React.createElement

function localTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function quotaColor(bucket: QuotaBucketState | undefined, now: number): string {
  if (!bucket || (bucket.resetAt != null && bucket.resetAt <= now)) return theme.stateIdle
  const f = bucket.remainingFraction
  if (!Number.isFinite(f) || f < 0) return theme.stateIdle
  if (f <= 0) return theme.stateError
  if (f <= LOW_QUOTA_THRESHOLD) return theme.stateWarn
  return theme.stateSuccess
}

function quotaWindow(title: string, bucket: QuotaBucketState | undefined, now: number): unknown {
  const expired = bucket?.resetAt != null && bucket.resetAt <= now
  const hasValidPct =
    bucket != null &&
    !expired &&
    Number.isFinite(bucket.remainingFraction) &&
    bucket.remainingFraction >= 0 &&
    bucket.remainingFraction <= 1
  const pct = hasValidPct ? bucket.remainingFraction * 100 : 0
  const color = quotaColor(bucket, now)

  return h(
    'div',
    { style: { minWidth: 0 } },
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px' } },
      h('dt', { className: 'agy-acp-caption' }, title),
      h(
        'dd',
        {
          style: {
            margin: 0,
            fontSize: '12px',
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: hasValidPct && bucket.remainingFraction <= LOW_QUOTA_THRESHOLD ? color : theme.textPrimary,
          },
        },
        bucketDisplay(bucket, now),
      ),
    ),
    hasValidPct
      ? h(ProgressBar, {
          valuePct: pct,
          ariaLabel: `${title}剩余配额`,
          color,
          height: 4,
          style: { marginTop: '4px' },
        })
      : null,
    bucket?.resetAt != null && bucket.resetAt > now
      ? h('dd', { className: 'agy-acp-caption', style: { margin: '3px 0 0' } }, `重置于 ${localTime(bucket.resetAt)}`)
      : null,
  )
}

export const AccountCard = React.memo(function AccountCard({
  account,
  applyStatus,
  geoFenceMode = 'block',
}: {
  account: AccountHealthSnapshot
  geoFenceMode?: GeoFenceMode
  applyStatus: (value: StatusSnapshot) => void
}): unknown {
  const [pending, setPending] = React.useState(null as AccountActionKind | null)
  const [feedback, setFeedback] = React.useState('')
  const locked = React.useRef(false)
  const [, redraw] = React.useReducer((n: number) => n + 1, 0)
  const now = Date.now()
  const deadline = nextAccountExpiry(account, now)

  // Only re-arm when the next actual expiry timestamp changes (never depend on ephemeral `now`).
  React.useEffect(() => {
    if (deadline == null) return
    const timer = setTimeout(redraw, Math.min(2_147_483_647, Math.max(1, deadline - Date.now())))
    return () => clearTimeout(timer)
  }, [deadline])

  const cooldowns = activeCooldowns(account.families, now)
  const { quota, egress } = account
  const lowWarnings = lowQuotaWarnings(quota, now)
  const flag = accountAttention(account, now)
  const egressBadge = formatEgressBadge(egress, geoFenceMode)
  const egressColor =
    egressBadge.tone === 'success'
      ? theme.stateSuccess
      : egressBadge.tone === 'error'
        ? theme.stateError
        : egressBadge.tone === 'warn'
          ? theme.stateWarn
          : theme.stateIdle
  const unavailable = account.quotaRefreshUnavailable || (!account.enabled ? '账号已停用。' : undefined)

  const act = async (action: AccountActionKind): Promise<void> => {
    if (locked.current || (action === 'refresh' && unavailable) || (action === 'egress' && !account.enabled)) return
    locked.current = true
    setPending(action)
    setFeedback('')
    try {
      const nextStatus = await requestAccountAction(action, account.id)
      applyStatus(nextStatus)
      if (action === 'refresh') {
        setFeedback('配额已刷新。')
      } else if (action === 'egress') {
        const updatedEgress = nextStatus.accounts.find(a => a.id === account.id)?.egress
        setFeedback(
          updatedEgress?.status === 'supported'
            ? `出口检测通过（${updatedEgress.country ?? 'Google 可用'}）。`
            : updatedEgress?.status === 'unsupported'
              ? formatEgressBadge(updatedEgress, nextStatus.config?.geoFenceMode).label
              : '出口检测已完成。',
        )
      } else {
        setFeedback('已清除本地冷却，上游配额不变。')
      }
    } catch (error) {
      // requestAccountAction emits only locally authored messages.
      const failure = error instanceof Error ? error.message : '操作未完成，请重试。'
      setFeedback(action === 'refresh' && quota ? `${failure} 当前显示上次成功查询的结果。` : failure)
    } finally {
      locked.current = false
      setPending(null)
    }
  }

  const statusPillClass = !account.enabled
    ? 'agy-acp-pill agy-acp-pill--sm'
    : flag
      ? account.tosBlocked || account.egress?.status === 'unsupported'
        ? 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--error'
        : 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--warn'
      : 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--success'

  return h(
    'article',
    { className: 'agy-acp-account-card' },
    // Header row: label + status pill + quick actions
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minWidth: 0 } },
        h(
          'h4',
          { style: { margin: 0, fontSize: '14px', fontWeight: 600 } },
          account.label,
          account.id !== account.label
            ? h('small', { className: 'agy-acp-muted', style: { fontWeight: 400 } }, ` · ${account.id}`)
            : null,
        ),
        h(
          'span',
          { className: statusPillClass },
          flag ? `已启用 · ${flag}` : account.enabled ? '已启用' : '已停用',
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
        h(
          'button',
          {
            type: 'button',
            disabled: !!pending || !account.enabled,
            className: 'agy-acp-btn agy-acp-btn--sm',
            onClick: () => void act('egress'),
            'aria-label': `检测 ${account.label} 的网络出口`,
          },
          pending === 'egress' ? '检测中…' : '检测出口',
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: !!pending || !!unavailable,
            className: 'agy-acp-btn agy-acp-btn--sm',
            title: unavailable || undefined,
            onClick: () => void act('refresh'),
            'aria-label': `刷新 ${account.label} 的配额`,
          },
          pending === 'refresh' ? '刷新中…' : '刷新配额',
        ),
        cooldowns.length > 0 || account.tosBlocked
          ? h(
              'button',
              {
                type: 'button',
                disabled: !!pending,
                className: 'agy-acp-btn agy-acp-btn--sm agy-acp-btn--danger',
                onClick: () => void act('clear'),
                'aria-label': `清除 ${account.label} 的本地冷却`,
              },
              pending === 'clear' ? '清除中…' : account.tosBlocked ? '解除隔离与冷却' : '清除本地冷却',
            )
          : null,
      ),
    ),

    // Meta line
    h(
      'div',
      {
        className: 'agy-acp-caption',
        style: { marginTop: '5px' },
        title: '最近分配指最近一次租约分配（包括模型探测），不是最近一轮对话。',
      },
      [
        `活跃租约 ${account.activeLeases}`,
        `最近分配：${account.lastUsedAt != null ? localTime(account.lastUsedAt) : '暂无记录'}`,
        account.hasSandboxHome && '独立 HOME',
        account.lastError && '最近请求出现错误',
      ].filter(Boolean).join(' · '),
    ),

    h('hr', { className: 'agy-acp-divider', style: { margin: '10px 0' } }),

    // Network egress compliance row
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 10px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
        h('span', { className: 'agy-acp-muted', style: { fontWeight: 500 } }, '网络出口合规'),
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              fontWeight: 500,
              color: egressBadge.tone === 'idle' ? theme.textSecondary : egressColor,
            },
          },
          h('span', { className: 'agy-acp-dot', style: { backgroundColor: egressColor } }),
          egressBadge.label,
        ),
      ),
      egress
        ? h(
            'span',
            { className: 'agy-acp-caption' },
            [
              egress.ipMasked ? `IP ${egress.ipMasked}` : formatEgressProbeSource(egress.probeSource),
              `检测于 ${localTime(egress.checkedAt)}`,
            ].filter(Boolean).join(' · '),
          )
        : h('span', { className: 'agy-acp-caption' }, '首次请求前自动预检，也可点击「检测出口」手动检查'),
    ),
    egress?.reason && egress.status !== 'supported'
      ? h(
          'div',
          {
            className: 'agy-acp-caption',
            style: {
              color: egressBadge.tone === 'error' ? theme.stateError : theme.stateWarn,
              marginTop: '4px',
            },
          },
          egress.reason,
        )
      : null,

    // Local routing cooldown & TOS alert
    account.tosBlocked
      ? h(
          'div',
          {
            role: 'alert',
            className: 'agy-acp-notice agy-acp-notice--error',
            style: { marginTop: '10px', marginBottom: 0, padding: '8px 10px', fontSize: '12px' },
          },
          '风控/TOS 隔离中：已停止调度与自动切号，以防连坐封禁；核查后可点击「解除隔离与冷却」。',
        )
      : null,
    cooldowns.length > 0
      ? h(
          'div',
          { style: { marginTop: '8px' } },
          h('div', { className: 'agy-acp-muted', style: { fontWeight: 500 } }, '本地路由冷却'),
          h(
            'ul',
            { className: 'agy-acp-caption', style: { paddingInlineStart: '18px', margin: '4px 0 0' } },
            ...cooldowns.map(({ family, until }) => h('li', { key: family }, `${family} · 冷却至 ${localTime(until)}`)),
          ),
        )
      : !account.tosBlocked
        ? h(
            'div',
            { className: 'agy-acp-caption', style: { marginTop: '6px' } },
            '本地路由冷却：无进行中的冷却',
          )
        : null,

    // Upstream quota section
    h(
      'div',
      { style: { marginTop: '10px' } },
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 10px' } },
        h('span', { className: 'agy-acp-muted', style: { fontWeight: 500 } }, '上游剩余配额'),
        quota
          ? h(
              'span',
              { className: 'agy-acp-caption' },
              `上次成功更新：${localTime(quota.sampledAt)} · 来源：${quota.source === 'direct' ? '上游接口' : quota.source === 'cli' ? 'agy CLI /usage' : '未上报'}`,
            )
          : null,
      ),
      unavailable ? h('div', { className: 'agy-acp-caption', style: { marginTop: '4px' } }, unavailable) : null,
      lowWarnings.length > 0
        ? h(
            'div',
            {
              role: 'alert',
              style: {
                fontSize: '12px',
                fontWeight: 500,
                color: lowWarnings.some(w => w.exhausted) ? theme.stateError : theme.stateWarn,
                marginTop: '6px',
              },
            },
            `低配额预警：${lowWarnings.map(w => `${w.group} · ${w.windowLabel}${w.exhausted ? '已耗尽' : `仅剩 ${bucketDisplay({ remainingFraction: w.remainingFraction }, now)}`}`).join('；')}`,
          )
        : null,
      quota?.groups.length
        ? h(
            'div',
            { className: 'agy-acp-quota-grid' },
            ...quota.groups.map(group =>
              h(
                'div',
                { key: group.name, className: 'agy-acp-quota-card' },
                h('div', { style: { fontWeight: 600, fontSize: '12.5px', marginBottom: '6px' } }, group.name),
                h(
                  'dl',
                  { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '7px', margin: 0 } },
                  quotaWindow('5 小时', group.fiveHour, now),
                  quotaWindow('7 天', group.sevenDay, now),
                ),
              ),
            ),
          )
        : h(
            'div',
            { className: 'agy-acp-caption', style: { marginTop: '4px' } },
            quota
              ? '本次查询没有返回配额窗口。'
              : '暂无配额样本。' + (unavailable ? '' : '点击「刷新配额」查询此账号的余量。'),
          ),
    ),

    feedback
      ? h('div', { role: 'status', 'aria-live': 'polite', className: 'agy-acp-caption', style: { marginTop: '8px' } }, feedback)
      : null,
  )
})
