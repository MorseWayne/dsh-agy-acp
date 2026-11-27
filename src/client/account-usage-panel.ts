// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import { MODEL_FAMILY_META, MODEL_FAMILY_ORDER } from '../common/account-routing.ts'
import { USAGE_RETENTION_DAYS, usageSharePct } from '../common/account-usage.ts'
import type {
  AccountHealthSnapshot, AccountUsageEntry, AccountUsageSnapshot, AccountUsageWindowKey, StatusSnapshot, UsageCounter,
} from '../common/types.ts'
import { resetAccountUsage } from './panel-actions.ts'
import { formatTime, formatTokens, ProgressBar, SegmentedControl } from './ui-primitives.ts'

const h = React.createElement
const btn = 'agy-acp-btn agy-acp-btn--sm'
const pill = 'agy-acp-pill agy-acp-pill--sm'
const ranges = [
  { value: 'today', label: '今日' }, { value: 'last7Days', label: '近 7 天' }, { value: 'allTime', label: '累计' },
] as const

export interface AccountUsagePanelProps {
  accounts: AccountHealthSnapshot[]
  accountUsage?: AccountUsageSnapshot
  applyStatus: (next: StatusSnapshot) => void
}

interface PanelState {
  range: AccountUsageWindowKey
  reset: 'idle' | 'confirm' | 'pending' | 'done' | 'failed'
  error?: string
}
export const initialUsagePanel: PanelState = { range: 'today', reset: 'idle' }

function hasActivity(counter: UsageCounter): boolean {
  return Object.values(counter).some(value => value > 0)
}

function kpi(label: string, value: string, detail?: string): unknown {
  return h('div', { className: 'agy-acp-kpi-tile' },
    h('div', { className: 'agy-acp-kpi-label' }, label),
    h('div', { className: 'agy-acp-kpi-value' }, value),
    detail ? h('div', { className: 'agy-acp-caption' }, detail) : null)
}

function poolSummary(t: UsageCounter): unknown {
  return h('div', { className: 'agy-acp-kpi-grid', role: 'group', 'aria-label': '全池总量' },
    kpi('总 Token', formatTokens(t.totalTokens)),
    kpi('请求轮次', `${t.requests} 次`, t.rateLimited || t.failed ? `限流 ${t.rateLimited} · 失败 ${t.failed}` : undefined),
    kpi('输入 / 缓存读', `${formatTokens(t.inputTokens)} / ${formatTokens(t.cachedReadTokens)}`,
      t.cachedWriteTokens ? `缓存写 ${formatTokens(t.cachedWriteTokens)}` : undefined),
    kpi('输出 / 推理', `${formatTokens(t.outputTokens)} / ${formatTokens(t.reasoningTokens)}`))
}

function accountRow(entry: AccountUsageEntry, pool: UsageCounter, account?: AccountHealthSnapshot): unknown {
  const t = entry.totals
  const name = account?.label || entry.accountLabel || entry.accountId
  let basis = 'Token'
  let pct = usageSharePct(t.totalTokens, pool.totalTokens)
  if (!pool.totalTokens && pool.requests > 0) {
    basis = '请求'
    pct = usageSharePct(t.requests, pool.requests)
  } else if (!pool.totalTokens && pool.rateLimited + pool.failed > 0) {
    basis = '限流与失败'
    pct = usageSharePct(t.rateLimited + t.failed, pool.rateLimited + pool.failed)
  }
  const share = `${basis}占比 ${Number(pct.toFixed(1))}%`
  const cacheWrite = t.cachedWriteTokens ? ` · 缓存写 ${formatTokens(t.cachedWriteTokens)}` : ''
  const families = MODEL_FAMILY_ORDER.flatMap(family => {
    const c = entry.families[family]
    if (!c || !hasActivity(c)) return []
    return [h('span', { key: family, className: pill },
      `${MODEL_FAMILY_META[family].label} · ${formatTokens(c.totalTokens)} · ${c.requests} 次` +
      (c.rateLimited ? ` · 限流 ${c.rateLimited}` : '') + (c.failed ? ` · 失败 ${c.failed}` : ''))]
  })
  return h('li', { key: entry.accountId, className: 'agy-acp-usage-row' },
    h('div', { className: 'agy-acp-usage-line' },
      h('strong', null, name),
      !account ? h('span', { className: pill }, '已移除') : account.enabled === false ? h('span', { className: pill }, '已停用') : null,
      h('span', { className: 'agy-acp-usage-share' }, share)),
    h(ProgressBar, { valuePct: pct, ariaLabel: `${name}的${share}` }),
    h('div', { className: 'agy-acp-usage-line' },
      h('strong', null, `${formatTokens(t.totalTokens)} Token`), h('span', null, `${t.requests} 次请求`),
      t.rateLimited ? h('span', { className: `${pill} agy-acp-pill--warn` }, `限流 ${t.rateLimited}`) : null,
      t.failed ? h('span', { className: `${pill} agy-acp-pill--error` }, `失败 ${t.failed}`) : null,
      h('span', { className: 'agy-acp-caption' }, `最近使用 ${formatTime(entry.lastUsedAt ?? 0)}`)),
    h('div', { className: 'agy-acp-caption' }, `输入 ${formatTokens(t.inputTokens)} · 缓存读 ${formatTokens(t.cachedReadTokens)}` +
      `${cacheWrite} · 输出 ${formatTokens(t.outputTokens)} · 推理 ${formatTokens(t.reasoningTokens)}`),
    families.length ? h('div', { className: 'agy-acp-usage-line', role: 'group', 'aria-label': '按模型大类细分' }, ...families) : null)
}

