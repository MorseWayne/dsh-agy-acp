// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
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
  equalEffectiveMcpToolPolicy,
  resolveEffectiveMcpToolPolicy,
  type EffectiveMcpToolPolicy,
  type ReplaceGroupId,
  type ReplaceGroupMode,
  type SupplementGroupId,
  type SupplementGroupMode,
  type ToolExposureMode,
} from '../common/mcp-tool-policy.ts'
import {
  PROVIDER_ID,
  type AcpModelOption,
  type GeoFenceMode,
  type McpToolCatalogSnapshot,
  type ReviewProviderOption,
  type StatusSnapshot,
} from '../common/types.ts'
import { McpToolPolicyPanel } from './mcp-tool-panel.ts'
import { fetchReviewModels, postJson, type ReviewModelOption, type SessionResetTarget } from './panel-actions.ts'
import { theme } from './theme.ts'
import { ToggleSwitch } from './ui-primitives.ts'

const h = React.createElement

export type Operation = 'save' | 'resetConfig' | 'resetSessions' | null

function clampIdleMinutes(ms: number | undefined): number {
  const raw = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 60_000) : 30
  return Math.min(SESSION_IDLE_TTL_MAX_MS / 60_000, Math.max(SESSION_IDLE_TTL_MIN_MS / 60_000, raw))
}

function clampTimeoutSeconds(ms: number | undefined): number {
  const raw = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 1_000) : 600
  return Math.min(REQUEST_TIMEOUT_MAX_MS / 1_000, Math.max(REQUEST_TIMEOUT_MIN_MS / 1_000, raw))
}

