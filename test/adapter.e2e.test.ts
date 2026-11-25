import { fakeHost } from './fixtures/session-policy.ts'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID, WRAPPER_TOOL_NAME } from '../src/common/types.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { defineAgyAcpMirrorTool } from '../src/provider/mirror-tool.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { MultiAccountPool } from '../src/runtime/account-pool.ts'
import { EgressGuard } from '../src/runtime/egress-guard.ts'
import { SessionIndex } from '../src/runtime/session-index.ts'
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
  return { adapter, pool, cfg, runs, mirrorTool, permissionLog }
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

async function assertMirrorContinuation(format: 'legacy' | 'tool role' | 'runtime-context' | 'time-context') {
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
    assert.equal(span1.some(c => c.type === 'usage'), false)
    const observed = pool.getStatus().sessions[0]!
    assert.equal(observed.contextUsed, 320)
    assert.equal(observed.contextSize, 65536)
    assert.equal((await adapter.resolveModel(PROVIDER_ID, 'gemini-4-neon')).context?.contextWindow, 65536)

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

    // Span 2: echo the result in the host's format; keep the same ACP prompt alive.
    const result = { toolCallId: toolBlockEnd.block.id, content: rendered, isError: false }
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'please USE_TOOL now' }] },
      { role: 'assistant', content: [toolBlockEnd.block] },
      format === 'legacy'
        ? { role: 'user', content: [{ type: 'tool-result', ...result }] }
        : { role: 'tool', source: { kind: 'tool' }, ...result },
    ]
    const continuationMessages = format === 'runtime-context' || format === 'time-context'
      ? [...history, { role: 'user', content: [{ type: 'text', text: 'Updated host context' }], source: { kind: format } }]
      : history
    const span2 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: continuationMessages,
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
    assert.equal(usage2.usage.inputTokens, 500) // 1000 - 400 read - 100 write
    assert.equal(usage2.usage.cacheWriteTokens, 100)
    assert.equal(pool.getStatus().usageTotals.inputTokens, 500)
    assert.equal(pool.getStatus().usageTotals.cachedWriteTokens, 100)
    assert.equal(usage2.usage.cacheReadTokens, 400)
    assert.equal(usage2.usage.reasoningTokens, 120)

    const followUp = await collectChunks(adapter.stream({ provider: PROVIDER_ID, model: 'claude-sonnet-5-5', sessionId: 'dsh-tool-conv',
      messages: [...history, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'switch model' }] }],
    } as unknown as GenerateOptions))
    assert.equal(followUp.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '[sess_1#2] switch model')
    assert.equal(pool.getStatus().sessions[0]?.contextUsed, null)
    assert.equal(pool.getStatus().sessions[0]?.contextSize, 0)
    const nextModel = await adapter.resolveModel(PROVIDER_ID, 'claude-sonnet-5-5')
    assert.notEqual(nextModel.context?.contextWindow, 65536)
    assert.equal(nextModel.reasoning?.defaultEffort, 'medium') // returned on model switch, not guessed at session/new

    const finish2 = span2.find((c) => c.type === 'finish')
    assert.ok(finish2 && finish2.type === 'finish')
    assert.equal(finish2.reason.kind, 'stop')
  } finally {
    pool.dispose()
  }
}

for (const format of ['legacy', 'tool role', 'runtime-context', 'time-context'] as const) {
  test(`AcpAdapter.stream() resumes the original ACP prompt after a ${format} mirror result`, () => assertMirrorContinuation(format))
}

