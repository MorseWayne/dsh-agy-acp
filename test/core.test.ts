import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/common/config.ts'
import { isGeoUnsupportedError, isUnsupportedGeoCountry, maskIpAddress, normalizeGeoCountryCode } from '../src/common/geo.ts'
import { sanitizeDiagnosticText } from '../src/common/sanitize.ts'
import { MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME } from '../src/common/types.ts'
import { detectContinuation } from '../src/provider/adapter.ts'
import {
  compactDisplayInput,
  defineAgyAcpMirrorTool,
  presentMirrorCall,
  presentMirrorResult,
} from '../src/provider/mirror-tool.ts'
import { buildPromptBlocks, prepareSystemPrompt, type PromptMessage } from '../src/provider/prompt-builder.ts'
import { AcpRunStore, decodeMirrorCallId, encodeMirrorCallId } from '../src/provider/run-store.ts'

test('resolveConfig applies defaults and parses env-style strings', () => {
  const cfg = resolveConfig({ enabled: 'false', permissionMode: 'plan', mcpBridge: '1' })
  assert.equal(cfg.enabled, false)
  assert.equal('permissionMode' in cfg, false)
  assert.equal(cfg.mcpBridge, true)

  const fallback = resolveConfig({ permissionMode: 'invalid-mode' })
  assert.equal(fallback.enabled, true)
  assert.equal('permissionMode' in fallback, false)
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

test('presentMirrorResult projects read, search (matches & paths), and web cards with strict contracts and no-meta fallback', () => {
  // 1. ReadResultView (numbered lines + lang + no meta required)
  const readArgs = {
    run: 'r1',
    step: 1,
    tool: 'read_file',
    input: { Path: 'src/app.ts', StartLine: 10 },
  }
  const readView = presentMirrorResult(readArgs, {
    content: [{ type: 'text', text: 'Showing lines 10 to 11 of 40\n10: const x = 1\n11: export default x\n' }],
    isError: false,
  })
  assert.equal(readView.card, 'read')
  if (readView.card === 'read') {
    assert.equal(readView.path, 'src/app.ts')
    assert.equal(readView.lang, 'ts')
    assert.equal(readView.offset, 10)
    assert.equal(readView.totalLines, 40)
    assert.deepEqual(readView.lines, [
      { number: 10, text: 'const x = 1' },
      { number: 11, text: 'export default x' },
    ])
  }

  // Error read falls back to generic
  assert.equal(
    presentMirrorResult(readArgs, { content: [{ type: 'text', text: 'ENOENT' }], isError: true }).card,
    'generic',
  )

  // 2. SearchMatchesResultView (grep)
  const grepView = presentMirrorResult(
    { run: 'r1', step: 2, tool: 'grep_search', input: { Query: 'foo', SearchPath: 'src' } },
    { content: [{ type: 'text', text: 'src/a.ts:12:const foo = 1\nsrc/a.ts:18:return foo\nsrc/b.ts:3:import foo' }], isError: false },
  )
  assert.deepEqual(grepView, {
    card: 'search',
    shape: 'matches',
    title: 'Search "foo" in src',
    files: [
      { path: 'src/a.ts', matches: [{ lineNumber: 12, line: 'const foo = 1' }, { lineNumber: 18, line: 'return foo' }] },
      { path: 'src/b.ts', matches: [{ lineNumber: 3, line: 'import foo' }] },
    ],
    truncated: false,
    total: 3,
  })

  // 3. SearchPathsResultView (glob / list_dir)
  const globView = presentMirrorResult(
    { run: 'r1', step: 3, tool: 'glob', input: { DirectoryPath: 'src' } },
    { content: [{ type: 'text', text: 'src/index.ts\nsrc/provider/adapter.ts\n' }], isError: false },
  )
  assert.deepEqual(globView, {
    card: 'search',
    shape: 'paths',
    title: 'List src',
    paths: ['src/index.ts', 'src/provider/adapter.ts'],
    truncated: false,
    total: 2,
  })

  // 4. WebSearchResultView (without meta, from markdown links)
  const webSearchView = presentMirrorResult(
    { run: 'r1', step: 4, tool: 'search_web', input: { Query: 'acp spec' } },
    { content: [{ type: 'text', text: 'See [ACP Spec](https://example.com/acp) and [Docs](https://example.com/docs).' }], isError: false },
  )
  assert.equal(webSearchView.card, 'web')
  if (webSearchView.card === 'web' && webSearchView.kind === 'search') {
    assert.equal(webSearchView.sources.length, 2)
    assert.equal(webSearchView.sources[0]?.url, 'https://example.com/acp')
  }

  // 5. WebFetchResultView requires real HTTP statusCode (never fabricates 200)
  const fetchArgs = { run: 'r1', step: 5, tool: 'web_fetch', input: { Url: 'https://example.com' } }
  assert.equal(
    presentMirrorResult(fetchArgs, { content: [{ type: 'text', text: 'Hello world body' }], isError: false }).card,
    'generic',
  )
  const fetchWithStatus = presentMirrorResult(fetchArgs, {
    content: [{ type: 'text', text: 'Status: 200\nHello world' }],
    isError: false,
  })
  assert.deepEqual(fetchWithStatus, {
    card: 'web',
    kind: 'fetch',
    title: 'Fetch https://example.com',
    url: 'https://example.com',
    statusCode: 200,
    truncated: false,
  })
})

test('mirrorTool.execute output satisfies output.schema strictly and compactDisplayInput bounds oversized payloads', async () => {
  const store = new AcpRunStore()
  const rec = store.create('sess-schema')
  rec.pushUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc_web',
    name: 'web_fetch',
    kind: 'fetch',
    status: 'in_progress',
    locations: [{ path: 'ignored.ts', line: 12.9 }],
    rawInput: { Url: 'https://example.com/page', huge: 'x'.repeat(30_000) },
  })
  rec.pushUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_web',
    status: 'completed',
    rawOutput: { statusCode: 201, output: 'created' },
  })

  const mirror = defineAgyAcpMirrorTool(store)
  const args = { run: rec.id, step: 0, toolCallId: 'tc_web', tool: 'web_fetch' }
  const val = await mirror.execute(args, { agent: { session: { id: 'sess-schema' } } } as ToolRunContext)
  // Strict validation against dsh-tools output.schema (additionalProperties: false)
  validateJsonSchemaValue(mirror.output.schema, val)
  const compact = compactDisplayInput({ CommandLine: 'echo ok', big: 'y'.repeat(20_000) }) as Record<string, unknown>
  assert.equal(compact.CommandLine, 'echo ok')
  assert.equal('big' in compact, false)
})

