// Minimal offline peer for full and partial model-catalog responses.
import { createInterface } from 'node:readline'

const { full, update, restoredVia, restored } = JSON.parse(process.argv[2])
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const { id, method } = JSON.parse(line)
  switch (method) {
    case 'initialize':
      write({ id, result: { protocolVersion: 1, agentCapabilities: {
        ...(restoredVia === 'resume' ? { sessionCapabilities: { resume: {} } } : {}),
        ...(restoredVia === 'load' ? { loadSession: true } : {}),
      } } })
      break
    case 'session/new':
      write({ id, result: full })
      break
    case `session/${restoredVia}`:
      write({ id, result: { configOptions: restored } })
      break
    case 'catalog_test/config_update':
      write({ method: 'session/update', params: { sessionId: full.sessionId, update: {
        sessionUpdate: 'config_option_update', configOptions: update,
      } } })
      // Response acts as a barrier: the previous notification has been consumed.
      write({ id, result: {} })
      break
    case 'session/close':
      write({ id, result: {} })
      break
    default:
      write({ id, error: { code: -32601, message: `Unexpected ${method}` } })
  }
}