export interface FormBaseline {
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

export function baselineFromConfig(config: StatusSnapshot['config'] | undefined): FormBaseline {
  const rawMode = config?.geoFenceMode
  const rawReviewProvider = config?.autoReviewProvider ?? ''
  return {
    mcpBridge: Boolean(config?.mcpBridge),
    mcpToolPolicy: resolveEffectiveMcpToolPolicy(config?.mcpToolPolicy, config?.mcpExposeOverlappingTools),
    quotaAwareScheduling: Boolean(config?.quotaAwareScheduling),
    geoFenceMode: isGeoFenceMode(rawMode) ? rawMode : 'block',
    defaultModel: config?.defaultModel ?? '',
    defaultEffort: config?.defaultEffort ?? '',
    autoReviewProvider: rawReviewProvider === PROVIDER_ID ? '' : rawReviewProvider,
    autoReviewModel: config?.autoReviewModel ?? '',
    autoReviewEffort: config?.autoReviewEffort ?? '',
    agyBin: config?.agyBin ?? '',
    workspaceRoot: config?.workspaceRoot ?? '',
    idleMinutes: String(clampIdleMinutes(config?.sessionIdleTtlMs)),
    timeoutSeconds: String(clampTimeoutSeconds(config?.requestTimeoutMs)),
  }
}

function equalBaseline(a: FormBaseline, b: FormBaseline): boolean {
  return (
    a.mcpBridge === b.mcpBridge &&
    equalEffectiveMcpToolPolicy(a.mcpToolPolicy, b.mcpToolPolicy) &&
    a.quotaAwareScheduling === b.quotaAwareScheduling &&
    a.geoFenceMode === b.geoFenceMode &&
    a.defaultModel === b.defaultModel &&
    a.defaultEffort === b.defaultEffort &&
    a.autoReviewProvider === b.autoReviewProvider &&
    a.autoReviewModel === b.autoReviewModel &&
    a.autoReviewEffort === b.autoReviewEffort &&
    a.agyBin === b.agyBin &&
    a.workspaceRoot === b.workspaceRoot &&
    a.idleMinutes === b.idleMinutes &&
    a.timeoutSeconds === b.timeoutSeconds
  )
}

/** Native fieldset semantics lock all descendant controls, including any future configuration fields. */
export function ConfigFieldset({
  operation,
  hidden,
  onEdit,
  children,
}: {
  operation: Operation
  hidden?: boolean
  onEdit: () => void
  children?: unknown
}): unknown {
  const writing = operation === 'save' || operation === 'resetConfig'
  return h(
    'fieldset',
    {
      disabled: writing,
      'aria-busy': writing,
      'aria-label': '桥接配置',
      hidden: hidden || undefined,
      className: 'agy-acp-fieldset',
      onChangeCapture: (ev: { target?: { getAttribute?: (name: string) => string | null } }) => {
        if (ev?.target?.getAttribute?.('data-agy-ignore-edit') === 'true') return
        onEdit()
      },
    },
    children,
  )
}

export interface ConfigPanelProps {
  config: StatusSnapshot['config']
  hasPersistedConfig: boolean
  models: AcpModelOption[]
  reviewProviders: ReviewProviderOption[]
  mcpToolCatalog?: McpToolCatalogSnapshot
  activeSessionCount: number
  operation: Operation
  refreshingModels: boolean
  setOperation: (op: Operation) => void
  onRefreshModels: () => void
  onResetSessions: (target: SessionResetTarget) => void
  applyStatus: (next: StatusSnapshot) => void
  onDirtyChange?: (dirty: boolean) => void
}

export const ConfigPanel = React.memo(function ConfigPanel({
  config,
  hasPersistedConfig,
  models,
  reviewProviders,
  mcpToolCatalog,
  activeSessionCount,
  operation,
  refreshingModels,
  setOperation,
  onRefreshModels,
  onResetSessions,
  applyStatus,
  onDirtyChange,
}: ConfigPanelProps): unknown {
  const busy = operation !== null
  const [savedMsg, setSavedMsg] = React.useState('')
  const [effortNotice, setEffortNotice] = React.useState('')
  const [needsSessionResetHint, setNeedsSessionResetHint] = React.useState(false)
  const [confirmResetConfig, setConfirmResetConfig] = React.useState(false)

  const initialBase = React.useMemo(() => baselineFromConfig(config), [])
  const [baseline, setBaseline] = React.useState(initialBase)
  const [mcpBridge, setMcpBridge] = React.useState(initialBase.mcpBridge)
  const [mcpToolPolicy, setMcpToolPolicy] = React.useState(initialBase.mcpToolPolicy)
  const [quotaAwareScheduling, setQuotaAwareScheduling] = React.useState(initialBase.quotaAwareScheduling)
  const [geoFenceMode, setGeoFenceMode] = React.useState(initialBase.geoFenceMode)
  const [defaultModel, setDefaultModel] = React.useState(initialBase.defaultModel)
  const [defaultEffort, setDefaultEffort] = React.useState(initialBase.defaultEffort)
  const [autoReviewProvider, setAutoReviewProvider] = React.useState(initialBase.autoReviewProvider)
  const [autoReviewModel, setAutoReviewModel] = React.useState(initialBase.autoReviewModel)
  const [autoReviewEffort, setAutoReviewEffort] = React.useState(initialBase.autoReviewEffort)
  const [manualReviewModel, setManualReviewModel] = React.useState(false)
  const [externalReviewModels, setExternalReviewModels]: [ReviewModelOption[], (v: ReviewModelOption[]) => void] = React.useState([])
  const [loadingReviewModels, setLoadingReviewModels] = React.useState(false)
  const [reviewModelsError, setReviewModelsError] = React.useState('')
  const [agyBin, setAgyBin] = React.useState(initialBase.agyBin)
  const [workspaceRoot, setWorkspaceRoot] = React.useState(initialBase.workspaceRoot)
  const [idleMinutes, setIdleMinutes] = React.useState(initialBase.idleMinutes)
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(initialBase.timeoutSeconds)

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
    setEffortNotice('')
    setConfirmResetConfig(false)
  }, [])