test('buildPromptBlocks stops trailingUsers at tool messages and builds budget-aware digest unwrapping mirror tools', () => {
  const messages: PromptMessage[] = [
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'STALE_RUNTIME_SNAPSHOT' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run the check' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          id: 'c1' as never,
          name: MIRROR_TOOL_NAME,
          arguments: JSON.stringify({ run: 'r', step: 0, tool: 'run_command', title: 'npm test', input: { CommandLine: 'npm test' } }),
        },
        {
          type: 'tool-call',
          id: 'c2' as never,
          name: WRAPPER_TOOL_NAME,
          arguments: JSON.stringify({ code: `await tools[${JSON.stringify(MIRROR_TOOL_NAME)}](${JSON.stringify({ run: 'r', step: 1, tool: 'read_file', title: 'Read index.ts' })})` }),
        },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'PASS 39/39' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'now fix the bug' }] },
  ]

  const first = buildPromptBlocks(messages, true)
  assert.equal(first.length, 2)
  const digest = (first[0] as { text: string }).text
  assert.match(digest, /\[tool_call: run_command\] npm test/)
  assert.match(digest, /\[tool_call: read_file\] Read index\.ts/)
  assert.match(digest, /\[tool_result\]: PASS 39\/39/)
  assert.equal(digest.includes(MIRROR_TOOL_NAME), false)
  assert.equal(digest.includes('STALE_RUNTIME_SNAPSHOT'), false)
  assert.equal((first[1] as { text: string }).text, 'now fix the bug')

  // TrailingUsers must not cross role='tool' to duplicate earlier user text
  const afterTool: PromptMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'earlier user turn' }] },
    { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: 'tool output' }] },
    { role: 'user', content: [{ type: 'text', text: 'latest prompt' }] },
  ]
  const follow = buildPromptBlocks(afterTool, false)
  assert.deepEqual(follow, [{ type: 'text', text: 'latest prompt' }])

  // prepareSystemPrompt appends bridge guidance and returns stable hash
  const sys = prepareSystemPrompt('Always respond in Chinese.')
  assert.ok(sys)
  assert.match(sys.append, /Always respond in Chinese\./)
  assert.match(sys.append, /Host Bridge Guidance/)
  assert.equal(prepareSystemPrompt('   '), null)
})

test('detectContinuation takes max itemIndex across out-of-order concurrent tool results', () => {
  const id2 = encodeMirrorCallId('runA', 5)
  const id1 = encodeMirrorCallId('runA', 3)
  const cont = detectContinuation([
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [] },
    { role: 'tool', toolCallId: id2, content: [{ type: 'text', text: 'res2' }] },
    { role: 'tool', toolCallId: id1, content: [{ type: 'text', text: 'res1' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ctx' }] },
  ])
  assert.deepEqual(cont, { runId: 'runA', itemIndex: 5 })
  assert.equal(detectContinuation([
    { role: 'tool', toolCallId: id2, content: [] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] },
    { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'step time' }] },
  ]), null)
})

