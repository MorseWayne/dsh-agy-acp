import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { RequestPermissionParams } from '../src/acp/protocol.ts'
import {
  createTurnOutcomeWatcher,
  evaluateInlineWarningFallback,
  evaluateTurnOutcome,
  extractResetAtMs,
} from '../src/acp/turn-outcome.ts'
import { ReverseMcpBridge } from '../src/mcp/server.ts'
import { hostPermissions, type QuestionService } from '../src/runtime/host-permissions.ts'

const result = { stopReason: 'end_turn' }
const step = (text: string, reachedModel = false) => ({ type: 17, payload: Buffer.from(text), reachedModel })

test('upstream outcome precedence and 404 classification do not depend on assistant prose', () => {
  assert.equal(evaluateTurnOutcome('end_turn', undefined), undefined)
  assert.equal(evaluateTurnOutcome('refusal', undefined)?.code, 'REFUSAL')
  assert.equal(evaluateTurnOutcome('refusal', step('Error 403, Message: policy, Status: PERMISSION_DENIED'))?.kind, 'provider_error')
  assert.equal(evaluateTurnOutcome('refusal', step('reason:QUOTA_EXHAUSTED'))?.kind, 'quota')
  assert.equal(evaluateTurnOutcome('refusal', step('TOS_VIOLATION reason:QUOTA_EXHAUSTED'))?.kind, 'tos')
  assert.equal(evaluateTurnOutcome('end_turn', step('INVALID_THINKING_SIGNATURE'))?.sessionBroken, true)
  const missingModel = 'Error 404, Message: missing, Status: NOT_FOUND'
  assert.equal(evaluateTurnOutcome('end_turn', step(missingModel))?.retryable, false)
  assert.equal(evaluateTurnOutcome('end_turn', step(missingModel, true))?.transientNotFound, true)
  assert.equal(extractResetAtMs('retryDelay:1h2m3s', 1000), 3_724_000)

  // Protobuf length varint byte 0x4e ('N') preceding a 78-byte string must not corrupt status code.
  const pb429 = Buffer.concat([Buffer.from([0x12, 0x4e]), Buffer.from('RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).')])
  const out429 = evaluateTurnOutcome('end_turn', { type: 17, payload: pb429, reachedModel: false })
  assert.equal(out429?.kind, 'quota')
  assert.equal(out429?.code, 'RESOURCE_EXHAUSTED')
  const pb404 = Buffer.concat([Buffer.from([0x12, 0x41]), Buffer.from('NOT_FOUND (code 404): Requested entity was not found.')])
  assert.equal(evaluateTurnOutcome('end_turn', { type: 17, payload: pb404, reachedModel: false })?.code, 'NOT_FOUND')

  // Inline warning fallback for read-only sandbox turns where SQLite cannot persist ERROR_MESSAGE steps
  const inlineGeo = '\n⚠ FAILED_PRECONDITION (code 400): User location is not supported for the API use.\n'
  assert.equal(evaluateInlineWarningFallback('end_turn', inlineGeo, false, undefined)?.kind, 'geo')
  assert.equal(evaluateInlineWarningFallback('end_turn', '⚠ RESOURCE_EXHAUSTED (code 429): quota exceeded', false, { inputTokens: 0, outputTokens: 0 })?.kind, 'quota')
  // Never triggers on real assistant prose (nonzero output/thought tokens, tools/thoughts, or non-warning text)
  assert.equal(evaluateInlineWarningFallback('end_turn', inlineGeo, false, { outputTokens: 12 }), undefined)
  assert.equal(evaluateInlineWarningFallback('end_turn', inlineGeo, true, undefined), undefined)
  assert.equal(evaluateInlineWarningFallback('end_turn', 'The API returned FAILED_PRECONDITION (code 400).', false, undefined), undefined)
})