  const currentForm: FormBaseline = React.useMemo(
    () => ({
      mcpBridge,
      mcpToolPolicy,
      quotaAwareScheduling,
      geoFenceMode,
      defaultModel,
      defaultEffort,
      autoReviewProvider,
      autoReviewModel,
      autoReviewEffort,
      agyBin,
      workspaceRoot,
      idleMinutes,
      timeoutSeconds,
    }),
    [
      mcpBridge,
      mcpToolPolicy,
      quotaAwareScheduling,
      geoFenceMode,
      defaultModel,
      defaultEffort,
      autoReviewProvider,
      autoReviewModel,
      autoReviewEffort,
      agyBin,
      workspaceRoot,
      idleMinutes,
      timeoutSeconds,
    ],
  )

  const dirty = React.useMemo(() => !equalBaseline(currentForm, baseline), [currentForm, baseline])

  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // Sync incoming server config only when form is clean and server config actually changed.
  React.useEffect(() => {
    const incoming = baselineFromConfig(config)
    if (!dirty && !equalBaseline(incoming, baseline)) {
      syncFormTo(incoming)
    }
  }, [config, dirty, baseline, syncFormTo])

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

  const allEfforts: string[] = React.useMemo(() => sortedEfforts(models.flatMap(m => m.efforts)), [models])

  const trimmedModel = defaultModel.trim()
  const selected = models.find(m => m.value === trimmedModel)
  const customModelNotInCatalog = trimmedModel !== '' && models.length > 0 && !selected
  const effortChoices: string[] = selected?.efforts ?? allEfforts
  const knownEfforts = !!selected || (!trimmedModel && models.length > 0)
  const incompatible = knownEfforts && defaultEffort !== '' && !effortChoices.includes(defaultEffort)

  const filteredReviewProviders: ReviewProviderOption[] = React.useMemo(
    () => reviewProviders.filter(p => p.id !== PROVIDER_ID),
    [reviewProviders],
  )
  const customReviewProviderNotInList =
    isExternalReviewProvider && !filteredReviewProviders.some(p => p.id === trimmedReviewProvider)
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
  const reviewEffortChoices: string[] = !isExternalReviewProvider
    ? (selectedInternalReviewModel?.efforts ?? allEfforts)
    : []
  const knownReviewEfforts =
    !isExternalReviewProvider && (!!selectedInternalReviewModel || (!trimmedReviewModel && models.length > 0))
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

  const advancedInvalid = !idleValid || !timeoutValid
  const advancedDirty =
    agyBin !== baseline.agyBin ||
    workspaceRoot !== baseline.workspaceRoot ||
    idleMinutes !== baseline.idleMinutes ||
    timeoutSeconds !== baseline.timeoutSeconds ||
    geoFenceMode !== baseline.geoFenceMode

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

  const mcpPolicyChanged =
    mcpBridge !== baseline.mcpBridge || !equalEffectiveMcpToolPolicy(mcpToolPolicy, baseline.mcpToolPolicy)

  const handleDefaultModelChange = React.useCallback(
    (nextModel: string) => {
      setDefaultModel(nextModel)
      setEffortNotice('')
      const nextTrimmed = nextModel.trim()
      const nextSelected = models.find(m => m.value === nextTrimmed)
      const nextChoices = nextSelected?.efforts ?? allEfforts
      const nextKnown = !!nextSelected || (!nextTrimmed && models.length > 0)
      if (nextKnown && defaultEffort !== '' && !nextChoices.includes(defaultEffort)) {
        setDefaultEffort('')
        setEffortNotice('已将默认推理强度自动重置为该模型默认档位')
      }
    },
    [models, allEfforts, defaultEffort],
  )

