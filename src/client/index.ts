import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
// @ts-expect-error runtime ReactDOM is supplied by the DSH web host
import ReactDOM from 'react-dom'
import type {
  AccountHealthSnapshot,
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
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

function useAgyAcpStatus(): StatusSnapshot | null {
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

/** Full Settings & Plugin Configuration page (`settings.section`, `plugins.bundle.config`, `plugins.row.config`). */
function AgyAcpSettingsSection(): unknown {
  const status = useAgyAcpStatus()
  const [busy, setBusy] = React.useState(false)
  const [savedMsg, setSavedMsg] = React.useState('')

  const [mcpBridge, setMcpBridge] = React.useState(false)
  const [defaultModel, setDefaultModel] = React.useState('')
  const [defaultEffort, setDefaultEffort] = React.useState('')
  const [agyBin, setAgyBin] = React.useState('')
  const [workspaceRoot, setWorkspaceRoot] = React.useState('')
  const initializedRef = React.useRef(false)

  React.useEffect(() => {
    if (!status || initializedRef.current) return
    initializedRef.current = true
    setMcpBridge(Boolean(status.config?.mcpBridge))
    setDefaultModel(status.config?.defaultModel ?? '')
    setDefaultEffort(status.config?.defaultEffort ?? '')
    setAgyBin(status.config?.agyBin ?? '')
    setWorkspaceRoot(status.config?.workspaceRoot ?? '')
  }, [status])

  const connected = Boolean(status?.connected)
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

      React.createElement('p', null, '权限跟随当前 DSH 会话，需要确认时请在对应对话中处理。若 agy 不支持原生自动审查，将改为询问，不会自动同意。'),

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
          React.createElement('div', { style: { fontSize: '12px', opacity: 0.8, marginBottom: '4px' } }, '模型探测目录（不改变会话工作区）'),
          React.createElement('input', {
            type: 'text',
            value: workspaceRoot,
            placeholder: '留空使用默认探测目录',
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

function portalToBody(node: unknown): unknown {
  if (typeof document !== 'undefined' && document.body && typeof ReactDOM?.createPortal === 'function') {
    return ReactDOM.createPortal(node, document.body)
  }
  return node
}

/** Compact header badge + body-portaled console modal (`conversation.session.header.actions`). */
function AgyAcpConsoleWidget(): unknown {
  const [open, setOpen] = React.useState(false)
  const status = useAgyAcpStatus()

  React.useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const connected = Boolean(status?.connected)
  const sessions = status?.sessions ?? []

  const badgeLabel = connected ? `AGY·ACP (${sessions.length})` : 'AGY·ACP'
  const dotColor = connected ? '#22c55e' : '#94a3b8'

  const modal = open
    ? portalToBody(
        React.createElement(
          'div',
          {
            onClick: (ev: { target: unknown; currentTarget: unknown }) => {
              if (ev.target === ev.currentTarget) setOpen(false)
            },
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 10000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
              backdropFilter: 'blur(4px)',
            },
          },
          React.createElement(
            'div',
            {
              role: 'dialog',
              'aria-label': 'Antigravity ACP 控制台',
              style: {
                position: 'relative',
                width: 'min(780px, 94vw)',
                maxHeight: '86vh',
                overflowY: 'auto',
                borderRadius: '14px',
                border: '1px solid rgba(148, 163, 184, 0.35)',
                backgroundColor: 'var(--bg-elevated, #18181b)',
                color: 'var(--text-primary, #f4f4f5)',
                boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
                padding: '18px 22px',
              },
            },
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => setOpen(false),
                title: '关闭 (Esc)',
                style: {
                  position: 'absolute',
                  top: '14px',
                  right: '14px',
                  width: '28px',
                  height: '28px',
                  borderRadius: '6px',
                  border: '1px solid rgba(148, 163, 184, 0.3)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '15px',
                  lineHeight: 1,
                },
              },
              '×',
            ),
            React.createElement(AgyAcpSettingsSection),
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
        title: connected
          ? `${status?.agentName ?? 'Antigravity ACP'} ${status?.agentVersion ?? ''} (${status?.tierName ?? '已连接'})`
          : '打开 Antigravity ACP 控制台',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '2px 8px',
          borderRadius: '999px',
          fontSize: '12px',
          fontWeight: 500,
          border: '1px solid currentColor',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          opacity: connected ? 0.95 : 0.75,
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
