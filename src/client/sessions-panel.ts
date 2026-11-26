// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import { effortLabel } from '../common/effort.ts'
import type {
  AccountHealthSnapshot,
  AcpCapabilitiesSnapshot,
  McpBridgeSnapshot,
  SessionSummary,
  UsageTotals,
} from '../common/types.ts'
import { sessionAccountLabel } from './account-display.ts'
import type { SessionResetTarget } from './panel-actions.ts'
import { actualTransport, capabilityLabel, recoveryCapability, sessionRecovery } from './runtime-display.ts'
import { theme } from './theme.ts'
import { formatTime, formatTokens, ProgressBar } from './ui-primitives.ts'

const h = React.createElement

function contextLabel(s: SessionSummary): string {
  if (s.contextUsed == null) return '待上报'
  if (!(s.contextSize > 0)) return `${formatTokens(s.contextUsed)}（容量未知）`
  return `${formatTokens(s.contextUsed)} / ${formatTokens(s.contextSize)}（${((100 * s.contextUsed) / s.contextSize).toFixed(1)}%）`
}

export interface SessionsPanelProps {
  notice: string
  sessions: SessionSummary[]
  persistedSessions?: number
  accounts: AccountHealthSnapshot[]
  capabilities?: AcpCapabilitiesSnapshot
  mcpBridge?: McpBridgeSnapshot
  usageTotals?: UsageTotals
  busy: boolean
  resettingSessions: boolean
  sessionMsg: string
  onResetSessions: (target: SessionResetTarget) => void
}

const CAPABILITY_ITEMS = [
  ['HTTP MCP', 'mcpHttp'],
  ['图像', 'image'],
  ['音频', 'audio'],
  ['嵌入上下文', 'embeddedContext'],
  ['系统提示追加', 'systemPromptAppend'],
] as const