test('read-only trajectory inspection ignores old steps, symlinks, and replaced session files', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'agy-outcome-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'conversations'); mkdirSync(dir)
  const file = path.join(dir, 'session.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)')
  const insert = db.prepare('INSERT INTO steps VALUES (?, ?, ?)')
  insert.run(1, 17, Buffer.from('TOS_VIOLATION'))
  const watch = createTurnOutcomeWatcher('session', {}, [root])
  assert.equal(watch.check(result), undefined)
  insert.run(2, 15, Buffer.from('QUOTA_EXHAUSTED'))
  assert.equal(watch.check(result), undefined)
  insert.run(3, 17, Buffer.from('RESOURCE_EXHAUSTED (code 429): too many requests retryDelay:30s'))
  assert.equal(watch.check(result)?.kind, 'quota')
  db.close()
  renameSync(file, file + '.old')
  const replacement = new DatabaseSync(file)
  replacement.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)')
  replacement.prepare('INSERT INTO steps VALUES (4, 17, ?)').run(Buffer.from('TOS_VIOLATION')); replacement.close()
  assert.equal(watch.check(result), undefined)
  symlinkSync(file, path.join(dir, 'alias.db'))
  assert.equal(createTurnOutcomeWatcher('alias', {}, [root]).check(result), undefined)
})

test('native questions use the live owner and selected label, never a binary approval or guessed default', async () => {
  const owner = { session: { id: 'test' } }
  const policy = { sessionId: 'test', mode: 'read-only' as const, workspaceRoot: process.cwd(), preset: 'read-only', approval: 'ask' as const }
  let binaryCalls = 0, asked = 0
  let choice = true
  const service: QuestionService = { async ask({ agent, questions }) {
    assert.equal(agent, owner); asked++
    const q = questions[0]!
    return { answers: [{ id: q.id, selected: choice ? [q.options[1]!.label] : [] }] }
  } }
  const host = { agents: { get: () => owner }, sandboxPolicy: { resolve: () => policy }, permissionPresets: { current: () => policy.preset },
    approval: { config: { policy: 'ask' }, overrideOf: () => undefined, request: async () => { binaryCalls++; return 'allowed-once' } } }
  const p = hostPermissions(host, () => service)
  const req: RequestPermissionParams = { sessionId: 'test', toolCall: { sessionUpdate: 'tool_call', toolCallId: 'interaction_a', title: 'Choose', rawInput: {} },
    options: ['opaque-a', 'opaque-b'].map(optionId => ({ optionId, name: 'Same label', kind: 'allow_once' })) }
  const run = () => p.onPermission(req, 'test', new AbortController().signal)
  assert.deepEqual(await run(), { outcome: { outcome: 'selected', optionId: 'opaque-b' } })
  choice = false
  assert.deepEqual(await run(), { outcome: { outcome: 'cancelled' } })
  req.toolCall.kind = 'edit'; assert.deepEqual(await run(), { outcome: { outcome: 'cancelled' } })
  delete req.toolCall.kind; host.approval.config.policy = 'never'; assert.deepEqual(await run(), { outcome: { outcome: 'cancelled' } })
  assert.equal(asked, 2); assert.equal(binaryCalls, 0)
})

test('native HTTP MCP negotiates, acknowledges notifications, and requires its own bearer', async t => {
  const bridge = new ReverseMcpBridge({ listTools: () => [{ name: 'test' }], callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) })
  await bridge.start(); t.after(() => bridge.dispose())
  const spec = bridge.getHttpMcpServerSpec()!
  const headers = Object.fromEntries(spec.headers!.map(h => [h.name, h.value])); headers['Content-Type'] = 'application/json'
  const post = (body: object, h = headers) => fetch(spec.url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', ...body }) })
  assert.equal((await post({ id: 1, method: 'tools/list' }, {})).status, 401)
  assert.equal((await post({ id: 1, method: 'tools/list' }, { ...headers, Origin: 'https://example.invalid' })).status, 403)
  const init = await post({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }); assert.equal((await init.json()).result.protocolVersion, '2025-03-26')
  assert.equal((await post({ method: 'notifications/initialized' })).status, 202)
  assert.equal((await (await post({ id: 2, method: 'tools/call', params: { name: 'test', arguments: {} } })).json()).result.content[0].text, 'ok')
  assert.equal(bridge.getStats().transport, 'http')
})
