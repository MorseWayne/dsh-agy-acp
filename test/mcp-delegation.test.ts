import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/common/config.ts'
import { MIRROR_TOOL_NAME, PROVIDER_ID, WRAPPER_TOOL_NAME } from '../src/common/types.ts'
import { OVERLAPPING_NATIVE_DSH_TOOLS, ReverseMcpBridge } from '../src/mcp/server.ts'
import { AcpAdapter } from '../src/provider/adapter.ts'
import { detectContinuation } from '../src/provider/continuation.ts'
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

function createDelegationHarness(opts?: { canUseMirrorTool?: (sessionKey: string) => boolean }) {
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
    { name: 'wait_agent', description: 'Wait for agent input', parameters: { type: 'object', properties: { timeout_ms: { type: 'number' } } } },
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
    async getMcpServers(key, mcpOpts) {
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
          if (!rec) throw new Error('No active ACP turn for delegated MCP call')
          if (!rec.delegatesMcp) {
            return {
              content: [{ type: 'text', text: `Error: Tool "${name}" is not available in this DSH step` }],
              isError: true,
            }
          }
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
      const spec = bridge.getPreferredMcpServerSpec(Boolean(mcpOpts?.preferHttp))
      return spec ? [spec] : []
    },
  })

  const adapter = new AcpAdapter({
    getConfig: () => cfg,
    pool,
    runs,
    ...(opts?.canUseMirrorTool ? { canUseMirrorTool: opts.canUseMirrorTool } : {}),
  })
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

for (const scenario of ['wait only', 'parallel after wait', 'native before wait'] as const) {
  test(`mid-turn inbox reaches the active wait_agent prompt: ${scenario}`, { timeout: 10_000 }, async t => {
    const harness = createDelegationHarness()
    t.after(() => harness.dispose())
    const sessionId = 'wait-agent-inbox'
    const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
    const tools = [mirrorSchema, ...harness.dshTools]
    const marker = scenario === 'native before wait' ? ' MIDTURN_NATIVE' : scenario === 'parallel after wait' ? ' PARALLEL_AFTER_WAIT' : ''
    const history: unknown[] = [{ role: 'user', content: [{ type: 'text', text: `DELEGATE_MCP_WAIT_AGENT${marker}` }] }]
    // Exercise the direct-adapter fallback too: no turn/start event in the wait-only case.
    if (scenario !== 'wait only') harness.runs.beginHostTurn(sessionId, 1)
    const stream = () => collectChunks(harness.adapter.stream({ provider: PROVIDER_ID, model: 'gemini-4-neon', sessionId, tools, messages: history } as unknown as GenerateOptions))
    const calls = (chunks: StreamChunk[]) => chunks.flatMap(c => c.type === 'block-end' && c.block.type === 'tool-call' ? [c.block] : [])
    const message = (kind: string, text: string, id: string) => ({ role: 'user', id, source: { kind }, content: [{ type: 'text', text }] })
    const result = (toolCallId: string, text: string) => ({ role: 'tool', toolCallId, content: [{ type: 'text', text }] })
    const relay = message('agent-message', 'The child has finished its report', 'child-1')
    let step = await stream()
    const rec = harness.runs.getActiveForOwner(sessionId)!
    assert.ok(rec)
    const resolve = t.mock.method(rec, 'resolveMcpCall')
    if (scenario === 'native before wait') {
      const native = calls(step)
      assert.equal(native[0]?.name, MIRROR_TOOL_NAME)
      const args = JSON.parse(native[0]!.arguments)
      assert.equal(args.tool, 'update_steps')
      await harness.mirrorTool.execute(args, { agent: { session: { id: sessionId } } } as ToolRunContext)
      history.push({ role: 'assistant', content: native }, result(native[0]!.id, 'mirror result'), relay)
      step = await stream()
      assert.equal(resolve.mock.callCount(), 0)
    }
    const waits = calls(step)
    assert.deepEqual(waits.map(c => c.name), ['wait_agent'])
    assert.equal(step.find(c => c.type === 'finish')?.reason.kind, 'tool-calls')
    history.push({ role: 'assistant', content: waits }, result(waits[0]!.id, '{"timedOut":false}'))
    if (scenario !== 'native before wait') history.push(relay)
    step = await stream()
    const expectedMcpCalls = scenario === 'parallel after wait' ? 3 : 1
    if (scenario === 'parallel after wait') {
      const parallel = calls(step)
      assert.deepEqual(parallel.map(c => c.name).sort(), ['mnemon_recall', 'ops_glob'])
      history.push({ role: 'assistant', content: parallel }, result(parallel[0]!.id, 'tool-a'),
        message('time-context', 'An updated clock', 'time'), result(parallel[1]!.id, 'tool-b'),
        relay, // Same stable host ID, even if a projection returns it again on a subsequent step.
        message('user', 'Please focus on the conclusion', 'human-1'), message('runtime-context', 'Runtime snapshot', 'snapshot'))
      step = await stream()
    }
    assert.equal(resolve.mock.callCount(), expectedMcpCalls)
    const waitResult = resolve.mock.calls[0]!.arguments[1]
    assert.equal(waitResult.content[0]?.text, '{"timedOut":false}')
    assert.match(waitResult.content[1]!.text, /agent-message.*The child has finished its report/)
    const text = step.flatMap(c => c.type === 'text-delta' ? [c.text] : []).join('')
    assert.ok(text.startsWith('WAIT[sess_1#1]:')) // one physical ACP prompt; the peer read the real MCP response
    const observed = JSON.parse(text.slice(text.indexOf(':') + 1)) as string[]
    assert.equal(observed[0], '{"timedOut":false}')
    assert.equal(observed.filter(content => content.includes('The child has finished its report')).length, 1)
    assert.equal(observed.filter(content => content.includes('Please focus on the conclusion')).length, scenario === 'parallel after wait' ? 1 : 0)
    assert.ok(observed.every(content => !content.includes('An updated clock') && !content.includes('Runtime snapshot')))
    assert.equal(step.find(c => c.type === 'finish')?.reason.kind, 'stop')
    assert.deepEqual(calls(step), [])
  })
}

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

