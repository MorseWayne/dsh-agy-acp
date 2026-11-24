#!/usr/bin/env node
/**
 * Zero-dependency stdio-to-HTTP reverse MCP bridge for `agy acp` sessions.
 * Spawned per ACP session via `session/new` `mcpServers` without touching
 * global `~/.gemini/config/mcp_config.json`.
 */
import { createInterface } from 'node:readline'

const BRIDGE_URL = process.env.DSH_MCP_BRIDGE_URL
const BRIDGE_TOKEN = process.env.DSH_MCP_BRIDGE_TOKEN

if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  process.stderr.write('[dsh-mcp-bridge] Missing DSH_MCP_BRIDGE_URL or DSH_MCP_BRIDGE_TOKEN\n')
  process.exit(1)
}

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function forwardMessage(msg) {
  const hasId = msg.id !== undefined && msg.id !== null
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      body: JSON.stringify(msg),
    })

    if (!hasId) return

    if (!res.ok) {
      writeOut({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: `Bridge HTTP ${res.status}` },
      })
      return
    }

    const text = await res.text()
    if (!text.trim()) return
    process.stdout.write(text.trim() + '\n')
  } catch (err) {
    if (!hasId) return
    writeOut({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    })
  }
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
  void forwardMessage(msg)
})
