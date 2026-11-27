import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
// @ts-expect-error runtime ReactDOM is supplied by the DSH web host
import ReactDOM from 'react-dom'
import { equalModelAccountRouting } from '../common/account-routing.ts'
import { effortLabel } from '../common/effort.ts'
import {
  MIRROR_TOOL_NAME,
  type AcpModelOption,
  type McpToolCatalogSnapshot,
  type ReviewProviderOption,
  type SessionSummary,
  type StatusSnapshot,
} from '../common/types.ts'
import { sessionAccountLabel } from './account-display.ts'
import { AccountsPanel } from './accounts-panel.ts'
import { ConfigFieldset, ConfigPanel, type Operation } from './config-panel.ts'
import { EnvSetupBanner } from './env-setup-banner.ts'
import { AgyAcpToolRow } from './mirror-tool-view.ts'
import { postJson, resetSessions, type SessionResetTarget } from './panel-actions.ts'
import { accountAttention } from './runtime-display.ts'
import { SessionsPanel } from './sessions-panel.ts'
import { snapshotNotice, type SnapshotState } from './snapshot-state.ts'
import { getSharedStatusStore } from './status-store.ts'
import { ensureAgyAcpStyles, styles, theme } from './theme.ts'
import { formatTime, formatTokens } from './ui-primitives.ts'

export { ConfigFieldset }

export const name = 'dsh-agy-acp-client'
export const inject = ['slots']

const h = React.createElement

interface SlotOwnerProps {
  sessionId?: string
  view?: string
}

interface ClientContext extends Context {
  slots: {
    inject(name: string, register: () => () => void): void
    register(
      opts: { name: string; id?: string; key?: string; order?: number; label?: string; inject?: (sessionId: string) => SlotOwnerProps },
      Component: (props?: SlotOwnerProps) => unknown,
    ): () => void
  }
}

function contextLabel(s: SessionSummary): string {
  if (s.contextUsed == null) return '待上报'
  if (!(s.contextSize > 0)) return `${formatTokens(s.contextUsed)}（容量未知）`
  return `${formatTokens(s.contextUsed)} / ${formatTokens(s.contextSize)}（${((100 * s.contextUsed) / s.contextSize).toFixed(1)}%）`
}

function sameModels(a: AcpModelOption[], b: AcpModelOption[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.value !== y.value || x.name !== y.name || x.efforts.length !== y.efforts.length) return false
    for (let j = 0; j < x.efforts.length; j++) {
      if (x.efforts[j] !== y.efforts[j]) return false
    }
  }
  return true
}

function sameReviewProviders(a: ReviewProviderOption[], b: ReviewProviderOption[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || a[i]!.name !== b[i]!.name) return false
  }
  return true
}

function sameCatalog(a: McpToolCatalogSnapshot | undefined, b: McpToolCatalogSnapshot | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (
    a.source !== b.source ||
    a.eagerCount !== b.eagerCount ||
    a.lazyCount !== b.lazyCount ||
    a.offCount !== b.offCount ||
    a.estimatedEagerBytes !== b.estimatedEagerBytes ||
    a.budgetBytes !== b.budgetBytes ||
    a.tools.length !== b.tools.length
  ) {
    return false
  }
  for (let i = 0; i < a.tools.length; i++) {
    const x = a.tools[i]!
    const y = b.tools[i]!
    if (
      x.name !== y.name ||
      x.groupId !== y.groupId ||
      x.effectiveMode !== y.effectiveMode ||
      x.estimatedBytes !== y.estimatedBytes
    ) {
      return false
    }
  }
  return true
}

function useStableValue<T>(value: T, isEqual: (a: T, b: T) => boolean): T {
  const ref = React.useRef(value)
  if (!isEqual(ref.current, value)) {
    ref.current = value
  }
  return ref.current
}