test('resolved reasoning defaults match persistent ACP selection after returning to Default', async () => {
  const { adapter, pool, cfg } = createHarness()
  const model = 'gemini-4-neon'
  const resolve = async () => (await adapter.resolveModel(PROVIDER_ID, model)).reasoning
  const turn = (effort?: string) => collectChunks(adapter.stream({ provider: PROVIDER_ID, model,
    reasoningEffort: effort, sessionId: 'reasoning', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  } as GenerateOptions))
  try {
    const listed = (await adapter.listModels(PROVIDER_ID)).map(m => m.id)
    assert.deepEqual(listed, ['gemini-4-neon', 'claude-sonnet-5-5'])
    assert.deepEqual(pool.getStatus().models.map(m => m.value), listed)
    assert.deepEqual((await resolve())?.efforts.map(e => e.id), ['low', 'medium', 'high'])
    assert.equal((await resolve())?.defaultEffort, 'medium')
    cfg.defaultEffort = 'invalid'
    assert.equal((await resolve())?.defaultEffort, 'medium')
    cfg.defaultEffort = 'high'
    assert.equal((await resolve())?.defaultEffort, 'high')
    assert.equal((await adapter.resolveModel(PROVIDER_ID, `${model}-low`)).reasoning?.defaultEffort, 'low')
    await turn('low')
    assert.equal(pool.getStatus().sessions[0]?.currentEffort, 'low')
    await turn()
    assert.equal(pool.getStatus().sessions[0]?.currentEffort, 'high')
    assert.equal(pool.getStatus().sessions[0]?.contextUsed, null) // billing alone is not occupancy
  } finally { pool.dispose() }
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

test('AcpAdapter.stream() emits live pending tool card immediately, merges incremental completion, and resumes', async () => {
  const { adapter, pool, mirrorTool } = createHarness()
  const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  try {
    const t0 = Date.now()
    const span1 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'run LIVE_TOOL_INCREMENTAL' }] } as Message],
        sessionId: 'dsh-live-tool',
      } as unknown as GenerateOptions),
    )
    const toolBlockEnd = span1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.ok(toolBlockEnd && toolBlockEnd.type === 'block-end' && toolBlockEnd.block.type === 'tool-call')
    const parsedArgs = JSON.parse(toolBlockEnd.block.arguments) as Record<string, unknown>
    assert.equal(parsedArgs.toolCallId, 'tc_live')
    assert.deepEqual(mirrorTool.presentCall?.(parsedArgs), {
      card: 'terminal',
      title: 'echo live',
      description: 'Run live echo',
      cwd: '/tmp',
    })

    // mirrorTool.execute awaits the delayed completion frame (which omits name/rawInput)
    const value = (await mirrorTool.execute(parsedArgs, { agent: { session: { id: 'dsh-live-tool' } } } as ToolRunContext)) as Record<string, unknown>
    assert.ok(Date.now() - t0 >= 60)
    const rendered = mirrorTool.output.render(parsedArgs, value as never)
    const meta = mirrorTool.output.presentationMeta?.(parsedArgs, value as never)
    assert.deepEqual(mirrorTool.presentResult?.(parsedArgs, { content: rendered, isError: false, meta }), {
      card: 'terminal',
      title: 'echo live',
      output: 'live ok\n',
      exitCode: 0,
    })

    const span2 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'run LIVE_TOOL_INCREMENTAL' }] },
          { role: 'assistant', content: [toolBlockEnd.block] },
          { role: 'tool', toolCallId: toolBlockEnd.block.id, content: rendered, isError: false },
        ],
        sessionId: 'dsh-live-tool',
      } as unknown as GenerateOptions),
    )
    assert.equal(span2.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Live tool finished.')
  } finally {
    pool.dispose()
  }
})

test('empty placeholder in_progress tool emits immediately and upgrades via presentationMeta on completion', async () => {
  const { adapter, pool, mirrorTool } = createHarness()
  const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  try {
    const span1 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'EMPTY_PLACEHOLDER_TOOL' }] } as Message],
        sessionId: 'dsh-empty-tool',
      } as unknown as GenerateOptions),
    )
    const toolBlockEnd = span1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.ok(toolBlockEnd && toolBlockEnd.type === 'block-end' && toolBlockEnd.block.type === 'tool-call')
    const parsedArgs = JSON.parse(toolBlockEnd.block.arguments) as Record<string, unknown>
    assert.equal(mirrorTool.presentCall?.(parsedArgs)?.card, 'generic')

    const value = (await mirrorTool.execute(parsedArgs, { agent: { session: { id: 'dsh-empty-tool' } } } as ToolRunContext)) as Record<string, unknown>
    const rendered = mirrorTool.output.render(parsedArgs, value as never)
    const meta = mirrorTool.output.presentationMeta?.(parsedArgs, value as never)
    assert.deepEqual(mirrorTool.presentResult?.(parsedArgs, { content: rendered, isError: false, meta }), {
      card: 'terminal',
      title: 'echo late',
      output: 'late\n',
      exitCode: 0,
    })
  } finally {
    pool.dispose()
  }
})

test('aborting exec.signal during live mirrorTool.execute cancels the underlying ACP turn', async () => {
  const { adapter, pool, mirrorTool } = createHarness()
  const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  try {
    const span1 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'SLOW_TOOL_CANCEL' }] } as Message],
        sessionId: 'dsh-tool-abort',
      } as unknown as GenerateOptions),
    )
    const toolBlockEnd = span1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.ok(toolBlockEnd && toolBlockEnd.type === 'block-end' && toolBlockEnd.block.type === 'tool-call')
    const parsedArgs = JSON.parse(toolBlockEnd.block.arguments) as Record<string, unknown>

    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const value = (await mirrorTool.execute(parsedArgs, {
      agent: { session: { id: 'dsh-tool-abort' } },
      signal: ac.signal,
    } as ToolRunContext)) as { output: string; isError: boolean }
    assert.equal(value.isError, true)
    assert.match(value.output, /aborted/i)

    // Wait briefly for cancelled turn to settle, then verify session remains usable
    await new Promise(r => setTimeout(r, 30))
    const follow = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping after abort' }] } as Message],
        sessionId: 'dsh-tool-abort',
      } as GenerateOptions),
    )
    assert.equal(follow.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '[sess_1#2] ping after abort')
  } finally {
    pool.dispose()
  }
})

