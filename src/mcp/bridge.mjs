#!/usr/bin/env node
/**
 * Zero-dependency stdio-to-HTTP reverse MCP bridge for `agy acp` sessions.
 * Spawned per ACP session via `session/new` `mcpServers` without touching
 * global `~/.gemini/config/mcp_config.json`.
 *
 * Uses `node:http` / `node:https` directly instead of `fetch()` so loopback
 * traffic to the local DSH bridge can never be hijacked by `HTTP_PROXY` /
 * `ALL_PROXY` / `NODE_USE_ENV_PROXY=1`.
 */
import http from 'node:http'
import https from 'node:https'
import { createInterface } from 'node:readline'

const BRIDGE_URL = process.env.DSH_MCP_BRIDGE_URL
const BRIDGE_TOKEN = process.env.DSH_MCP_BRIDGE_TOKEN
const BRIDGE_TIMEOUT_MS = Math.max(1_000, Number(process.env.DSH_MCP_BRIDGE_TIMEOUT_MS) || 125_000)

if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  process.stderr.write('[dsh-mcp-bridge] Missing DSH_MCP_BRIDGE_URL or DSH_MCP_BRIDGE_TOKEN\n')
  process.exit(1)
}

let parsedUrl
try {
  parsedUrl = new URL(BRIDGE_URL)
} catch {
  process.stderr.write('[dsh-mcp-bridge] Invalid DSH_MCP_BRIDGE_URL\n')
  process.exit(1)
}

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function postJsonDirect(bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(bodyStr, 'utf8')
    const client = parsedUrl.protocol === 'https:' ? https : http
    const req = client.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.once('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.once('error', reject)
      },
    )
    req.once('error', reject)
    req.end(payload)
  })
}

async function forwardMessage(msg) {
  const hasId = msg.id !== undefined && msg.id !== null
  try {
    const res = await postJsonDirect(JSON.stringify(msg), BRIDGE_TIMEOUT_MS)

    if (!hasId) return

    if (res.status < 200 || res.status >= 300) {
      writeOut({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: `Bridge HTTP ${res.status}` },
      })
      return
    }

    const text = res.text
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
