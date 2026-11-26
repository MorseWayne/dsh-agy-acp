import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID, WRAPPER_TOOL_NAME } from '../src/common/types.ts'
import { ReverseMcpBridge } from '../src/mcp/server.ts'
import { AcpAdapter, collectContinuationToolResults, detectContinuation } from '../src/provider/adapter.ts'
import { defineAgyAcpMirrorTool } from '../src/provider/mirror-tool.ts'
import { AcpRunStore, encodeMirrorCallId } from '../src/provider/run-store.ts'
import { decidePermission, isDshReverseMcpToolCall, type SessionPolicy } from '../src/runtime/permission-manager.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGY_BIN = path.join(__dirname, 'fixtures', 'fake-agy.mjs')
chmodSync(FAKE_AGY_BIN, 0o755)

async function collectChunks(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const c of iterable) chunks.push(c)
  return chunks
}

function createDelegationHarness() {
  const cfg = resolveConfig({
    enabled: true,
    mcpBridge: true,
    requestTimeoutMs: 10_000,
  })
  const runs = new AcpRunStore()
  const bridges = new Map<string, ReverseMcpBridge>()
  const dshTools = [
    {
      name: 'ops_glob',
      description: 'Find files',
      parameters: { type: 'object', properties: { pattern: { type: 'array' } }, additionalProperties: false },
    },
    {
      name: 'mnemon_recall',
      description: 'Recall memories',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    },
  ]

  const pool: AcpSessionPool = new AcpSessionPool({
    ...fakeHost,
    getConfig: () => cfg,
    resolveBin: () => FAKE_AGY_BIN,
    onSessionClosed: (key) => {
      const b = bridges.get(key)
      bridges.delete(key)
      if (b) void b.dispose()
    },
    async getMcpServers(key, opts) {
      const bridge = new ReverseMcpBridge({
        listTools: () => dshTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        callTool: async (name, args, signal) => {
          const turn = pool.activeSignal(key)
          if (!turn) throw new Error('Inactive ACP turn')
          const schema = dshTools.find((t) => t.name === name)
          if (!schema) throw new Error('Unknown tool')
          if (Object.hasOwn(args, 'toolSummary') && !Object.hasOwn(schema.parameters.properties, 'toolSummary')) {
            const { toolSummary: _, ...rest } = args
            args = rest
          }
          const rec = runs.getActiveForOwner(key)
          assert.ok(rec?.delegatesMcp, 'expected active recording with MCP delegation enabled')
          const resumeTimer = pool.pauseTurnTimer(key)
          try {
            return await rec.enqueueMcpCall(name, args, AbortSignal.any([signal, turn]))
          } finally {
            resumeTimer()
          }
        },
        callTimeoutMs: 10_000,
      })
      bridges.set(key, bridge)
      await bridge.start()
      const spec = bridge.getPreferredMcpServerSpec(Boolean(opts?.preferHttp))
      return spec ? [spec] : []
    },
  })

  const adapter = new AcpAdapter({ getConfig: () => cfg, pool, runs })
  const mirrorTool = defineAgyAcpMirrorTool(runs)
  const dispose = async () => {
    pool.dispose()
    for (const b of bridges.values()) await b.dispose()
    bridges.clear()
  }
  return { adapter, pool, runs, mirrorTool, dshTools, dispose }
}