test('parallel tool calls with out-of-order completion resume cleanly without duplicates and Code Mode retains input', async () => {
  const { adapter, pool, mirrorTool } = createHarness()
  const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  const codeSchema = { name: WRAPPER_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  try {
    const span1 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [mirrorSchema],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PARALLEL_TOOLS' }] } as Message],
        sessionId: 'dsh-parallel',
      } as unknown as GenerateOptions),
    )
    const toolBlocks = span1
      .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
      .map(c => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
    assert.ok(toolBlocks.length >= 1)

    // Execute every emitted tool call concurrently and feed results back in reverse order
    const results = await Promise.all(
      toolBlocks.map(async (b) => {
        const args = JSON.parse(b.arguments) as Record<string, unknown>
        const value = await mirrorTool.execute(args, { agent: { session: { id: 'dsh-parallel' } } } as ToolRunContext)
        return {
          role: 'tool',
          toolCallId: b.id,
          content: mirrorTool.output.render(args, value as never),
          isError: false,
        }
      }),
    )

    let messages: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: 'PARALLEL_TOOLS' }] },
      { role: 'assistant', content: toolBlocks },
      ...results.reverse(),
    ]
    let finalText = ''
    const seenToolCallIds = new Set(toolBlocks.map(b => (JSON.parse(b.arguments) as { toolCallId?: string }).toolCallId))

    for (let hop = 0; hop < 3; hop++) {
      const nextSpan = await collectChunks(
        adapter.stream({
          provider: PROVIDER_ID,
          model: 'gemini-4-neon',
          tools: [mirrorSchema],
          messages,
          sessionId: 'dsh-parallel',
        } as unknown as GenerateOptions),
      )
      finalText += nextSpan.filter(c => c.type === 'text-delta').map(c => c.text).join('')
      const moreTools = nextSpan
        .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
        .map(c => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
      if (moreTools.length === 0) break
      const moreResults = await Promise.all(
        moreTools.map(async (b) => {
          const args = JSON.parse(b.arguments) as Record<string, unknown>
          assert.equal(seenToolCallIds.has(args.toolCallId as string), false)
          seenToolCallIds.add(args.toolCallId as string)
          const value = await mirrorTool.execute(args, { agent: { session: { id: 'dsh-parallel' } } } as ToolRunContext)
          return { role: 'tool', toolCallId: b.id, content: mirrorTool.output.render(args, value as never), isError: false }
        }),
      )
      messages = [...messages, { role: 'assistant', content: moreTools }, ...moreResults]
    }
    assert.equal(seenToolCallIds.size, 2)
    assert.equal(finalText, 'Both parallel tools done.')

    // Code Mode preserves bounded input inside run_code wrapper
    const codeSpan = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        tools: [codeSchema],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'LIVE_TOOL_INCREMENTAL' }] } as Message],
        sessionId: 'dsh-code-mode',
      } as unknown as GenerateOptions),
    )
    const codeBlock = codeSpan.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.ok(codeBlock && codeBlock.type === 'block-end' && codeBlock.block.type === 'tool-call')
    assert.equal(codeBlock.block.name, WRAPPER_TOOL_NAME)
    const wrapperArgs = JSON.parse(codeBlock.block.arguments) as { code: string }
    assert.match(wrapperArgs.code, /echo live/)
  } finally {
    pool.dispose()
  }
})

test('options.system passes via ACP systemPrompt.append, updates inline on change, and falls back when unsupported', async () => {
  const { adapter, pool } = createHarness()
  try {
    const t1 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        system: 'Rule Alpha',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ECHO_SYSTEM 1' }] } as Message],
        sessionId: 'dsh-sys',
      } as GenerateOptions),
    )
    const out1 = t1.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.match(out1, /^SYS=Rule Alpha/)
    assert.equal(out1.includes('<host_system_instructions>'), false)

    // Unchanged system prompt should not inject updated tag
    const t2 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        system: 'Rule Alpha',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ECHO_SYSTEM 2' }] } as Message],
        sessionId: 'dsh-sys',
      } as GenerateOptions),
    )
    const out2 = t2.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(out2.includes('<host_system_instructions_updated>'), false)

    // Changed system prompt injects updated tag without destroying persistent session
    const t3 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        system: 'Rule Beta',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ECHO_SYSTEM 3' }] } as Message],
        sessionId: 'dsh-sys',
      } as GenerateOptions),
    )
    const out3 = t3.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.match(out3, /<host_system_instructions_updated>[\s\S]*Rule Beta[\s\S]*<\/host_system_instructions_updated>/)
    assert.equal(pool.getStatus().activeSessions, 1)

    // Clearing system prompt does NOT inject an empty updated tag
    const t4 = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ECHO_SYSTEM 4' }] } as Message],
        sessionId: 'dsh-sys',
      } as GenerateOptions),
    )
    const out4 = t4.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(out4.includes('<host_system_instructions_updated>'), false)
  } finally {
    pool.dispose()
  }

  // Fallback when peer does not advertise systemPrompt.append
  const prevEnv = process.env.FAKE_NO_SYSTEM_APPEND
  process.env.FAKE_NO_SYSTEM_APPEND = '1'
  const fallbackHarness = createHarness()
  try {
    const fb = await collectChunks(
      fallbackHarness.adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        system: 'Fallback Rule',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ECHO_SYSTEM fb' }] } as Message],
        sessionId: 'dsh-sys-fb',
      } as GenerateOptions),
    )
    const out = fb.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.match(out, /^SYS=NONE\|\|PROMPT=<host_system_instructions>[\s\S]*Fallback Rule/)
  } finally {
    if (prevEnv === undefined) delete process.env.FAKE_NO_SYSTEM_APPEND
    else process.env.FAKE_NO_SYSTEM_APPEND = prevEnv
    fallbackHarness.pool.dispose()
  }
})

