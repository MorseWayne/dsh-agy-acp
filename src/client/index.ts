import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import type { PendingPermission, PermissionMode, SessionSummary, StatusSnapshot } from '../common/types.ts'

export const name = 'dsh-agy-acp-client'
export const inject = ['slots']

interface ClientContext extends Context {
  slots: {
    inject(name: string, register: () => () => void): void
    register(
      opts: { name: string; id?: string; order?: number; label?: string },
      Component: () => unknown,
    ): () => void
  }
}

const MODES: Array<{ id: PermissionMode; label: string }> = [
  { id: 'accept-edits', label: 'Accept Edits' },
  { id: 'default', label: 'Ask All' },
  { id: 'plan', label: 'Plan Only' },
  { id: 'skip', label: 'Auto Skip' },
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
    return s.length > 160 ? s.slice(0, 160) + '…' : s
  } catch {
    return String(raw)
  }
}

async function postJson(url: string, body: Record<string, unknown>): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function AgyAcpConsoleWidget(): unknown {
  const [status, setStatus] = React.useState(null as StatusSnapshot | null)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const es = new EventSource('/plugins/agy-acp/events')
    const onStatus = (ev: MessageEvent<string>): void => {
      try {
        const next = JSON.parse(ev.data) as StatusSnapshot
        setStatus(next)
        if (next.pendingPermissions.length > 0) {
          setOpen(true)
        }
      } catch {
        // ignore malformed frame
      }
    }
    es.addEventListener('status', onStatus as EventListener)
    return () => {
      es.removeEventListener('status', onStatus as EventListener)
      es.close()
    }
  }, [])

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
      ? `AGY·ACP (${pending.length} pending)`
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
          ? `${status?.agentName ?? 'Antigravity ACP'} ${status?.agentVersion ?? ''} (${status?.tierName ?? 'connected'})`
          : 'Antigravity ACP console',
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
          // Header
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
                  ? `${status?.agentName ?? 'agy'} ${status?.agentVersion ?? ''} · ${status?.tierName ?? 'Connected'}`
                  : 'Idle (spawns on first turn)',
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

          // Pending interactive permissions
          pending.length > 0
            ? React.createElement(
                'div',
                {
                  style: {
                    marginBottom: '10px',
                    padding: '8px',
                    borderRadius: '8px',
                    border: '1px solid rgba(245, 158, 11, 0.5)',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  },
                },
                React.createElement(
                  'div',
                  { style: { fontWeight: 600, marginBottom: '6px', color: '#fbbf24' } },
                  `Permission Approvals (${pending.length})`,
                ),
                ...pending.map((p: PendingPermission) =>
                  React.createElement(
                    'div',
                    {
                      key: p.requestId,
                      style: {
                        padding: '6px',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(0, 0, 0, 0.2)',
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
                              marginTop: '3px',
                              wordBreak: 'break-all',
                            },
                          },
                          summarizeInput(p.rawInput),
                        )
                      : null,
                    React.createElement(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' } },
                      ...p.options.map((opt) =>
                        React.createElement(
                          'button',
                          {
                            key: opt.optionId,
                            type: 'button',
                            disabled: busy,
                            onClick: () => void handleDecidePermission(p.requestId, opt.optionId),
                            style: {
                              padding: '3px 8px',
                              borderRadius: '5px',
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: '11px',
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
                          onClick: () => void handleDecidePermission(p.requestId, undefined, true),
                          style: {
                            padding: '3px 8px',
                            borderRadius: '5px',
                            border: '1px solid rgba(148,163,184,0.4)',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            fontSize: '11px',
                          },
                        },
                        'Cancel',
                      ),
                    ),
                  ),
                ),
              )
            : null,

          // Permission mode selector
          React.createElement(
            'div',
            { style: { marginBottom: '10px' } },
            React.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, 'Permission Mode'),
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

          // Token usage summary
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

          // Active sessions
          React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '6px',
                },
              },
              React.createElement('span', { style: { opacity: 0.75 } }, `Active Sessions (${sessions.length})`),
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
                    'Reset All',
                  )
                : null,
            ),
            sessions.length === 0
              ? React.createElement('div', { style: { opacity: 0.55, fontSize: '11px' } }, 'No active ACP sessions.')
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
                      'Close',
                    ),
                  ),
                ),
          ),
        )
      : null,
  )
}

export function apply(ctx: ClientContext): void {
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
}
