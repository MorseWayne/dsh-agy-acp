import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  PermissionOption,
  RequestPermissionParams,
  RequestPermissionResult,
} from '../acp/protocol.ts'
import type { PendingPermission, PermissionMode } from '../common/types.ts'

interface PendingEntry {
  info: PendingPermission
  resolve: (result: RequestPermissionResult) => void
  timer?: ReturnType<typeof setTimeout>
}

export interface PermissionManagerOptions {
  getMode: () => PermissionMode
  /** Auto-cancel unanswered interactive prompts after this many ms (default: 5 min). */
  timeoutMs?: number
  log?: (msg: string) => void
}

const MUTATING_KINDS = new Set(['execute', 'edit', 'delete', 'move'])
const AUTO_ALLOW_IN_ACCEPT_EDITS = new Set(['read', 'search', 'edit', 'fetch'])

function pickOption(options: readonly PermissionOption[], match: 'allow' | 'reject'): PermissionOption | undefined {
  if (match === 'allow') {
    return (
      options.find((o) => o.kind === 'allow_once') ??
      options.find((o) => o.kind.includes('allow'))
    )
  }
  return (
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind.includes('reject'))
  )
}

/**
 * Interactive ACP permission approval manager.
 * - Honors `skip`, `plan`, `accept-edits`, and `default` permission modes.
 * - Suspends `session/request_permission` RPCs until decided via UI/API (SSE push).
 * - Remembers per-session `allow_always` / `reject_always` choices.
 */
export class PermissionManager extends EventEmitter {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly sessionRules = new Map<string, Map<string, 'allow' | 'reject'>>()
  private readonly timeoutMs: number

  constructor(private readonly opts: PermissionManagerOptions) {
    super()
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000
  }

  listPending(): PendingPermission[] {
    return Array.from(this.pending.values(), (e) => e.info)
  }

  async handleRequest(req: RequestPermissionParams): Promise<RequestPermissionResult> {
    const mode = this.opts.getMode()
    const toolName = req.toolCall.name ?? 'tool'
    const kind = req.toolCall.kind ?? 'other'
    const allowOpt = pickOption(req.options, 'allow')
    const rejectOpt = pickOption(req.options, 'reject')

    // 1. `skip` mode auto-approves everything
    if (mode === 'skip') {
      return allowOpt
        ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }

    // 2. `plan` mode denies mutating/executing tools, allows read-only
    if (mode === 'plan') {
      if (MUTATING_KINDS.has(kind)) {
        return rejectOpt
          ? { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      }
      return allowOpt
        ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }

    // 3. Session-scoped remembered rule (`allow_always` / `reject_always`)
    const remembered = this.sessionRules.get(req.sessionId)?.get(toolName)
    if (remembered === 'allow' && allowOpt) {
      return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
    }
    if (remembered === 'reject') {
      return rejectOpt
        ? { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }

    // 4. `accept-edits` auto-approves non-destructive reads/searches/edits, asks for shell execution
    if (mode === 'accept-edits' && AUTO_ALLOW_IN_ACCEPT_EDITS.has(kind)) {
      return allowOpt
        ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }

    // 5. Suspend and broadcast to SSE clients for interactive approval
    const requestId = randomUUID().slice(0, 12)
    const info: PendingPermission = {
      requestId,
      sessionId: req.sessionId,
      toolCallId: req.toolCall.toolCallId,
      toolName,
      ...(req.toolCall.title ? { title: req.toolCall.title } : {}),
      ...(req.toolCall.kind ? { kind: req.toolCall.kind } : {}),
      ...(req.toolCall.rawInput !== undefined ? { rawInput: req.toolCall.rawInput } : {}),
      options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      createdAt: Date.now(),
    }

    this.opts.log?.(`awaiting interactive permission (${requestId}): ${toolName}`)

    return new Promise<RequestPermissionResult>((resolve) => {
      const entry: PendingEntry = { info, resolve }
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(requestId)) return
          this.pending.delete(requestId)
          this.opts.log?.(`permission request ${requestId} timed out, cancelling`)
          this.emit('change')
          resolve({ outcome: { outcome: 'cancelled' } })
        }, this.timeoutMs)
        entry.timer.unref?.()
      }
      this.pending.set(requestId, entry)
      this.emit('change')
    })
  }

  decide(requestId: string, decision: { optionId?: string; cancel?: boolean }): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(requestId)

    if (decision.cancel || !decision.optionId) {
      this.emit('change')
      entry.resolve({ outcome: { outcome: 'cancelled' } })
      return true
    }

    const chosen = entry.info.options.find((o) => o.optionId === decision.optionId)
    if (chosen && (chosen.kind === 'allow_always' || chosen.kind === 'reject_always')) {
      let rules = this.sessionRules.get(entry.info.sessionId)
      if (!rules) {
        rules = new Map()
        this.sessionRules.set(entry.info.sessionId, rules)
      }
      rules.set(entry.info.toolName, chosen.kind === 'allow_always' ? 'allow' : 'reject')
    }

    this.emit('change')
    entry.resolve({ outcome: { outcome: 'selected', optionId: decision.optionId } })
    return true
  }

  clearSessionRules(sessionId?: string): void {
    if (sessionId) {
      this.sessionRules.delete(sessionId)
    } else {
      this.sessionRules.clear()
    }
  }

  dispose(): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.sessionRules.clear()
    this.removeAllListeners()
  }
}
