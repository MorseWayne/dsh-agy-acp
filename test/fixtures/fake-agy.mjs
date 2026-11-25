#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Minimal ACP JSON-RPC 2.0 server over stdio for end-to-end integration tests.
// Behavior is triggered by prompt text keywords:
//   - "USE_TOOL"        : emits text -> permission request -> completed run_command tool -> follow-up text
//   - "SLOW_CANCEL"     : emits partial text then waits until `session/cancel` notification arrives
//   - otherwise         : echoes turn count & prompt text with cached usage stats

let nextSessionSeq = 1
let nextServerReqId = 1000
const sessions = new Map()
const pendingServerCalls = new Map()
const activeTurns = new Map()

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function sendUpdate(sessionId, update) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  })
}

function requestClient(method, params) {
  const id = nextServerReqId++
  return new Promise((resolve, reject) => {
    pendingServerCalls.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  // Response to server->client request (e.g. session/request_permission)
  if (msg.id !== undefined && msg.method === undefined && pendingServerCalls.has(msg.id)) {
    const entry = pendingServerCalls.get(msg.id)
    pendingServerCalls.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message))
    else entry.resolve(msg.result)
    return
  }

  // Notifications
  if (msg.id === undefined && typeof msg.method === 'string') {
    if (msg.method === 'session/cancel') {
      const sid = msg.params?.sessionId
      const turn = activeTurns.get(sid)
      if (turn) {
        turn.cancel()
      }
    }
    return
  }

  // Requests
  if (msg.id !== undefined && typeof msg.method === 'string') {
    void handleRequest(msg.id, msg.method, msg.params)
  }
})