test('options.purpose auxiliary calls enforce mode=default, deny all permissions, stay out of main sessions, and anonymous non-purpose still rejects', async () => {
  const { adapter, pool } = createHarness()
  try {
    const auxChunks = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        purpose: 'session-title',
        system: 'Generate a short title.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'AUX_TRY_TOOL' }] } as Message],
      } as GenerateOptions),
    )
    const auxText = auxChunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(auxText, 'AUX_MODE=default|READ=false|EXEC=false|SYS=META')
    assert.equal(pool.getStatus().activeSessions, 0)
    const usage = auxChunks.find(c => c.type === 'usage')
    assert.ok(usage && usage.type === 'usage' && usage.usage.inputTokens === 40)

    // Missing sessionId WITHOUT purpose must still throw
    await assert.rejects(
      async () => collectChunks(adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'anonymous' }] } as Message],
      } as GenerateOptions)),
      /identified DSH conversation turn/,
    )
  } finally {
    pool.dispose()
  }
})

test('AcpRpcError preserves persistent process and releases turn lock immediately; AcpTimeoutError invalidates without retry', async () => {
  const { adapter, pool, cfg } = createHarness()
  try {
    // Turn 1: clean JSON-RPC error -> process stays alive & active turn lock is released synchronously
    const errTurn = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'RPC_ERR_RECOVERABLE' }] } as Message],
        sessionId: 'dsh-rpc-keep',
      } as GenerateOptions),
    )
    const errFinish = errTurn.find(c => c.type === 'finish')
    assert.ok(errFinish && errFinish.type === 'finish' && errFinish.reason.kind === 'error')
    assert.equal(pool.getStatus().activeSessions, 1)

    // Immediate next turn reuses exact same sess_1 (#2) with no lock race
    const okTurn = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'still alive' }] } as Message],
        sessionId: 'dsh-rpc-keep',
      } as GenerateOptions),
    )
    assert.equal(okTurn.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '[sess_1#2] still alive')

    // Timeout MUST invalidate process, never auto-retry, and attach sanitized stderr
    cfg.requestTimeoutMs = 150
    const timeoutTurn = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'TIMEOUT_NEVER_REPLY' }] } as Message],
        sessionId: 'dsh-rpc-keep',
      } as GenerateOptions),
    )
    const timeoutFinish = timeoutTurn.find(c => c.type === 'finish')
    assert.ok(timeoutFinish && timeoutFinish.type === 'finish' && timeoutFinish.reason.kind === 'error')
    assert.match(timeoutFinish.reason.failure.message, /timed out/)
    assert.match(timeoutFinish.reason.failure.message, /upstream slow hang/)
    assert.equal(timeoutFinish.reason.failure.message.includes('super_secret_token_999'), false)
    assert.equal(pool.getStatus().activeSessions, 0)
  } finally {
    pool.dispose()
  }
})

