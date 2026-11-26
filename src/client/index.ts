import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
// @ts-expect-error runtime ReactDOM is supplied by the DSH web host
import ReactDOM from 'react-dom'
import {
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
  SESSION_IDLE_TTL_MAX_MS,
  SESSION_IDLE_TTL_MIN_MS,
} from '../common/config.ts'
import { effortLabel, sortedEfforts } from '../common/effort.ts'
import { isGeoFenceMode } from '../common/geo.ts'
import {
  compactMcpToolPolicy,
  resolveEffectiveMcpToolPolicy,
  type EffectiveMcpToolPolicy,
  type ReplaceGroupId,
  type ReplaceGroupMode,
  type SupplementGroupId,
  type SupplementGroupMode,
  type ToolExposureMode,
} from '../common/mcp-tool-policy.ts'
import { PROVIDER_ID, type GeoFenceMode, type SessionSummary, type StatusSnapshot } from '../common/types.ts'
import { AccountCard } from './account-card.ts'
import { sessionAccountLabel } from './account-display.ts'
import { McpToolPolicyPanel } from './mcp-tool-panel.ts'
import { actualTransport, accountAttention, capabilityLabel, recoveryCapability, sessionRecovery } from './runtime-display.ts'
import { snapshotNotice, type SnapshotState } from './snapshot-state.ts'
import { fetchReviewModels, postJson, resetSessions, type ReviewModelOption, type SessionResetTarget } from './panel-actions.ts'
import { getSharedStatusStore } from './status-store.ts'
import { styles, theme } from './theme.ts'

export const name = 'dsh-agy-acp-client'
export const inject = ['slots']

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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function contextLabel(s: SessionSummary): string {
  if (s.contextUsed == null) return '待上报'
  if (!(s.contextSize > 0)) return `${formatTokens(s.contextUsed)}（容量未知）`
  return `${formatTokens(s.contextUsed)} / ${formatTokens(s.contextSize)}（${(100 * s.contextUsed / s.contextSize).toFixed(1)}%）`
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知'
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function clampIdleMinutes(ms: number | undefined): number {
  const raw = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 60_000) : 30
  return Math.min(SESSION_IDLE_TTL_MAX_MS / 60_000, Math.max(SESSION_IDLE_TTL_MIN_MS / 60_000, raw))
}

function clampTimeoutSeconds(ms: number | undefined): number {
  const raw = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 1_000) : 600
  return Math.min(REQUEST_TIMEOUT_MAX_MS / 1_000, Math.max(REQUEST_TIMEOUT_MIN_MS / 1_000, raw))
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
  return React.createElement(SettingsView, { ...useAgyAcpStatus(), initialPanel: 'config' })
}

interface FormBaseline {
  mcpBridge: boolean
  mcpToolPolicy: EffectiveMcpToolPolicy
  quotaAwareScheduling: boolean
  geoFenceMode: GeoFenceMode
  defaultModel: string
  defaultEffort: string
  autoReviewProvider: string
  autoReviewModel: string
  autoReviewEffort: string
  agyBin: string
  workspaceRoot: string
  idleMinutes: string
  timeoutSeconds: string
}

function baselineFromStatus(status: StatusSnapshot): FormBaseline {
  const rawMode = status.config?.geoFenceMode
  const rawReviewProvider = status.config?.autoReviewProvider ?? ''
  return {
    mcpBridge: Boolean(status.config?.mcpBridge),
    mcpToolPolicy: resolveEffectiveMcpToolPolicy(status.config?.mcpToolPolicy, status.config?.mcpExposeOverlappingTools),
    quotaAwareScheduling: Boolean(status.config?.quotaAwareScheduling),
    geoFenceMode: isGeoFenceMode(rawMode) ? rawMode : 'block',
    defaultModel: status.config?.defaultModel ?? '',
    defaultEffort: status.config?.defaultEffort ?? '',
    autoReviewProvider: rawReviewProvider === PROVIDER_ID ? '' : rawReviewProvider,
    autoReviewModel: status.config?.autoReviewModel ?? '',
    autoReviewEffort: status.config?.autoReviewEffort ?? '',
    agyBin: status.config?.agyBin ?? '',
    workspaceRoot: status.config?.workspaceRoot ?? '',
    idleMinutes: String(clampIdleMinutes(status.config?.sessionIdleTtlMs)),
    timeoutSeconds: String(clampTimeoutSeconds(status.config?.requestTimeoutMs)),
  }
}

type Panel = 'sessions' | 'accounts' | 'config'
type Operation = 'save' | 'resetConfig' | 'resetSessions' | null

/** Native fieldset semantics lock all descendant controls, including any future configuration fields. */
export function ConfigFieldset({ operation, hidden, onEdit, children }: {
  operation: Operation; hidden: boolean; onEdit: () => void; children?: unknown
}): unknown {
  const writing = operation === 'save' || operation === 'resetConfig'
  return React.createElement('fieldset', {
    disabled: writing, 'aria-busy': writing, 'aria-label': '桥接配置', hidden, onChangeCapture: onEdit,
    style: { ...styles.card, marginInline: 0, minWidth: 0 },
  }, children)
}

