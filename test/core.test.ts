import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/common/config.ts'
import {
  defineAgyAcpMirrorTool,
  presentMirrorCall,
  presentMirrorResult,
} from '../src/provider/mirror-tool.ts'
import { buildPromptBlocks } from '../src/provider/prompt-builder.ts'
import { AcpRunStore, decodeMirrorCallId, encodeMirrorCallId } from '../src/provider/run-store.ts'

test('resolveConfig applies defaults and parses env-style strings', () => {
  const cfg = resolveConfig({ enabled: 'false', permissionMode: 'plan', mcpBridge: '1' })
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.permissionMode, 'plan')
  assert.equal(cfg.mcpBridge, true)

  const fallback = resolveConfig({ permissionMode: 'invalid-mode' })
  assert.equal(fallback.enabled, true)
  assert.equal(fallback.permissionMode, 'accept-edits')
})

test('encodeMirrorCallId / decodeMirrorCallId round-trip', () => {
  const id = encodeMirrorCallId('abc123', 7)
  assert.deepEqual(decodeMirrorCallId(id), { runId: 'abc123', itemIndex: 7 })
  assert.equal(decodeMirrorCallId('other:1:2'), null)
})

test('buildPromptBlocks sends digest only on first turn and trailing user text on follow-ups', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] } as Message,
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } as Message,
    { role: 'user', content: [{ type: 'text', text: 'second question' }] } as Message,
  ]

  const first = buildPromptBlocks(messages, true)
  assert.equal(first.length, 2)
  assert.equal(first[0]?.type, 'text')
  assert.match((first[0] as { text: string }).text, /prior_conversation_digest/)
  assert.equal((first[1] as { text: string }).text, 'second question')

  const followUp = buildPromptBlocks(messages, false)
  assert.equal(followUp.length, 1)
  assert.equal((followUp[0] as { text: string }).text, 'second question')
})

test('AcpRunStore + mirror tool replay recorded ACP tool output with canonical output & meta', async () => {
  const store = new AcpRunStore()
  const rec = store.create()
  const idx = rec.pushUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    name: 'run_command',
    kind: 'execute',
    title: 'Print hi',
    status: 'completed',
    rawInput: { CommandLine: 'echo hi', Cwd: '/workspace' },
    rawOutput: { output: 'hi\n', exit_code: 0 },
    content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
  })

  const mirror = defineAgyAcpMirrorTool(store)
  const args = {
    run: rec.id,
    step: idx,
    tool: 'run_command',
    title: 'Print hi',
    kind: 'execute',
    input: { CommandLine: 'echo hi', Cwd: '/workspace' },
  }
  const value = (await mirror.execute(args, {} as ToolRunContext)) as {
    output: string
    isError: boolean
    exitCode?: number
  }
  assert.equal(value.isError, false)
  assert.equal(value.output, 'hi\n')
  assert.equal(value.exitCode, 0)

  const rendered = mirror.output.render(args, value as never)
  assert.deepEqual(rendered, [{ type: 'text', text: 'hi\n' }])

  const meta = mirror.output.presentationMeta?.(args, value as never)
  assert.deepEqual(mirror.presentCall?.(args), {
    card: 'terminal',
    title: 'echo hi',
    description: 'Print hi',
    cwd: '/workspace',
  })
  assert.deepEqual(mirror.presentResult?.(args, { content: rendered, isError: false, meta }), {
    card: 'terminal',
    title: 'echo hi',
    output: 'hi\n',
    exitCode: 0,
  })
})

test('presentMirrorCall / presentMirrorResult project diff and generic cards accurately', () => {
  const editArgs = {
    run: 'r1',
    step: 2,
    tool: 'edit_file',
    input: {
      Path: 'src/app.ts',
      Target: 'const a = 1',
      Replacement: 'const a = 2',
    },
  }
  assert.deepEqual(presentMirrorCall(editArgs), {
    card: 'diff',
    title: 'Edit src/app.ts',
    diffs: [{ path: 'src/app.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    locations: [{ path: 'src/app.ts' }],
  })
  assert.deepEqual(
    presentMirrorResult(editArgs, {
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
    {
      card: 'diff',
      title: 'Edit src/app.ts',
      diffs: [{ path: 'src/app.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    },
  )

  const readArgs = {
    run: 'r1',
    step: 3,
    tool: 'read_file',
    input: { Path: 'README.md', StartLine: 10 },
  }
  assert.deepEqual(presentMirrorCall(readArgs), {
    card: 'generic',
    title: 'Read README.md:10',
    kind: 'read',
    rawInput: { Path: 'README.md', StartLine: 10 },
    locations: [{ path: 'README.md', line: 10 }],
  })
})
