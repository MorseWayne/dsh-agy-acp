import type { AccountHealthSnapshot, AcpCapabilitiesSnapshot, McpBridgeSnapshot, SessionSummary } from '../common/types.ts'

import { activeCooldowns, lowQuotaWarnings } from './account-display.ts'

/** These values describe observations, never capability or configuration guesses. */
export function sessionRecovery(s: Pick<SessionSummary, 'resumed' | 'resumedVia'>): string {
  if (s.resumedVia === 'load' || s.resumedVia === 'resume') return `session/${s.resumedVia} 已恢复`
  return s.resumed ? '已恢复（方式未上报）' : ''
}

export function actualTransport(value: SessionSummary['mcpTransport'] | McpBridgeSnapshot['transport']): string {
  switch (value) {
    case 'http': return 'HTTP'
    case 'stdio': return 'stdio'
    case 'mixed': return 'HTTP + stdio'
    case 'none': return '未挂载'
    default: return '未上报'
  }
}

export function capabilityLabel(v?: boolean): string {
  return v === true ? '支持' : v === false ? '不支持' : '未上报'
}

export function recoveryCapability(caps?: AcpCapabilitiesSnapshot): string {
  return `session/resume：${capabilityLabel(caps?.resumeSession)} · session/load：${capabilityLabel(caps?.loadSession)}`
}

export function accountAttention(account: AccountHealthSnapshot, at: number): string {
  if (!account.enabled) return ''
  if (account.tosBlocked) return '风控隔离'
  if (account.egress?.status === 'unsupported') return '上次检测出口受限'
  if (account.egress?.status === 'error' || account.egress?.status === 'unknown') return '出口待核查'
  if (activeCooldowns(account.families, at).length) return '本地冷却'
  if (lowQuotaWarnings(account.quota, at).length) return '配额偏低'
  return account.lastError ? '最近请求异常' : ''
}