test('pre-output process crash auto-recovers once with digest, reports sanitized stderr on repeat crash, and cleans zombie sessions on idle exit', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-crash-'))
  const counterFile = path.join(tmpDir, 'crash-count')
  const syncCrashFile = path.join(tmpDir, 'sync-crash-count')
  const prevCounter = process.env.FAKE_CRASH_COUNTER_FILE
  const prevAlways = process.env.FAKE_CRASH_ALWAYS
  const prevSync = process.env.FAKE_CRASH_ON_SYNC_FILE

  const { adapter, pool } = createHarness()
  try {
    // 1. Pre-output crash on first attempt -> silently recreates and succeeds on retry 1/1
    process.env.FAKE_CRASH_COUNTER_FILE = counterFile
    delete process.env.FAKE_CRASH_ALWAYS
    const recovered = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'earlier context' }] } as Message,
          { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } as Message,
          { role: 'user', content: [{ type: 'text', text: 'CRASH_BEFORE_OUTPUT now' }] } as Message,
        ],
        sessionId: 'dsh-crash-once',
      } as GenerateOptions),
    )
    const recoveredText = recovered.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.match(recoveredText, /^RECOVERED:/)
    assert.match(recoveredText, /earlier context/)

    // 2. Crash during syncSessionOptions on reused session also auto-recovers once
    process.env.FAKE_CRASH_ON_SYNC_FILE = syncCrashFile
    const syncRecovered = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'after sync crash' }] } as Message],
        sessionId: 'dsh-crash-once',
      } as GenerateOptions),
    )
    assert.match(syncRecovered.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /after sync crash/)
    delete process.env.FAKE_CRASH_ON_SYNC_FILE

    // 3. Persistent crash (2x) stops after 1 retry and surfaces sanitized stderr
    process.env.FAKE_CRASH_ALWAYS = '1'
    const failed = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'CRASH_BEFORE_OUTPUT again' }] } as Message],
        sessionId: 'dsh-crash-always',
      } as GenerateOptions),
    )
    const failFinish = failed.find(c => c.type === 'finish')
    assert.ok(failFinish && failFinish.type === 'finish' && failFinish.reason.kind === 'error')
    assert.match(failFinish.reason.failure.message, /fatal peer crash/)
    assert.equal(failFinish.reason.failure.message.includes('AIzaSySecretKey'), false)
    assert.match(failFinish.reason.failure.message, /\[REDACTED\]/)
    delete process.env.FAKE_CRASH_ALWAYS
    delete process.env.FAKE_CRASH_COUNTER_FILE

    // 4. Idle unexpected exit automatically evicts zombie session via onExit
    const idleTurn = await collectChunks(
      adapter.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'EXIT_IDLE_SOON' }] } as Message],
        sessionId: 'dsh-idle-exit',
      } as GenerateOptions),
    )
    assert.equal(idleTurn.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'bye soon')
    await new Promise(r => setTimeout(r, 150))
    assert.equal(pool.getStatus().sessions.some(s => s.dshSessionKey === 'dsh-idle-exit'), false)
  } finally {
    if (prevCounter === undefined) delete process.env.FAKE_CRASH_COUNTER_FILE
    else process.env.FAKE_CRASH_COUNTER_FILE = prevCounter
    if (prevAlways === undefined) delete process.env.FAKE_CRASH_ALWAYS
    else process.env.FAKE_CRASH_ALWAYS = prevAlways
    if (prevSync === undefined) delete process.env.FAKE_CRASH_ON_SYNC_FILE
    else process.env.FAKE_CRASH_ON_SYNC_FILE = prevSync
    pool.dispose()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('EgressGuard blocks HK main chat & auxiliary calls with zero subprocess launches, guards reused sessions on TTL drift, circuit-breaks runtime 400, and fails over across MultiAccountPool', async () => {
  // 1. Single account on HK: main chat & auxiliary call must spawn 0 subprocesses
  let launches = 0
  let currentCountry: 'HK' | 'US' = 'HK'
  let fakeNow = 1_000_000
  const cfg1 = resolveConfig({ enabled: true, geoFenceMode: 'block', requestTimeoutMs: 10_000 })
  const guard1 = new EgressGuard({
    now: () => fakeNow,
    probeFn: async () => ({
      status: currentCountry === 'HK' ? 'unsupported' : 'supported',
      country: currentCountry,
      ipMasked: '203.0.113.*',
      proxyMode: 'proxy',
      probeSource: 'mock-trace',
    }),
  })
  const runs1 = new AcpRunStore()
  const pool1 = new AcpSessionPool({
    ...fakeHost,
    egressGuard: guard1,
    getConfig: () => cfg1,
    resolveBin: () => FAKE_AGY_BIN,
    prepareArgv: async (argv) => {
      launches++
      return argv
    },
  })
  const adapter1 = new AcpAdapter({ getConfig: () => cfg1, pool: pool1, runs: runs1 })

  try {
    const blockedMain = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello from HK' }] } as Message],
        sessionId: 'dsh-hk-block',
      } as GenerateOptions),
    )
    const finMain = blockedMain.find(c => c.type === 'finish')
    assert.ok(finMain && finMain.type === 'finish' && finMain.reason.kind === 'error')
    assert.match(finMain.reason.failure.message, /\[安全拦截\].*HK/)
    assert.equal(launches, 0, 'main chat must not launch agy subprocess when egress is HK')

    const blockedAux = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        purpose: 'session-title',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize title' }] } as Message],
      } as GenerateOptions),
    )
    const finAux = blockedAux.find(c => c.type === 'finish')
    assert.ok(finAux && finAux.type === 'finish' && finAux.reason.kind === 'error')
    assert.match(finAux.reason.failure.message, /\[安全拦截\].*HK/)
    assert.equal(launches, 0, 'auxiliary call must not launch agy subprocess when egress is HK')

    // 2. Switch VPN to US + manual check -> creates session; then TTL expires & drifts to HK -> reused session blocked locally!
    currentCountry = 'US'
    await pool1.checkAccountEgress('default')
    const turn1 = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'turn 1 on US' }] } as Message],
        sessionId: 'dsh-drift-reuse',
      } as GenerateOptions),
    )
    assert.equal(turn1.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '[sess_1#1] turn 1 on US')
    assert.equal(launches, 1)

    // Advance past 5-minute supported TTL and flip node to HK
    fakeNow += 301_000
    currentCountry = 'HK'
    const driftedTurn2 = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'turn 2 drifted to HK' }] } as Message],
        sessionId: 'dsh-drift-reuse',
      } as GenerateOptions),
    )
    const finDrift = driftedTurn2.find(c => c.type === 'finish')
    assert.ok(finDrift && finDrift.type === 'finish' && finDrift.reason.kind === 'error')
    assert.match(finDrift.reason.failure.message, /\[安全拦截\].*HK/)
    assert.equal(launches, 1)

    // Switch back to US -> existing persistent session [sess_1] resumes at turn #2 (proving turn 2 never reached fake-agy!)
    currentCountry = 'US'
    await pool1.checkAccountEgress('default')
    const turn3 = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'turn 3 back on US' }] } as Message],
        sessionId: 'dsh-drift-reuse',
      } as GenerateOptions),
    )
    assert.equal(turn3.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '[sess_1#2] turn 3 back on US')

    // 3. Leaked upstream Google 400 (`FORCE_GEO_400`) during valid cache window immediately arms local circuit breaker
    const leaked400 = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'FORCE_GEO_400' }] } as Message],
        sessionId: 'dsh-drift-reuse',
      } as GenerateOptions),
    )
    const fin400 = leaked400.find(c => c.type === 'finish')
    assert.ok(fin400 && fin400.type === 'finish' && fin400.reason.kind === 'error')
    assert.match(fin400.reason.failure.message, /\[地域限制熔断\]/)
    assert.equal(pool1.getStatus().accounts[0]?.egress?.probeSource, 'runtime-400')

    // Immediate next turn (1ms later!) is blocked locally BEFORE sending `session/prompt` to fake-agy
    const blockedAfter400 = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'immediate follow-up' }] } as Message],
        sessionId: 'dsh-drift-reuse',
      } as GenerateOptions),
    )
    const finNext = blockedAfter400.find(c => c.type === 'finish')
    assert.ok(finNext && finNext.type === 'finish' && finNext.reason.kind === 'error')
    assert.match(finNext.reason.failure.message, /\[安全拦截\]/)
  } finally {
    pool1.dispose()
  }

  // 4. MultiAccountPool: Account A (HK) is skipped with 0 subprocess launches, seamlessly failing over to Account B (US)
  const cfgMulti = resolveConfig({
    enabled: true,
    geoFenceMode: 'block',
    accounts: [
      { id: 'acct-hk', label: '香港节点账号', proxyUrl: 'http://127.0.0.1:18081', env: { FAKE_ACCOUNT_TAG: 'acct-hk' } },
      { id: 'acct-us', label: '美国节点账号', proxyUrl: 'http://127.0.0.1:18082', env: { FAKE_ACCOUNT_TAG: 'acct-us' } },
    ],
  })
  const launchedEnvs: string[] = []
  const multiPool = new MultiAccountPool({ accounts: cfgMulti.accounts })
  const multiGuard = new EgressGuard({
    probeFn: async (accountId) => ({
      status: accountId === 'acct-hk' ? 'unsupported' : 'supported',
      country: accountId === 'acct-hk' ? 'HK' : 'US',
      ipMasked: '198.51.100.*',
      proxyMode: 'proxy',
      probeSource: 'mock',
    }),
  })
  const poolMulti = new AcpSessionPool({
    ...fakeHost,
    accountProvider: multiPool,
    egressGuard: multiGuard,
    getConfig: () => cfgMulti,
    resolveBin: () => FAKE_AGY_BIN,
    prepareArgv: async (argv) => {
      launchedEnvs.push(argv.join(' '))
      return argv
    },
  })
  const adapterMulti = new AcpAdapter({ getConfig: () => cfgMulti, pool: poolMulti, runs: new AcpRunStore() })

  try {
    const failoverTurn = await collectChunks(
      adapterMulti.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello multi geo' }] } as Message],
        sessionId: 'dsh-multi-geo',
      } as GenerateOptions),
    )
    const text = failoverTurn.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(text, '<acct-us> [sess_1#1] hello multi geo')
    assert.equal(launchedEnvs.length, 1, 'only acct-us should launch an agy subprocess')
    assert.equal(poolMulti.getStatus().sessions[0]?.accountId, 'acct-us')
    assert.equal(poolMulti.getStatus().accounts.find(a => a.id === 'acct-hk')?.egress?.status, 'unsupported')
    assert.equal(poolMulti.getStatus().accounts.find(a => a.id === 'acct-us')?.egress?.status, 'supported')
  } finally {
    poolMulti.dispose()
  }
})

