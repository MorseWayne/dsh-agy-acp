import type { Context } from '@deepseek-ai/cordis'
// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import type { StatusSnapshot } from '../common/types.ts'

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

function AgyAcpBadge(): unknown {
  const [status, setStatus] = React.useState(null as StatusSnapshot | null)

  React.useEffect(() => {
    const es = new EventSource('/plugins/agy-acp/events')
    const onStatus = (ev: MessageEvent<string>): void => {
      try {
        setStatus(JSON.parse(ev.data) as StatusSnapshot)
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
  const label = connected ? `AGY·ACP (${status?.activeSessions ?? 0})` : 'AGY·ACP'

  return React.createElement(
    'span',
    {
      title: connected
        ? `${status?.agentName ?? 'Antigravity ACP'} ${status?.agentVersion ?? ''} (${status?.tierName ?? 'connected'})`
        : 'Antigravity ACP idle (connects on first turn)',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '12px',
        fontWeight: 500,
        border: '1px solid currentColor',
        opacity: connected ? 0.95 : 0.65,
      },
    },
    React.createElement('span', {
      style: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        backgroundColor: connected ? '#22c55e' : '#94a3b8',
      },
    }),
    label,
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
      AgyAcpBadge,
    ),
  )
}
