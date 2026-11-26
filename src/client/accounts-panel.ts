// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import type { AccountHealthSnapshot, GeoFenceMode, StatusSnapshot } from '../common/types.ts'
import { AccountCard } from './account-card.ts'
import { requestAllAccountsEgressCheck } from './account-display.ts'

const h = React.createElement

export interface AccountsPanelProps {
  accounts: AccountHealthSnapshot[]
  geoFenceMode?: GeoFenceMode
  applyStatus: (next: StatusSnapshot) => void
}

export const AccountsPanel = React.memo(function AccountsPanel({
  accounts,
  geoFenceMode,
  applyStatus,
}: AccountsPanelProps): unknown {
  const [checkingAll, setCheckingAll] = React.useState(false)
  const [batchMsg, setBatchMsg] = React.useState('')

  const enabledCount = accounts.filter(a => a.enabled).length

  const handleCheckAllEgress = async (): Promise<void> => {
    if (checkingAll || enabledCount === 0) return
    setCheckingAll(true)
    setBatchMsg('')
    try {
      const nextStatus = await requestAllAccountsEgressCheck()
      applyStatus(nextStatus)
      const enabledAfter = nextStatus.accounts.filter(a => a.enabled)
      const supportedCount = enabledAfter.filter(a => a.egress?.status === 'supported').length
      const unsupportedCount = enabledAfter.filter(a => a.egress?.status === 'unsupported').length
      if (unsupportedCount > 0) {
        setBatchMsg(`已完成全部出口检测：${supportedCount} 个合规，${unsupportedCount} 个受限。`)
      } else {
        setBatchMsg(`已完成全部出口检测（${supportedCount}/${enabledAfter.length} 个合规）。`)
      }
    } catch (error) {
      setBatchMsg(error instanceof Error ? error.message : '全部出口检测失败，请稍后重试。')
    } finally {
      setCheckingAll(false)
    }
  }

  return h(
    'section',
    { className: 'agy-acp-card' },
    h(
      'div',
      { className: 'agy-acp-section-head' },
      h(
        'div',
        null,
        h('h3', { className: 'agy-acp-section-title' }, `账号状态 (${accounts.length})`),
        h(
          'p',
          { className: 'agy-acp-caption', style: { margin: '3px 0 0' } },
          '配额仅在手动刷新时向上游查询，不按 Token 用量推算。清除本地冷却不会恢复上游额度。',
        ),
      ),
      enabledCount > 0
        ? h(
            'button',
            {
              type: 'button',
              disabled: checkingAll,
              className: 'agy-acp-btn agy-acp-btn--sm',
              onClick: () => void handleCheckAllEgress(),
            },
            checkingAll ? '正在检测全部出口…' : '检测全部出口',
          )
        : null,
    ),
    batchMsg
      ? h('div', { role: 'status', className: 'agy-acp-notice', style: { padding: '8px 11px', marginBottom: '10px' } }, batchMsg)
      : null,
    accounts.length > 0
      ? accounts.map(account =>
          h(AccountCard, {
            key: account.id,
            account,
            geoFenceMode,
            applyStatus,
          }),
        )
      : h(
          'div',
          { className: 'agy-acp-muted', style: { padding: '12px 0' } },
          '尚未收到账号状态。请检查账号配置及插件是否启用；收到快照后将自动显示。',
        ),
  )
})
