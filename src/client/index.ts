import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import type {
  AccountHealthSnapshot,
  PendingPermission,
  PermissionMode,
  SessionSummary,
  StatusSnapshot,
} from '../common/types.ts'

export const name = 'dsh-agy-acp-client'
export const inject = ['slots']

interface SlotOwnerProps {
  view?: string
}

interface ClientContext extends Context {
  slots: {
    inject(name: string, register: () => () => void): void
    register(
      opts: { name: string; id?: string; key?: string; order?: number; label?: string },
      Component: (props?: SlotOwnerProps) => unknown,
    ): () => void
  }
}

const MODES: Array<{ id: PermissionMode; label: string; desc: string }> = [
  { id: 'accept-edits', label: 'Accept Edits', desc: '自动允许读写编辑，执行命令时弹窗审批' },
  { id: 'default', label: 'Ask All', desc: '所有敏感操作均需手动审批' },
  { id: 'plan', label: 'Plan Only', desc: '只读规划模式，拒绝修改与执行命令' },
  { id: 'skip', label: 'Auto Skip', desc: '全自动跳过审批（需重启子进程生效）' },
]

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function summarizeInput(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  } catch {
    return String(raw)
  }
}

async function postJson(url: string, body: Record<string, unknown>): Promise<StatusSnapshot | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return null
  try {
    const data = (await res.json()) as { status?: StatusSnapshot }
    return data.status ?? null
  } catch {
    return null
  }
}

function useAgyAcpStatus(onPending?: () => void): StatusSnapshot | null {
  const [status, setStatus] = React.useState(null as StatusSnapshot | null)

  React.useEffect(() => {
    let active = true
    void fetch('/plugins/agy-acp/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((snap) => {
        if (active && snap) setStatus(snap as StatusSnapshot)
      })
      .catch(() => undefined)

    const es = new EventSource('/plugins/agy-acp/events')
    const onStatus = (ev: MessageEvent<string>): void => {
      try {
        const next = JSON.parse(ev.data) as StatusSnapshot
        setStatus(next)
        if (next.pendingPermissions.length > 0) {
          onPending?.()
        }
      } catch {
        // ignore malformed frame
      }
    }
    es.addEventListener('status', onStatus as EventListener)
    return () => {
      active = false
      es.removeEventListener('status', onStatus as EventListener)
      es.close()
    }
  }, [])

  return status
}

function renderPendingPermissions(
  pending: PendingPermission[],
  busy: boolean,
  onDecide: (requestId: string, optionId?: string, cancel?: boolean) => Promise<void>,
): unknown {
  if (pending.length === 0) return null
  return React.createElement(
    'div',
    {
      style: {
        marginBottom: '12px',
        padding: '10px',
        borderRadius: '8px',
        border: '1px solid rgba(245, 158, 11, 0.5)',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
      },
    },
    React.createElement(
      'div',
      { style: { fontWeight: 600, marginBottom: '6px', color: '#f59e0b' } },
      `待审批权限请求 (${pending.length})`,
    ),
    ...pending.map((p) =>
      React.createElement(
        'div',
        {
          key: p.requestId,
          style: {
            padding: '8px',
            borderRadius: '6px',
            backgroundColor: 'rgba(0, 0, 0, 0.16)',
            marginBottom: '6px',
          },
        },
        React.createElement(
          'div',
          { style: { fontWeight: 600 } },
          p.title ? `${p.toolName} — ${p.title}` : p.toolName,
        ),
        p.rawInput !== undefined
          ? React.createElement(
              'div',
              {
                style: {
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  opacity: 0.85,
                  marginTop: '4px',
                  wordBreak: 'break-all',
                },
              },
              summarizeInput(p.rawInput),
            )
          : null,
        React.createElement(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } },
          ...p.options.map((opt) =>
            React.createElement(
              'button',
              {
                key: opt.optionId,
                type: 'button',
                disabled: busy,
                onClick: () => void onDecide(p.requestId, opt.optionId),
                style: {
                  padding: '4px 10px',
                  borderRadius: '5px',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 500,
                  backgroundColor: opt.kind.includes('allow') ? '#16a34a' : '#dc2626',
                  color: '#fff',
                },
              },
              opt.name,
            ),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => void onDecide(p.requestId, undefined, true),
              style: {
                padding: '4px 10px',
                borderRadius: '5px',
                border: '1px solid rgba(148,163,184,0.4)',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '12px',
              },
            },
            '取消',
          ),
        ),
      ),
    ),
  )
}