test('only an outstanding receipt in the current turn can cross an agent-message trailer', () => {
  const runs = new AcpRunStore()
  const key = 'receipts'
  runs.beginHostTurn(key, 42)
  const rec = runs.create(key)
  rec.expectToolResult(2)
  rec.expectToolResult(4)
  const id1 = encodeMirrorCallId(rec.id, 2)
  const id2 = encodeMirrorCallId(rec.id, 4)
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [] },
    { role: 'tool', toolCallId: id1, content: [{ type: 'text', text: 'first' }], isError: false },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: id2, content: [{ type: 'text', text: 'second' }], isError: true }] },
    { role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime' }] },
    { role: 'user', id: 'inbox-1', source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'child reply' }] },
  ]
  const continuation = detectContinuation(messages, runs.getContinuationForOwner(key), runs.hasHostTurn(rec))
  assert.deepEqual(continuation?.toolResults, [
    { itemIndex: 2, result: { content: [{ type: 'text', text: 'first' }], isError: false } },
    { itemIndex: 4, result: { content: [{ type: 'text', text: 'second' }], isError: true } },
  ])
  assert.deepEqual(continuation?.midTurnMessages, [{ key: 'id:inbox-1', source: 'agent-message', text: 'child reply' }])
  rec.finish('end_turn')
  assert.equal(runs.getActiveForOwner(key), undefined)
  assert.equal(detectContinuation(messages, rec), null)
  assert.ok(detectContinuation(messages, runs.getContinuationForOwner(key), runs.hasHostTurn(rec)))
  runs.endHostTurn(key, 42)
  assert.equal(detectContinuation(messages, runs.getContinuationForOwner(key)), null)
  runs.beginHostTurn(key, 43)
  assert.equal(detectContinuation(messages, runs.getContinuationForOwner(key)), null)
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