for (const scenario of ['before grant', 'after grant', 'repeat exit', 'caller cancelled', 'policy changed'] as const) {
  test(`SIGTERM during a mirror tool call: ${scenario}`, { timeout: 10_000 }, async t => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-approval-exit-'))
    const sessionId = 'approval-test'
    const cfg = resolveConfig({})
    const runs = new AcpRunStore()
    const logs: string[] = []
    const caller = new AbortController()
    let approvals = 0
    let oldApprovalClosed = false
    let approvalPolicy: 'ask' | 'never' = 'ask'
    const pool = new AcpSessionPool({
      ...fakeHost, resolveBin: () => FAKE_AGY_BIN, getConfig: () => cfg,
      readPolicy: () => ({ sessionId, workspaceRoot: cwd, mode: 'workspace-write', preset: 'workspace-write', approval: approvalPolicy }),
      log: message => logs.push(message),
      async onPermission(_req, _key, signal) {
        approvals++
        if (scenario !== 'after grant' && (approvals === 1 || scenario === 'repeat exit')) {
          const launch = logs.findLast(line => line.startsWith('ACP started'))
          const pid = Number(launch?.match(/pid=(\d+)/)?.[1])
          assert.ok(pid > 0)
          process.kill(pid, 'SIGTERM')
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          oldApprovalClosed = true
        }
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
    })
    t.after(() => { pool.dispose(); rmSync(cwd, { recursive: true, force: true }) })
    const adapter = new AcpAdapter({ pool, runs, getConfig: () => cfg })
    const mirror = defineAgyAcpMirrorTool(runs)
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'earlier context' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
      { role: 'user', content: [{ type: 'text', text: 'APPROVAL_EXIT' + (scenario === 'after grant' ? ' AFTER_GRANT' : '') }] },
    ] as Message[]
    const stream = () => collectChunks(adapter.stream({ provider: PROVIDER_ID, model: 'gemini-4-neon', sessionId, messages: history, signal: caller.signal,
      tools: [{ name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }] } as unknown as GenerateOptions))
    async function mirrorResult(chunks: StreamChunk[]) {
      const end = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
      assert.ok(end?.type === 'block-end' && end.block.type === 'tool-call')
      const args = JSON.parse(end.block.arguments)
      const result = await mirror.execute(args, { agent: { session: { id: sessionId } } } as ToolRunContext)
      const content = mirror.output.render(args, result as never)
      history.push({ role: 'assistant', content: [end.block] } as Message,
        { role: 'tool', toolCallId: end.block.id, content } as unknown as Message)
      return result as { output: string; isError: boolean }
    }

    const first = await mirrorResult(await stream())
    assert.equal(first.isError, true)
    if (scenario === 'after grant') {
      assert.match(first.output, /已获准执行/)
    } else {
      assert.equal(oldApprovalClosed, true)
      assert.match(first.output, /尚未获准执行/)
      assert.equal(existsSync(path.join(cwd, 'executions')), false)
    }
    if (scenario === 'caller cancelled') caller.abort()
    if (scenario === 'policy changed') approvalPolicy = 'never'
    let next = await stream()
    if (scenario === 'before grant' || scenario === 'repeat exit') {
      await mirrorResult(next)
      next = await stream()
      assert.equal(approvals, 2)
    } else {
      assert.equal(approvals, 1)
    }
    assert.ok(logs.some(line => line.includes(`phase=${scenario === 'after grant' ? 'after-grant' : 'permission-pending'}`)))
    const finish = next.find(c => c.type === 'finish')
    assert.equal(finish?.reason.kind, scenario === 'before grant' ? 'stop' : scenario === 'caller cancelled' ? 'aborted' : 'error')
    if (scenario === 'before grant') {
      assert.match(next.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /earlier context/)
    }
    if (scenario === 'after grant' || scenario === 'before grant') {
      assert.equal(readFileSync(path.join(cwd, 'executions'), 'utf8'), 'executed\n')
    } else {
      assert.equal(existsSync(path.join(cwd, 'executions')), false)
    }
  })
}

