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
import type { SessionSummary, StatusSnapshot } from '../common/types.ts'
import { AccountCard } from './account-card.ts'
import { sessionAccountLabel } from './account-display.ts'
import { snapshotNotice, type SnapshotState } from './snapshot-state.ts'
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

interface PostJsonResult {
  ok: boolean
  status?: StatusSnapshot
  error?: string
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

async function postJson(url: string, body: Record<string, unknown>): Promise<PostJsonResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data: { status?: StatusSnapshot; error?: string } = {}
    try {
      data = (await res.json()) as { status?: StatusSnapshot; error?: string }
    } catch {
      // ignore non-JSON body
    }
    return {
      ok: res.ok,
      ...(data.status ? { status: data.status } : {}),
      ...(typeof data.error === 'string' && data.error.trim() ? { error: data.error.trim() } : {}),
    }
  } catch {
    return { ok: false, error: '未能连接到插件，请重试' }
  }
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
  return React.createElement(SettingsView, useAgyAcpStatus())
}

interface FormBaseline {
  mcpBridge: boolean
  defaultModel: string
  defaultEffort: string
  agyBin: string
  workspaceRoot: string
  idleMinutes: string
  timeoutSeconds: string
}

function baselineFromStatus(status: StatusSnapshot): FormBaseline {
  return {
    mcpBridge: Boolean(status.config?.mcpBridge),
    defaultModel: status.config?.defaultModel ?? '',
    defaultEffort: status.config?.defaultEffort ?? '',
    agyBin: status.config?.agyBin ?? '',
    workspaceRoot: status.config?.workspaceRoot ?? '',
    idleMinutes: String(clampIdleMinutes(status.config?.sessionIdleTtlMs)),
    timeoutSeconds: String(clampTimeoutSeconds(status.config?.requestTimeoutMs)),
  }
}