test('sanitizeDiagnosticText redacts credentials case-insensitively before tail truncation', () => {
  const raw = [
    '\u001b[31mERROR\u001b[0m GOOGLE_API_KEY=AIzaSySecretKey1234567890123456789',
    'PROXY_PASSWORD=my-secret-pass',
    '{"access_token": "tok_json_secret", "cookie": "a=secret1; b=secret2"}',
    'Authorization: BEARER eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456',
    'Cookie: sid=abc123; csrf=xyz789',
    'https://user:pass@proxy.local:8080/path?api_key=querySecret&ok=1',
    'https://onlytoken@proxy2.local:8080/test',
    'key=sk-ant-api03-verysecretvalue1234567890',
    'FINAL_ROOT_CAUSE_MARKER',
  ].join('\n')

  const clean = sanitizeDiagnosticText(raw, 400)
  for (const leak of [
    'AIzaSySecretKey',
    'my-secret-pass',
    'tok_json_secret',
    'secret1',
    'secret2',
    'eyJhbGci',
    'abc123',
    'xyz789',
    'user:pass',
    'onlytoken',
    'querySecret',
    'sk-ant-api03',
    '\u001b[31m',
  ]) {
    assert.equal(clean.includes(leak), false, `must not leak "${leak}" in: ${clean}`)
  }
  assert.match(clean, /FINAL_ROOT_CAUSE_MARKER/)

  // Tail truncation must happen AFTER redaction so a boundary-spanning token never leaks its suffix
  const boundaryToken = 'Bearer ' + 'A'.repeat(200)
  const truncated = sanitizeDiagnosticText(`prefix ${boundaryToken} tail_err`, 40)
  assert.equal(truncated.includes('AAAA'), false)
  assert.match(truncated, /tail_err/)
})

test('geo rules classify restricted countries, upstream 400 errors, and mask IPv4/IPv6 addresses safely', () => {
  for (const blocked of ['HK', 'hk', ' CN ', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU']) {
    assert.equal(isUnsupportedGeoCountry(blocked), true, blocked)
  }
  for (const allowed of ['US', 'JP', 'SG', 'TW', 'DE', 'GB', 'KR', 'XX', 'T1', '', null, undefined]) {
    assert.equal(isUnsupportedGeoCountry(allowed), false, String(allowed))
  }
  assert.deepEqual(normalizeGeoCountryCode('xx'), { kind: 'placeholder', raw: 'XX' })
  assert.deepEqual(normalizeGeoCountryCode('t1'), { kind: 'placeholder', raw: 'T1' })
  assert.deepEqual(normalizeGeoCountryCode('us'), { kind: 'valid', country: 'US' })
  assert.deepEqual(normalizeGeoCountryCode('USA'), { kind: 'invalid' })

  assert.equal(
    isGeoUnsupportedError(new Error('FAILED_PRECONDITION (code 400): User location is not supported for the API use.')),
    true,
  )
  assert.equal(
    isGeoUnsupportedError({ code: 400, status: 'FAILED_PRECONDITION', message: 'Location is not supported' }),
    true,
  )
  assert.equal(isGeoUnsupportedError(new Error('HTTP 429 RESOURCE_EXHAUSTED')), false)
  assert.equal(isGeoUnsupportedError('Invalid argument: bad model'), false)

  assert.equal(maskIpAddress('203.0.113.42'), '203.0.113.*')
  assert.equal(maskIpAddress(' 0.0.0.0 '), '0.0.0.*')
  assert.equal(maskIpAddress('999.1.2.3'), 'unknown')
  assert.equal(maskIpAddress('01.2.3.4'), 'unknown')
  assert.equal(maskIpAddress('::ffff:198.51.100.9'), '::ffff:198.51.100.*')
  assert.equal(maskIpAddress('2001:0db8:85a3::8a2e:0370:7334'), '2001:db8::*')
  assert.equal(maskIpAddress('[fe80::1%eth0]'), 'fe80:0::*')
  assert.equal(maskIpAddress('2001:db8::1::2'), 'unknown')
  assert.equal(maskIpAddress('not-an-ip'), 'unknown')
  assert.equal(maskIpAddress(''), 'unknown')

  assert.equal(resolveConfig({}).geoFenceMode, 'block')
  assert.equal(resolveConfig({ geoFenceMode: 'strict' }).geoFenceMode, 'strict')
  assert.equal(resolveConfig({ geoFenceMode: 'invalid' }).geoFenceMode, 'block')
})