/** Full Settings & Plugin Configuration page (`settings.section`, `plugins.bundle.config`, `plugins.row.config`). */
function AgyAcpSettingsSection(): unknown {
  const status = useAgyAcpStatus()
  const [busy, setBusy] = React.useState(false)
  const [savedMsg, setSavedMsg] = React.useState('')

  const [permissionMode, setPermissionMode] = React.useState('accept-edits' as PermissionMode)
  const [mcpBridge, setMcpBridge] = React.useState(false)
  const [defaultModel, setDefaultModel] = React.useState('')
  const [defaultEffort, setDefaultEffort] = React.useState('')
  const [agyBin, setAgyBin] = React.useState('')
  const [workspaceRoot, setWorkspaceRoot] = React.useState('')
  const initializedRef = React.useRef(false)

  React.useEffect(() => {
    if (!status || initializedRef.current) return
    initializedRef.current = true
    setPermissionMode(status.permissionMode)
    setMcpBridge(Boolean(status.config?.mcpBridge))
    setDefaultModel(status.config?.defaultModel ?? '')
    setDefaultEffort(status.config?.defaultEffort ?? '')
    setAgyBin(status.config?.agyBin ?? '')
    setWorkspaceRoot(status.config?.workspaceRoot ?? '')
  }, [status])

  const connected = Boolean(status?.connected)
  const pending = status?.pendingPermissions ?? []
  const sessions = status?.sessions ?? []
  const accounts = status?.accounts ?? []
  const totals = status?.usageTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
  }

  const handleSaveConfig = async (): Promise<void> => {
    setBusy(true)
    setSavedMsg('')
    try {
      await postJson('/plugins/agy-acp/config', {
        permissionMode,
        mcpBridge,
        defaultModel,
        defaultEffort,
        agyBin,
        workspaceRoot,
      })
      setSavedMsg('配置已生效')
      setTimeout(() => setSavedMsg(''), 2500)
    } finally {
      setBusy(false)
    }
  }

  const handleResetSessions = async (sessionKey?: string): Promise<void> => {
    setBusy(true)
    try {
      await postJson('/plugins/agy-acp/sessions/reset', sessionKey ? { sessionKey } : {})
    } finally {
      setBusy(false)
    }
  }

  const handleDecidePermission = async (
    requestId: string,
    optionId?: string,
    cancel?: boolean,
  ): Promise<void> => {
    setBusy(true)
    try {
      await postJson('/plugins/agy-acp/permissions/decide', {
        requestId,
        ...(optionId ? { optionId } : {}),
        ...(cancel ? { cancel: true } : {}),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleClearCooldown = async (accountId?: string): Promise<void> => {
    setBusy(true)
    try {
      await postJson('/plugins/agy-acp/accounts/cooldown/clear', accountId ? { accountId } : {})
    } finally {
      setBusy(false)
    }
  }

  const cardStyle = {
    borderRadius: '10px',
    border: '1px solid rgba(148, 163, 184, 0.28)',
    padding: '14px 16px',
    marginBottom: '14px',
    backgroundColor: 'rgba(148, 163, 184, 0.05)',
  }

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '7px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(148, 163, 184, 0.35)',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontSize: '13px',
  }

  return React.createElement(
    'div',
    { style: { maxWidth: '760px', padding: '8px 4px', fontSize: '13px', lineHeight: 1.5 } },
    // Title
    React.createElement(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' } },
      React.createElement(
        'div',
        null,
        React.createElement('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, 'Antigravity ACP (dsh-agy-acp)'),
        React.createElement(
          'div',
          { style: { opacity: 0.7, fontSize: '12px', marginTop: '2px' } },
          '基于官方 agy acp 持久化 JSON-RPC 2.0 长连接的下一代 Antigravity 桥接插件',
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
            border: '1px solid rgba(148,163,184,0.35)',
          },
        },
        React.createElement('span', {
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: connected ? '#22c55e' : '#94a3b8',
          },
        }),
        connected
          ? `${status?.agentName ?? 'agy acp'} ${status?.agentVersion ?? ''} (${status?.tierName ?? '已连接'})`
          : '待机中（首轮对话自动建连）',
      ),
    ),

    // Pending approvals
    renderPendingPermissions(pending, busy, handleDecidePermission),

    // Usage overview card
    React.createElement(
      'div',
      { style: cardStyle },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: '10px' } }, '运行概览与 Token 用量'),
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px', textAlign: 'center' } },
        React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '11px' } }, '活跃会话'), String(sessions.length)),
        React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '11px' } }, 'Input'), formatTokens(totals.inputTokens)),
        React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '11px' } }, 'Cached'), formatTokens(totals.cachedReadTokens)),
        React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '11px' } }, 'Output'), formatTokens(totals.outputTokens)),
        React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '11px' } }, 'Thinking'), formatTokens(totals.reasoningTokens)),
      ),
    ),

    // Runtime settings card
    React.createElement(
      'div',
      { style: cardStyle },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: '10px' } }, '桥接配置'),

      // Permission mode
      React.createElement('div', { style: { marginBottom: '12px' } },
        React.createElement('div', { style: { fontWeight: 500, marginBottom: '6px' } }, '权限审批模式'),
        React.createElement(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' } },
          ...MODES.map((m) => {
            const active = permissionMode === m.id
            return React.createElement(
              'button',
              {
                key: m.id,
                type: 'button',
                onClick: () => setPermissionMode(m.id),
                style: {
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  border: `1px solid ${active ? '#3b82f6' : 'rgba(148,163,184,0.3)'}`,
                  backgroundColor: active ? 'rgba(59, 130, 246, 0.16)' : 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                },
              },
              React.createElement('div', { style: { fontWeight: 600, fontSize: '12px' } }, m.label),
              React.createElement('div', { style: { opacity: 0.72, fontSize: '11px', marginTop: '2px' } }, m.desc),
            )
          }),
        ),
      ),

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
            border: '1px solid rgba(148,163,184,0.25)',
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
            { style: { opacity: 0.7, fontSize: '11px' } },
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

      // Model / effort / paths
      React.createElement(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginBottom: '12px' } },
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontSize: '12px', opacity: 0.8, marginBottom: '4px' } }, '默认模型（留空自动）'),
          React.createElement('input', {
            type: 'text',
            value: defaultModel,
            placeholder: '例如 gemini-4-neon',
            onChange: (e: { target: { value: string } }) => setDefaultModel(e.target.value),
            style: inputStyle,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontSize: '12px', opacity: 0.8, marginBottom: '4px' } }, '默认思考档位（留空自动）'),
          React.createElement('input', {
            type: 'text',
            value: defaultEffort,
            placeholder: 'low / medium / high',
            onChange: (e: { target: { value: string } }) => setDefaultEffort(e.target.value),
            style: inputStyle,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontSize: '12px', opacity: 0.8, marginBottom: '4px' } }, 'agy 可执行文件路径（留空自动探测）'),
          React.createElement('input', {
            type: 'text',
            value: agyBin,
            placeholder: '/home/user/.local/bin/agy',
            onChange: (e: { target: { value: string } }) => setAgyBin(e.target.value),
            style: inputStyle,
          }),
        ),
        React.createElement(
          'div',
          null,
          React.createElement('div', { style: { fontSize: '12px', opacity: 0.8, marginBottom: '4px' } }, '工作区根目录（留空跟随会话）'),
          React.createElement('input', {
            type: 'text',
            value: workspaceRoot,
            placeholder: '留空使用当前会话目录',
            onChange: (e: { target: { value: string } }) => setWorkspaceRoot(e.target.value),
            style: inputStyle,
          }),
        ),
      ),

      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: () => void handleSaveConfig(),
            style: {
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: '#2563eb',
              color: '#fff',
              fontWeight: 500,
              cursor: 'pointer',
              fontSize: '13px',
            },
          },
          busy ? '保存中…' : '保存并应用',
        ),
        savedMsg
          ? React.createElement('span', { style: { color: '#22c55e', fontSize: '12px' } }, savedMsg)
          : null,
      ),
    ),

    // Active ACP sessions card
    React.createElement(
      'div',
      { style: cardStyle },
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
                style: {
                  padding: '3px 8px',
                  borderRadius: '5px',
                  border: '1px solid rgba(239, 68, 68, 0.5)',
                  background: 'transparent',
                  color: '#f87171',
                  cursor: 'pointer',
                  fontSize: '12px',
                },
              },
              '重置全部会话',
            )
          : null,
      ),
      sessions.length === 0
        ? React.createElement('div', { style: { opacity: 0.6, fontSize: '12px' } }, '暂无活跃 ACP 会话（在对话中选择 Antigravity (ACP) 模型后自动建立）。')
        : sessions.map((s: SessionSummary) =>
            React.createElement(
              'div',
              {
                key: s.dshSessionKey,
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(148, 163, 184, 0.08)',
                  marginBottom: '6px',
                },
              },
              React.createElement(
                'div',
                null,
                React.createElement('div', { style: { fontWeight: 500 } }, `${s.currentModel || 'default'} · ${s.currentMode}`),
                React.createElement(
                  'div',
                  { style: { opacity: 0.7, fontSize: '11px' } },
                  `会话 ${s.dshSessionKey} · 思考 ${s.currentEffort || 'auto'} · 上下文 ${formatTokens(s.contextUsed)}${s.contextSize > 0 ? '/' + formatTokens(s.contextSize) : ''}`,
                ),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => void handleResetSessions(s.dshSessionKey),
                  style: {
                    padding: '3px 8px',
                    borderRadius: '5px',
                    border: '1px solid rgba(148,163,184,0.35)',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: '12px',
                  },
                },
                '关闭',
              ),
            ),
          ),
    ),

    // Multi-account pool health card (shown when accounts configured)
    accounts.length > 0
      ? React.createElement(
          'div',
          { style: cardStyle },
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
            React.createElement('div', { style: { fontWeight: 600 } }, `多账号池 (${accounts.length})`),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => void handleClearCooldown(),
                style: {
                  padding: '3px 8px',
                  borderRadius: '5px',
                  border: '1px solid rgba(148,163,184,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '12px',
                },
              },
              '清除全部冷却',
            ),
          ),
          ...accounts.map((acc: AccountHealthSnapshot) =>
            React.createElement(
              'div',
              {
                key: acc.id,
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(148, 163, 184, 0.08)',
                  marginBottom: '6px',
                },
              },
              React.createElement(
                'div',
                null,
                React.createElement('div', { style: { fontWeight: 500 } }, `${acc.label} (${acc.id})`),
                React.createElement(
                  'div',
                  { style: { opacity: 0.7, fontSize: '11px' } },
                  `${acc.hasSandboxHome ? '独立 HOME · ' : ''}${acc.hasProxy ? '独立代理 · ' : ''}活跃租约 ${acc.activeLeases}${acc.lastError ? ' · ' + acc.lastError : ''}`,
                ),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => void handleClearCooldown(acc.id),
                  style: {
                    padding: '3px 8px',
                    borderRadius: '5px',
                    border: '1px solid rgba(148,163,184,0.35)',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: '11px',
                  },
                },
                '清除冷却',
              ),
            ),
          ),
        )
      : null,
  )
}

