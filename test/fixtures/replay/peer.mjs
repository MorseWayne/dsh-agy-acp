// Offline peer: fixture frames are data, never commands. Exact comparison catches wrong
// methods, IDs, ordering, approvals or extra requests. Tests advance at protocol barriers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line =>
  JSON.parse(line, (_key, value) => value === '$workspace' ? process.cwd() : value))
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]()
for (const [index, row] of rows.entries()) {
  if (row.expect) {
    const { value, done } = await input.next()
    assert.equal(done, false, `missing outbound line ${index + 1}`)
    const frame = JSON.parse(value)
    if (row.expect.method === 'initialize' && row.expect.params.clientInfo.version === '$version') {
      assert.match(frame.params.clientInfo.version, /^\d+\.\d+\.\d+([-+].*)?$/)
      frame.params.clientInfo.version = '$version'
    }
    assert.deepEqual(frame, { jsonrpc: '2.0', ...row.expect }, `outbound line ${index + 1}`)
  } else {
    assert.ok(row.emit)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...row.emit }) + '\n')
  }
}
// Stay alive like the real persistent ACP server; no output or implicit completion.
assert.equal((await input.next()).done, true, 'unexpected outbound message after replay')