function sameConfig(a: StatusSnapshot['config'] | undefined, b: StatusSnapshot['config'] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.agyBin === b.agyBin &&
    a.workspaceRoot === b.workspaceRoot &&
    a.defaultModel === b.defaultModel &&
    a.defaultEffort === b.defaultEffort &&
    a.autoReviewProvider === b.autoReviewProvider &&
    a.autoReviewModel === b.autoReviewModel &&
    a.autoReviewEffort === b.autoReviewEffort &&
    a.mcpBridge === b.mcpBridge &&
    a.mcpExposeOverlappingTools === b.mcpExposeOverlappingTools &&
    equalModelAccountRouting(a.modelAccountRouting, b.modelAccountRouting) &&
    a.quotaAwareScheduling === b.quotaAwareScheduling &&
    a.sessionIdleTtlMs === b.sessionIdleTtlMs &&
    a.requestTimeoutMs === b.requestTimeoutMs &&
    a.geoFenceMode === b.geoFenceMode &&
    JSON.stringify(a.mcpToolPolicy ?? null) === JSON.stringify(b.mcpToolPolicy ?? null)
  )
}

export interface StatusView extends SnapshotState {
  applyStatus: (next: StatusSnapshot) => void
}

function useAgyAcpStatus(): StatusView {
  const store = getSharedStatusStore()
  const snapshot: SnapshotState =
    typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      : (() => {
          const [snap, setSnap] = React.useState(store.getSnapshot)
          React.useEffect(() => {
            setSnap(store.getSnapshot())
            return store.subscribe(() => setSnap(store.getSnapshot()))
          }, [store])
          return snap
        })()
  const applyStatus = React.useCallback((next: StatusSnapshot) => store.applyStatus(next), [store])
  return { ...snapshot, applyStatus }
}

/** Full Settings & Plugin Configuration page (`settings.section`, `plugins.bundle.config`, `plugins.row.config`). */
function AgyAcpSettingsSection(): unknown {
  return h(SettingsView, { ...useAgyAcpStatus(), initialPanel: 'config' })
}

type Panel = 'sessions' | 'accounts' | 'config'

function renderConnectionPill(
  status: StatusSnapshot,
  stream: SnapshotState['stream'],
  notice: string,
): unknown {
  const connected = !notice && status.enabled && status.connected
  const dotColor = notice
    ? theme.stateWarn
    : !status.enabled
      ? theme.stateIdle
      : connected
        ? theme.stateSuccess
        : theme.stateIdle
  const label = notice
    ? stream === 'offline'
      ? '实时连接中断'
      : '等待实时连接'
    : !status.enabled
      ? '插件已停用'
      : connected
        ? `ACP 已连接 · ${[status.agentName, status.agentVersion, status.tierName].filter(Boolean).join(' · ') || 'agy acp'}`
        : 'ACP 待机（首轮对话自动建连）'
  return h(
    'span',
    { className: 'agy-acp-pill' },
    h('span', { className: 'agy-acp-dot', style: { backgroundColor: dotColor } }),
    label,
  )
}