export function SettingsView({ status, stream, failed, applyStatus, initialPanel = 'sessions' }: StatusView & { initialPanel?: Panel }): unknown {
  const [panel, setPanel] = React.useState(initialPanel)
  const [operation, setOperation] = React.useState(null as Operation)
  const busy = operation !== null
  const [sessionMsg, setSessionMsg] = React.useState('')
  const [modelMsg, setModelMsg] = React.useState('')
  const [confirmAll, setConfirmAll] = React.useState(false)
  const [refreshingModels, setRefreshingModels] = React.useState(false)
  const [savedMsg, setSavedMsg] = React.useState('')

  const initialBase = status ? baselineFromStatus(status) : null
  const [baseline, setBaseline] = React.useState(initialBase as FormBaseline | null)
  const [mcpBridge, setMcpBridge] = React.useState(initialBase?.mcpBridge ?? false)
  const [mcpToolPolicy, setMcpToolPolicy] = React.useState(
    initialBase?.mcpToolPolicy ?? resolveEffectiveMcpToolPolicy(),
  )
  const [needsSessionResetHint, setNeedsSessionResetHint] = React.useState(false)
  const [quotaAwareScheduling, setQuotaAwareScheduling] = React.useState(initialBase?.quotaAwareScheduling ?? false)
  const [geoFenceMode, setGeoFenceMode] = React.useState(initialBase?.geoFenceMode ?? ('block' as GeoFenceMode))
  const [defaultModel, setDefaultModel] = React.useState(initialBase?.defaultModel ?? '')
  const [defaultEffort, setDefaultEffort] = React.useState(initialBase?.defaultEffort ?? '')
  const [autoReviewProvider, setAutoReviewProvider] = React.useState(initialBase?.autoReviewProvider ?? '')
  const [autoReviewModel, setAutoReviewModel] = React.useState(initialBase?.autoReviewModel ?? '')
  const [autoReviewEffort, setAutoReviewEffort] = React.useState(initialBase?.autoReviewEffort ?? '')
  const [manualReviewModel, setManualReviewModel] = React.useState(false)
  const [externalReviewModels, setExternalReviewModels]: [ReviewModelOption[], (v: ReviewModelOption[]) => void] = React.useState([])
  const [loadingReviewModels, setLoadingReviewModels] = React.useState(false)
  const [reviewModelsError, setReviewModelsError] = React.useState('')
  const [agyBin, setAgyBin] = React.useState(initialBase?.agyBin ?? '')
  const [workspaceRoot, setWorkspaceRoot] = React.useState(initialBase?.workspaceRoot ?? '')
  const [idleMinutes, setIdleMinutes] = React.useState(initialBase?.idleMinutes ?? '30')
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(initialBase?.timeoutSeconds ?? '600')

  const syncFormTo = React.useCallback((nextBase: FormBaseline) => {
    setBaseline(nextBase)
    setMcpBridge(nextBase.mcpBridge)
    setMcpToolPolicy(nextBase.mcpToolPolicy)
    setQuotaAwareScheduling(nextBase.quotaAwareScheduling)
    setGeoFenceMode(nextBase.geoFenceMode)
    setDefaultModel(nextBase.defaultModel)
    setDefaultEffort(nextBase.defaultEffort)
    setAutoReviewProvider(nextBase.autoReviewProvider)
    setAutoReviewModel(nextBase.autoReviewModel)
    setAutoReviewEffort(nextBase.autoReviewEffort)
    setAgyBin(nextBase.agyBin)
    setWorkspaceRoot(nextBase.workspaceRoot)
    setIdleMinutes(nextBase.idleMinutes)
    setTimeoutSeconds(nextBase.timeoutSeconds)
  }, [])

  React.useEffect(() => {
    if (!status) return
    const incoming = baselineFromStatus(status)
    if (!baseline) {
      syncFormTo(incoming)
      return
    }
    const isCurrentlyClean =
      mcpBridge === baseline.mcpBridge &&
      JSON.stringify(mcpToolPolicy) === JSON.stringify(baseline.mcpToolPolicy) &&
      quotaAwareScheduling === baseline.quotaAwareScheduling &&
      geoFenceMode === baseline.geoFenceMode &&
      defaultModel === baseline.defaultModel &&
      defaultEffort === baseline.defaultEffort &&
      autoReviewProvider === baseline.autoReviewProvider &&
      autoReviewModel === baseline.autoReviewModel &&
      autoReviewEffort === baseline.autoReviewEffort &&
      agyBin === baseline.agyBin &&
      workspaceRoot === baseline.workspaceRoot &&
      idleMinutes === baseline.idleMinutes &&
      timeoutSeconds === baseline.timeoutSeconds
    if (isCurrentlyClean && JSON.stringify(incoming) !== JSON.stringify(baseline)) {
      syncFormTo(incoming)
    }
  }, [status, baseline, mcpBridge, mcpToolPolicy, quotaAwareScheduling, geoFenceMode, defaultModel, defaultEffort, autoReviewProvider, autoReviewModel, autoReviewEffort, agyBin, workspaceRoot, idleMinutes, timeoutSeconds, syncFormTo])

  const trimmedReviewProvider = autoReviewProvider.trim()
  const isExternalReviewProvider = trimmedReviewProvider !== '' && trimmedReviewProvider !== PROVIDER_ID

  React.useEffect(() => {
    if (!isExternalReviewProvider) {
      setExternalReviewModels([])
      setLoadingReviewModels(false)
      setReviewModelsError('')
      setManualReviewModel(false)
      return
    }
    let cancelled = false
    setLoadingReviewModels(true)
    setReviewModelsError('')
    void fetchReviewModels(trimmedReviewProvider).then((res) => {
      if (cancelled) return
      setLoadingReviewModels(false)
      setExternalReviewModels(res.models)
      setReviewModelsError(res.ok ? '' : (res.error ?? '获取模型列表失败，可手动输入模型 ID'))
    })
    return () => {
      cancelled = true
    }
  }, [isExternalReviewProvider, trimmedReviewProvider])

  if (!status) {
    return React.createElement(
      'p',
      { role: 'status' },
      stream === 'offline' || failed ? '暂时无法读取 ACP 状态，等待连接恢复。' : '正在读取 ACP 状态…',
    )
  }

  const notice = snapshotNotice({ status, stream })
  const connected = !notice && status.enabled && status.connected
  const sessions = status.sessions
  const accounts = status.accounts
  const attentionCount = accounts.filter(a => accountAttention(a, status.updatedAt)).length
  const models = status.models ?? []
  const trimmedModel = defaultModel.trim()
  const selected = models.find(m => m.value === trimmedModel)
  const customModelNotInCatalog = trimmedModel !== '' && models.length > 0 && !selected
  const effortChoices = selected?.efforts ?? sortedEfforts(models.flatMap(m => m.efforts))
  const knownEfforts = !!selected || (!trimmedModel && models.length > 0)
  const incompatible = knownEfforts && defaultEffort !== '' && !effortChoices.includes(defaultEffort)

  const reviewProviders = (status.reviewProviders ?? []).filter(p => p.id !== PROVIDER_ID)
  const customReviewProviderNotInList =
    isExternalReviewProvider && !reviewProviders.some(p => p.id === trimmedReviewProvider)
  const trimmedReviewModel = autoReviewModel.trim()
  const selectedInternalReviewModel = !isExternalReviewProvider
    ? models.find(m => m.value === trimmedReviewModel)
    : undefined
  const customInternalReviewModelNotInCatalog =
    !isExternalReviewProvider && trimmedReviewModel !== '' && models.length > 0 && !selectedInternalReviewModel
  const customExternalReviewModelNotInList =
    isExternalReviewProvider &&
    trimmedReviewModel !== '' &&
    externalReviewModels.length > 0 &&
    !externalReviewModels.some(m => m.id === trimmedReviewModel)
  const reviewEffortChoices = !isExternalReviewProvider
    ? (selectedInternalReviewModel?.efforts ?? sortedEfforts(models.flatMap(m => m.efforts)))
    : []
  const knownReviewEfforts = !isExternalReviewProvider && (!!selectedInternalReviewModel || (!trimmedReviewModel && models.length > 0))
  const incompatibleReviewEffort =
    knownReviewEfforts && autoReviewEffort !== '' && !reviewEffortChoices.includes(autoReviewEffort)
  const externalReviewModelMissing = isExternalReviewProvider && trimmedReviewModel === ''

  const parsedIdleMin = Number(idleMinutes)
  const idleValid =
    idleMinutes.trim() !== '' &&
    Number.isInteger(parsedIdleMin) &&
    parsedIdleMin >= SESSION_IDLE_TTL_MIN_MS / 60_000 &&
    parsedIdleMin <= SESSION_IDLE_TTL_MAX_MS / 60_000

  const parsedTimeoutSec = Number(timeoutSeconds)
  const timeoutValid =
    timeoutSeconds.trim() !== '' &&
    Number.isInteger(parsedTimeoutSec) &&
    parsedTimeoutSec >= REQUEST_TIMEOUT_MIN_MS / 1_000 &&
    parsedTimeoutSec <= REQUEST_TIMEOUT_MAX_MS / 1_000

  const validationError = !idleValid
    ? `空闲会话回收须为 ${SESSION_IDLE_TTL_MIN_MS / 60_000}–${SESSION_IDLE_TTL_MAX_MS / 60_000} 之间的整数分钟`
    : !timeoutValid
      ? `单次请求超时须为 ${REQUEST_TIMEOUT_MIN_MS / 1_000}–${REQUEST_TIMEOUT_MAX_MS / 1_000} 之间的整数秒`
      : incompatible
        ? '当前选择的推理强度不适用于所选模型'
        : externalReviewModelMissing
          ? '选择外部自动审查 Provider 时请同时指定审查模型'
          : incompatibleReviewEffort
            ? '当前选择的自动审查推理强度不适用于所选审查模型'
            : ''

  const mcpPolicyChanged = Boolean(
    baseline && (
      mcpBridge !== baseline.mcpBridge ||
      JSON.stringify(mcpToolPolicy) !== JSON.stringify(baseline.mcpToolPolicy)
    ),
  )

  const dirty = Boolean(
    baseline && (
      mcpPolicyChanged ||
      quotaAwareScheduling !== baseline.quotaAwareScheduling ||
      geoFenceMode !== baseline.geoFenceMode ||
      defaultModel !== baseline.defaultModel ||
      defaultEffort !== baseline.defaultEffort ||
      autoReviewProvider !== baseline.autoReviewProvider ||
      autoReviewModel !== baseline.autoReviewModel ||
      autoReviewEffort !== baseline.autoReviewEffort ||
      agyBin !== baseline.agyBin ||
      workspaceRoot !== baseline.workspaceRoot ||
      idleMinutes !== baseline.idleMinutes ||
      timeoutSeconds !== baseline.timeoutSeconds
    ),
  )

  const handleChangeGroup = (groupId: SupplementGroupId, mode: SupplementGroupMode): void => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => ({
      ...prev,
      groups: { ...prev.groups, [groupId]: mode },
    }))
  }

  const handleChangeReplace = (groupId: ReplaceGroupId, mode: ReplaceGroupMode): void => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => ({
      ...prev,
      replace: { ...prev.replace, [groupId]: mode },
    }))
  }

  const handleChangeOverride = (toolName: string, mode: ToolExposureMode | ''): void => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => {
      const nextOverrides = { ...prev.overrides }
      if (!mode) delete nextOverrides[toolName]
      else nextOverrides[toolName] = mode
      return { ...prev, overrides: nextOverrides }
    })
  }

  const handleClearOverrides = (): void => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => ({ ...prev, overrides: {} }))
  }

  const handleResetPolicyDefaults = (): void => {
    setSavedMsg('')
    setMcpToolPolicy(resolveEffectiveMcpToolPolicy())
  }

  const totals = status.usageTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
  }

  const handleSaveConfig = async (): Promise<void> => {
    if (validationError) return
    const hadMcpChanges = mcpPolicyChanged
    setOperation('save')
    setSavedMsg('')
    try {
      const res = await postJson('/plugins/agy-acp/config', {
        mcpBridge,
        mcpExposeOverlappingTools: false,
        mcpToolPolicy: compactMcpToolPolicy(mcpToolPolicy) ?? {},
        quotaAwareScheduling,
        geoFenceMode,
        defaultModel,
        defaultEffort,
        autoReviewProvider,
        autoReviewModel,
        autoReviewEffort,
        agyBin,
        workspaceRoot,
        sessionIdleTtlMs: parsedIdleMin * 60_000,
        requestTimeoutMs: parsedTimeoutSec * 1_000,
      })
      if (res.ok && res.status) {
        applyStatus(res.status)
        syncFormTo(baselineFromStatus(res.status))
        const activeCount = res.status.sessions?.length ?? 0
        setNeedsSessionResetHint(Boolean(hadMcpChanges && activeCount > 0))
        setSavedMsg(
          hadMcpChanges && activeCount > 0
            ? '已保存并持久化；新对话立即生效，已有活跃会话可点击右侧按钮重置连接以刷新工具表'
            : '已保存并持久化到本机配置',
        )
      } else {
        setSavedMsg(res.error || '保存失败，请重试')
      }
    } finally {
      setOperation(null)
    }
  }

  const handleResetConfig = async (): Promise<void> => {
    setOperation('resetConfig')
    setSavedMsg('')
    setNeedsSessionResetHint(false)
    try {
      const res = await postJson('/plugins/agy-acp/config/reset', {})
      if (res.ok && res.status) {
        applyStatus(res.status)
        syncFormTo(baselineFromStatus(res.status))
        setSavedMsg('已恢复为默认配置')
      } else {
        setSavedMsg(res.error || '恢复默认失败，请重试')
      }
    } finally {
      setOperation(null)
    }
  }

  const handleRefreshModels = async (): Promise<void> => {
    setRefreshingModels(true)
    setModelMsg('')
    try {
      const res = await postJson('/plugins/agy-acp/models/refresh', {})
      if (res.status) applyStatus(res.status)
      setModelMsg(res.ok && Array.isArray(res.status?.models) ? `模型目录已刷新（共 ${res.status.models.length} 个模型）` : (res.error || '模型目录刷新失败'))
    } finally {
      setRefreshingModels(false)
    }
  }

  const handleResetSessions = async (target: SessionResetTarget): Promise<void> => {
    setOperation('resetSessions')
    setConfirmAll(false)
    setSessionMsg('')
    try {
      const res = await resetSessions(target)
      if (res.status) applyStatus(res.status)
      setSessionMsg(res.message)
    } finally {
      setOperation(null)
    }
  }

  return React.createElement(
    'div',
    { style: { maxWidth: '760px', minWidth: 0, overflowWrap: 'anywhere', padding: '8px 4px', fontSize: '13px', lineHeight: 1.5 } },
    // Transport freshness is independent of whether an ACP process is running.
    React.createElement(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' } },
      React.createElement(
        'div',
        null,
        React.createElement('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, 'Antigravity ACP'),
        React.createElement(
          'div',
          { style: { ...styles.secondaryText, marginTop: '2px' } },
          `运行控制台 · 快照更新于 ${formatTime(status.updatedAt)}`,
        ),
      ),
      React.createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '999px',
            fontSize: '12px',
            border: theme.borderPrimary,
            backgroundColor: theme.surfaceTile,
          },
        },
        React.createElement('span', {
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: connected ? theme.stateSuccess : theme.stateIdle,
          },
        }),
        notice ? (stream === 'offline' ? '实时连接中断' : '等待实时连接') : !status.enabled ? '插件已停用' : connected
          ? `ACP 已连接 · ${[status.agentName, status.agentVersion, status.tierName].filter(Boolean).join(' · ') || 'agy acp'}`
          : 'ACP 待机（首轮对话自动建连）',
      ),
    ),

    notice ? React.createElement('p', { role: 'status', style: { ...styles.tile, borderInlineStart: `3px solid ${theme.stateWarn}` } }, notice) : null,

    // Diagnostic error banner (from Phase 2 sanitized lastError)
    status.lastError
      ? React.createElement(
          'div',
          {
            role: 'alert',
            style: {
              borderRadius: '10px',
              border: `1px solid ${theme.stateError}`,
              padding: '10px 14px',
              marginBottom: '14px',
              backgroundColor: theme.surfaceTile,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            },
          },
          React.createElement(
            'div',
            { style: { flex: '1 1 280px', overflowWrap: 'anywhere' } },
            React.createElement('strong', { style: { color: theme.stateError } }, '目录/连接诊断：'),
            status.lastError,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: refreshingModels || busy,
              onClick: () => void handleRefreshModels(),
              style: styles.ghostButton,
            },
            refreshingModels ? '探测中…' : '重新探测目录',
          ),
        )
      : null,

    modelMsg ? React.createElement('p', { role: 'status', style: styles.tile }, modelMsg) : null,
    React.createElement('div', { role: 'group', 'aria-label': '控制台分区', style: styles.panelNav },
      ...([
        ['sessions', `会话与用量 · ${sessions.length}${status.mcpBridge?.lastError ? '（桥接告警）' : ''}`],
        ['accounts', `账号与配额 · ${accounts.length}${attentionCount ? `（${attentionCount} 个快照告警）` : ''}`],
        ['config', `桥接配置${dirty ? ' · 未保存' : ''}`],
      ] as const).map(([key, label]) => React.createElement('button', {
        key, type: 'button', 'aria-pressed': panel === key, onClick: () => setPanel(key),
        style: panel === key ? styles.primaryButton : styles.ghostButton,
      }, label))),

    // Usage overview card
    React.createElement(
      'div',
      { style: styles.card, hidden: panel !== 'sessions' },
      React.createElement('h3', { style: styles.sectionHeading }, '运行概览与 Token 用量'),
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 6.5rem), 1fr))', gap: '8px', textAlign: 'center' } },
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, notice ? '快照会话' : '活跃会话'), String(sessions.length)),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '输入'), formatTokens(totals.inputTokens)),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '缓存读 / 写'), `${formatTokens(totals.cachedReadTokens)} / ${formatTokens(totals.cachedWriteTokens ?? 0)}`),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '输出'), formatTokens(totals.outputTokens)),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '推理'), formatTokens(totals.reasoningTokens)),
      ),
    ),

    // Runtime settings card
    React.createElement(
      ConfigFieldset,
      { operation, hidden: panel !== 'config', onEdit: () => setSavedMsg('') },
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', gap: '8px', flexWrap: 'wrap' } },
        React.createElement('h3', { style: styles.sectionHeading }, '桥接配置'),
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: refreshingModels || busy,
            onClick: () => void handleRefreshModels(),
            style: styles.ghostButton,
          },
          refreshingModels ? '刷新中…' : `刷新模型目录 (${models.length})`,
        ),
      ),

      React.createElement('p', { style: { ...styles.secondaryText, marginTop: 0, marginBottom: '10px' } },
        '配置保存在本机。权限跟随 DSH 会话；如需批准工具调用，请返回对应对话。'),

      // Reverse MCP bridge toggle
      React.createElement(
        'label',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 10px',
            borderRadius: '8px',
            border: theme.borderPrimary,
            backgroundColor: theme.surfaceTile,
            marginBottom: '12px',
            cursor: 'pointer',
          },
        },
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontWeight: 500 } }, '会话级反向 MCP 桥接（Reverse MCP Bridge）'),
          React.createElement(
            'div',
            { style: { ...styles.secondaryText, fontSize: '11px' } },
            '通过 ACP session/new 动态向 agy 暴露 DSH 工具，不污染全局 ~/.gemini/config/mcp_config.json',
          ),
        ),
        React.createElement('input', {
          type: 'checkbox',
          checked: mcpBridge,
          onChange: (e: { target: { checked: boolean } }) => setMcpBridge(e.target.checked),
          style: { width: '16px', height: '16px', cursor: 'pointer' },
        }),
      ),

      // Reverse MCP supplement/replace tool policy panel
      React.createElement(McpToolPolicyPanel, {
        enabled: mcpBridge,
        policy: mcpToolPolicy,
        catalog: status.mcpToolCatalog,
        onChangeGroup: handleChangeGroup,
        onChangeReplace: handleChangeReplace,
        onChangeOverride: handleChangeOverride,
        onClearOverrides: handleClearOverrides,
        onResetPolicyDefaults: handleResetPolicyDefaults,
      }),

      // Opt-in quota-aware scheduling toggle
      React.createElement(
        'label',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 10px',
            borderRadius: '8px',
            border: theme.borderPrimary,
            backgroundColor: theme.surfaceTile,
            marginBottom: '12px',
            cursor: 'pointer',
          },
        },
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontWeight: 500 } }, '配额感知多账号调度（Quota-Aware Scheduling）'),
          React.createElement(
            'div',
            { style: { ...styles.secondaryText, fontSize: '11px' } },
            '开启后将手动采集的 5h / 7d 配额余量映射至多账号池调度权重，优先分配高余量账号并避开耗尽账号（默认关闭，不后台轮询刷配额）',
          ),
        ),
        React.createElement('input', {
          type: 'checkbox',
          checked: quotaAwareScheduling,
          onChange: (e: { target: { checked: boolean } }) => setQuotaAwareScheduling(e.target.checked),
          style: { width: '16px', height: '16px', cursor: 'pointer' },
        }),
      ),

      models.length === 0 ? React.createElement('p', { style: styles.secondaryText }, '模型目录为空。可点击「刷新模型目录」探测；也可留空使用 ACP 默认模型。') : null,
      // Model / effort / paths / timeouts grid
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '10px', marginBottom: '12px' } },
        React.createElement(
          'div',
          null,
          React.createElement(
            'label',
            null,
            React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '默认模型（留空自动）'),
            models.length > 0
              ? React.createElement(
                  'select',
                  {
                    value: defaultModel,
                    onChange: (e: { target: { value: string } }) => setDefaultModel(e.target.value),
                    style: styles.input,
                  },
                  React.createElement('option', { value: '' }, '自动（使用 ACP 默认）'),
                  customModelNotInCatalog
                    ? React.createElement('option', { value: defaultModel }, `${defaultModel}（当前已存，不在目录中）`)
                    : null,
                  ...models.map(m =>
                    React.createElement('option', { key: m.value, value: m.value }, m.name === m.value ? m.value : `${m.name} (${m.value})`),
                  ),
                )
              : React.createElement('input', {
                  type: 'text',
                  value: defaultModel,
                  placeholder: '例如 gemini-4-neon',
                  onChange: (e: { target: { value: string } }) => setDefaultModel(e.target.value),
                  style: styles.input,
                }),
          ),
        ),
        React.createElement(
          'div',
          null,
          React.createElement(
            'label',
            null,
            React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '默认推理强度'),
            knownEfforts
              ? React.createElement(
                  'select',
                  {
                    style: styles.input,
                    value: defaultEffort,
                    onChange: (e: { target: { value: string } }) => setDefaultEffort(e.target.value),
                  },
                  React.createElement('option', { value: '' }, '使用模型默认档位'),
                  incompatible
                    ? React.createElement('option', { value: defaultEffort, disabled: true }, `${defaultEffort}（不适用于当前选择）`)
                    : null,
                  ...effortChoices.map(id => React.createElement('option', { key: id, value: id }, effortLabel(id))),
                )
              : React.createElement('input', {
                  type: 'text',
                  value: defaultEffort,
                  placeholder: '目录尚未确认，留空使用模型默认档位',
                  onChange: (e: { target: { value: string } }) => setDefaultEffort(e.target.value),
                  style: styles.input,
                }),
          ),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, 'agy 可执行文件路径（留空自动探测）'),
          React.createElement('input', {
            type: 'text',
            'aria-label': 'agy 可执行文件路径',
            value: agyBin,
            placeholder: '/home/user/.local/bin/agy',
            onChange: (e: { target: { value: string } }) => setAgyBin(e.target.value),
            style: styles.input,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '模型探测目录（不改变会话工作区）'),
          React.createElement('input', {
            type: 'text',
            'aria-label': '模型探测目录',
            value: workspaceRoot,
            placeholder: '留空使用默认探测目录',
            onChange: (e: { target: { value: string } }) => setWorkspaceRoot(e.target.value),
            style: styles.input,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '空闲会话回收（分钟，1–1440）'),
          React.createElement('input', {
            type: 'number',
            min: SESSION_IDLE_TTL_MIN_MS / 60_000,
            max: SESSION_IDLE_TTL_MAX_MS / 60_000,
            step: 1,
            'aria-label': '空闲会话回收（分钟）',
            value: idleMinutes,
            onChange: (e: { target: { value: string } }) => setIdleMinutes(e.target.value),
            style: styles.input,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, `单次请求超时（秒，${REQUEST_TIMEOUT_MIN_MS / 1_000}–${REQUEST_TIMEOUT_MAX_MS / 1_000}）`),
          React.createElement('input', {
            type: 'number',
            min: REQUEST_TIMEOUT_MIN_MS / 1_000,
            max: REQUEST_TIMEOUT_MAX_MS / 1_000,
            step: 10,
            'aria-label': '单次请求超时（秒）',
            value: timeoutSeconds,
            onChange: (e: { target: { value: string } }) => setTimeoutSeconds(e.target.value),
            style: styles.input,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement(
            'label',
            null,
            React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '地域合规防护（防封号拦截）'),
            React.createElement(
              'select',
              {
                value: geoFenceMode,
                onChange: (e: { target: { value: string } }) => {
                  if (isGeoFenceMode(e.target.value)) setGeoFenceMode(e.target.value)
                },
                style: styles.input,
              },
              React.createElement('option', { value: 'block' }, '拦截受限地区（推荐，默认）'),
              React.createElement('option', { value: 'strict' }, '严格模式（受限与未知均拦截）'),
              React.createElement('option', { value: 'warn' }, '仅告警不拦截'),
              React.createElement('option', { value: 'off' }, '关闭'),
            ),
          ),
        ),
      ),

      // Auto review routing section
      React.createElement(
        'div',
        {
          style: {
            padding: '10px 12px',
            borderRadius: '8px',
            border: theme.borderPrimary,
            backgroundColor: theme.surfaceTile,
            marginBottom: '12px',
          },
        },
        React.createElement('div', { style: { fontWeight: 500, marginBottom: '2px' } }, '自动审查模型（DSH Auto Review）'),
        React.createElement(
          'div',
          { style: { ...styles.secondaryText, fontSize: '11px', marginBottom: '10px' } },
          '在 Auto 权限模式下控制工具审查使用的模型。留空默认跟随当前对话主模型（ACP 内部审查默认自动选用最低推理档位以提速）；选择其他 DSH Provider 可直连其 API，省去 agy 进程冷启动。',
        ),
        React.createElement(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '10px' } },
          React.createElement(
            'div',
            null,
            React.createElement(
              'label',
              null,
              React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '审查 Provider'),
              React.createElement(
                'select',
                {
                  'aria-label': '自动审查 Provider',
                  value: autoReviewProvider,
                  onChange: (e: { target: { value: string } }) => {
                    const next = e.target.value
                    setAutoReviewProvider(next)
                    setAutoReviewModel('')
                    setAutoReviewEffort('')
                    setManualReviewModel(false)
                  },
                  style: styles.input,
                },
                React.createElement('option', { value: '' }, '当前插件（Antigravity ACP）'),
                customReviewProviderNotInList
                  ? React.createElement('option', { value: autoReviewProvider }, `${autoReviewProvider}（已存，当前未注册）`)
                  : null,
                ...reviewProviders.map(p =>
                  React.createElement('option', { key: p.id, value: p.id }, p.name === p.id ? p.id : `${p.name} (${p.id})`),
                ),
              ),
            ),
          ),
          React.createElement(
            'div',
            null,
            React.createElement(
              'label',
              null,
              React.createElement(
                'div',
                { style: { ...styles.secondaryText, marginBottom: '4px', display: 'flex', justifyContent: 'space-between', gap: '6px' } },
                React.createElement('span', null, isExternalReviewProvider ? '审查模型（必填）' : '审查模型（留空跟随主模型）'),
                isExternalReviewProvider && externalReviewModels.length > 0
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        onClick: () => setManualReviewModel((v: boolean) => !v),
                        style: { background: 'none', border: 'none', padding: 0, color: theme.brandPrimary, cursor: 'pointer', fontSize: '11px' },
                      },
                      manualReviewModel ? '返回下拉选择' : '手动输入',
                    )
                  : null,
              ),
              !isExternalReviewProvider
                ? (models.length > 0
                    ? React.createElement(
                        'select',
                        {
                          'aria-label': '自动审查模型',
                          value: autoReviewModel,
                          onChange: (e: { target: { value: string } }) => setAutoReviewModel(e.target.value),
                          style: styles.input,
                        },
                        React.createElement('option', { value: '' }, '跟随当前对话主模型'),
                        customInternalReviewModelNotInCatalog
                          ? React.createElement('option', { value: autoReviewModel }, `${autoReviewModel}（当前已存，不在目录中）`)
                          : null,
                        ...models.map(m =>
                          React.createElement('option', { key: m.value, value: m.value }, m.name === m.value ? m.value : `${m.name} (${m.value})`),
                        ),
                      )
                    : React.createElement('input', {
                        type: 'text',
                        'aria-label': '自动审查模型',
                        value: autoReviewModel,
                        placeholder: '留空跟随主模型，或填如 gemini-3-flash',
                        onChange: (e: { target: { value: string } }) => setAutoReviewModel(e.target.value),
                        style: styles.input,
                      }))
                : (!manualReviewModel && externalReviewModels.length > 0
                    ? React.createElement(
                        'select',
                        {
                          'aria-label': '自动审查模型',
                          value: autoReviewModel,
                          onChange: (e: { target: { value: string } }) => setAutoReviewModel(e.target.value),
                          style: styles.input,
                        },
                        React.createElement('option', { value: '' }, '请选择审查模型…'),
                        customExternalReviewModelNotInList
                          ? React.createElement('option', { value: autoReviewModel }, `${autoReviewModel}（当前已存）`)
                          : null,
                        ...externalReviewModels.map(m =>
                          React.createElement('option', { key: m.id, value: m.id }, m.name === m.id ? m.id : `${m.name} (${m.id})`),
                        ),
                      )
                    : React.createElement('input', {
                        type: 'text',
                        'aria-label': '自动审查模型',
                        value: autoReviewModel,
                        placeholder: loadingReviewModels ? '正在加载模型列表…' : '输入目标 Provider 的模型 ID',
                        onChange: (e: { target: { value: string } }) => setAutoReviewModel(e.target.value),
                        style: styles.input,
                      })),
            ),
            reviewModelsError
              ? React.createElement('div', { style: { fontSize: '11px', color: theme.stateWarn, marginTop: '4px' } }, reviewModelsError)
              : null,
          ),
          React.createElement(
            'div',
            null,
            React.createElement(
              'label',
              null,
              React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '审查推理强度'),
              !isExternalReviewProvider && knownReviewEfforts
                ? React.createElement(
                    'select',
                    {
                      'aria-label': '自动审查推理强度',
                      value: autoReviewEffort,
                      onChange: (e: { target: { value: string } }) => setAutoReviewEffort(e.target.value),
                      style: styles.input,
                    },
                    React.createElement('option', { value: '' }, '自动（最低档位，推荐）'),
                    incompatibleReviewEffort
                      ? React.createElement('option', { value: autoReviewEffort, disabled: true }, `${autoReviewEffort}（不适用于当前选择）`)
                      : null,
                    ...reviewEffortChoices.map(id => React.createElement('option', { key: id, value: id }, effortLabel(id))),
                  )
                : React.createElement('input', {
                    type: 'text',
                    'aria-label': '自动审查推理强度',
                    value: autoReviewEffort,
                    placeholder: isExternalReviewProvider ? '留空不覆盖（可填 low / minimal）' : '留空自动使用最低档位',
                    onChange: (e: { target: { value: string } }) => setAutoReviewEffort(e.target.value),
                    style: styles.input,
                  }),
            ),
          ),
        ),
      ),

      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy || Boolean(validationError),
            onClick: () => void handleSaveConfig(),
            style: { ...styles.primaryButton, opacity: busy || validationError ? 0.55 : 1 },
          },
          operation === 'save' ? '保存中…' : '保存并应用',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy || !status.hasPersistedConfig,
            onClick: () => void handleResetConfig(),
            style: { ...styles.ghostButton, opacity: busy || !status.hasPersistedConfig ? 0.5 : 1 },
          },
          operation === 'resetConfig' ? '恢复中…' : '恢复默认',
        ),
        validationError
          ? React.createElement('span', { role: 'alert', style: { fontSize: '12px', color: theme.stateError } }, validationError)
          : dirty
            ? React.createElement('span', { style: { fontSize: '12px', color: theme.stateWarn } }, '有未保存的修改')
            : null,
        savedMsg ? React.createElement('span', { role: 'status', style: styles.secondaryText }, savedMsg) : null,
        needsSessionResetHint && sessions.length > 0
          ? React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => {
                  setNeedsSessionResetHint(false)
                  void handleResetSessions({ kind: 'all' })
                },
                style: styles.ghostButton,
              },
              '立即应用到活跃会话（重置连接）',
            )
          : null,
      ),
    ),

    // Active ACP sessions card
    React.createElement(
      'section',
      { style: styles.card, hidden: panel !== 'sessions' },
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', gap: '8px', flexWrap: 'wrap' } },
        React.createElement(
          'div',
          null,
          React.createElement('h3', { style: styles.sectionHeading }, `${notice ? '快照中的会话' : '活跃 ACP 会话'} (${sessions.length})`),
          React.createElement('div', { style: styles.secondaryText }, `上次握手的恢复能力 · ${recoveryCapability(status.capabilities)}`),
          typeof status.persistedSessions === 'number' && status.persistedSessions > 0
            ? React.createElement(
                'div',
                { style: { ...styles.secondaryText, fontSize: '11px' } },
                `恢复索引：${status.persistedSessions} 个 · 下次建连时尝试恢复，索引并非活跃会话。`,
              )
            : null,
        ),
        (sessions.length > 0 || (status.persistedSessions ?? 0) > 0)
          ? React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => setConfirmAll(true),
                style: styles.dangerButton,
              },
              '重置全部会话',
            )
          : null,
      ),
      React.createElement('details', { style: { marginBottom: '10px' } },
        React.createElement('summary', { style: { cursor: 'pointer' } }, '上次握手的输入与工具能力'),
        React.createElement('div', { style: styles.secondaryText },
          ([['HTTP MCP', 'mcpHttp'], ['图像', 'image'], ['音频', 'audio'], ['嵌入上下文', 'embeddedContext'], ['系统提示追加', 'systemPromptAppend']] as const)
            .map(([label, key]) => `${label}：${capabilityLabel(status.capabilities?.[key])}`).join(' · '))),
      status.mcpBridge
        ? React.createElement(
            'div',
            { style: { ...styles.secondaryText, fontSize: '11px', padding: '0 4px', marginBottom: '12px' } },
            [
              `桥接运行态：挂载会话 ${status.mcpBridge.activeBridges}`,
              `在途调用 ${status.mcpBridge.inFlightCalls}`,
              `累计调用 ${status.mcpBridge.totalCalls}`,
              status.mcpBridge.failedCalls > 0 && `失败/超时 ${status.mcpBridge.failedCalls}`,
              status.mcpBridge.lastToolName && `最近工具 ${status.mcpBridge.lastToolName}`,
              `实际传输：${status.mcpBridge.activeBridges > 0 ? actualTransport(status.mcpBridge.transport) : '未挂载'}`,
            ].filter(Boolean).join(' · '),
            status.mcpBridge.lastError
              ? React.createElement(
                  'div',
                  { style: { color: theme.stateWarn, marginTop: '2px', overflowWrap: 'anywhere' } },
                  `最近桥接告警：${status.mcpBridge.lastError}`,
                )
              : null,
          )
        : React.createElement('div', { style: styles.secondaryText }, '桥接运行态：未上报'),
      confirmAll ? React.createElement('div', { style: styles.tile },
        React.createElement('p', { style: { margin: '0 0 6px' } }, '关闭全部 ACP 会话并清除恢复索引？此操作不能撤销。'),
        React.createElement('div', { style: styles.panelNav },
          React.createElement('button', { type: 'button', style: styles.ghostButton, onClick: () => setConfirmAll(false) }, '取消'),
          React.createElement('button', { type: 'button', style: styles.dangerButton, disabled: busy, onClick: () => void handleResetSessions({ kind: 'all' }) }, '确认重置全部')),
      ) : null,
      operation === 'resetSessions' || sessionMsg ? React.createElement('p', { role: 'status' }, operation === 'resetSessions' ? '正在关闭会话…' : sessionMsg) : null,
      sessions.length === 0
        ? React.createElement('div', { style: styles.secondaryText }, notice ? '此快照没有会话。等待实时连接后可确认当前状态。' : '暂无活跃 ACP 会话。在对话中选择 Antigravity (ACP) 模型并发送消息即可建立。')
        : sessions.map((s: SessionSummary) => {
            const pct = s.contextUsed != null && s.contextSize > 0
              ? Math.min(100, Math.max(0, (100 * s.contextUsed) / s.contextSize))
              : null
            const recovery = sessionRecovery(s)
            const barColor = pct == null ? theme.stateIdle : pct > 92 ? theme.stateError : pct > 80 ? theme.stateWarn : theme.brandPrimary
            return React.createElement(
              'div',
              {
                key: s.dshSessionKey,
                style: {
                  ...styles.tile,
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '12px',
                },
              },
              React.createElement(
                'div',
                { style: { flex: '1 1 15rem', minWidth: 0 } },
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontWeight: 500 } },
                  `${s.currentModel || 'default'} · ${s.currentMode}`,
                  recovery
                    ? React.createElement(
                        'span',
                        {
                          style: {
                            fontSize: '11px',
                            fontWeight: 400,
                            padding: '0 6px',
                            borderRadius: '999px',
                            border: theme.borderPrimary,
                            color: theme.stateSuccess,
                          },
                        },
                        recovery,
                      )
                    : null,
                ),
                s.title
                  ? React.createElement('div', { style: { fontSize: '12px', overflowWrap: 'anywhere' } }, `标题：${s.title}`)
                  : null,
                React.createElement('div', { style: { overflowWrap: 'anywhere', fontSize: '12px' } }, `使用账号${notice ? '（上次快照）' : ''}：${sessionAccountLabel(s.accountId, accounts)}`),
                React.createElement(
                  'div',
                  { style: { ...styles.secondaryText, fontSize: '11px' } },
                  `会话 ${s.dshSessionKey} · 推理强度 ${s.currentEffort ? effortLabel(s.currentEffort) : '未报告'} · ACP 上下文 ${contextLabel(s)} · 活跃于 ${formatTime(s.lastActiveAt)}`,
                ),
                React.createElement('div', { style: styles.secondaryText }, `MCP 实际传输：${actualTransport(s.mcpTransport)}`),
                pct != null
                  ? React.createElement(
                      'div',
                      {
                        role: 'progressbar',
                        'aria-label': 'ACP 上下文占用',
                        'aria-valuenow': Math.round(pct),
                        'aria-valuemin': 0,
                        'aria-valuemax': 100,
                        style: {
                          marginTop: '6px',
                          height: '4px',
                          borderRadius: '999px',
                          backgroundColor: theme.surfaceCard,
                          overflow: 'hidden',
                        },
                      },
                      React.createElement('div', {
                        style: {
                          width: `${pct.toFixed(1)}%`,
                          height: '100%',
                          backgroundColor: barColor,
                        },
                      }),
                    )
                  : null,
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => void handleResetSessions({ kind: 'one', sessionKey: s.dshSessionKey }),
                  'aria-label': `关闭会话 ${s.title || s.dshSessionKey}`,
                  style: styles.ghostButton,
                },
                '关闭',
              ),
            )
          }),
    ),

    React.createElement(
      'section',
      { style: styles.card, hidden: panel !== 'accounts' },
      React.createElement('h3', { style: styles.sectionHeading }, `账号状态 (${accounts.length})`),
      React.createElement('p', { style: { margin: '4px 0 10px', ...styles.secondaryText } },
        '配额仅在手动刷新时向上游查询，不按 Token 用量推算。清除本地冷却不会恢复上游额度。'),
      accounts.length
        ? accounts.map(account => React.createElement(AccountCard, { key: account.id, account, geoFenceMode: status.config?.geoFenceMode, applyStatus }))
        : React.createElement('div', null, '尚未收到账号状态。请检查账号配置及插件是否启用；收到快照后将自动显示。'),
    ),
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
  const { status } = state

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
  const badgeLabel = notice
    ? `AGY·ACP · ${state.stream === 'offline' ? '实时连接中断' : '连接中'}`
    : current
      ? `AGY·ACP · 上下文 ${current.contextUsed == null ? '待上报' : formatTokens(current.contextUsed)}`
      : 'AGY·ACP'
  const hasGeoAlert = Boolean(
    status?.config?.geoFenceMode !== 'off' &&
      status?.accounts.some(a => a.enabled && a.egress?.status === 'unsupported'),
  )
  const dotColor = status?.lastError || hasGeoAlert ? theme.stateError : current ? theme.stateSuccess : theme.stateIdle

  const modal = open
    ? portalToBody(
        React.createElement(
          'div',
          {
            onClick: (ev: { target: unknown; currentTarget: unknown }) => {
              if (ev.target === ev.currentTarget) setOpen(false)
            },
            style: styles.modalOverlay,
          },
          React.createElement(
            'div',
            {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': 'Antigravity ACP 控制台',
              style: styles.modalDialog,
            },
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => setOpen(false),
                title: '关闭 (Esc)',
                'aria-label': '关闭控制台',
                style: {
                  position: 'absolute',
                  top: '14px',
                  right: '14px',
                  width: '28px',
                  height: '28px',
                  borderRadius: '6px',
                  border: theme.borderPrimary,
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '15px',
                  lineHeight: 1,
                },
              },
              '×',
            ),
            React.createElement(SettingsView, state),
          ),
        ),
      )
    : null

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: (ev: { stopPropagation?: () => void }) => {
          ev.stopPropagation?.()
          setOpen((v: boolean) => !v)
        },
        title: current
          ? `${current.currentModel} · 使用账号 ${sessionAccountLabel(current.accountId, status?.accounts ?? [])} · 推理强度 ${effortLabel(current.currentEffort) || '未报告'} · ACP 上下文 ${contextLabel(current)}`
          : status?.lastError || notice || '打开 Antigravity ACP 控制台',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '2px 8px',
          borderRadius: '999px',
          fontSize: '12px',
          fontWeight: 500,
          border: theme.borderPrimary,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          opacity: current || status?.lastError ? 0.95 : 0.78,
        },
      },
      React.createElement('span', {
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
        return React.createElement(AgyAcpSettingsSection)
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
        return React.createElement(AgyAcpSettingsSection)
      },
    ),
  )
}