test('delegates reverse MCP calls as real DSH native tool-call steps, suppresses duplicate mirror cards, and propagates results & errors', { timeout: 10_000 }, async (t) => {
  const harness = createDelegationHarness()
  t.after(() => harness.dispose())

  const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  const hostTools = [mirrorSchema, ...harness.dshTools]

  // 1. Success flow: Standard Mode emits real `ops_glob` tool-call (not `agy_acp_tool`) and strips undeclared `toolSummary`.
  const span1 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: hostTools,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] } as Message],
      sessionId: 'sess-mcp-std',
    } as unknown as GenerateOptions),
  )

  const preText = span1.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(preText, 'Checking via DSH tool...')

  const toolCalls1 = span1
    .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
  assert.equal(toolCalls1.length, 1)
  assert.equal(toolCalls1[0]!.name, 'ops_glob')
  assert.deepEqual(JSON.parse(toolCalls1[0]!.arguments), { pattern: ['src/**/*.ts'] })
  assert.equal(span1.find((c) => c.type === 'finish')?.reason.kind, 'tool-calls')

  // Simulate DSH logging assistant/message + tool/call + running auto-review + tool/result + developer tool update
  const span2 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: hostTools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] },
        { role: 'assistant', content: toolCalls1 },
        { role: 'tool', toolCallId: toolCalls1[0]!.id, content: [{ type: 'text', text: 'src/index.ts\nsrc/adapter.ts' }], isError: false },
        { role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'ops_read_pdf' }] },
        { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time: now' }] },
      ],
      sessionId: 'sess-mcp-std',
    } as unknown as GenerateOptions),
  )

  // No duplicate agy_acp_tool mirror call emitted for the completed MCP tool
  const toolCalls2 = span2.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(toolCalls2.length, 0)
  const finalText = span2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(finalText, 'MCP_RESULT:OK:src/index.ts\nsrc/adapter.ts')
  assert.equal(span2.find((c) => c.type === 'finish')?.reason.kind, 'stop')

  // 2. Error / Auto-review denial flow (`isError: true`) propagates cleanly back to agy
  const errSpan1 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: hostTools,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] } as Message],
      sessionId: 'sess-mcp-std',
    } as unknown as GenerateOptions),
  )
  const errCalls = errSpan1
    .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
  assert.equal(errCalls.length, 1)
  assert.equal(errCalls[0]!.name, 'ops_glob')

  const errSpan2 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: hostTools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] },
        { role: 'assistant', content: errCalls },
        { role: 'tool', toolCallId: errCalls[0]!.id, content: [{ type: 'text', text: 'Error: the user rejected tool "ops_glob"' }], isError: true },
      ],
      sessionId: 'sess-mcp-std',
    } as unknown as GenerateOptions),
  )
  const errFinal = errSpan2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(errFinal, 'MCP_RESULT:ERR:Error: the user rejected tool "ops_glob"')
  assert.equal(errSpan2.find((c) => c.type === 'finish')?.reason.kind, 'stop')
})

test('Code Mode (PTC) wraps delegated reverse MCP calls in run_code with required description and returns result', { timeout: 10_000 }, async (t) => {
  const harness = createDelegationHarness()
  t.after(() => harness.dispose())

  const tsRunCodeSchema = {
    name: WRAPPER_TOOL_NAME,
    description: 'Execute a TypeScript program against the available tools.',
    parameters: { type: 'object', properties: { code: { type: 'string' }, description: { type: 'string' } } },
  }

  const span1 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: [tsRunCodeSchema],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] } as Message],
      sessionId: 'sess-mcp-ptc',
    } as unknown as GenerateOptions),
  )

  const calls = span1
    .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.name, WRAPPER_TOOL_NAME)
  const args = JSON.parse(calls[0]!.arguments) as { code: string; description: string }
  assert.equal(args.code, 'return await tools["ops_glob"]({"pattern":["src/**/*.ts"]})')
  assert.ok(args.description.trim().length > 0)

  const span2 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: [tsRunCodeSchema],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] },
        { role: 'assistant', content: calls },
        { role: 'tool', toolCallId: calls[0]!.id, content: [{ type: 'text', text: '["src/a.ts"]' }], isError: false },
        { role: 'user', source: { kind: 'ptc-mode' }, content: [{ type: 'text', text: 'PTC attachment' }] },
      ],
      sessionId: 'sess-mcp-ptc',
    } as unknown as GenerateOptions),
  )
  const finalText = span2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(finalText, 'MCP_RESULT:OK:["src/a.ts"]')
  assert.equal(span2.find((c) => c.type === 'finish')?.reason.kind, 'stop')
})

