import path from 'node:path'
import type { RequestPermissionParams, RequestPermissionResult } from '../acp/protocol.ts'

export interface FilePolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
  additionalWritableRoots?: readonly string[]
  sessionId: string
}
export interface SessionPolicy extends FilePolicy {
  preset: string
  approval: 'ask' | 'never'
}

/** Only exact, single-use grants are safe: a later request may see a different DSH policy. */
export const cancelled = (): RequestPermissionResult => ({ outcome: { outcome: 'cancelled' } })

export function policyKey(policy: SessionPolicy): string {
  return JSON.stringify([policy.sessionId, policy.mode, policy.workspaceRoot, policy.additionalWritableRoots ?? [], policy.preset, policy.approval])
}

function disposition(p: SessionPolicy, req: RequestPermissionParams): 'allow' | 'ask' | 'deny' {
  const kind = req.toolCall.kind
  if (p.preset === 'auto') return 'ask' // native ACP calls do not pass through tools/pre-execute
  if (kind === 'read' || kind === 'search') return 'allow'
  if (p.mode === 'read-only') return 'deny'
  if (p.mode === 'danger-full-access' && p.preset === 'danger-full-access' && p.approval === 'never') return 'allow'
  if (p.mode === 'workspace-write' && p.preset === 'workspace-write' && kind === 'edit') {
    const roots = [p.workspaceRoot, ...(p.additionalWritableRoots ?? [])]
    const locations = req.toolCall.locations
    if (Array.isArray(locations) && locations.length && locations.every(l => typeof l?.path === 'string' && l.path && roots.some(root => {
      const rel = path.relative(root, path.resolve(p.workspaceRoot, l.path))
      return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
    }))) return 'allow' // the process sandbox, not this classification, enforces actual writes
  }
  return 'ask'
}

export async function decidePermission(req: RequestPermissionParams, readPolicy: () => SessionPolicy,
  ask: (reason: string) => Promise<string>, signal: AbortSignal): Promise<RequestPermissionResult> {
  try {
    const p = readPolicy()
    const allow = req.options.find(o => o.kind === 'allow_once')
    const reject = req.options.find(o => o.kind === 'reject_once')
    const denied = (): RequestPermissionResult => reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelled()
    if (signal.aborted || !allow) return denied()
    const action = disposition(p, req)
    if (action === 'deny') return denied()
    if (action === 'ask') {
      if (p.approval !== 'ask') return denied()
      const details = JSON.stringify({ title: req.toolCall.title, kind: req.toolCall.kind, input: req.toolCall.rawInput ?? req.toolCall.args, locations: req.toolCall.locations })
      // Never approve an operation from a misleading truncated preview.
      if (details.length > 8192 || await ask(`Antigravity 请求执行 ${req.toolCall.name ?? '工具'}：${details}`) !== 'allowed-once') return denied()
    }
    return !signal.aborted && policyKey(readPolicy()) === policyKey(p)
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : denied()
  } catch { return cancelled() }
}
