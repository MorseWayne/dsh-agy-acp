import type { RequestPermissionParams } from '../acp/protocol.ts'
import { decidePermission, type FilePolicy, type SessionPolicy } from './permission-manager.ts'

// Structural service contracts keep the bundle independent of the host package copies.
export interface SessionAgent { session: { id: string } }
interface PermissionHost {
  agents: { get(id: string): SessionAgent | undefined }
  sandboxPolicy: { resolve(r: { session: SessionAgent['session'] }): FilePolicy }
  permissionPresets: { current(session: SessionAgent['session']): string }
  approval: {
    overrideOf(session: SessionAgent['session']): string | undefined
    config: { policy?: string }
    request(r: { agent: SessionAgent; toolName: string; reason: string; signal: AbortSignal }): Promise<string>
  }
  sandbox?: { confine(argv: readonly string[], policy: FilePolicy, signal?: AbortSignal): Promise<{ argv: string[]; enforcement: string }> }
}
export interface QuestionService {
  ask(request: { agent: SessionAgent; signal: AbortSignal; questions: Array<{ id: string; question: string; options: Array<{ label: string }> }> }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}
export function hostPermissions(host: PermissionHost, questions?: () => QuestionService | undefined) {
  function agent(key: string): SessionAgent {
    const owner = host.agents.get(key)
    if (!owner || owner.session.id !== key) throw new Error('No live DSH session owns this Antigravity call')
    return owner
  }
  function readPolicy(key: string): SessionPolicy {
    const { session } = agent(key)
    const file = host.sandboxPolicy.resolve({ session })
    const approval = host.approval.overrideOf(session) ?? host.approval.config.policy
    const preset = host.permissionPresets.current(session)
    if (!preset || file.sessionId !== key || !['read-only', 'workspace-write', 'danger-full-access'].includes(file.mode) || (approval !== 'ask' && approval !== 'never')) throw new Error('Incomplete DSH session policy; refusing ACP execution')
    return { ...file, approval, preset }
  }
  return { agent, readPolicy,
    async prepareArgv(argv: string[], file: FilePolicy, signal?: AbortSignal) {
      if (file.mode === 'danger-full-access') return argv
      const confined = await host.sandbox?.confine(argv, file, signal)
      if (!confined?.argv.length || confined.enforcement !== 'full') throw new Error(`Cannot enforce DSH ${file.mode} for Antigravity; refusing unconfined startup`)
      return confined.argv
    },
    onPermission(req: RequestPermissionParams, key: string, signal: AbortSignal, launchPolicy?: SessionPolicy) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
      return decidePermission(req, () => readPolicy(key), reason => host.approval.request({
        agent: agent(key), toolName: `agy:${req.toolCall.name ?? req.toolCall.kind ?? 'tool'}`, reason, signal: deadline,
      }), deadline, launchPolicy, async ({toolCall, options}) => {
        const owner = agent(key)
        const id = toolCall.toolCallId
        const labels = options.map((o, i) => `${i + 1}. ${(o.name?.trim() || o.optionId).slice(0, 240)}`)
        const reply = await questions?.()?.ask({ agent: owner, signal: deadline, questions: [{
          id, question: toolCall.title?.trim().slice(0, 2000) || '请选择一项',
          options: labels.map(label => ({ label })),
        }] })
        const answer = reply?.answers[0]
        if (!answer || reply?.answers.length !== 1 || answer.id !== id || answer.custom ||
            answer.selected.length !== 1 || owner !== agent(key)) return undefined
        return options[labels.indexOf(answer.selected[0]!)]?.optionId
      })
    },
  }
}