export function SettingsView({
  status,
  stream,
  failed,
  applyStatus,
  initialPanel = 'sessions',
  inModal = false,
}: StatusView & { initialPanel?: Panel; inModal?: boolean }): unknown {
  React.useEffect(() => {
    ensureAgyAcpStyles()
  }, [])

  const [panel, setPanel] = React.useState(initialPanel)
  const [operation, setOperation] = React.useState(null as Operation)
  const busy = operation !== null
  const [sessionMsg, setSessionMsg] = React.useState('')
  const [modelMsg, setModelMsg] = React.useState('')
  const [refreshingModels, setRefreshingModels] = React.useState(false)
  const [configDirty, setConfigDirty] = React.useState(false)

  // Keep stable references for low-frequency config slices so high-frequency SSE usage/session ticks
  // do not trigger re-renders inside memoized ConfigPanel.
  const emptyModelsRef = React.useRef([] as AcpModelOption[])
  const emptyProvidersRef = React.useRef([] as ReviewProviderOption[])
  const stableConfig = useStableValue(status?.config, sameConfig)
  const stableModels = useStableValue(status?.models ?? emptyModelsRef.current, sameModels)
  const stableReviewProviders = useStableValue(status?.reviewProviders ?? emptyProvidersRef.current, sameReviewProviders)
  const stableCatalog = useStableValue(status?.mcpToolCatalog, sameCatalog)

  const handleRefreshModels = React.useCallback(async (): Promise<void> => {
    setRefreshingModels(true)
    setModelMsg('')
    try {
      const res = await postJson('/plugins/agy-acp/models/refresh', {})
      if (res.status) applyStatus(res.status)
      setModelMsg(
        res.ok && Array.isArray(res.status?.models)
          ? `模型目录已刷新（共 ${res.status.models.length} 个模型）`
          : res.error || '模型目录刷新失败',
      )
    } finally {
      setRefreshingModels(false)
    }
  }, [applyStatus])

  const handleResetSessions = React.useCallback(
    async (target: SessionResetTarget): Promise<void> => {
      setOperation('resetSessions')
      setSessionMsg('')
      try {
        const res = await resetSessions(target)
        if (res.status) applyStatus(res.status)
        setSessionMsg(res.message)
      } finally {
        setOperation(null)
      }
    },
    [applyStatus],
  )

  if (!status) {
    return h(
      'p',
      { role: 'status', className: 'agy-acp-muted' },
      stream === 'offline' || failed ? '暂时无法读取 ACP 状态，等待连接恢复。' : '正在读取 ACP 状态…',
    )
  }

  const notice = snapshotNotice({ status, stream })
  const sessions = status.sessions
  const accounts = status.accounts
  const attentionCount = accounts.filter(a => accountAttention(a, status.updatedAt)).length

  return h(
    'div',
    { className: 'agy-acp-root', style: { padding: inModal ? '0' : '6px 4px', color: theme.textPrimary } },
    !inModal
      ? h(
          'div',
          { className: 'agy-acp-header' },
          h(
            'div',
            null,
            h('h2', { className: 'agy-acp-title' }, 'Antigravity ACP'),
            h('div', { className: 'agy-acp-subtitle' }, `运行控制台 · 快照更新于 ${formatTime(status.updatedAt)}`),
          ),
          renderConnectionPill(status, stream, notice),
        )
      : null,

    notice
      ? h('div', { role: 'status', className: 'agy-acp-notice agy-acp-notice--warn' }, notice)
      : null,

    h(EnvSetupBanner, {
      environment: status.environment,
      agentVersion: status.agentVersion,
      applyStatus,
      onOpenConfig: () => setPanel('config'),
      onOpenAccounts: () => setPanel('accounts'),
    }),

    // Diagnostic error banner (from Phase 2 sanitized lastError)
    status.lastError
      ? h(
          'div',
          { role: 'alert', className: 'agy-acp-notice agy-acp-notice--error' },
          h(
            'div',
            { style: { flex: '1 1 280px', overflowWrap: 'anywhere' } },
            h('strong', { style: { color: theme.stateError } }, '目录/连接诊断：'),
            status.lastError,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: refreshingModels || busy,
              onClick: () => void handleRefreshModels(),
              className: 'agy-acp-btn agy-acp-btn--sm',
            },
            refreshingModels ? '探测中…' : '重新探测目录',
          ),
        )
      : null,

    modelMsg
      ? h('div', { role: 'status', className: 'agy-acp-notice', style: { padding: '8px 12px' } }, modelMsg)
      : null,

    // Segmented console navigation tabs
    h(
      'div',
      { role: 'group', 'aria-label': '控制台分区', className: 'agy-acp-tabs' },
      ...([
        ['sessions', `会话与用量 · ${sessions.length}${status.mcpBridge?.lastError ? '（桥接告警）' : ''}`],
        ['accounts', `账号与配额 · ${accounts.length}${attentionCount ? `（${attentionCount} 个快照告警）` : ''}`],
        ['config', `桥接配置${configDirty ? ' · 未保存' : ''}`],
      ] as const).map(([key, label]) =>
        h(
          'button',
          {
            key,
            type: 'button',
            'aria-pressed': panel === key,
            onClick: () => setPanel(key),
            className: 'agy-acp-tab',
          },
          label,
        ),
      ),
    ),

    // Conditional mounting: only the active tab is mounted in the DOM.
    panel === 'sessions'
      ? h(SessionsPanel, {
          notice,
          sessions,
          persistedSessions: status.persistedSessions,
          accounts,
          capabilities: status.capabilities,
          mcpBridge: status.mcpBridge,
          usageTotals: status.usageTotals,
          busy,
          resettingSessions: operation === 'resetSessions',
          sessionMsg,
          onResetSessions: (target: SessionResetTarget) => void handleResetSessions(target),
        })
      : panel === 'accounts'
        ? h(AccountsPanel, {
            accounts,
            accountUsage: status.accountUsage,
            models: stableModels,
            modelAccountRouting: stableConfig?.modelAccountRouting,
            refreshingModels,
            onRefreshModels: handleRefreshModels,
            preferredAccountId: status.preferredAccountId,
            geoFenceMode: status.config?.geoFenceMode,
            agyFound: status.environment?.agyFound ?? true,
            activeLogin: status.activeLogin,
            applyStatus,
          })
        : stableConfig
          ? h(ConfigPanel, {
              config: stableConfig,
              hasPersistedConfig: Boolean(status.hasPersistedConfig),
              models: stableModels,
              reviewProviders: stableReviewProviders,
              mcpToolCatalog: stableCatalog,
              activeSessionCount: sessions.length,
              operation,
              refreshingModels,
              setOperation,
              onRefreshModels: () => void handleRefreshModels(),
              onResetSessions: (target: SessionResetTarget) => void handleResetSessions(target),
              applyStatus,
              onDirtyChange: setConfigDirty,
            })
          : null,
  )
}

