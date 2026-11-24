// Run from the terminal whose model picker you want to compare. No inference or MCP calls.
import { execFileSync } from 'node:child_process'
import { AcpClient } from '../src/acp/client.ts'
import { resolveAgyBin } from '../src/runtime/bin.ts'
import { modelCatalog, selectOption, values } from '../src/runtime/model-catalog.ts'

const bin = resolveAgyBin(process.argv[2])
if (!bin) throw new Error('agy executable not found; pass its absolute path')
const run = (...args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const cli = run('models').split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/, 1)[0])
console.log('agy:', bin, 'version:', run('--version'), '\nagy models:', cli)
const client = new AcpClient({ bin })
try {
  client.start()
  await client.initialize()
  const setup = await client.sessionNew({ cwd: process.cwd(), mcpServers: [] })
  try {
    const ids = modelCatalog(setup).models.map(m => m.value)
    console.log('ACP model selector:', values(selectOption(setup.configOptions, 'model')).map(v => v.value))
    console.log('ACP availableModels:', setup.models?.availableModels.map(m => m.modelId) ?? [])
    console.log('CLI IDs missing from merged catalog:', cli.filter(id => !ids.includes(id)))
  } finally { await client.sessionClose(setup.sessionId).catch(() => {}) }
} finally { client.dispose() }
