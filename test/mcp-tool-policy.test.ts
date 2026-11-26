import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig, validateConfigPatchInput } from '../src/common/config.ts'
import {
  buildActiveReplacementGuidance,
  buildLazyToolCatalogGuidance,
  classifyDshTool,
  compactMcpToolPolicy,
  DSH_CALL_TOOL_NAME,
  DSH_DISCOVER_TOOLS_NAME,
  META_GATEWAY_ESTIMATED_BYTES,
  resolveEffectiveMcpToolPolicy,
  resolveToolExposure,
  validateMcpToolPolicyInput,
} from '../src/common/mcp-tool-policy.ts'
import { computeLivePolicyBudget } from '../src/client/mcp-tool-panel.ts'
import { ReverseMcpBridge } from '../src/mcp/server.ts'
import { prepareSystemPrompt } from '../src/provider/prompt-builder.ts'

async function rpcCall(
  url: string,
  headers: Record<string, string>,
  id: number,
  method: string,
  params?: Record<string, unknown>,
) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } }
}

test('default mcpToolPolicy partitions DSH tools into lossless eager core, on-demand lazy, and native-off', () => {
  const effective = resolveEffectiveMcpToolPolicy()

  // Core supplements -> eager
  for (const name of ['mnemon_runtime_memory', 'mnemon_recall', 'present', 'skill', 'web_fetch']) {
    const res = resolveToolExposure(name, effective)
    assert.equal(res.mode, 'eager', `${name} should default to eager`)
  }

  // Subagent routing -> replace (eager + replacedNative)
  for (const name of ['subagent', 'subagent_fork', 'list_agents', 'wait_agent', 'send_message', 'list_subagent_models']) {
    const res = resolveToolExposure(name, effective)
    assert.equal(res.mode, 'eager', `${name} should default to eager`)
    assert.equal(res.replacedNative, true, `${name} should mark replacedNative`)
  }

  // Overlapping native basics (including new ops_* file tools) -> off by default
  for (const name of [
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search', 'todo_write', 'ask_user_question',
    'ops_inspect_local_file', 'ops_glob', 'ops_grep', 'ops_edit_file', 'ops_write_file', 'schedule_create',
  ]) {
    const res = resolveToolExposure(name, effective)
    assert.equal(res.mode, 'off', `${name} should default to off (native)`)
  }

  // Specialized & low-frequency & unknown 3rd-party plugins -> lazy
  for (const name of [
    'ops_read_pdf', 'ops_read_docx', 'office_convert', 'workflow', 'team_task_create', 'create_goal',
    'codex_image_generate', 'plugin_manager', 'mnemon_memory_bodies', 'mnemon_subagent_result',
    'custom_plugin_jira_sync',
  ]) {
    const res = resolveToolExposure(name, effective)
    assert.equal(res.mode, 'lazy', `${name} should default to lazy`)
  }
  assert.equal(classifyDshTool('custom_plugin_jira_sync').id, 'other_plugins')
})

test('legacy mcpExposeOverlappingTools maps unset replace groups while explicit policy and per-tool overrides win', () => {
  const legacyOnly = resolveEffectiveMcpToolPolicy(undefined, true)
  assert.equal(resolveToolExposure('web_search', legacyOnly).mode, 'eager')
  assert.equal(resolveToolExposure('ops_edit_file', legacyOnly).mode, 'eager')
  assert.equal(resolveToolExposure('bash', legacyOnly).mode, 'eager')

  const mixed = resolveEffectiveMcpToolPolicy(
    {
      groups: { media_system: 'eager' },
      replace: { web_search: 'native', subagents: 'native' },
      overrides: { ops_read_pdf: 'eager', present: 'off', bash: 'lazy' },
    },
    true,
  )
  assert.equal(resolveToolExposure('web_search', mixed).mode, 'off')
  assert.equal(resolveToolExposure('subagent', mixed).mode, 'off')
  assert.equal(resolveToolExposure('ops_edit_file', mixed).mode, 'eager')
  assert.equal(resolveToolExposure('codex_image_generate', mixed).mode, 'eager')
  assert.equal(resolveToolExposure('ops_read_pdf', mixed).mode, 'eager')
  assert.equal(resolveToolExposure('present', mixed).mode, 'off')
  assert.equal(resolveToolExposure('bash', mixed).mode, 'lazy')
})