test('SIGTERM after reasoning recovers once with distinct block indices, while partial answers are preserved', async t => {
  const { adapter, pool } = createHarness()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-reasoning-exit-'))
  t.after(() => { pool.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const previous = process.env.FAKE_CRASH_COUNTER_FILE
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_CRASH_COUNTER_FILE
    else process.env.FAKE_CRASH_COUNTER_FILE = previous
  })
  for (const partial of [false, true]) {
    const counter = path.join(dir, String(partial))
    process.env.FAKE_CRASH_COUNTER_FILE = counter
    const chunks = await collectChunks(adapter.stream({
      provider: PROVIDER_ID, model: 'gemini-4-neon', sessionId: `reasoning-${partial}`,
      messages: [{ role: 'user', content: [{ type: 'text',
        text: 'CRASH_BEFORE_OUTPUT DURING_REASONING' + (partial ? ' ANSWER_STARTED' : '') }] }],
    } as unknown as GenerateOptions))
    assert.equal(readFileSync(counter, 'utf8'), partial ? '1' : '2')
    assert.deepEqual(chunks.filter(c => c.type === 'block-start').map(c => c.index), [0, 1])
    assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.index), [0, 1])
    assert.deepEqual(chunks.filter(c => c.type === 'finish').map(c => c.reason.kind), [partial ? 'error' : 'stop'])
  }
})

