import type { StatusSnapshot } from '../common/types.ts'

export interface SnapshotState {
  status: StatusSnapshot | null
  stream: 'connecting' | 'offline' | 'live'
  failed: boolean
}

export const initialSnapshot: SnapshotState = { status: null, stream: 'connecting', failed: false }
type StatusEvent = { type: 'initial' | 'sse' | 'action'; value: StatusSnapshot } | { type: 'readFailed' | 'disconnect' }

export function reduceSnapshot(state: SnapshotState, event: StatusEvent): SnapshotState {
  switch (event.type) {
    case 'disconnect': return { ...state, stream: 'offline' }
    case 'readFailed': return state.status ? state : { ...state, failed: true }
    case 'initial':
      // A delayed initial GET is never authoritative over a stream or action reply.
      return state.status ? state : { ...state, status: event.value, failed: false }
    case 'action':
    case 'sse':
      if (state.status && state.status.updatedAt > event.value.updatedAt) return state
      return { status: event.value, stream: event.type === 'sse' ? 'live' : state.stream, failed: false }
  }
}

export function snapshotNotice(state: Pick<SnapshotState, 'status' | 'stream'>): string {
  if (state.stream === 'live') return ''
  const text = state.stream === 'offline' ? '实时连接中断' : '等待实时连接'
  return state.status ? `${text}；显示上次快照（${new Date(state.status.updatedAt).toLocaleString()}），并非当前状态。` : text
}