test('restricted subagent without agy_acp_tool still delegates reverse MCP tools natively without bypassing DSH loop', { timeout: 10_000 }, async (t) => {
  const harness = createDelegationHarness()
  t.after(() => harness.dispose())

  // Simulate a restricted subagent (e.g. Mnemon isolated subagent) whose tools.restrict() hides agy_acp_tool
  // and exposes only scoped/allowlisted DSH tools.
  const restrictedTools = [harness.dshTools[0]!]

  const span1 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: restrictedTools,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] } as Message],
      sessionId: 'sess-restricted-subagent',
    } as unknown as GenerateOptions),
  )

  const calls1 = span1
    .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
  assert.equal(calls1.length, 1)
  assert.equal(calls1[0]!.name, 'ops_glob')
  assert.equal(span1.find((c) => c.type === 'finish')?.reason.kind, 'tool-calls')

  const span2 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: restrictedTools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] },
        { role: 'assistant', content: calls1 },
        { role: 'tool', toolCallId: calls1[0]!.id, content: [{ type: 'text', text: 'restricted-ok' }], isError: false },
      ],
      sessionId: 'sess-restricted-subagent',
    } as unknown as GenerateOptions),
  )
  assert.equal(span2.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'MCP_RESULT:OK:restricted-ok')
  assert.equal(span2.find((c) => c.type === 'finish')?.reason.kind, 'stop')

  // No-tool step (`tools: []`) disables delegation and returns an explicit tool error rather than invoking tools.execute
  const noToolSpan = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_SINGLE' }] } as Message],
      sessionId: 'sess-restricted-subagent',
    } as unknown as GenerateOptions),
  )
  assert.equal(noToolSpan.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call').length, 0)
  assert.match(
    noToolSpan.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
    /MCP_RESULT:ERR:Error: Tool "ops_glob" is not available in this DSH step/,
  )
  assert.equal(noToolSpan.find((c) => c.type === 'finish')?.reason.kind, 'stop')
})

test('restricted PTC subagent delegates MCP via run_code without emitting unavailable agy_acp_tool mirror calls', { timeout: 10_000 }, async (t) => {
  const harness = createDelegationHarness({ canUseMirrorTool: () => false })
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
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_MIXED' }] } as Message],
      sessionId: 'sess-restricted-ptc',
    } as unknown as GenerateOptions),
  )

  const calls1 = span1
    .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block as Extract<typeof c.block, { type: 'tool-call' }>)
  assert.equal(calls1.length, 1)
  assert.equal(calls1[0]!.name, WRAPPER_TOOL_NAME)
  const ptcArgs = JSON.parse(calls1[0]!.arguments) as { code: string; description: string }
  assert.match(ptcArgs.code, /tools\["ops_glob"\]/)
  assert.doesNotMatch(ptcArgs.code, /agy_acp_tool/)

  const span2 = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      tools: [tsRunCodeSchema],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'DELEGATE_MCP_MIXED' }] },
        { role: 'assistant', content: calls1 },
        { role: 'tool', toolCallId: calls1[0]!.id, content: [{ type: 'text', text: 'ptc-ok' }], isError: false },
      ],
      sessionId: 'sess-restricted-ptc',
    } as unknown as GenerateOptions),
  )

  // Native `read_file` must NOT be mirrored into `run_code` calling `agy_acp_tool` since mirror tool is hidden
  const calls2 = span2.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(calls2.length, 0)
  assert.equal(span2.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'MIXED_DONE:ptc-ok')
  assert.equal(span2.find((c) => c.type === 'finish')?.reason.kind, 'stop')
})