test('session/load restores native ACP context across idle sweep & restart without digest duplication, isolates replay chunks, and falls back smoothly to session/new', async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-load-'))
  const storeFile = path.join(tmpDir, 'fake-agy-sessions.json')
  const indexFile = path.join(tmpDir, 'sessions.json')
  const prevStore = process.env.FAKE_SESSION_STORE_FILE
  const prevFail = process.env.FAKE_FAIL_SESSION_LOAD
  process.env.FAKE_SESSION_STORE_FILE = storeFile
  delete process.env.FAKE_FAIL_SESSION_LOAD

  t.after(() => {
    if (prevStore === undefined) delete process.env.FAKE_SESSION_STORE_FILE
    else process.env.FAKE_SESSION_STORE_FILE = prevStore
    if (prevFail === undefined) delete process.env.FAKE_FAIL_SESSION_LOAD
    else process.env.FAKE_FAIL_SESSION_LOAD = prevFail
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const cfg = resolveConfig({ enabled: true, sessionIdleTtlMs: 60_000, requestTimeoutMs: 10_000 })
  const sessionIndex1 = new SessionIndex({ filePath: indexFile })
  const pool1 = new AcpSessionPool({
    ...fakeHost,
    sessionIndex: sessionIndex1,
    getConfig: () => cfg,
    resolveBin: () => FAKE_AGY_BIN,
  })
  const adapter1 = new AcpAdapter({ getConfig: () => cfg, pool: pool1, runs: new AcpRunStore() })

  try {
    // Turn 1: creates sess_1 via session/new
    const t1 = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'first turn' }] } as Message],
        sessionId: 'conv-load-1',
      } as GenerateOptions),
    )
    assert.equal(t1.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '[sess_1#1] first turn')
    assert.equal(pool1.getStatus().persistedSessions, 1)

    // Simulate idle TTL sweep -> closes child process while preserving SessionIndex
    const liveSess = pool1.getStatus().sessions[0]!
    assert.equal(liveSess.acpSessionId, 'sess_1')
    ;(pool1 as unknown as { sessions: Map<string, { lastActiveAt: number }> }).sessions.get('conv-load-1')!.lastActiveAt = 1
    await pool1.sweepIdleSessions()
    assert.equal(pool1.getStatus().activeSessions, 0)
    assert.equal(pool1.getStatus().persistedSessions, 1)

    // Turn 2: restores sess_1 via session/load -> turn #2, NO <prior_conversation_digest>, NO leaked replay text, contextUsed=1234 restored!
    const history2: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first turn' }] } as Message,
      { role: 'assistant', content: [{ type: 'text', text: '[sess_1#1] first turn' }] } as Message,
      { role: 'user', content: [{ type: 'text', text: 'second turn after idle' }] } as Message,
    ]
    const t2 = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: history2,
        sessionId: 'conv-load-1',
      } as GenerateOptions),
    )
    const text2 = t2.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(text2, '[sess_1#2] second turn after idle')
    assert.equal(text2.includes('prior_conversation_digest'), false)
    assert.equal(text2.includes('STALE_REPLAY_TEXT_MUST_NOT_LEAK'), false)
    const snap2 = pool1.getStatus().sessions[0]!
    assert.equal(snap2.resumed, true)
    assert.equal(snap2.contextUsed, 1234)
    assert.equal(snap2.contextSize, 65536)

    // Dynamic notifications (`session_info_update` + `config_option_update`) sync immediately to status & SessionIndex
    const dynTurn = await collectChunks(
      adapter1.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: [...history2, { role: 'user', content: [{ type: 'text', text: 'EMIT_DYNAMIC_UPDATES' }] } as Message],
        sessionId: 'conv-load-1',
      } as GenerateOptions),
    )
    assert.equal(dynTurn.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Dynamic updates pushed.')
    const afterDyn = pool1.getStatus().sessions[0]!
    assert.equal(afterDyn.title, '重构登录模块')
    assert.equal(afterDyn.currentModel, 'claude-sonnet-5-5')
    assert.equal(afterDyn.currentEffort, 'high')
  } finally {
    pool1.dispose()
  }

  // Simulate full DSH/plugin restart: new pool + new SessionIndex reading persisted sessions.json
  const sessionIndex2 = new SessionIndex({ filePath: indexFile })
  sessionIndex2.load()
  const pool2 = new AcpSessionPool({
    ...fakeHost,
    sessionIndex: sessionIndex2,
    getConfig: () => cfg,
    resolveBin: () => FAKE_AGY_BIN,
  })
  const adapter2 = new AcpAdapter({ getConfig: () => cfg, pool: pool2, runs: new AcpRunStore() })

  try {
    const history3: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first turn' }] } as Message,
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] } as Message,
      { role: 'user', content: [{ type: 'text', text: 'turn after restart' }] } as Message,
    ]
    const t3 = await collectChunks(
      adapter2.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: history3,
        sessionId: 'conv-load-1',
      } as GenerateOptions),
    )
    assert.equal(t3.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '[sess_1#4] turn after restart')
    assert.equal(pool2.getStatus().sessions[0]?.title, '重构登录模块')

    // Force `session/load` failure -> seamlessly falls back to `session/new` WITH 24K `<prior_conversation_digest>`
    ;(pool2 as unknown as { sessions: Map<string, { lastActiveAt: number }> }).sessions.get('conv-load-1')!.lastActiveAt = 1
    await pool2.sweepIdleSessions()
    process.env.FAKE_FAIL_SESSION_LOAD = '1'
    const t4 = await collectChunks(
      adapter2.stream({
        provider: PROVIDER_ID,
        model: 'gemini-4-neon',
        messages: history3,
        sessionId: 'conv-load-1',
      } as GenerateOptions),
    )
    const text4 = t4.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.match(text4, /prior_conversation_digest/)
    assert.match(text4, /turn after restart/)
    assert.equal(pool2.getStatus().sessions[0]?.resumed, undefined)
  } finally {
    pool2.dispose()
  }
})