test('parallel delegated MCP calls and mixed MCP + unsettled native tools complete without deadlock or duplicate cards', { timeout: 10_000 }, async (t) => {
  const harness = createDelegationHarness()
  t.after(() => harness.dispose())

  const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  const hostTools = [mirrorSchema, ...harness.dshTools]

  const runLoop = async (sessionId: string, promptText: string) => {
    const executedNative: string[] = []
    const executedMirror: string[] = []
    let finalText = ''
    let messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: promptText }] }]

    for (let step = 0; step < 6; step++) {
      const span = await collectChunks(
        harness.adapter.stream({
          provider: PROVIDER_ID,
          model: 'gemini-4-neon',
          tools: hostTools,
          messages,
          sessionId,
        } as unknown as GenerateOptions),
      )
      finalText += span.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
      const calls = span
        .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
        .map((c) => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
      const finish = span.find((c) => c.type === 'finish')
      if (calls.length === 0) {
        assert.equal(finish?.reason.kind, 'stop')
        break
      }
      assert.equal(finish?.reason.kind, 'tool-calls')

      const results = await Promise.all(
        calls.map(async (c) => {
          const parsedArgs = JSON.parse(c.arguments) as Record<string, unknown>
          if (c.name === MIRROR_TOOL_NAME) {
            executedMirror.push(String(parsedArgs.tool ?? 'unknown'))
            const val = await harness.mirrorTool.execute(parsedArgs, { agent: { session: { id: sessionId } } } as ToolRunContext)
            return {
              role: 'tool',
              toolCallId: c.id,
              content: harness.mirrorTool.output.render(parsedArgs, val as never),
              isError: false,
            }
          }
          executedNative.push(c.name)
          const text = c.name === 'ops_glob' ? 'matched:a.ts' : 'memory:dark-mode'
          return {
            role: 'tool',
            toolCallId: c.id,
            content: [{ type: 'text', text }],
            isError: false,
          }
        }),
      )
      messages = [...messages, { role: 'assistant', content: calls }, ...results]
    }
    return { executedNative, executedMirror, finalText }
  }

  // 1. Parallel MCP calls
  const par = await runLoop('sess-mcp-par', 'DELEGATE_MCP_PARALLEL')
  assert.deepEqual(par.executedNative.sort(), ['mnemon_recall', 'ops_glob'])
  assert.deepEqual(par.executedMirror, [])
  assert.equal(par.finalText, 'PARALLEL:matched:a.ts|memory:dark-mode')

  // 2. Mixed MCP + unsettled native tool (serial execution in agy — must NOT deadlock!)
  const mixed = await runLoop('sess-mcp-mixed', 'DELEGATE_MCP_MIXED')
  assert.deepEqual(mixed.executedNative, ['ops_glob'])
  assert.deepEqual(mixed.executedMirror, ['read_file'])
  assert.equal(mixed.finalText, 'MIXED_DONE:matched:a.ts')
})

test('cancelling an active turn immediately rejects pending delegated MCP calls without hanging', async () => {
  const store = new AcpRunStore()
  const rec = store.create('sess-cancel')
  rec.delegatesMcp = true
  let cancelled = false
  rec.setCancelHandler(() => { cancelled = true })

  const pending = rec.enqueueMcpCall('ops_glob', { pattern: ['**/*'] })
  store.cancelActiveForOwner('sess-cancel', new Error('DSH turn ended'))

  await assert.rejects(pending, /DSH turn ended/)
  assert.equal(cancelled, true)
  assert.equal(store.getActiveForOwner('sess-cancel'), undefined)
})

test('detectContinuation and collectContinuationToolResults handle developer/step-context trailers and legacy blocks', () => {
  const id1 = encodeMirrorCallId('runX', 2)
  const id2 = encodeMirrorCallId('runX', 4)
  const msgs = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [] },
    { role: 'tool', toolCallId: id1, content: [{ type: 'text', text: 'first' }], isError: false },
    { role: 'tool', toolCallId: id2, content: [{ type: 'text', text: 'second' }], isError: true },
    { role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition' }] },
    { role: 'user', source: { kind: 'ptc-mode' }, content: [{ type: 'text', text: 'image ctx' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime' }] },
    { role: 'user', source: { kind: 'custom-deferred-tool-context' }, content: [{ type: 'text', text: 'deferred ctx' }] },
  ]
  assert.deepEqual(detectContinuation(msgs), { runId: 'runX', itemIndex: 4 })
  assert.deepEqual(collectContinuationToolResults(msgs, 'runX'), [
    { itemIndex: 2, result: { content: [{ type: 'text', text: 'first' }], isError: false } },
    { itemIndex: 4, result: { content: [{ type: 'text', text: 'second' }], isError: true } },
  ])

  // Fresh turn triggers (scheduled, agent-message, user) must NOT be skipped as step context
  assert.equal(
    detectContinuation([
      ...msgs,
      { role: 'user', source: { kind: 'scheduled' }, content: [{ type: 'text', text: 'cron trigger' }] },
    ]),
    null,
  )
  assert.equal(
    detectContinuation([
      ...msgs,
      { role: 'user', source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'child reply' }] },
    ]),
    null,
  )
})