/** Compact header badge + quick dropdown popover (`conversation.session.header.actions`). */
function AgyAcpConsoleWidget(): unknown {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const status = useAgyAcpStatus(() => setOpen(true))

  const connected = Boolean(status?.connected)
  const pending = status?.pendingPermissions ?? []
  const sessions = status?.sessions ?? []
  const totals = status?.usageTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
  }

  const handleModeChange = async (mode: PermissionMode): Promise<void> => {
    setBusy(true)
    try {
      await postJson('/plugins/agy-acp/mode', { mode })
    } finally {
      setBusy(false)
    }
  }

  const handleResetSessions = async (sessionKey?: string): Promise<void> => {
    setBusy(true)
    try {
      await postJson('/plugins/agy-acp/sessions/reset', sessionKey ? { sessionKey } : {})
    } finally {
      setBusy(false)
    }
  }

  const handleDecidePermission = async (
    requestId: string,
    optionId?: string,
    cancel?: boolean,
  ): Promise<void> => {
    setBusy(true)
    try {
      await postJson('/plugins/agy-acp/permissions/decide', {
        requestId,
        ...(optionId ? { optionId } : {}),
        ...(cancel ? { cancel: true } : {}),
      })
    } finally {
      setBusy(false)
    }
  }

  const badgeLabel =
    pending.length > 0
      ? `AGY·ACP (${pending.length} 待审批)`
      : connected
        ? `AGY·ACP (${sessions.length})`
        : 'AGY·ACP'

  const dotColor = pending.length > 0 ? '#f59e0b' : connected ? '#22c55e' : '#94a3b8'

  return React.createElement(
    'div',
    { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => setOpen((v: boolean) => !v),
        title: connected
          ? `${status?.agentName ?? 'Antigravity ACP'} ${status?.agentVersion ?? ''} (${status?.tierName ?? '已连接'})`
          : 'Antigravity ACP 控制台',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '2px 8px',
          borderRadius: '999px',
          fontSize: '12px',
          fontWeight: 500,
          border: `1px solid ${pending.length > 0 ? '#f59e0b' : 'currentColor'}`,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          opacity: connected || pending.length > 0 ? 0.95 : 0.7,
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
    open
      ? React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              top: 'calc(100% + 8px)',
              right: 0,
              width: '360px',
              maxHeight: '480px',
              overflowY: 'auto',
              zIndex: 9999,
              borderRadius: '10px',
              border: '1px solid rgba(148, 163, 184, 0.35)',
              backgroundColor: 'var(--bg-elevated, #18181b)',
              color: 'var(--text-primary, #f4f4f5)',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
              padding: '12px',
              fontSize: '12px',
              lineHeight: 1.45,
            },
          },
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '10px',
                paddingBottom: '8px',
                borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
              },
            },
            React.createElement(
              'div',
              null,
              React.createElement('strong', { style: { fontSize: '13px' } }, 'Antigravity ACP'),
              React.createElement(
                'div',
                { style: { opacity: 0.7, fontSize: '11px' } },
                connected
                  ? `${status?.agentName ?? 'agy'} ${status?.agentVersion ?? ''} · ${status?.tierName ?? '已连接'}`
                  : '待机中（首轮对话自动建连）',
              ),
            ),
            React.createElement(
              'span',
              {
                style: {
                  fontSize: '11px',
                  padding: '2px 6px',
                  borderRadius: '6px',
                  backgroundColor: status?.mcpBridgeActive ? 'rgba(34, 197, 94, 0.18)' : 'rgba(148, 163, 184, 0.15)',
                  color: status?.mcpBridgeActive ? '#4ade80' : '#cbd5e1',
                },
              },
              status?.mcpBridgeActive ? 'MCP Bridge ON' : 'MCP Bridge OFF',
            ),
          ),

          renderPendingPermissions(pending, busy, handleDecidePermission),

          React.createElement(
            'div',
            { style: { marginBottom: '10px' } },
            React.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, '权限模式'),
            React.createElement(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' } },
              ...MODES.map((m) => {
                const active = status?.permissionMode === m.id
                return React.createElement(
                  'button',
                  {
                    key: m.id,
                    type: 'button',
                    disabled: busy,
                    onClick: () => void handleModeChange(m.id),
                    style: {
                      padding: '4px 4px',
                      borderRadius: '6px',
                      border: `1px solid ${active ? '#3b82f6' : 'rgba(148,163,184,0.3)'}`,
                      backgroundColor: active ? 'rgba(59, 130, 246, 0.22)' : 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: active ? 600 : 400,
                    },
                  },
                  m.label,
                )
              }),
            ),
          ),

          React.createElement(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '6px',
                padding: '6px',
                borderRadius: '6px',
                backgroundColor: 'rgba(148, 163, 184, 0.08)',
                marginBottom: '10px',
                textAlign: 'center',
              },
            },
            React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '10px' } }, 'Input'), formatTokens(totals.inputTokens)),
            React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '10px' } }, 'Cached'), formatTokens(totals.cachedReadTokens)),
            React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '10px' } }, 'Output'), formatTokens(totals.outputTokens)),
            React.createElement('div', null, React.createElement('div', { style: { opacity: 0.65, fontSize: '10px' } }, 'Think'), formatTokens(totals.reasoningTokens)),
          ),

          React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
              React.createElement('span', { style: { opacity: 0.75 } }, `活跃会话 (${sessions.length})`),
              sessions.length > 0
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      disabled: busy,
                      onClick: () => void handleResetSessions(),
                      style: {
                        padding: '2px 6px',
                        borderRadius: '4px',
                        border: '1px solid rgba(239, 68, 68, 0.45)',
                        background: 'transparent',
                        color: '#f87171',
                        cursor: 'pointer',
                        fontSize: '11px',
                      },
                    },
                    '重置全部',
                  )
                : null,
            ),
            sessions.length === 0
              ? React.createElement('div', { style: { opacity: 0.55, fontSize: '11px' } }, '暂无活跃 ACP 会话')
              : sessions.map((s: SessionSummary) =>
                  React.createElement(
                    'div',
                    {
                      key: s.dshSessionKey,
                      style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(148, 163, 184, 0.08)',
                        marginBottom: '4px',
                      },
                    },
                    React.createElement(
                      'div',
                      { style: { minWidth: 0 } },
                      React.createElement('div', { style: { fontWeight: 500 } }, s.currentModel || 'default'),
                      React.createElement(
                        'div',
                        { style: { opacity: 0.7, fontSize: '11px' } },
                        `${s.dshSessionKey} · ${s.currentEffort || 'auto'} · ctx ${formatTokens(s.contextUsed)}${s.contextSize > 0 ? '/' + formatTokens(s.contextSize) : ''}`,
                      ),
                    ),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        disabled: busy,
                        onClick: () => void handleResetSessions(s.dshSessionKey),
                        style: {
                          padding: '2px 6px',
                          borderRadius: '4px',
                          border: '1px solid rgba(148,163,184,0.35)',
                          background: 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                          fontSize: '11px',
                        },
                      },
                      '关闭',
                    ),
                  ),
                ),
          ),
        )
      : null,
  )
}

export function apply(ctx: ClientContext): void {
  // 1. Top session header quick badge + popover console
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'agy-acp-status',
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
        key: 'dsh-agy-acp',
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
        key: 'dsh-agy-acp#agy-acp',
      },
      (ownerProps?: SlotOwnerProps) => {
        if (ownerProps?.view === 'summary') return null
        return React.createElement(AgyAcpSettingsSection)
      },
    ),
  )
}
