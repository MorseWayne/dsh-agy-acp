import { fakeHost } from './fixtures/session-policy.ts'
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { defineAgyAcpMirrorTool } from '../src/provider/mirror-tool.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGY_BIN = path.join(__dirname, 'fixtures', 'fake-agy.mjs')
chmodSync(FAKE_AGY_BIN, 0o755)

async function collectChunks(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const c of iterable) {
    chunks.push(c)
  }
  return chunks
}

function createHarness() {
  const cfg = resolveConfig({
    enabled: true,
    requestTimeoutMs: 10_000,
  })
  const permissionLog: string[] = []
  const runs = new AcpRunStore()
  const pool = new AcpSessionPool({
    ...fakeHost,
    getConfig: () => cfg,
    resolveBin: () => FAKE_AGY_BIN,
    onPermission: async (req) => {
      permissionLog.push(req.toolCall.name ?? 'unknown')
      const allow = req.options.find((o) => o.kind === 'allow_once')
      return allow
        ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    },
  })
  const adapter = new AcpAdapter({
    getConfig: () => cfg,
    pool,
    runs,
  })
  const mirrorTool = defineAgyAcpMirrorTool(runs)
  return { adapter, pool, runs, mirrorTool, permissionLog }
}

test('AcpAdapter.stream() reuses persistent ACP session across multi-turn conversation', async () => {
  const { adapter, pool } = createHarness()
  try {
    const turn1 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello turn 1' }] } as Message],
        sessionId: 'dsh-conv-1',
      } as GenerateOptions),
    )

    const text1 = turn1
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text1, '[sess_1#1] hello turn 1')
    assert.equal(pool.getStatus().activeSessions, 1)

    const turn2 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello turn 1' }] } as Message,
          { role: 'assistant', content: [{ type: 'text', text: text1 }] } as Message,
          { role: 'user', content: [{ type: 'text', text: 'follow up turn 2' }] } as Message,
        ],
        sessionId: 'dsh-conv-1',
      } as GenerateOptions),
    )

    const text2 = turn2
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text2, '[sess_1#2] follow up turn 2')
    assert.equal(pool.getStatus().activeSessions, 1)

    const usageChunk = turn2.find((c) => c.type === 'usage')
    assert.ok(usageChunk && usageChunk.type === 'usage')
    assert.equal(usageChunk.usage.inputTokens, 200) // 500 - 300 cachedReadTokens
    assert.equal(usageChunk.usage.cacheReadTokens, 300)
  } finally {
    pool.dispose()
  }
})

test('AcpAdapter.stream() splits span on tool call, replays via agy_acp_tool, and resumes to completion', async () => {
  const { adapter, pool, mirrorTool, permissionLog } = createHarness()
  try {
    const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }

    // Span 1: triggers tool execution + permission callback -> finishes with tool-calls
    const span1 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'please USE_TOOL now' }] } as Message],
        sessionId: 'dsh-tool-conv',
      } as unknown as GenerateOptions),
    )

    assert.deepEqual(permissionLog, ['run_command'])

    const reasoning1 = span1
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(reasoning1, 'Let me run a command.')

    const text1 = span1
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text1, 'Running check...')

    const toolBlockEnd = span1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.ok(toolBlockEnd && toolBlockEnd.type === 'block-end' && toolBlockEnd.block.type === 'tool-call')
    assert.equal(toolBlockEnd.block.name, MIRROR_TOOL_NAME)

    const finish1 = span1.find((c) => c.type === 'finish')
    assert.ok(finish1 && finish1.type === 'finish')
    assert.equal(finish1.reason.kind, 'tool-calls')

    // DSH executes the mirror tool & presents native terminal card
    const parsedArgs = JSON.parse(toolBlockEnd.block.arguments) as Record<string, unknown>
    const callView = mirrorTool.presentCall?.(parsedArgs)
    assert.deepEqual(callView, {
      card: 'terminal',
      title: 'echo hello',
      description: 'Run echo',
      cwd: '/tmp',
    })

    await assert.rejects(mirrorTool.execute(parsedArgs, {} as ToolRunContext), /another DSH session/)
    const value = (await mirrorTool.execute(parsedArgs, { agent: { session: { id: 'dsh-tool-conv' } } } as ToolRunContext)) as Record<string, unknown>
    const rendered = mirrorTool.output.render(parsedArgs, value as never)
    const meta = mirrorTool.output.presentationMeta?.(parsedArgs, value as never)
    const resultView = mirrorTool.presentResult?.(parsedArgs, {
      content: rendered,
      isError: false,
      meta,
    })
    assert.deepEqual(resultView, {
      card: 'terminal',
      title: 'echo hello',
      output: 'hello\n',
      exitCode: 0,
    })

    // Span 2: DSH feeds tool-result back -> adapter resumes recording and emits final text + usage
    const span2 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'please USE_TOOL now' }] } as Message,
          { role: 'assistant', content: [toolBlockEnd.block] } as Message,
          {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: toolBlockEnd.block.id,
                content: rendered,
                isError: false,
              },
            ],
          } as Message,
        ],
        sessionId: 'dsh-tool-conv',
      } as unknown as GenerateOptions),
    )

    const text2 = span2
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text2, 'Command succeeded with hello.')

    const usage2 = span2.find((c) => c.type === 'usage')
    assert.ok(usage2 && usage2.type === 'usage')
    assert.equal(usage2.usage.inputTokens, 600) // 1000 - 400
    assert.equal(usage2.usage.cacheReadTokens, 400)
    assert.equal(usage2.usage.reasoningTokens, 120)

    const finish2 = span2.find((c) => c.type === 'finish')
    assert.ok(finish2 && finish2.type === 'finish')
    assert.equal(finish2.reason.kind, 'stop')
  } finally {
    pool.dispose()
  }
})

test('AcpAdapter.stream() propagates AbortSignal to session/cancel and finishes as aborted', async () => {
  const { adapter, pool } = createHarness()
  try {
    const ac = new AbortController()
    const chunks: StreamChunk[] = []

    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'SLOW_CANCEL test' }] } as Message],
      sessionId: 'dsh-cancel-conv',
      signal: ac.signal,
    } as GenerateOptions)) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') {
        ac.abort()
      }
    }

    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text, 'working...')

    const finish = chunks.find((c) => c.type === 'finish')
    assert.ok(finish && finish.type === 'finish')
    assert.equal(finish.reason.kind, 'aborted')

    // Ensure the underlying session remains usable after cancellation
    const followUp = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'after cancel' }] } as Message],
        sessionId: 'dsh-cancel-conv',
      } as GenerateOptions),
    )
    const followText = followUp
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(followText, '[sess_1#2] after cancel')
  } finally {
    pool.dispose()
  }
})