async function handleRequest(id, method, params) {
  if (method === 'initialize') {
    const supportsAppend = process.env.FAKE_NO_SYSTEM_APPEND !== '1'
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'fake-agy-acp', version: '1.5.16-test' },
        agentCapabilities: {
          promptCapabilities: { image: true, embeddedContext: true },
          ...(supportsAppend ? { _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } } : {}),
        },
      },
    })
    return
  }

  if (method === 'session/new') {
    const sessionId = `sess_${nextSessionSeq++}`
    const systemAppend = params?._meta?.antigravity?.systemPrompt?.append ?? null
    const configOptions = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'gemini-4-neon',
        options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thought Level',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'accept-edits',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'accept-edits', name: 'Accept Edits' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ]
    sessions.set(sessionId, { turns: 0, configOptions, systemAppend })
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        configOptions,
        models: {
          currentModelId: 'gemini-4-neon-medium',
          availableModels: [
            { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon Low' },
            { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon Medium' },
            { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon High' },
          ],
        },
        _meta: { antigravity: { tier: { name: 'Test Tier', id: 'test' } } },
      },
    })
    return
  }

  if (method === 'session/set_config_option') {
    if (
      params?.configId === 'model' &&
      params?.value === 'claude-sonnet-5-5' &&
      process.env.FAKE_CRASH_ON_SYNC_FILE
    ) {
      const f = process.env.FAKE_CRASH_ON_SYNC_FILE
      const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
      writeFileSync(f, String(n + 1))
      if (n === 0) {
        process.stderr.write('sync pipe died\n')
        process.exit(1)
      }
    }
    const sess = sessions.get(params?.sessionId)
    if (sess) {
      for (const opt of sess.configOptions) {
        if (opt.id === params.configId) {
          opt.currentValue = params.value
        }
      }
      send({ jsonrpc: '2.0', id, result: { configOptions: sess.configOptions } })
    } else {
      send({ jsonrpc: '2.0', id, result: {} })
    }
    return
  }

  if (method === 'session/close') {
    sessions.delete(params?.sessionId)
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'session/prompt') {
    const sessionId = params?.sessionId
    const sess = sessions.get(sessionId)
    if (!sess) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: `Unknown session ${sessionId}` } })
      return
    }
    sess.turns += 1
    const promptText = (params?.prompt ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')

    if (promptText.includes('SLOW_CANCEL')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'working...' },
      })
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          activeTurns.delete(sessionId)
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
          resolve()
        }, 10_000)
        activeTurns.set(sessionId, {
          cancel: () => {
            clearTimeout(timer)
            activeTurns.delete(sessionId)
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
            resolve()
          },
        })
      })
      return
    }

    if (promptText.includes('USE_TOOL')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me run a command.' },
      })
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Running check...' },
      })
      sendUpdate(sessionId, {
        sessionUpdate: 'usage_update',
        used: 320,
        size: 65536,
      })

      const permRes = await requestClient('session/request_permission', {
        sessionId,
        toolCall: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_1',
          name: 'run_command',
          kind: 'execute',
          status: 'pending',
          rawInput: { CommandLine: 'echo hello', Cwd: '/tmp' },
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        ],
      })

      const allowed = permRes?.outcome?.outcome === 'selected' && permRes.outcome.optionId === 'allow_once'
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_1',
        name: 'run_command',
        kind: 'execute',
        title: 'Run echo',
        status: allowed ? 'completed' : 'failed',
        rawInput: { CommandLine: 'echo hello', Cwd: '/tmp' },
        rawOutput: allowed
          ? { output: 'hello\n', exit_code: 0 }
          : { output: 'Permission denied', exit_code: 1 },
        content: [{ type: 'content', content: { type: 'text', text: allowed ? 'hello\n' : 'Permission denied' } }],
      })

      // Short tick so the adapter can emit span 1 while background turn continues
      await new Promise((r) => setTimeout(r, 20))

      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: allowed ? 'Command succeeded with hello.' : 'Command was denied.' },
      })

      send({
        jsonrpc: '2.0',
        id,
        result: {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 1000,
            cachedReadTokens: 400,
            cachedWriteTokens: 100,
            outputTokens: 50,
            thoughtTokens: 120,
            totalTokens: 1050,
          },
        },
      })
      return
    }

    if (promptText.includes('LIVE_TOOL_INCREMENTAL')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_live',
        name: 'run_command',
        kind: 'execute',
        title: 'Run live echo',
        status: 'in_progress',
        rawInput: { CommandLine: 'echo live', Cwd: '/tmp' },
      })
      await new Promise((r) => setTimeout(r, 80))
      // Deliberately omit name/kind/title/rawInput on completion frame to verify incremental merge
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_live',
        status: 'completed',
        rawOutput: { output: 'live ok\n', exit_code: 0 },
        content: [{ type: 'content', content: { type: 'text', text: 'live ok\n' } }],
      })
      await new Promise((r) => setTimeout(r, 20))
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Live tool finished.' },
      })
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
      })
      return
    }

    if (promptText.includes('EMPTY_PLACEHOLDER_TOOL')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_empty',
        status: 'in_progress',
      })
      await new Promise((r) => setTimeout(r, 60))
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_empty',
        name: 'run_command',
        kind: 'execute',
        title: 'Late metadata',
        status: 'completed',
        rawInput: { CommandLine: 'echo late', Cwd: '/work' },
        rawOutput: { output: 'late\n', exit_code: 0 },
      })
      await new Promise((r) => setTimeout(r, 20))
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Placeholder done.' },
      })
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'end_turn' },
      })
      return
    }

    if (promptText.includes('SLOW_TOOL_CANCEL')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_slow',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'sleep 10', Cwd: '/tmp' },
      })
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          activeTurns.delete(sessionId)
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
          resolve()
        }, 10_000)
        activeTurns.set(sessionId, {
          cancel: () => {
            clearTimeout(timer)
            activeTurns.delete(sessionId)
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
            resolve()
          },
        })
      })
      return
    }

    if (promptText.includes('PARALLEL_TOOLS')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_p1',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { Path: 'a.ts' },
      })
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_p2',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { Path: 'b.ts' },
      })
      await new Promise((r) => setTimeout(r, 50))
      // Complete out of order: tc_p2 first, then tc_p1
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_p2',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'const b = 2' } }],
      })
      sendUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_p1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'const a = 1' } }],
      })
      await new Promise((r) => setTimeout(r, 20))
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Both parallel tools done.' },
      })
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 15, totalTokens: 95 } },
      })
      return
    }

    if (promptText.includes('AUX_TRY_TOOL')) {
      const modeOpt = sess.configOptions.find((o) => o.id === 'mode')
      const currentMode = modeOpt?.currentValue ?? ''
      const readPerm = await requestClient('session/request_permission', {
        sessionId,
        toolCall: { sessionUpdate: 'tool_call_update', toolCallId: 'aux_r', name: 'read_file', kind: 'read', status: 'pending' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        ],
      })
      const execPerm = await requestClient('session/request_permission', {
        sessionId,
        toolCall: { sessionUpdate: 'tool_call_update', toolCallId: 'aux_e', name: 'run_command', kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        ],
      })
      const readAllowed = readPerm?.outcome?.outcome === 'selected' && readPerm.outcome.optionId === 'allow_once'
      const execAllowed = execPerm?.outcome?.outcome === 'selected' && execPerm.outcome.optionId === 'allow_once'
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `AUX_MODE=${currentMode}|READ=${readAllowed}|EXEC=${execAllowed}|SYS=${sess.systemAppend ? 'META' : 'NONE'}`,
        },
      })
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } },
      })
      return
    }

    if (promptText.includes('ECHO_SYSTEM')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `SYS=${sess.systemAppend ?? 'NONE'}||PROMPT=${promptText}`,
        },
      })
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } },
      })
      return
    }

    if (promptText.includes('RPC_ERR_RECOVERABLE')) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'Recoverable application refusal' },
      })
      return
    }

    if (promptText.includes('TIMEOUT_NEVER_REPLY')) {
      process.stderr.write('Authorization: Bearer super_secret_token_999\nupstream slow hang\n')
      return
    }

    if (promptText.includes('CRASH_BEFORE_OUTPUT')) {
      const f = process.env.FAKE_CRASH_COUNTER_FILE
      let shouldCrash = true
      if (f) {
        const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
        writeFileSync(f, String(n + 1))
        if (n >= 1 && process.env.FAKE_CRASH_ALWAYS !== '1') shouldCrash = false
      }
      if (shouldCrash) {
        process.stderr.write('GOOGLE_API_KEY=AIzaSySecretKey1234567890123456789\nfatal peer crash\n')
        process.exit(1)
      }
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `RECOVERED:${promptText}` },
      })
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
      return
    }

    if (promptText.includes('EXIT_IDLE_SOON')) {
      sendUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'bye soon' },
      })
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
      setTimeout(() => process.exit(1), 40)
      return
    }

    if (process.env.FAKE_FORCE_429 === '1') {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32029, message: 'HTTP 429 RESOURCE_EXHAUSTED: quota exceeded for account' },
      })
      return
    }

    if (process.env.FAKE_FORCE_GEO_400 === '1' || promptText.includes('FORCE_GEO_400')) {
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: 400,
          message: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
        },
      })
      return
    }

    // Default multi-turn echo
    const acctPrefix = process.env.FAKE_ACCOUNT_TAG ? `<${process.env.FAKE_ACCOUNT_TAG}> ` : ''
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${acctPrefix}[${sessionId}#${sess.turns}] ${promptText}` },
    })
    send({
      jsonrpc: '2.0',
      id,
      result: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 500,
          cachedReadTokens: sess.turns > 1 ? 300 : 0,
          outputTokens: 25,
          totalTokens: 525,
        },
      },
    })
    return
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
}