test('validateMcpToolPolicyInput and validateConfigPatchInput validate, compact, and reject invalid inputs', () => {
  const ok = validateConfigPatchInput({
    mcpToolPolicy: {
      groups: { memory_core: 'eager', media_system: 'eager' },
      replace: { subagents: 'replace', web_search: 'replace' },
      overrides: { ops_read_pdf: 'eager' },
    },
  })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    // Defaults (`memory_core: eager`, `subagents: replace`) are compacted away
    assert.deepEqual(ok.patch.mcpToolPolicy, {
      groups: { media_system: 'eager' },
      replace: { web_search: 'replace' },
      overrides: { ops_read_pdf: 'eager' },
    })
  }

  assert.equal(compactMcpToolPolicy({ groups: { memory_core: 'eager' }, replace: { subagents: 'replace' } }), undefined)
  assert.equal(validateMcpToolPolicyInput({ groups: { bad_group: 'eager' } }).ok, false)
  assert.equal(validateMcpToolPolicyInput({ replace: { web_search: 'eager' } }).ok, false)
  assert.equal(validateMcpToolPolicyInput({ overrides: { 'bad name!': 'eager' } }).ok, false)
  assert.equal(validateMcpToolPolicyInput({ extra: {} }).ok, false)

  const resolved = resolveConfig({ mcpToolPolicy: { replace: { web_search: 'replace' } } })
  assert.deepEqual(resolved.mcpToolPolicy, { replace: { web_search: 'replace' } })
})