test('isDshReverseMcpToolCall and decidePermission allow attached dsh-tools MCP across auto/read-only while rejecting spoofs', async () => {
  assert.equal(isDshReverseMcpToolCall({ name: 'mcp_dsh-tools_ops_glob', kind: 'other' }), true)
  assert.equal(isDshReverseMcpToolCall({ name: 'call_mcp_tool', kind: 'other', rawInput: { ServerName: 'dsh-tools', ToolName: 'ops_glob' } }), true)
  assert.equal(isDshReverseMcpToolCall({ title: 'Run mcp_dsh-tools_mnemon_recall?' }), true)
  // Spoof attempts must be rejected
  assert.equal(isDshReverseMcpToolCall({ name: 'mcp_dsh-tools_ops_glob', kind: 'execute', rawInput: { CommandLine: 'rm -rf /' } }), false)
  assert.equal(isDshReverseMcpToolCall({ title: 'Run mcp_dsh-tools_ops_glob', kind: 'edit' }), false)
  assert.equal(isDshReverseMcpToolCall({ name: 'call_mcp_tool', rawInput: { ServerName: 'gitnexus', ToolName: 'query' } }), false)

  const mcpReq = {
    sessionId: 's',
    toolCall: { toolCallId: 'm1', sessionUpdate: 'tool_call' as const, name: 'mcp_dsh-tools_ops_glob', title: 'Run mcp_dsh-tools_ops_glob?', kind: 'other' },
    options: [{ optionId: 'ok', kind: 'allow_once' as const, name: 'OK' }, { optionId: 'no', kind: 'reject_once' as const, name: 'No' }],
  }
  const ro: SessionPolicy = { sessionId: 's', mode: 'read-only', approval: 'ask', workspaceRoot: process.cwd(), preset: 'read-only' }
  const auto: SessionPolicy = { sessionId: 's', mode: 'danger-full-access', approval: 'ask', workspaceRoot: process.cwd(), preset: 'auto' }
  const neverAsk = async () => { assert.fail('should not ask at ACP layer when reverse MCP bridge is attached') }

  // With reverse MCP bridge attached: auto and read-only pass through to DSH's own native enforcement
  assert.deepEqual(
    await decidePermission(mcpReq, () => auto, neverAsk, new AbortController().signal, undefined, undefined, { hasReverseMcpBridge: true }),
    { outcome: { outcome: 'selected', optionId: 'ok' } },
  )
  assert.deepEqual(
    await decidePermission(mcpReq, () => ro, neverAsk, new AbortController().signal, undefined, undefined, { hasReverseMcpBridge: true }),
    { outcome: { outcome: 'selected', optionId: 'ok' } },
  )
  // Without reverse MCP bridge attached: fail-closed (read-only denies, auto asks)
  assert.deepEqual(
    await decidePermission(mcpReq, () => ro, neverAsk, new AbortController().signal, undefined, undefined, { hasReverseMcpBridge: false }),
    { outcome: { outcome: 'selected', optionId: 'no' } },
  )
  let asked = 0
  assert.deepEqual(
    await decidePermission(mcpReq, () => auto, async () => { asked++; return 'rejected' }, new AbortController().signal, undefined, undefined, { hasReverseMcpBridge: false }),
    { outcome: { outcome: 'selected', optionId: 'no' } },
  )
  assert.equal(asked, 1)
})
