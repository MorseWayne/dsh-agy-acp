import type { StatusSnapshot } from '../common/types.ts'
import { initialSnapshot, reduceSnapshot, type SnapshotState } from './snapshot-state.ts'

export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void
  removeEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void
  close(): void
}

export interface StatusStoreDeps {
  fetchStatus?: () => Promise<StatusSnapshot | null>
  createEventSource?: (url: string) => EventSourceLike | null
  closeGraceMs?: number
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void
}

export interface StatusStore {
  getSnapshot(): SnapshotState
  subscribe(listener: () => void): () => void
  applyStatus(next: StatusSnapshot): void
  dispose(): void
}

function isValidSnapshot(v: unknown): v is StatusSnapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<StatusSnapshot>
  return Number.isFinite(s.updatedAt) && Array.isArray(s.sessions) && Array.isArray(s.accounts)
}

async function defaultFetchStatus(): Promise<StatusSnapshot | null> {
  if (typeof fetch !== 'function') return null
  const res = await fetch('/plugins/agy-acp/status')
  if (!res.ok) return null
  const data: unknown = await res.json()
  return isValidSnapshot(data) ? data : null
}

function defaultCreateEventSource(url: string): EventSourceLike | null {
  const Ctor = (globalThis as unknown as { EventSource?: new (u: string) => EventSourceLike }).EventSource
  if (typeof Ctor !== 'function') return null
  return new Ctor(url)
}

/**
 * Shared singleton SSE + Snapshot store with ref-counted grace-period teardown.
 * Multiple UI mounts (header badge, modal, settings section, plugin row) share ONE EventSource.
 */
export function createStatusStore(deps: StatusStoreDeps = {}): StatusStore {
  const fetchStatus = deps.fetchStatus ?? defaultFetchStatus
  const createEventSource = deps.createEventSource ?? defaultCreateEventSource
  const closeGraceMs = deps.closeGraceMs ?? 1_500
  const setTimer = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimeoutFn ?? ((id) => clearTimeout(id))

  let state: SnapshotState = initialSnapshot
  const listeners = new Set<() => void>()
  let es: EventSourceLike | null = null
  let onStatusHandler: ((ev: MessageEvent<string>) => void) | null = null
  let onErrorHandler: (() => void) | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let inFlightFetch = false
  let disposed = false

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // isolate subscriber errors
      }
    }
  }

  const commit = (next: SnapshotState): void => {
    if (next.status === state.status && next.stream === state.stream && next.failed === state.failed) {
      return
    }
    state = next
    emit()
  }

  const dispatch = (event: Parameters<typeof reduceSnapshot>[1]): void => {
    if (disposed) return
    commit(reduceSnapshot(state, event))
  }

  const closeConnection = (resetLiveToConnecting: boolean): void => {
    generation++
    if (es) {
      if (onStatusHandler) es.removeEventListener('status', onStatusHandler)
      if (onErrorHandler) es.removeEventListener('error', onErrorHandler)
      try {
        es.close()
      } catch {
        // ignore close errors
      }
      es = null
      onStatusHandler = null
      onErrorHandler = null
    }
    if (resetLiveToConnecting && !disposed && state.stream === 'live') {
      // Never show a stale snapshot as live after closing SSE during idle grace teardown.
      commit({ ...state, stream: 'connecting' })
    }
  }

  const ensureConnected = (): void => {
    if (disposed) return
    if (closeTimer !== null) {
      clearTimer(closeTimer)
      closeTimer = null
    }

    if (!es) {
      const gen = ++generation
      const created = createEventSource('/plugins/agy-acp/events')
      if (created) {
        es = created
        onStatusHandler = (ev: MessageEvent<string>): void => {
          if (disposed || gen !== generation) return
          try {
            const parsed: unknown = JSON.parse(ev.data)
            if (isValidSnapshot(parsed)) {
              dispatch({ type: 'sse', value: parsed })
            }
          } catch {
            // ignore malformed frame
          }
        }
        onErrorHandler = (): void => {
          if (disposed || gen !== generation) return
          dispatch({ type: 'disconnect' })
        }
        created.addEventListener('status', onStatusHandler)
        created.addEventListener('error', onErrorHandler)
      }
    }

    if (!state.status && !inFlightFetch) {
      const gen = generation
      inFlightFetch = true
      void fetchStatus()
        .then((snap) => {
          inFlightFetch = false
          if (disposed || gen !== generation) return
          dispatch(snap ? { type: 'initial', value: snap } : { type: 'readFailed' })
        })
        .catch(() => {
          inFlightFetch = false
          if (disposed || gen !== generation) return
          dispatch({ type: 'readFailed' })
        })
    }
  }

  return {
    getSnapshot(): SnapshotState {
      return state
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      ensureConnected()
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
        if (listeners.size === 0 && closeTimer === null && !disposed) {
          closeTimer = setTimer(() => {
            closeTimer = null
            if (listeners.size === 0) {
              closeConnection(true)
            }
          }, closeGraceMs)
        }
      }
    },
    applyStatus(next: StatusSnapshot): void {
      if (isValidSnapshot(next)) {
        dispatch({ type: 'action', value: next })
      }
    },
    dispose(): void {
      disposed = true
      if (closeTimer !== null) {
        clearTimer(closeTimer)
        closeTimer = null
      }
      closeConnection(false)
      listeners.clear()
    },
  }
}

let sharedStore: StatusStore | null = null

export function getSharedStatusStore(): StatusStore {
  if (!sharedStore) {
    sharedStore = createStatusStore()
  }
  return sharedStore
}