export const SessionsPanel = React.memo(function SessionsPanel({
  notice,
  sessions,
  persistedSessions,
  accounts,
  capabilities,
  mcpBridge,
  usageTotals,
  busy,
  resettingSessions,
  sessionMsg,
  onResetSessions,
}: SessionsPanelProps): unknown {
  const [confirmAll, setConfirmAll] = React.useState(false)

  const totals = usageTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
  }

  return h(
    React.Fragment,
    null,
    // KPI Overview card
    h(
      'div',
      { className: 'agy-acp-card' },
      h('h3', { className: 'agy-acp-section-title', style: { marginBottom: '10px' } }, '运行概览与 Token 用量'),
      h(
        'div',
        { className: 'agy-acp-kpi-grid' },
        h(
          'div',
          { className: 'agy-acp-kpi-tile' },
          h('div', { className: 'agy-acp-kpi-label' }, notice ? '快照会话' : '活跃会话'),
          h('div', { className: 'agy-acp-kpi-value' }, String(sessions.length)),
        ),
        h(
          'div',
          { className: 'agy-acp-kpi-tile' },
          h('div', { className: 'agy-acp-kpi-label' }, '输入'),
          h('div', { className: 'agy-acp-kpi-value' }, formatTokens(totals.inputTokens)),
        ),
        h(
          'div',
          { className: 'agy-acp-kpi-tile' },
          h('div', { className: 'agy-acp-kpi-label' }, '缓存读 / 写'),
          h('div', { className: 'agy-acp-kpi-value' }, `${formatTokens(totals.cachedReadTokens)} / ${formatTokens(totals.cachedWriteTokens ?? 0)}`),
        ),
        h(
          'div',
          { className: 'agy-acp-kpi-tile' },
          h('div', { className: 'agy-acp-kpi-label' }, '输出'),
          h('div', { className: 'agy-acp-kpi-value' }, formatTokens(totals.outputTokens)),
        ),
        h(
          'div',
          { className: 'agy-acp-kpi-tile' },
          h('div', { className: 'agy-acp-kpi-label' }, '推理'),
          h('div', { className: 'agy-acp-kpi-value' }, formatTokens(totals.reasoningTokens)),
        ),
      ),
    ),

    // Active ACP sessions card
    h(
      'section',
      { className: 'agy-acp-card' },
      h(
        'div',
        { className: 'agy-acp-section-head' },
        h(
          'div',
          null,
          h('h3', { className: 'agy-acp-section-title' }, `${notice ? '快照中的会话' : '活跃 ACP 会话'} (${sessions.length})`),
          h('div', { className: 'agy-acp-caption', style: { marginTop: '2px' } }, `上次握手的恢复能力 · ${recoveryCapability(capabilities)}`),
          typeof persistedSessions === 'number' && persistedSessions > 0
            ? h(
                'div',
                { className: 'agy-acp-caption', style: { marginTop: '2px' } },
                `恢复索引：${persistedSessions} 个 · 下次建连时尝试恢复，索引并非活跃会话。`,
              )
            : null,
        ),
        sessions.length > 0 || (persistedSessions ?? 0) > 0
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => setConfirmAll(true),
                className: 'agy-acp-btn agy-acp-btn--sm agy-acp-btn--danger',
              },
              '重置全部会话',
            )
          : null,
      ),

      // Bridge runtime strip
      mcpBridge
        ? h(
            'div',
            {
              style: {
                padding: '8px 11px',
                borderRadius: '9px',
                border: theme.borderSubtle,
                backgroundColor: theme.surfaceTile,
                marginBottom: '10px',
                fontSize: '11.5px',
              },
            },
            h(
              'div',
              { className: 'agy-acp-muted', style: { fontSize: '11.5px' } },
              [
                `桥接运行态：挂载会话 ${mcpBridge.activeBridges}`,
                `在途调用 ${mcpBridge.inFlightCalls}`,
                `累计调用 ${mcpBridge.totalCalls}`,
                mcpBridge.failedCalls > 0 && `失败/超时 ${mcpBridge.failedCalls}`,
                mcpBridge.lastToolName && `最近工具 ${mcpBridge.lastToolName}`,
                `实际传输：${mcpBridge.activeBridges > 0 ? actualTransport(mcpBridge.transport) : '未挂载'}`,
              ].filter(Boolean).join(' · '),
            ),
            mcpBridge.lastError
              ? h(
                  'div',
                  { style: { color: theme.stateWarn, marginTop: '4px', overflowWrap: 'anywhere' } },
                  `最近桥接告警：${mcpBridge.lastError}`,
                )
              : null,
          )
        : h('div', { className: 'agy-acp-caption', style: { marginBottom: '10px' } }, '桥接运行态：未上报'),

      // Handshake capabilities collapsible
      h(
        'details',
        { className: 'agy-acp-collapsible', style: { marginBottom: '12px' } },
        h(
          'summary',
          null,
          h('span', null, '上次握手的输入与工具能力'),
          h('span', { className: 'agy-acp-caption' }, '查看详情'),
        ),
        h(
          'div',
          {
            className: 'agy-acp-collapsible-body',
            style: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
          },
          ...CAPABILITY_ITEMS.map(([label, key]) => {
            const val = capabilities?.[key]
            const toneClass =
              val === true ? 'agy-acp-pill--success' : val === false ? '' : ''
            return h(
              'span',
              { key, className: `agy-acp-pill agy-acp-pill--sm ${toneClass}` },
              `${label}：${capabilityLabel(val)}`,
            )
          }),
        ),
      ),

      confirmAll
        ? h(
            'div',
            { className: 'agy-acp-notice agy-acp-notice--error' },
            h('span', null, '关闭全部 ACP 会话并清除恢复索引？此操作不能撤销。'),
            h(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              h(
                'button',
                { type: 'button', className: 'agy-acp-btn agy-acp-btn--sm', onClick: () => setConfirmAll(false) },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'agy-acp-btn agy-acp-btn--sm agy-acp-btn--danger-solid',
                  disabled: busy,
                  onClick: () => {
                    setConfirmAll(false)
                    onResetSessions({ kind: 'all' })
                  },
                },
                '确认重置全部',
              ),
            ),
          )
        : null,

      resettingSessions || sessionMsg
        ? h(
            'div',
            { role: 'status', className: 'agy-acp-notice', style: { padding: '8px 11px' } },
            resettingSessions ? '正在关闭会话…' : sessionMsg,
          )
        : null,

      sessions.length === 0
        ? h(
            'div',
            { className: 'agy-acp-muted', style: { padding: '14px 2px' } },
            notice
              ? '此快照没有会话。等待实时连接后可确认当前状态。'
              : '暂无活跃 ACP 会话。在对话中选择 Antigravity (ACP) 模型并发送消息即可建立。',
          )
        : h(
            'div',
            { className: 'agy-acp-list' },
            ...sessions.map((s: SessionSummary) => {
              const pct =
                s.contextUsed != null && s.contextSize > 0
                  ? Math.min(100, Math.max(0, (100 * s.contextUsed) / s.contextSize))
                  : null
              const recovery = sessionRecovery(s)
              const barColor =
                pct == null ? theme.stateIdle : pct > 92 ? theme.stateError : pct > 80 ? theme.stateWarn : theme.accentBlue

              return h(
                'div',
                { key: s.dshSessionKey, className: 'agy-acp-list-row', style: { alignItems: 'center', padding: '11px 13px' } },
                h(
                  'div',
                  { style: { flex: '1 1 240px', minWidth: 0 } },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontWeight: 600, fontSize: '13px' } },
                    `${s.currentModel || 'default'} · ${s.currentMode}`,
                    recovery
                      ? h('span', { className: 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--success' }, recovery)
                      : null,
                  ),
                  s.title
                    ? h('div', { style: { fontSize: '12.5px', marginTop: '2px', overflowWrap: 'anywhere' } }, `标题：${s.title}`)
                    : null,
                  h(
                    'div',
                    { className: 'agy-acp-muted', style: { marginTop: '2px', overflowWrap: 'anywhere' } },
                    `使用账号${notice ? '（上次快照）' : ''}：${sessionAccountLabel(s.accountId, accounts)}`,
                  ),
                  h(
                    'div',
                    { className: 'agy-acp-caption', style: { marginTop: '2px' } },
                    `会话 ${s.dshSessionKey} · 推理强度 ${s.currentEffort ? effortLabel(s.currentEffort) : '未报告'} · ACP 上下文 ${contextLabel(s)} · 活跃于 ${formatTime(s.lastActiveAt)}`,
                  ),
                  h('div', { className: 'agy-acp-caption', style: { marginTop: '2px' } }, `MCP 实际传输：${actualTransport(s.mcpTransport)}`),
                  pct != null
                    ? h(ProgressBar, {
                        valuePct: pct,
                        ariaLabel: 'ACP 上下文占用',
                        color: barColor,
                        height: 4,
                        style: { marginTop: '7px' },
                      })
                    : null,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy,
                    onClick: () => onResetSessions({ kind: 'one', sessionKey: s.dshSessionKey }),
                    'aria-label': `关闭会话 ${s.title || s.dshSessionKey}`,
                    className: 'agy-acp-btn agy-acp-btn--sm',
                  },
                  '关闭',
                ),
              )
            }),
          ),
    ),
  )
})