function portalToBody(node: unknown): unknown {
  if (typeof document !== 'undefined' && document.body && typeof ReactDOM?.createPortal === 'function') {
    return ReactDOM.createPortal(node, document.body)
  }
  return node
}

/** Compact header badge + body-portaled console modal (`conversation.session.header.actions`). */
function AgyAcpConsoleWidget(props?: SlotOwnerProps): unknown {
  const [open, setOpen] = React.useState(false)
  const state = useAgyAcpStatus()
  const { status, stream } = state

  React.useEffect(() => {
    ensureAgyAcpStyles()
  }, [])

  React.useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = typeof document !== 'undefined' && document.body ? document.body.style.overflow : ''
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.overflow = 'hidden'
    }
    return () => {
      window.removeEventListener('keydown', onKey)
      if (typeof document !== 'undefined' && document.body) {
        document.body.style.overflow = prevOverflow
      }
    }
  }, [open])

  const notice = snapshotNotice(state)
  const current = !notice ? status?.sessions.find(s => s.dshSessionKey === props?.sessionId) : undefined
  const enabledAccounts = status?.accounts.filter(a => a.enabled) ?? []
  const activeAcc =
    status?.accounts.find(a => a.isEffectiveActive) ??
    (status?.preferredAccountId
      ? status.accounts.find(a => a.id === status.preferredAccountId && a.enabled)
      : undefined) ??
    (enabledAccounts.length === 1 ? enabledAccounts[0] : undefined)
  const badgeLabel = notice
    ? `AGY·ACP · ${stream === 'offline' ? '实时连接中断' : '连接中'}`
    : current
      ? `AGY·ACP · 上下文 ${current.contextUsed == null ? '待上报' : formatTokens(current.contextUsed)}`
      : 'AGY·ACP'
  const hasGeoAlert = Boolean(
    status?.config?.geoFenceMode !== 'off' &&
      status?.accounts.some(a => a.enabled && a.egress?.status === 'unsupported'),
  )
  const missingAgy = status?.environment?.agyFound === false
  const dotColor =
    status?.lastError || hasGeoAlert
      ? theme.stateError
      : missingAgy
        ? theme.stateWarn
        : current
          ? theme.stateSuccess
          : theme.stateIdle

  const modal = open
    ? portalToBody(
        h(
          'div',
          {
            onClick: (ev: { target: unknown; currentTarget: unknown }) => {
              if (ev.target === ev.currentTarget) setOpen(false)
            },
            style: styles.modalOverlay,
          },
          h(
            'div',
            {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': 'Antigravity ACP 控制台',
              style: styles.modalDialog,
            },
            // Fixed Modal Header
            h(
              'div',
              { className: 'agy-acp-modal-header' },
              h(
                'div',
                { style: { minWidth: 0 } },
                h('h2', { className: 'agy-acp-title', style: { fontSize: '16px' } }, 'Antigravity ACP'),
                status
                  ? h('div', { className: 'agy-acp-caption' }, `运行控制台 · 快照更新于 ${formatTime(status.updatedAt)}`)
                  : null,
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                status ? renderConnectionPill(status, stream, notice) : null,
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setOpen(false),
                    title: '关闭 (Esc)',
                    'aria-label': '关闭控制台',
                    className: 'agy-acp-modal-close',
                  },
                  '×',
                ),
              ),
            ),
            // Scrollable Modal Body
            h(
              'div',
              { className: 'agy-acp-modal-body' },
              h(SettingsView, { ...state, inModal: true }),
            ),
          ),
        ),
      )
    : null

  return h(
    React.Fragment,
    null,
    h(
      'button',
      {
        type: 'button',
        className: 'agy-acp-header-badge',
        onClick: (ev: { stopPropagation?: () => void }) => {
          ev.stopPropagation?.()
          setOpen((v: boolean) => !v)
        },
        title: current
          ? `${current.currentModel} · 使用账号 ${sessionAccountLabel(current.accountId, status?.accounts ?? [])} · 推理强度 ${effortLabel(current.currentEffort) || '未报告'} · ACP 上下文 ${contextLabel(current)}`
          : status?.lastError ||
            notice ||
            (activeAcc ? `当前账号：${activeAcc.label} · 点击打开 Antigravity ACP 控制台` : '打开 Antigravity ACP 控制台'),
        style: {
          opacity: current || status?.lastError ? 0.96 : 0.8,
        },
      },
      h('span', {
        style: {
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: dotColor,
        },
      }),
      badgeLabel,
    ),
    modal,
  )
}