  const handleInternalReviewModelChange = React.useCallback(
    (nextModel: string) => {
      setAutoReviewModel(nextModel)
      const nextTrimmed = nextModel.trim()
      const nextSelected = models.find(m => m.value === nextTrimmed)
      const nextChoices = nextSelected?.efforts ?? allEfforts
      const nextKnown = !!nextSelected || (!nextTrimmed && models.length > 0)
      if (nextKnown && autoReviewEffort !== '' && !nextChoices.includes(autoReviewEffort)) {
        setAutoReviewEffort('')
      }
    },
    [models, allEfforts, autoReviewEffort],
  )

  const handleChangeGroup = React.useCallback((groupId: SupplementGroupId, mode: SupplementGroupMode) => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => ({
      ...prev,
      groups: { ...prev.groups, [groupId]: mode },
    }))
  }, [])

  const handleChangeReplace = React.useCallback((groupId: ReplaceGroupId, mode: ReplaceGroupMode) => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => ({
      ...prev,
      replace: { ...prev.replace, [groupId]: mode },
    }))
  }, [])

  const handleChangeOverride = React.useCallback((toolName: string, mode: ToolExposureMode | '') => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => {
      const nextOverrides = { ...prev.overrides }
      if (!mode) delete nextOverrides[toolName]
      else nextOverrides[toolName] = mode
      return { ...prev, overrides: nextOverrides }
    })
  }, [])

  const handleApplyPreset = React.useCallback((nextPolicy: EffectiveMcpToolPolicy) => {
    setSavedMsg('')
    setMcpToolPolicy(nextPolicy)
  }, [])

  const handleClearOverrides = React.useCallback(() => {
    setSavedMsg('')
    setMcpToolPolicy((prev: EffectiveMcpToolPolicy) => ({ ...prev, overrides: {} }))
  }, [])

  const handleResetPolicyDefaults = React.useCallback(() => {
    setSavedMsg('')
    setMcpToolPolicy(resolveEffectiveMcpToolPolicy())
  }, [])

  const handleDiscardChanges = (): void => {
    syncFormTo(baseline)
    setSavedMsg('已放弃未保存的修改')
  }

  const handleSaveConfig = async (): Promise<void> => {
    if (validationError) return
    const hadMcpChanges = mcpPolicyChanged
    setOperation('save')
    setSavedMsg('')
    setConfirmResetConfig(false)
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
        syncFormTo(baselineFromConfig(res.status.config))
        const activeCount = res.status.sessions?.length ?? 0
        setNeedsSessionResetHint(Boolean(hadMcpChanges && activeCount > 0))
        setSavedMsg(
          hadMcpChanges && activeCount > 0
            ? '已保存并持久化；新对话立即生效，已有活跃会话可点击按钮重置连接以刷新工具表'
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
    setConfirmResetConfig(false)
    try {
      const res = await postJson('/plugins/agy-acp/config/reset', {})
      if (res.ok && res.status) {
        applyStatus(res.status)
        syncFormTo(baselineFromConfig(res.status.config))
        setSavedMsg('已恢复为默认配置')
      } else {
        setSavedMsg(res.error || '恢复默认失败，请重试')
      }
    } finally {
      setOperation(null)
    }
  }

  return h(
    ConfigFieldset,
    { operation, onEdit: () => setSavedMsg('') },
    // Card 1: Core model & auto-review routing
    h(
      'div',
      { className: 'agy-acp-card' },
      h(
        'div',
        { className: 'agy-acp-section-head' },
        h(
          'div',
          null,
          h('h3', { className: 'agy-acp-section-title' }, '模型与推理设置'),
          h(
            'div',
            { className: 'agy-acp-caption', style: { marginTop: '2px' } },
            '配置保存在本机。权限跟随 DSH 会话；如需批准工具调用，请返回对应对话。',
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: refreshingModels || busy,
            onClick: onRefreshModels,
            className: 'agy-acp-btn agy-acp-btn--sm',
          },
          refreshingModels ? '刷新中…' : `刷新模型目录 (${models.length})`,
        ),
      ),

      models.length === 0
        ? h(
            'p',
            { className: 'agy-acp-muted', style: { margin: '0 0 10px' } },
            '模型目录为空。可点击「刷新模型目录」探测；也可留空使用 ACP 默认模型。',
          )
        : null,

      h(
        'div',
        { className: 'agy-acp-grid-2' },
        h(
          'label',
          null,
          h('div', { className: 'agy-acp-field-label' }, '默认模型（留空自动）'),
          models.length > 0
            ? h(
                'select',
                {
                  value: defaultModel,
                  onChange: (e: { target: { value: string } }) => handleDefaultModelChange(e.target.value),
                  className: 'agy-acp-select',
                },
                h('option', { value: '' }, '自动（使用 ACP 默认）'),
                customModelNotInCatalog
                  ? h('option', { value: defaultModel }, `${defaultModel}（当前已存，不在目录中）`)
                  : null,
                ...models.map(m =>
                  h('option', { key: m.value, value: m.value }, m.name === m.value ? m.value : `${m.name} (${m.value})`),
                ),
              )
            : h('input', {
                type: 'text',
                value: defaultModel,
                placeholder: '例如 gemini-4-neon',
                onChange: (e: { target: { value: string } }) => handleDefaultModelChange(e.target.value),
                className: 'agy-acp-input',
              }),
        ),
        h(
          'label',
          null,
          h('div', { className: 'agy-acp-field-label' }, '默认推理强度'),
          knownEfforts
            ? h(
                'select',
                {
                  className: 'agy-acp-select',
                  value: defaultEffort,
                  onChange: (e: { target: { value: string } }) => {
                    setEffortNotice('')
                    setDefaultEffort(e.target.value)
                  },
                },
                h('option', { value: '' }, '使用模型默认档位'),
                incompatible
                  ? h('option', { value: defaultEffort, disabled: true }, `${defaultEffort}（不适用于当前选择）`)
                  : null,
                ...effortChoices.map(id => h('option', { key: id, value: id }, effortLabel(id))),
              )
            : h('input', {
                type: 'text',
                value: defaultEffort,
                placeholder: '目录尚未确认，留空使用模型默认档位',
                onChange: (e: { target: { value: string } }) => setDefaultEffort(e.target.value),
                className: 'agy-acp-input',
              }),
          effortNotice
            ? h('div', { className: 'agy-acp-caption', style: { color: theme.accentBlue, marginTop: '4px' } }, effortNotice)
            : null,
        ),
      ),

      h('hr', { className: 'agy-acp-divider' }),

      // Auto review routing
      h('div', { style: { fontWeight: 600, fontSize: '13px', marginBottom: '2px' } }, '自动审查模型（DSH Auto Review）'),
      h(
        'div',
        { className: 'agy-acp-caption', style: { marginBottom: '10px' } },
        '控制 Auto 权限模式下工具审查使用的模型。留空跟随对话主模型（ACP 内部自动选用最低档位提速）；选择其他 DSH Provider 可直连其 API 省去进程冷启动。',
      ),
      h(
        'div',
        { className: 'agy-acp-grid-3' },
        h(
          'label',
          null,
          h('div', { className: 'agy-acp-field-label' }, '审查 Provider'),
          h(
            'select',
            {
              'aria-label': '自动审查 Provider',
              value: autoReviewProvider,
              onChange: (e: { target: { value: string } }) => {
                setAutoReviewProvider(e.target.value)
                setAutoReviewModel('')
                setAutoReviewEffort('')
                setManualReviewModel(false)
              },
              className: 'agy-acp-select',
            },
            h('option', { value: '' }, '当前插件（Antigravity ACP）'),
            customReviewProviderNotInList
              ? h('option', { value: autoReviewProvider }, `${autoReviewProvider}（已存，当前未注册）`)
              : null,
            ...filteredReviewProviders.map(p =>
              h('option', { key: p.id, value: p.id }, p.name === p.id ? p.id : `${p.name} (${p.id})`),
            ),
          ),
        ),
        h(
          'div',
          null,
          h(
            'label',
            null,
            h(
              'div',
              { className: 'agy-acp-field-label' },
              h('span', null, isExternalReviewProvider ? '审查模型（必填）' : '审查模型（留空跟随主模型）'),
              isExternalReviewProvider && externalReviewModels.length > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setManualReviewModel((v: boolean) => !v),
                      className: 'agy-acp-btn agy-acp-btn--link',
                    },
                    manualReviewModel ? '返回下拉' : '手动输入',
                  )
                : null,
            ),
            !isExternalReviewProvider
              ? models.length > 0
                ? h(
                    'select',
                    {
                      'aria-label': '自动审查模型',
                      value: autoReviewModel,
                      onChange: (e: { target: { value: string } }) => handleInternalReviewModelChange(e.target.value),
                      className: 'agy-acp-select',
                    },
                    h('option', { value: '' }, '跟随当前对话主模型'),
                    customInternalReviewModelNotInCatalog
                      ? h('option', { value: autoReviewModel }, `${autoReviewModel}（当前已存，不在目录中）`)
                      : null,
                    ...models.map(m =>
                      h('option', { key: m.value, value: m.value }, m.name === m.value ? m.value : `${m.name} (${m.value})`),
                    ),
                  )
                : h('input', {
                    type: 'text',
                    'aria-label': '自动审查模型',
                    value: autoReviewModel,
                    placeholder: '留空跟随主模型，或填如 gemini-3-flash',
                    onChange: (e: { target: { value: string } }) => handleInternalReviewModelChange(e.target.value),
                    className: 'agy-acp-input',
                  })
              : !manualReviewModel && externalReviewModels.length > 0
                ? h(
                    'select',
                    {
                      'aria-label': '自动审查模型',
                      value: autoReviewModel,
                      onChange: (e: { target: { value: string } }) => setAutoReviewModel(e.target.value),
                      className: 'agy-acp-select',
                    },
                    h('option', { value: '' }, '请选择审查模型…'),
                    customExternalReviewModelNotInList
                      ? h('option', { value: autoReviewModel }, `${autoReviewModel}（当前已存）`)
                      : null,
                    ...externalReviewModels.map(m =>
                      h('option', { key: m.id, value: m.id }, m.name === m.id ? m.id : `${m.name} (${m.id})`),
                    ),
                  )
                : h('input', {
                    type: 'text',
                    'aria-label': '自动审查模型',
                    value: autoReviewModel,
                    placeholder: loadingReviewModels ? '正在加载模型列表…' : '输入目标 Provider 的模型 ID',
                    onChange: (e: { target: { value: string } }) => setAutoReviewModel(e.target.value),
                    className: 'agy-acp-input',
                  }),
          ),
          reviewModelsError
            ? h('div', { style: { fontSize: '11px', color: theme.stateWarn, marginTop: '4px' } }, reviewModelsError)
            : null,
        ),
        h(
          'label',
          null,
          h('div', { className: 'agy-acp-field-label' }, '审查推理强度'),
          !isExternalReviewProvider && knownReviewEfforts
            ? h(
                'select',
                {
                  'aria-label': '自动审查推理强度',
                  value: autoReviewEffort,
                  onChange: (e: { target: { value: string } }) => setAutoReviewEffort(e.target.value),
                  className: 'agy-acp-select',
                },
                h('option', { value: '' }, '自动（最低档位，推荐）'),
                incompatibleReviewEffort
                  ? h('option', { value: autoReviewEffort, disabled: true }, `${autoReviewEffort}（不适用于当前选择）`)
                  : null,
                ...reviewEffortChoices.map(id => h('option', { key: id, value: id }, effortLabel(id))),
              )
            : h('input', {
                type: 'text',
                'aria-label': '自动审查推理强度',
                value: autoReviewEffort,
                placeholder: isExternalReviewProvider ? '留空不覆盖（可填 low / minimal）' : '留空自动使用最低档位',
                onChange: (e: { target: { value: string } }) => setAutoReviewEffort(e.target.value),
                className: 'agy-acp-input',
              }),
        ),
      ),
    ),

    // Card 2: Reverse MCP Bridge & Tool Policy
    h(
      'div',
      { className: 'agy-acp-card' },
      h(ToggleSwitch, {
        checked: mcpBridge,
        onChange: setMcpBridge,
        title: '会话级反向 MCP 桥接（Reverse MCP Bridge）',
        description: '通过 ACP session/new 动态向 agy 暴露 DSH 工具，不污染全局 ~/.gemini/config/mcp_config.json',
      }),
      h(McpToolPolicyPanel, {
        enabled: mcpBridge,
        policy: mcpToolPolicy,
        catalog: mcpToolCatalog,
        onChangeGroup: handleChangeGroup,
        onChangeReplace: handleChangeReplace,
        onChangeOverride: handleChangeOverride,
        onApplyPreset: handleApplyPreset,
        onClearOverrides: handleClearOverrides,
        onResetPolicyDefaults: handleResetPolicyDefaults,
      }),
    ),

    // Card 3: Scheduling & Advanced Environment Settings
    h(
      'div',
      { className: 'agy-acp-card' },
      h(ToggleSwitch, {
        checked: quotaAwareScheduling,
        onChange: setQuotaAwareScheduling,
        title: '配额感知多账号调度（Quota-Aware Scheduling）',
        description: '将手动采集的 5h / 7d 配额余量映射至多账号池调度权重，优先分配高余量账号并避开耗尽账号（默认关闭，不后台轮询）',
        style: { marginBottom: '12px' },
      }),

      h(
        'details',
        { className: 'agy-acp-collapsible', open: advancedInvalid || undefined },
        h(
          'summary',
          null,
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            '高级与环境设置',
            advancedInvalid
              ? h('span', { className: 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--error' }, '需修正')
              : advancedDirty
                ? h('span', { className: 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--warn' }, '已修改')
                : null,
          ),
          h('span', { className: 'agy-acp-caption' }, '路径 · 超时 · 地域合规'),
        ),
        h(
          'div',
          { className: 'agy-acp-collapsible-body' },
          h(
            'div',
            { className: 'agy-acp-grid-2' },
            h(
              'label',
              null,
              h('div', { className: 'agy-acp-field-label' }, 'agy 可执行文件路径（留空自动探测）'),
              h('input', {
                type: 'text',
                'aria-label': 'agy 可执行文件路径',
                value: agyBin,
                placeholder: '/home/user/.local/bin/agy',
                onChange: (e: { target: { value: string } }) => setAgyBin(e.target.value),
                className: 'agy-acp-input',
              }),
            ),
            h(
              'label',
              null,
              h('div', { className: 'agy-acp-field-label' }, '模型探测目录（不改变会话工作区）'),
              h('input', {
                type: 'text',
                'aria-label': '模型探测目录',
                value: workspaceRoot,
                placeholder: '留空使用默认探测目录',
                onChange: (e: { target: { value: string } }) => setWorkspaceRoot(e.target.value),
                className: 'agy-acp-input',
              }),
            ),
            h(
              'label',
              null,
              h('div', { className: 'agy-acp-field-label' }, '空闲会话回收（分钟，1–1440）'),
              h('input', {
                type: 'number',
                min: SESSION_IDLE_TTL_MIN_MS / 60_000,
                max: SESSION_IDLE_TTL_MAX_MS / 60_000,
                step: 1,
                'aria-label': '空闲会话回收（分钟）',
                value: idleMinutes,
                onChange: (e: { target: { value: string } }) => setIdleMinutes(e.target.value),
                className: 'agy-acp-input',
              }),
            ),
            h(
              'label',
              null,
              h(
                'div',
                { className: 'agy-acp-field-label' },
                `单次请求超时（秒，${REQUEST_TIMEOUT_MIN_MS / 1_000}–${REQUEST_TIMEOUT_MAX_MS / 1_000}）`,
              ),
              h('input', {
                type: 'number',
                min: REQUEST_TIMEOUT_MIN_MS / 1_000,
                max: REQUEST_TIMEOUT_MAX_MS / 1_000,
                step: 10,
                'aria-label': '单次请求超时（秒）',
                value: timeoutSeconds,
                onChange: (e: { target: { value: string } }) => setTimeoutSeconds(e.target.value),
                className: 'agy-acp-input',
              }),
            ),
            h(
              'label',
              null,
              h('div', { className: 'agy-acp-field-label' }, '地域合规防护（防封号拦截）'),
              h(
                'select',
                {
                  value: geoFenceMode,
                  onChange: (e: { target: { value: string } }) => {
                    if (isGeoFenceMode(e.target.value)) setGeoFenceMode(e.target.value)
                  },
                  className: 'agy-acp-select',
                },
                h('option', { value: 'block' }, '拦截受限地区（推荐，默认）'),
                h('option', { value: 'strict' }, '严格模式（受限与未知均拦截）'),
                h('option', { value: 'warn' }, '仅告警不拦截'),
                h('option', { value: 'off' }, '关闭'),
              ),
            ),
          ),
        ),
      ),
    ),

    // Sticky Save Action Bar
    h(
      'div',
      { className: 'agy-acp-sticky-bar' },
      h(
        'div',
        { style: { flex: '1 1 220px', minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        validationError
          ? h('span', { role: 'alert', style: { fontSize: '12px', fontWeight: 500, color: theme.stateError } }, validationError)
          : dirty
            ? h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: theme.stateWarn, fontWeight: 500 } },
                h('span', { className: 'agy-acp-dot', style: { backgroundColor: theme.stateWarn } }),
                '有未保存的修改',
              )
            : savedMsg
              ? h('span', { role: 'status', className: 'agy-acp-muted' }, savedMsg)
              : h('span', { className: 'agy-acp-caption' }, hasPersistedConfig ? '当前已应用本机自定义配置' : '当前为默认配置'),
        needsSessionResetHint && activeSessionCount > 0
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => {
                  setNeedsSessionResetHint(false)
                  onResetSessions({ kind: 'all' })
                },
                className: 'agy-acp-btn agy-acp-btn--sm',
              },
              '立即应用到活跃会话（重置连接）',
            )
          : null,
      ),

      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        dirty
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: handleDiscardChanges,
                className: 'agy-acp-btn agy-acp-btn--sm',
              },
              '放弃修改',
            )
          : null,
        confirmResetConfig
          ? h(
              React.Fragment,
              null,
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => setConfirmResetConfig(false),
                  className: 'agy-acp-btn agy-acp-btn--sm',
                },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => void handleResetConfig(),
                  className: 'agy-acp-btn agy-acp-btn--sm agy-acp-btn--danger-solid',
                },
                operation === 'resetConfig' ? '恢复中…' : '确认恢复默认',
              ),
            )
          : h(
              'button',
              {
                type: 'button',
                disabled: busy || !hasPersistedConfig,
                onClick: () => setConfirmResetConfig(true),
                className: 'agy-acp-btn agy-acp-btn--sm',
              },
              operation === 'resetConfig' ? '恢复中…' : '恢复默认',
            ),
        h(
          'button',
          {
            type: 'button',
            disabled: busy || Boolean(validationError),
            onClick: () => void handleSaveConfig(),
            className: 'agy-acp-btn agy-acp-btn--primary',
          },
          operation === 'save' ? '保存中…' : '保存并应用',
        ),
      ),
    ),
  )
})
