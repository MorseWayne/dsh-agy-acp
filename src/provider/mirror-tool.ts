import { MIRROR_TOOL_NAME } from '../common/types.ts'
import type { AcpToolCallUpdate } from '../acp/protocol.ts'
import type { AcpRunStore } from './run-store.ts'

export interface MirrorToolInput {
  run: string
  step: number
  tool?: string
  input?: unknown
}

function formatToolOutput(update: AcpToolCallUpdate): string {
  if (Array.isArray(update.content) && update.content.length > 0) {
    const texts = update.content
      .map((c) => c.content?.text)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (texts.length > 0) return texts.join('\n')
  }
  if (update.rawOutput !== undefined) {
    if (typeof update.rawOutput === 'string') return update.rawOutput
    if (typeof update.rawOutput === 'object' && update.rawOutput !== null && 'output' in update.rawOutput) {
      const out = (update.rawOutput as { output?: unknown }).output
      if (typeof out === 'string') return out
    }
    try {
      return JSON.stringify(update.rawOutput, null, 2)
    } catch {
      return String(update.rawOutput)
    }
  }
  return '(no output)'
}

/**
 * Defines the synthetic DSH mirror tool (`agy_acp_tool`).
 * It replays the already-executed ACP tool output back into DSH's session log
 * so DSH renders native tool cards without re-executing anything.
 */
export function defineAgyAcpMirrorTool(runs: AcpRunStore) {
  return {
    name: MIRROR_TOOL_NAME,
    description: 'Internal mirror that replays completed Antigravity ACP tool steps into DSH native tool cards.',
    parameters: {
      type: 'object',
      properties: {
        run: { type: 'string' },
        step: { type: 'number' },
        tool: { type: 'string' },
        input: {},
      },
      required: ['run', 'step'],
    },
    async execute(args: MirrorToolInput): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      const rec = runs.get(args.run)
      const update = rec?.toolResults.get(args.step)
      if (!update) {
        return {
          content: [{ type: 'text', text: `[agy_acp_tool] recorded tool result unavailable (run=${args.run}, step=${args.step})` }],
          isError: false,
        }
      }
      return {
        content: [{ type: 'text', text: formatToolOutput(update) }],
        isError: update.status === 'failed',
      }
    },
  }
}