export function apply(ctx: ClientContext): void {
  ensureAgyAcpStyles()

  // 1. Top session header quick badge + popover console
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'agy-acp-status',
        inject: sessionId => ({ sessionId }),
        order: 12,
        label: 'Antigravity ACP',
      },
      AgyAcpConsoleWidget,
    ),
  )

  // 2. Dedicated Settings sidebar tab ("Antigravity ACP")
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'agy-acp',
        order: 21,
        label: 'Antigravity ACP',
      },
      AgyAcpSettingsSection,
    ),
  )

  // 3. Plugin manager bundle & row configuration panels
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: '@morsewayne/dsh-agy-acp',
      },
      (ownerProps?: SlotOwnerProps) => {
        if (ownerProps?.view === 'summary') return null
        return h(AgyAcpSettingsSection)
      },
    ),
  )

  ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.row.config',
        key: '@morsewayne/dsh-agy-acp#agy-acp',
      },
      (ownerProps?: SlotOwnerProps) => {
        if (ownerProps?.view === 'summary') return null
        return h(AgyAcpSettingsSection)
      },
    ),
  )

  // 4. Native DSH conversation-panel tool row renderer for `agy_acp_tool`
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: MIRROR_TOOL_NAME,
      },
      AgyAcpToolRow as (props?: SlotOwnerProps) => unknown,
    ),
  )
}