export function renderAccountUsagePanel(
  { accountUsage, accounts, applyStatus }: AccountUsagePanelProps, state: PanelState, setState: (next: PanelState) => void,
): unknown {
  const { range, reset, error } = state
  const window = accountUsage?.[range]
  const hasHistory = Boolean(accountUsage && hasActivity(accountUsage.allTime.totals))
  const pending = reset === 'pending'
  const confirming = reset === 'confirm' || pending
  const byId = new Map(accounts.map(account => [account.id, account]))
  async function submitReset(): Promise<void> {
    if (!hasHistory || reset !== 'confirm') return
    setState({ range, reset: 'pending' })
    const res = await resetAccountUsage()
    if (!res.ok || !res.status) {
      setState({ range, reset: 'failed', error: `清空失败：${res.error || '未收到有效的用量快照，请刷新后重试。'}` })
      return
    }
    applyStatus(res.status)
    setState({ range, reset: 'done' })
  }
  const historyHint = range === 'allTime' || !hasHistory ? '' :
    `可切换到${range === 'today' && accountUsage?.last7Days.accounts.length ? '「近 7 天」或' : ''}「累计」查看历史记录。`
  return h('section', { className: 'agy-acp-card agy-acp-usage', 'aria-label': '多账号用量看板' },
    h('div', { className: 'agy-acp-section-head' },
      h('div', { className: 'agy-acp-usage-intro' },
        h('h3', { className: 'agy-acp-section-title' }, '多账号用量看板'),
        h('p', { className: 'agy-acp-caption' }, `按本地实测统计各账号消耗（保留近 ${accountUsage?.retentionDays ?? USAGE_RETENTION_DAYS} 天日明细与历史累计），每轮对话结束自动刷新。`)),
      h('div', { className: 'agy-acp-usage-line' },
        h(SegmentedControl, { ariaLabel: '用量统计时间范围', options: ranges, value: range, disabled: !accountUsage || pending,
          onChange: (next: AccountUsageWindowKey) => setState({ range: next, reset: 'idle' }) }),
        h('button', { type: 'button', className: btn, 'aria-expanded': confirming, disabled: !hasHistory || confirming,
          onClick: () => setState({ range, reset: 'confirm' }) }, '清空统计'))),
    confirming ? h('div', { className: 'agy-acp-notice agy-acp-notice--warn', role: 'group', 'aria-label': '清空统计确认' },
      h('span', null, '确认清空全部历史与每日用量统计？此操作不可撤销。'),
      h('div', { className: 'agy-acp-usage-line' },
        h('button', { type: 'button', className: btn, disabled: pending, onClick: () => setState({ range, reset: 'idle' }) }, '取消'),
        h('button', { type: 'button', className: `${btn} agy-acp-btn--danger`, disabled: pending || !hasHistory, onClick: submitReset }, pending ? '清空中…' : '确认清空'))) : null,
    reset === 'failed' ? h('div', { role: 'alert', className: 'agy-acp-notice agy-acp-notice--error' }, error) : null,
    reset === 'done' ? h('div', { role: 'status', className: 'agy-acp-notice' }, '用量统计已清空。') : null,
    window ? h(React.Fragment, null, poolSummary(window.totals),
      h('h4', { className: 'agy-acp-usage-heading' }, '各账号用量'),
      window.accounts.length ? h('ul', { className: 'agy-acp-list agy-acp-usage-list' },
        ...window.accounts.map(entry => accountRow(entry, window.totals, byId.get(entry.accountId)))) :
        h('p', { className: 'agy-acp-muted' }, `当前时段暂无账号用量记录。${historyHint}`)) :
      h('p', { className: 'agy-acp-muted' }, '暂未收到用量统计，等待连接或插件更新。'))
}

export const AccountUsagePanel = React.memo(function AccountUsagePanel(props: AccountUsagePanelProps): unknown {
  const [state, setState] = React.useState(initialUsagePanel)
  return renderAccountUsagePanel(props, state, setState)
})
