// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import type { AccountHealthSnapshot, QuotaBucketState, StatusSnapshot } from '../common/types.ts'
import {
  activeCooldowns,
  bucketDisplay,
  formatEgressBadge,
  nextAccountExpiry,
  requestAccountAction,
  type AccountActionKind,
} from './account-display.ts'
import { styles, theme } from './theme.ts'

const h = React.createElement
const row = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 12px' }
const secondary = styles.secondaryText
const border = theme.borderPrimary
const button = styles.ghostButton

function localTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function quotaWindow(title: string, bucket: QuotaBucketState | undefined, now: number): unknown {
  return h('div', null,
    h('dt', { style: secondary }, title),
    h('dd', { style: { margin: 0, fontWeight: 550 } }, bucketDisplay(bucket, now)),
    bucket?.resetAt != null && bucket.resetAt > now
      ? h('dd', { style: { ...secondary, margin: 0 } }, `重置于 ${localTime(bucket.resetAt)}`) : null,
  )
}

export function AccountCard({ account, applyStatus }: { account: AccountHealthSnapshot; applyStatus: (value: StatusSnapshot) => void }): unknown {
  const [pending, setPending] = React.useState(null as AccountActionKind | null)
  const [feedback, setFeedback] = React.useState('')
  const locked = React.useRef(false)
  const [, redraw] = React.useReducer((n: number) => n + 1, 0)
  const now = Date.now()
  const deadline = nextAccountExpiry(account, now)
  React.useEffect(() => {
    if (deadline == null) return
    const timer = setTimeout(redraw, Math.min(2_147_483_647, Math.max(1, deadline - Date.now())))
    return () => clearTimeout(timer)
  }, [deadline, now])

  const cooldowns = activeCooldowns(account.families, now)
  const { quota, egress } = account
  const egressBadge = formatEgressBadge(egress)
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
            ? `出口检测通过（${updatedEgress.country ?? '合规'}）。`
            : updatedEgress?.status === 'unsupported'
              ? `检测到受限出口（${updatedEgress.country ?? '受限区'}），请求将在本地安全拦截。`
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

  return h('article', { style: { borderTop: border, padding: '12px 0', overflowWrap: 'anywhere' } },
    h('div', { style: row },
      h('h4', { style: { margin: 0, fontSize: '14px' } }, account.label, account.id !== account.label ? h('small', { style: { ...secondary, fontWeight: 400 } }, ` · ${account.id}`) : null),
      h('span', { style: { ...secondary, border, borderRadius: '12px', padding: '0 8px' } }, account.enabled ? '已启用' : '已停用')),
    h('div', { style: { ...secondary, marginTop: '4px' }, title: '最近分配指最近一次租约分配（包括模型探测），不是最近一轮对话。' }, [
      `活跃租约 ${account.activeLeases}`, `最近分配：${account.lastUsedAt != null ? localTime(account.lastUsedAt) : '暂无记录'}`,
      account.hasSandboxHome && '独立 HOME', account.hasProxy && '独立代理', account.lastError && '最近请求出现错误',
    ].filter(Boolean).join(' · ')),
    h('div', { style: { ...row, marginTop: '10px' } },
      h('strong', null, '网络出口合规'),
      h('button', {
        type: 'button',
        disabled: !!pending || !account.enabled,
        style: button,
        onClick: () => void act('egress'),
        'aria-label': `检测 ${account.label} 的网络出口`,
      }, pending === 'egress' ? '检测中…' : '检测出口')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } },
      h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '12px',
          fontWeight: 500,
          color: egressBadge.tone === 'idle' ? 'inherit' : egressColor,
        },
      },
      h('span', { style: { width: '7px', height: '7px', borderRadius: '999px', backgroundColor: egressColor } }),
      egressBadge.label),
      egress
        ? h('span', { style: secondary }, [
            egress.ipMasked && `IP ${egress.ipMasked}`,
            `检测于 ${localTime(egress.checkedAt)}`,
          ].filter(Boolean).join(' · '))
        : h('span', { style: secondary }, '首次请求前自动预检，也可点击右侧手动检测')),
    egress?.reason && egress.status !== 'supported'
      ? h('div', { style: { ...secondary, color: egressBadge.tone === 'error' ? theme.stateError : theme.stateWarn, opacity: 0.95, marginTop: '2px' } }, egress.reason)
      : null,
    h('div', { style: { ...row, marginTop: '10px' } },
      h('strong', null, '本地路由冷却'),
      cooldowns.length > 0 ? h('button', { type: 'button', disabled: !!pending, style: button,
        onClick: () => void act('clear'), 'aria-label': `清除 ${account.label} 的本地冷却`,
      }, pending === 'clear' ? '清除中…' : '清除本地冷却') : null),
    cooldowns.length ? h('ul', { style: { paddingInlineStart: '18px', margin: '4px 0', ...secondary } }, ...cooldowns.map(({ family, until }) =>
      h('li', { key: family }, `${family} · 冷却至 ${localTime(until)}`)))
      : h('div', { style: secondary }, '无进行中的冷却'),
    h('div', { style: { ...row, marginTop: '12px' } },
      h('strong', null, '上游剩余配额'),
      h('button', { type: 'button', disabled: !!pending || !!unavailable, style: button,
        title: unavailable || undefined, onClick: () => void act('refresh'), 'aria-label': `刷新 ${account.label} 的配额`,
      }, pending === 'refresh' ? '刷新中…' : '刷新配额')),
    unavailable ? h('div', { style: secondary }, unavailable) : null,
    quota ? h('div', { style: secondary }, `上次成功更新：${localTime(quota.sampledAt)}`) : null,
    quota?.groups.length ? quota.groups.map(group => h('div', { key: group.name, style: { marginTop: '6px', padding: '6px 10px', borderInlineStart: border } },
      h('div', { style: { fontWeight: 550 } }, group.name),
      h('dl', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 9rem), 1fr))', gap: '4px 12px', margin: '4px 0 0' } },
        quotaWindow('5 小时', group.fiveHour, now), quotaWindow('7 天', group.sevenDay, now))))
      : h('div', { style: secondary }, quota ? '本次查询没有返回配额窗口。' : '暂无配额样本。'),
    h('div', { role: 'status', 'aria-live': 'polite', style: secondary }, feedback),
  )
}
