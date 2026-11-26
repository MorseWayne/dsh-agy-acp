import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compactToolsForAgyBudget,
  DEFAULT_MAX_EAGER_SCHEMA_BYTES,
  estimateAgyMcpBytes,
  normalizeBridgeTool,
  truncateDescriptionText,
} from '../src/mcp/schema-budget.ts'
import { ReverseMcpBridge } from '../src/mcp/server.ts'

test('compactToolsForAgyBudget leaves small tool catalogs completely untouched', () => {
  const tools = [
    normalizeBridgeTool({
      name: 'mnemon_runtime_memory',
      description: 'Detailed hot memory instructions. '.repeat(40),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'Mutation kind.' },
          target: { type: 'string', enum: ['memory', 'user'], description: 'Target file.' },
        },
        required: ['action', 'target'],
      },
    }),
  ]

  const res = compactToolsForAgyBudget(tools)
  assert.equal(res.compacted, false)
  assert.deepEqual(res.tools, tools)
  assert.equal(res.finalEstimatedBytes, res.originalEstimatedBytes)
})

test('compactToolsForAgyBudget compacts oversized 60-tool catalogs below budget while preserving schema structure and description-named properties', () => {
  const tools = Array.from({ length: 58 }, (_, i) =>
    normalizeBridgeTool({
      name: `dsh_tool_${i + 1}`,
      description: `Tool ${i + 1} summary sentence. ` + 'Extra verbose detail '.repeat(35),
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A real parameter literally named description. ' + 'Guidance '.repeat(30),
          },
          mode: {
            type: 'string',
            enum: ['fast', 'full'],
            description: 'Execution mode selector. ' + 'More notes '.repeat(25),
          },
        },
        required: ['description'],
      },
    }),
  )
  tools.push(
    normalizeBridgeTool({
      name: 'mnemon_runtime_memory',
      description: 'Maintain compact hot memory injected into future turns. ' + 'Long protocol guidance. '.repeat(70),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'Mutation action.' },
          target: { type: 'string', enum: ['memory', 'user'], description: 'Target runtime file.' },
          content: { type: 'string', description: 'Compact entry content.' },
          old_text: { type: 'string', description: 'Unique existing entry match.' },
          branches: { type: 'array', items: { type: 'string' }, description: 'Optional git branches.' },
        },
        required: ['action', 'target'],
      },
    }),
    normalizeBridgeTool({
      name: 'workflow',
      description: 'Run a JavaScript orchestration script. ' + 'Hook documentation. '.repeat(65),
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'Plain JavaScript body.' },
          meta: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Workflow name.' },
              description: { type: 'string', description: 'One-line workflow description.' },
            },
            required: ['name', 'description'],
          },
        },
        required: ['script', 'meta'],
      },
    }),
  )

  const originalEstimated = estimateAgyMcpBytes(tools)
  assert.ok(originalEstimated > DEFAULT_MAX_EAGER_SCHEMA_BYTES, `expected test fixture > budget, got ${originalEstimated}`)

  const res = compactToolsForAgyBudget(tools)
  assert.equal(res.compacted, true)
  assert.equal(res.tools.length, 60)
  assert.ok(
    res.finalEstimatedBytes <= DEFAULT_MAX_EAGER_SCHEMA_BYTES,
    `expected compacted size <= ${DEFAULT_MAX_EAGER_SCHEMA_BYTES}, got ${res.finalEstimatedBytes}`,
  )

  const runtime = res.tools.find((t) => t.name === 'mnemon_runtime_memory')
  assert.ok(runtime, 'mnemon_runtime_memory must be preserved')
  assert.deepEqual(runtime.inputSchema.required, ['action', 'target'])
  const runtimeProps = runtime.inputSchema.properties as Record<string, { enum?: string[]; items?: { type: string } }>
  assert.deepEqual(runtimeProps.action?.enum, ['add', 'replace', 'remove'])
  assert.deepEqual(runtimeProps.target?.enum, ['memory', 'user'])
  assert.deepEqual(runtimeProps.branches?.items, { type: 'string' })

  // A parameter literally named `description` inside `properties` must never be stripped or mangled.
  const firstToolProps = res.tools[0]!.inputSchema.properties as Record<string, { type?: string }>
  assert.equal(firstToolProps.description?.type, 'string')
  const workflowProps = res.tools.find((t) => t.name === 'workflow')!.inputSchema.properties as Record<
    string,
    { properties?: Record<string, { type?: string }> }
  >
  assert.equal(workflowProps.meta?.properties?.description?.type, 'string')
})

test('truncateDescriptionText prefers clean sentence boundaries and respects maxChars', () => {
  const input = 'First concise sentence. Second sentence with extra details that pushes past the cap.'
  const out = truncateDescriptionText(input, 40)
  assert.ok(out.length <= 40)
  assert.equal(out, 'First concise sentence.…')
  assert.equal(truncateDescriptionText('short', 40), 'short')
})

test('ReverseMcpBridge tools/list compacts oversized catalogs and logs compaction summary', async () => {
  const logs: string[] = []
  const largeCatalog = Array.from({ length: 60 }, (_, i) => ({
    name: i === 18 ? 'mnemon_runtime_memory' : `bulk_tool_${i + 1}`,
    description: `Bulk tool #${i + 1}. ` + 'Detailed explanation text. '.repeat(40),
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Parameter documentation. '.repeat(20) },
      },
      required: ['input'],
    },
  }))

  const bridge = new ReverseMcpBridge({
    listTools: () => largeCatalog,
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    log: (msg) => logs.push(msg),
  })
  const url = await bridge.start()
  const spec = bridge.getHttpMcpServerSpec()
  assert.ok(spec)
  const auth = spec.headers?.find((h) => h.name === 'Authorization')?.value ?? ''

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } }
    assert.equal(body.result.tools.length, 60)
    assert.ok(body.result.tools.some((t) => t.name === 'mnemon_runtime_memory'))
    assert.ok(
      estimateAgyMcpBytes(body.result.tools) <= DEFAULT_MAX_EAGER_SCHEMA_BYTES,
      'tools/list response should fit within ACP eager schema budget',
    )
    assert.ok(logs.some((line) => line.includes('compacted reverse MCP schemas for 60 tools')))
  } finally {
    await bridge.dispose()
  }
})