test('ReverseMcpBridge with toolPolicy keeps eager schemas lossless and serves lazy tools via dsh_discover_tools / dsh_call_tool', async (t) => {
  const longWorkflowDesc =
    'Run a JavaScript workflow script that orchestrates subagents at scale. Exact format: export default async function(ctx) { return ctx.parallel([...]) }.'
  const longParamDesc = 'Full JavaScript source string with phases, parallel fan-out, and structured return value.'

  const hostTools = [
    {
      name: 'mnemon_runtime_memory',
      description: 'Maintain compact hot memory injected into future turns. '.repeat(25),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'Mutation operation to perform.' },
          target: { type: 'string', enum: ['memory', 'user'], description: 'Target hot memory file.' },
          content: { type: 'string', description: 'Durable fact or rule content.' },
        },
        required: ['action', 'target'],
      },
    },
    {
      name: 'subagent',
      description: 'Delegate a self-contained task to a subagent with task-category model routing.',
      inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'Task prompt.' } }, required: ['prompt'] },
    },
    {
      name: 'workflow',
      description: longWorkflowDesc,
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: longParamDesc },
          meta: { type: 'object', properties: { description: { type: 'string', description: 'Workflow summary.' } } },
        },
        required: ['script'],
      },
    },
    {
      name: 'codex_image_generate',
      description: 'Generate or edit PNG/WebP images via ChatGPT subscription.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed visual prompt.' },
          size: { type: 'string', description: 'Image size such as 1024x1024.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'bash',
      description: 'Execute shell command.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    },
    {
      name: 'ops_edit_file',
      description: 'Patch UTF-8 file with CAS revision.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ]

  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const logs: string[] = []
  const bridge = new ReverseMcpBridge({
    toolPolicy: resolveEffectiveMcpToolPolicy(),
    listTools: () => hostTools,
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: `ok:${name}:${JSON.stringify(args)}` }], isError: false }
    },
    log: (m) => logs.push(m),
  })
  await bridge.start()
  t.after(() => bridge.dispose())

  const spec = bridge.getHttpMcpServerSpec()!
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...Object.fromEntries((spec.headers ?? []).map((h) => [h.name, h.value])),
  }

  // 1. tools/list returns only eager tools + 2 meta-gateway tools, completely uncompacted (lossless!)
  const listed = await rpcCall(spec.url, headers, 1, 'tools/list')
  const tools = (listed.result?.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) ?? []
  assert.deepEqual(
    tools.map((x) => x.name),
    ['mnemon_runtime_memory', 'subagent', DSH_DISCOVER_TOOLS_NAME, DSH_CALL_TOOL_NAME],
  )
  const memTool = tools.find((x) => x.name === 'mnemon_runtime_memory')!
  assert.equal(memTool.description, hostTools[0]!.description)
  assert.equal(
    ((memTool.inputSchema.properties as Record<string, { description?: string }>).action)?.description,
    'Mutation operation to perform.',
  )
  assert.equal(logs.some((l) => l.includes('compaction')), false, 'must stay lossless without fallback compaction')

  // 2. dsh_discover_tools returns 100% full schema & parameter descriptions for lazy tools
  const discovered = await rpcCall(spec.url, headers, 2, 'tools/call', {
    name: DSH_DISCOVER_TOOLS_NAME,
    arguments: { names: ['workflow', 'bash'] },
  })
  assert.equal(discovered.result?.isError, false)
  const discJson = JSON.parse((discovered.result?.content as Array<{ text: string }>)[0]!.text) as {
    tools: Array<{ name: string; description: string; inputSchema: { properties: { script: { description: string } } } }>
    notFound?: string[]
  }
  assert.equal(discJson.tools.length, 1)
  assert.equal(discJson.tools[0]!.name, 'workflow')
  assert.equal(discJson.tools[0]!.description, longWorkflowDesc)
  assert.equal(discJson.tools[0]!.inputSchema.properties.script.description, longParamDesc)
  assert.deepEqual(discJson.notFound, ['bash'])

  // 3. dsh_discover_tools keyword query matches codex_image_generate
  const queried = await rpcCall(spec.url, headers, 3, 'tools/call', {
    name: DSH_DISCOVER_TOOLS_NAME,
    arguments: { query: 'image' },
  })
  const queryJson = JSON.parse((queried.result?.content as Array<{ text: string }>)[0]!.text) as {
    tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>
  }
  assert.deepEqual(queryJson.tools.map((x) => x.name), ['codex_image_generate'])
  assert.ok(queryJson.tools[0]!.inputSchema)

  // 4. dsh_call_tool invokes lazy tool seamlessly
  const invoked = await rpcCall(spec.url, headers, 4, 'tools/call', {
    name: DSH_CALL_TOOL_NAME,
    arguments: { name: 'workflow', arguments: { script: 'return 42' } },
  })
  assert.equal(invoked.result?.isError, false)
  assert.deepEqual(calls, [{ name: 'workflow', args: { script: 'return 42' } }])

  // 5. Disabled tools (`bash`, `ops_edit_file`) are rejected both via dsh_call_tool and direct call
  const deniedViaGateway = await rpcCall(spec.url, headers, 5, 'tools/call', {
    name: DSH_CALL_TOOL_NAME,
    arguments: { name: 'bash', arguments: { command: 'ls' } },
  })
  assert.equal(deniedViaGateway.result?.isError, true)

  const deniedDirect = await rpcCall(spec.url, headers, 6, 'tools/call', {
    name: 'ops_edit_file',
    arguments: { path: 'README.md' },
  })
  assert.equal(deniedDirect.result?.isError, true)

  // 6. Recursive meta-gateway call is rejected
  const recursive = await rpcCall(spec.url, headers, 7, 'tools/call', {
    name: DSH_CALL_TOOL_NAME,
    arguments: { name: DSH_CALL_TOOL_NAME, arguments: {} },
  })
  assert.equal(recursive.result?.isError, true)
})

