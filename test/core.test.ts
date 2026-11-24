import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/common/config.ts'
import { defineAgyAcpMirrorTool } from '../src/provider/mirror-tool.ts'
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

test('AcpRunStore + mirror tool replay recorded ACP tool output', async () => {
  const store = new AcpRunStore()
  const rec = store.create()
  const idx = rec.pushUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    name: 'run_command',
    status: 'completed',
    rawInput: { CommandLine: 'echo hi' },
    rawOutput: { output: 'hi\n', exit_code: 0 },
    content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
  })

  const mirror = defineAgyAcpMirrorTool(store)
  const res = await mirror.execute({ run: rec.id, step: idx, tool: 'run_command' })
  assert.equal(res.isError, false)
  assert.equal(res.content[0]?.text, 'hi\n')
})