export function SettingsView({ status, stream, failed, applyStatus }: StatusView): unknown {
  const [busy, setBusy] = React.useState(false)
  const [refreshingModels, setRefreshingModels] = React.useState(false)
  const [savedMsg, setSavedMsg] = React.useState('')

  const initialBase = status ? baselineFromStatus(status) : null
  const [baseline, setBaseline] = React.useState(initialBase as FormBaseline | null)
  const [mcpBridge, setMcpBridge] = React.useState(initialBase?.mcpBridge ?? false)
  const [defaultModel, setDefaultModel] = React.useState(initialBase?.defaultModel ?? '')
  const [defaultEffort, setDefaultEffort] = React.useState(initialBase?.defaultEffort ?? '')
  const [agyBin, setAgyBin] = React.useState(initialBase?.agyBin ?? '')
  const [workspaceRoot, setWorkspaceRoot] = React.useState(initialBase?.workspaceRoot ?? '')
  const [idleMinutes, setIdleMinutes] = React.useState(initialBase?.idleMinutes ?? '30')
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(initialBase?.timeoutSeconds ?? '600')

  const syncFormTo = React.useCallback((nextBase: FormBaseline) => {
    setBaseline(nextBase)
    setMcpBridge(nextBase.mcpBridge)
    setDefaultModel(nextBase.defaultModel)
    setDefaultEffort(nextBase.defaultEffort)
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
      defaultModel === baseline.defaultModel &&
      defaultEffort === baseline.defaultEffort &&
      agyBin === baseline.agyBin &&
      workspaceRoot === baseline.workspaceRoot &&
      idleMinutes === baseline.idleMinutes &&
      timeoutSeconds === baseline.timeoutSeconds
    if (isCurrentlyClean && JSON.stringify(incoming) !== JSON.stringify(baseline)) {
      syncFormTo(incoming)
    }
  }, [status, baseline, mcpBridge, defaultModel, defaultEffort, agyBin, workspaceRoot, idleMinutes, timeoutSeconds, syncFormTo])

  if (!status) {
    return React.createElement(
      'p',
      { role: 'status' },
      stream === 'offline' || failed ? '暂时无法读取 ACP 状态，等待连接恢复。' : '正在读取 ACP 状态…',
    )
  }

  const notice = snapshotNotice({ status, stream })
  const connected = !notice && status.connected
  const sessions = status.sessions
  const accounts = status.accounts
  const models = status.models ?? []
  const trimmedModel = defaultModel.trim()
  const selected = models.find(m => m.value === trimmedModel)
  const customModelNotInCatalog = trimmedModel !== '' && models.length > 0 && !selected
  const effortChoices = selected?.efforts ?? sortedEfforts(models.flatMap(m => m.efforts))
  const knownEfforts = !!selected || (!trimmedModel && models.length > 0)
  const incompatible = knownEfforts && defaultEffort !== '' && !effortChoices.includes(defaultEffort)

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
        : ''

  const dirty = Boolean(
    baseline && (
      mcpBridge !== baseline.mcpBridge ||
      defaultModel !== baseline.defaultModel ||
      defaultEffort !== baseline.defaultEffort ||
      agyBin !== baseline.agyBin ||
      workspaceRoot !== baseline.workspaceRoot ||
      idleMinutes !== baseline.idleMinutes ||
      timeoutSeconds !== baseline.timeoutSeconds
    ),
  )

  const totals = status.usageTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
  }

  const handleSaveConfig = async (): Promise<void> => {
    if (validationError) return
    setBusy(true)
    setSavedMsg('')
    try {
      const res = await postJson('/plugins/agy-acp/config', {
        mcpBridge,
        defaultModel,
        defaultEffort,
        agyBin,
        workspaceRoot,
        sessionIdleTtlMs: parsedIdleMin * 60_000,
        requestTimeoutMs: parsedTimeoutSec * 1_000,
      })
      if (res.ok && res.status) {
        applyStatus(res.status)
        syncFormTo(baselineFromStatus(res.status))
        setSavedMsg('已保存并持久化到本机配置')
      } else {
        setSavedMsg(res.error || '保存失败，请重试')
      }
    } finally {
      setBusy(false)
    }
  }

  const handleResetConfig = async (): Promise<void> => {
    setBusy(true)
    setSavedMsg('')
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
      setBusy(false)
    }
  }

  const handleRefreshModels = async (): Promise<void> => {
    setRefreshingModels(true)
    setSavedMsg('')
    try {
      const res = await postJson('/plugins/agy-acp/models/refresh', {})
      if (res.status) applyStatus(res.status)
      setSavedMsg(res.ok ? `模型目录已刷新（共 ${res.status?.models.length ?? 0} 个模型）` : (res.error || '模型目录刷新失败'))
    } finally {
      setRefreshingModels(false)
    }
  }

  const handleResetSessions = async (sessionKey?: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await postJson('/plugins/agy-acp/sessions/reset', sessionKey ? { sessionKey } : {})
      if (res.status) applyStatus(res.status)
    } finally {
      setBusy(false)
    }
  }

  return React.createElement(
    'div',
    { style: { maxWidth: '760px', padding: '8px 4px', fontSize: '13px', lineHeight: 1.5 } },
    // Title
    React.createElement(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' } },
      React.createElement(
        'div',
        null,
        React.createElement('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, 'Antigravity ACP (dsh-agy-acp)'),
        React.createElement(
          'div',
          { style: { ...styles.secondaryText, marginTop: '2px' } },
          '基于官方 agy acp 持久化 JSON-RPC 2.0 长连接的 Antigravity 桥接插件',
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
        notice || (connected
          ? `${status.agentName ?? 'agy acp'} ${status.agentVersion ?? ''} (${status.tierName ?? '已连接'})`
          : '待机中（首轮对话自动建连）'),
      ),
    ),

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

    // Usage overview card
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: '10px' } }, '运行概览与 Token 用量'),
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px', textAlign: 'center' } },
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '活跃会话'), String(sessions.length)),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, 'Input'), formatTokens(totals.inputTokens)),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '缓存读 / 写'), `${formatTokens(totals.cachedReadTokens)} / ${formatTokens(totals.cachedWriteTokens ?? 0)}`),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, 'Output'), formatTokens(totals.outputTokens)),
        React.createElement('div', null, React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, 'Thinking'), formatTokens(totals.reasoningTokens)),
      ),
    ),

    // Runtime settings card
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', gap: '8px', flexWrap: 'wrap' } },
        React.createElement('div', { style: { fontWeight: 600 } }, '桥接配置'),
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
        '权限跟随当前 DSH 会话，需要确认时请在对应对话中处理。此处配置会持久化到本机并在重启后生效。'),

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
            value: idleMinutes,
            onChange: (e: { target: { value: string } }) => setIdleMinutes(e.target.value),
            style: styles.input,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { ...styles.secondaryText, marginBottom: '4px' } }, '单次请求超时（秒，10–3600）'),
          React.createElement('input', {
            type: 'number',
            min: REQUEST_TIMEOUT_MIN_MS / 1_000,
            max: REQUEST_TIMEOUT_MAX_MS / 1_000,
            step: 10,
            value: timeoutSeconds,
            onChange: (e: { target: { value: string } }) => setTimeoutSeconds(e.target.value),
            style: styles.input,
          }),
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
          busy ? '保存中…' : '保存并应用',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy || !status.hasPersistedConfig,
            onClick: () => void handleResetConfig(),
            style: { ...styles.ghostButton, opacity: busy || !status.hasPersistedConfig ? 0.5 : 1 },
          },
          '恢复默认',
        ),
        validationError
          ? React.createElement('span', { role: 'alert', style: { fontSize: '12px', color: theme.stateError } }, validationError)
          : dirty
            ? React.createElement('span', { style: { fontSize: '12px', color: theme.stateWarn } }, '有未保存的修改')
            : savedMsg
              ? React.createElement('span', { role: 'status', style: { fontSize: '12px' } }, savedMsg)
              : null,
      ),
    ),

    // Active ACP sessions card
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
        React.createElement('div', { style: { fontWeight: 600 } }, `活跃 ACP 长连接会话 (${sessions.length})`),
        sessions.length > 0
          ? React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => void handleResetSessions(),
                style: styles.dangerButton,
              },
              '重置全部会话',
            )
          : null,
      ),
      sessions.length === 0
        ? React.createElement('div', { style: styles.secondaryText }, '暂无活跃 ACP 会话（在对话中选择 Antigravity (ACP) 模型后自动建立）。')
        : sessions.map((s: SessionSummary) => {
            const pct = s.contextUsed != null && s.contextSize > 0
              ? Math.min(100, Math.max(0, (100 * s.contextUsed) / s.contextSize))
              : null
            const barColor = pct == null ? theme.stateIdle : pct > 92 ? theme.stateError : pct > 80 ? theme.stateWarn : theme.brandPrimary
            return React.createElement(
              'div',
              {
                key: s.dshSessionKey,
                style: {
                  ...styles.tile,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '12px',
                },
              },
              React.createElement(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', { style: { fontWeight: 500 } }, `${s.currentModel || 'default'} · ${s.currentMode}`),
                React.createElement('div', { style: { overflowWrap: 'anywhere', fontSize: '12px' } }, `使用账号${notice ? '（上次快照）' : ''}：${sessionAccountLabel(s.accountId, accounts)}`),
                React.createElement(
                  'div',
                  { style: { ...styles.secondaryText, fontSize: '11px' } },
                  `会话 ${s.dshSessionKey} · 推理强度 ${s.currentEffort ? effortLabel(s.currentEffort) : '未报告'} · ACP 上下文 ${contextLabel(s)} · 活跃于 ${formatTime(s.lastActiveAt)}`,
                ),
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
                          backgroundColor: 'rgba(127, 127, 127, 0.2)',
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
                  onClick: () => void handleResetSessions(s.dshSessionKey),
                  style: styles.ghostButton,
                },
                '关闭',
              ),
            )
          }),
    ),

    React.createElement(
      'section',
      { style: styles.card },
      React.createElement('h3', { style: { fontSize: '14px', margin: 0 } }, `账号状态 (${accounts.length})`),
      notice ? React.createElement('div', { role: 'status', style: { marginTop: '4px', fontWeight: 550 } }, notice) : null,
      React.createElement('p', { style: { margin: '4px 0 10px', ...styles.secondaryText } },
        '配额仅在手动刷新时向上游查询，不按 Token 用量推算。清除本地冷却不会恢复上游额度。'),
      accounts.length
        ? accounts.map(account => React.createElement(AccountCard, { key: account.id, account, applyStatus }))
        : React.createElement('div', null, '暂无账号状态。'),
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
  const dotColor = status?.lastError ? theme.stateError : current ? theme.stateSuccess : theme.stateIdle

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
