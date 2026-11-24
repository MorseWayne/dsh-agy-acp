#!/usr/bin/env node
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
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'fake-agy-acp', version: '1.5.16-test' },
        agentCapabilities: {
          promptCapabilities: { image: true, embeddedContext: true },
        },
      },
    })
    return
  }

  if (method === 'session/new') {
    const sessionId = `sess_${nextSessionSeq++}`
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
    sessions.set(sessionId, { turns: 0, configOptions })
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
        size: 1048576,
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
            outputTokens: 50,
            thoughtTokens: 120,
            totalTokens: 1050,
          },
        },
      })
      return
    }

    // Default multi-turn echo
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `[${sessionId}#${sess.turns}] ${promptText}` },
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