test('prompt builder injects dynamic replacement guidance and compact lazy tool catalog', () => {
  const policy = resolveEffectiveMcpToolPolicy({
    replace: { subagents: 'native', web_search: 'replace', shell_jobs: 'replace' },
  })
  const available = new Set(['subagent', 'web_search', 'bash', 'workflow', 'codex_image_generate'])
  const replacements = buildActiveReplacementGuidance(policy, available)
  assert.equal(replacements.length, 2)
  assert.ok(replacements.some((line) => line.includes('mcp_dsh-tools_web_search')))
  assert.ok(replacements.some((line) => line.includes('mcp_dsh-tools_bash')))
  assert.equal(replacements.some((line) => line.includes('mcp_dsh-tools_subagent')), false)

  const lazyCatalog = buildLazyToolCatalogGuidance([
    { name: 'workflow', description: 'Run workflow' },
    { name: 'codex_image_generate', description: 'Generate image' },
  ])
  assert.ok(lazyCatalog)
  assert.match(lazyCatalog, /mcp_dsh-tools_dsh_discover_tools/)
  assert.match(lazyCatalog, /mcp_dsh-tools_dsh_call_tool/)
  assert.match(lazyCatalog, /workflow/)
  assert.match(lazyCatalog, /codex_image_generate/)

  const prepared = prepareSystemPrompt('Host system prompt.', undefined, {
    replacementGuidance: replacements,
    lazyToolCatalog: lazyCatalog,
  })
  assert.ok(prepared)
  assert.match(prepared.append, /mcp_dsh-tools_web_search/)
  assert.match(prepared.append, /mcp_dsh-tools_dsh_discover_tools/)
})

test('computeLivePolicyBudget reflects group and override changes in real time', () => {
  const catalog = {
    tools: [
      {
        name: 'mnemon_runtime_memory',
        groupId: 'memory_core' as const,
        kind: 'supplement' as const,
        description: 'Hot memory',
        estimatedBytes: 2_500,
        effectiveMode: 'eager' as const,
        replacedNative: false,
        overridden: false,
      },
      {
        name: 'workflow',
        groupId: 'goals_teams_workflow' as const,
        kind: 'supplement' as const,
        description: 'Run workflow',
        estimatedBytes: 3_000,
        effectiveMode: 'lazy' as const,
        replacedNative: false,
        overridden: false,
      },
      {
        name: 'web_search',
        groupId: 'web_search' as const,
        kind: 'replace' as const,
        description: 'Search web',
        estimatedBytes: 1_200,
        effectiveMode: 'off' as const,
        replacedNative: false,
        overridden: false,
      },
    ],
    eagerCount: 1,
    lazyCount: 1,
    offCount: 1,
    estimatedEagerBytes: 2_500 + META_GATEWAY_ESTIMATED_BYTES,
    budgetBytes: 5_000,
    willCompact: false,
    source: 'live' as const,
  }

  const defBudget = computeLivePolicyBudget(catalog, resolveEffectiveMcpToolPolicy())
  assert.equal(defBudget.eagerCount, 1)
  assert.equal(defBudget.lazyCount, 1)
  assert.equal(defBudget.offCount, 1)
  assert.equal(defBudget.estimatedEagerBytes, 2_500 + META_GATEWAY_ESTIMATED_BYTES)
  assert.equal(defBudget.willCompact, false)

  // Promoting workflow + web_search to eager removes meta-gateway (0 lazy left) and exceeds 5_000 budget
  const heavyPolicy = resolveEffectiveMcpToolPolicy({
    groups: { goals_teams_workflow: 'eager' },
    replace: { web_search: 'replace' },
  })
  const heavyBudget = computeLivePolicyBudget(catalog, heavyPolicy)
  assert.equal(heavyBudget.eagerCount, 3)
  assert.equal(heavyBudget.lazyCount, 0)
  assert.equal(heavyBudget.offCount, 0)
  assert.equal(heavyBudget.estimatedEagerBytes, 2_500 + 3_000 + 1_200)
  assert.equal(heavyBudget.willCompact, true)
})