test('ReverseMcpBridge filters overlapping local basic tools while preserving DSH subagent/routing tools', { timeout: 10_000 }, async (t) => {
  const routingTools = [
    'subagent',
    'subagent_fork',
    'list_agents',
    'wait_agent',
    'send_message',
    'list_subagent_models',
  ]
  for (const name of routingTools) {
    assert.equal(OVERLAPPING_NATIVE_DSH_TOOLS.has(name), false, `${name} must not be filtered as overlapping`)
  }
  for (const basic of ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'web_search', 'todo_write', 'ask_user_question', 'job_output', 'job_list', 'job_kill']) {
    assert.equal(OVERLAPPING_NATIVE_DSH_TOOLS.has(basic), true, `${basic} should remain filtered by default`)
  }

  const allTools = [
    ...[...OVERLAPPING_NATIVE_DSH_TOOLS],
    MIRROR_TOOL_NAME,
    WRAPPER_TOOL_NAME,
    ...routingTools,
    'mnemon_recall',
    'team_route_delegate',
  ]
  const bridge = new ReverseMcpBridge({
    excludeOverlappingNativeTools: true,
    listTools: () => allTools.map((name) => ({ name })),
    callTool: async (name, args) => ({
      content: [{ type: 'text', text: `called:${name}:${JSON.stringify(args)}` }],
      isError: false,
    }),
  })
  await bridge.start()
  t.after(() => bridge.dispose())

  const spec = bridge.getHttpMcpServerSpec()!
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...Object.fromEntries((spec.headers ?? []).map((h) => [h.name, h.value])),
  }
  const rpc = async (id: number, method: string, params?: Record<string, unknown>) => {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    return (await res.json()) as { result?: Record<string, unknown> }
  }

  const listed = await rpc(1, 'tools/list')
  const names = ((listed.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name)
  assert.deepEqual(names, [...routingTools, 'mnemon_recall', 'team_route_delegate'])

  const subagentCall = await rpc(2, 'tools/call', {
    name: 'subagent',
    arguments: { provider: 'aisub2api', model: 'gpt-6.2-astra', prompt: 'design check' },
  })
  assert.equal(subagentCall.result?.isError, false)
  assert.match(String((subagentCall.result?.content as Array<{ text: string }>)?.[0]?.text ?? ''), /called:subagent:/)

  const blockedBasic = await rpc(3, 'tools/call', { name: 'bash', arguments: { command: 'pwd' } })
  assert.equal(blockedBasic.result?.isError, true)
})

test('AcpAdapter injects subagent MCP bridge guidance only when reverse MCP bridge and subagent tool are active', { timeout: 10_000 }, async (t) => {
  const harness = createDelegationHarness()
  t.after(() => harness.dispose())

  const mirrorSchema = { name: MIRROR_TOOL_NAME, description: '', parameters: { type: 'object', properties: {} } }
  const subagentSchema = { name: 'subagent', description: 'Spawn DSH subagent', parameters: { type: 'object', properties: {} } }

  // 1. Standard mode with subagent tool available + mcpBridge enabled -> guidance mentions mcp_dsh-tools_subagent
  const withSubagent = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      system: 'Task-category model routing is configured.',
      tools: [mirrorSchema, subagentSchema, ...harness.dshTools],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ECHO_SYSTEM subagent-on' }] } as Message],
      sessionId: 'sess-subagent-guidance-on',
    } as unknown as GenerateOptions),
  )
  const textOn = withSubagent.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.match(textOn, /mcp_dsh-tools_subagent/)

  // 2. Standard mode restricted subagent without `subagent` tool -> guidance omits mcp_dsh-tools_subagent
  const withoutSubagent = await collectChunks(
    harness.adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      system: 'Restricted child prompt.',
      tools: [harness.dshTools[0]!],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ECHO_SYSTEM subagent-off' }] } as Message],
      sessionId: 'sess-subagent-guidance-off',
    } as unknown as GenerateOptions),
  )
  const textOff = withoutSubagent.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(textOff.includes('mcp_dsh-tools_subagent'), false)
})
