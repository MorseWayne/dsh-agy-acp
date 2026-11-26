import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundHeadText, boundTailText, sanitizeToolPayload } from '../src/acp/payload-bounds.ts'
import type { AcpToolCallUpdate } from '../src/acp/protocol.ts'
import { capturePreEditLocations, createPreEditLocator, compactDisplayInput, locateUniqueSnippetLine, presentMirrorCall } from '../src/provider/mirror-tool.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { buildAuxiliaryPromptBlocks, buildPromptBlocksWithAttachments, MAX_IMAGE_ATTACHMENT_BYTES as maxImage, type PromptMessage, type ReadPromptImage, type ReadPromptFile } from '../src/provider/prompt-builder.ts'

test('bounded text includes markers in budgets, including zero and surrogate boundaries', () => {
  const source = '😀你好'.repeat(100)
  for (const fn of [boundTailText, boundHeadText]) for (const limit of [0, 1, 3, 23, 29, 30, 35, 80]) {
    const out = fn(source, limit)
    assert.ok(out.length <= limit)
    assert.equal(Buffer.from(out).toString(), out)
    assert.equal(fn(out, limit), out)
  }
  assert.deepEqual(sanitizeToolPayload({ ['x'.repeat(4_000)]: 'bad', text: source }, { maxTotalText: 13 }), { text: '[Earlier ' })
  const raw = { CommandLine: '🥦'.repeat(60_000), Cwd: '9'.repeat(3000) }
  for (const n of [2, 15, 512, 4096]) {
    for (const data of [raw, raw.CommandLine, '\u0001'.repeat(20_000)]) {
      const json = JSON.stringify(compactDisplayInput(data, n))
      assert.ok(!json || Buffer.byteLength(json) <= n)
    }
  }
})

test('untrusted tool fields are projected once at ingestion; unknowns and binary never enter history', () => {
  const store = new AcpRunStore(), rec = store.create('s')
  const args = { CommandLine: 'cmd-' + 'Z'.repeat(400_000), media: { type: 'image', data: 'X'.repeat(500_000) } }
  rec.pushUpdate({ sessionUpdate: 'tool_call', toolCallId: 't', name: 'bash', kind: 'execute',
    title: ' '.repeat(400_000), rawOutput: 'data:image/png;base64,DoNotRetain', _meta: { secret: 'DoNotRetain' },
    args, locations: [{ path: 'x'.repeat(90_000) }, { path: 'ok.ts' }], extra: args } as AcpToolCallUpdate)
  const item = rec.items[0]!
  assert.equal(item.kind, 'update'); if (item.kind !== 'update') return
  const tc = item.update as AcpToolCallUpdate
  assert.equal(tc.rawOutput, undefined)
  assert.equal('_meta' in tc || 'extra' in tc, false)
  assert.deepEqual(tc.locations, [{ path: 'ok.ts' }]); assert.equal(tc.args, rec.getToolCall('t')?.args)
  assert.ok((tc.args!.CommandLine as string).length <= 16_000)
  assert.ok(!JSON.stringify(item).includes('DoNotRetain')); assert.deepEqual(tc.args?.media, { type: 'image' })
})

test('only released settled recordings may compact or evict, including same-owner supersession', async () => {
  const store = new AcpRunStore(), active = store.create('a'), pending = store.create('b')
  pending.pushUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pending answer' } }); pending.finish('stop')
  // No active promise is necessary for a continuation to be outstanding.
  for (let i = 0; i < 70; i++) { const done = store.create('b'); done.finish('stop'); done.releaseRecording() }
  assert.equal(store.get(active.id), active); assert.equal(store.get(pending.id), pending)
  assert.equal((await pending.waitFor(0))?.kind, 'update'); assert.equal((await pending.waitFor(1))?.kind, 'done')
  assert.equal(store.isLatestForOwner(pending), false)
  pending.releaseRecording(); pending.compactSettled(); assert.equal(pending.items.length, 0)
})

test('pre-edit snapshots are workspace-contained, regular small UTF-8 files; cards replay without reading', { skip: process.platform !== 'linux' }, t => {
  const tmp = mkdtempSync(join(tmpdir(), 'acp-edit-')); t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const root = join(tmp, 'work'); mkdirSync(root)
  writeFileSync(join(root, 'a'), 'header\r\nold\r\nextra\r\nold\r\nend\r\n')
  writeFileSync(join(tmp, 'outside'), 'secret\n'); symlinkSync(join(tmp, 'outside'), join(root, 'link'))
  symlinkSync(tmp, join(root, 'escape')); symlinkSync('/dev/zero', join(root, 'device'))
  writeFileSync(join(root, 'large'), ''); truncateSync(join(root, 'large'), 1024 * 1024 + 1)
  writeFileSync(join(root, 'binary'), Buffer.from([255, 10, 120, 10]))
  for (const f of ['../outside', join(tmp, 'outside'), 'link', 'escape/outside', 'device', '.', 'large', 'binary']) {
    assert.equal(locateUniqueSnippetLine(f, 'secret', 1, Infinity, root), undefined)
  }
  assert.equal(locateUniqueSnippetLine(join(root, 'a'), 'header'), undefined)
  assert.equal(locateUniqueSnippetLine('a', 'old', 1, Infinity, root), undefined)
  assert.equal(locateUniqueSnippetLine('a', 'ld', 2, 2, root), undefined)
  const tc: AcpToolCallUpdate = { sessionUpdate: 'tool_call', toolCallId: 't', name: 'multi_replace_file_content', rawInput: {
    TargetFile: 'a', ReplacementChunks: [{ StartLine: 1, EndLine: 3, TargetContent: 'old\nextra', ReplacementContent: 'new' },
      { StartLine: 3, EndLine: 5, TargetContent: 'old', ReplacementContent: 'other' }],
  } }
  const locate = createPreEditLocator(root)
  const rec = new AcpRunStore().create('s', locate); rec.pushUpdate(tc)
  writeFileSync(join(root, 'a'), 'new\nother\n'); rec.pushUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', locations: [{ path: 'a', line: 1 }] })
  const stored = rec.getToolCall('t')!, view = presentMirrorCall({ run: rec.id, step: 0, tool: tc.name, input: stored.rawInput, locations: stored.locations })
  assert.equal(view.card, 'diff'); if (view.card !== 'diff') return
  assert.deepEqual(view.locations, [{ path: 'a', line: 2 }, { path: 'a', line: 4 }])
  const hints = [{ path: 'a', line: 1 }, { path: 'a', line: 3 }]
  assert.deepEqual(capturePreEditLocations(tc), hints)
  const retired = join(tmp, 'original-work')
  renameSync(root, retired); mkdirSync(root); writeFileSync(join(root, 'a'), 'header\nold\nextra\nold\nend\n')
  assert.deepEqual(locate(tc), hints, 'must not read a replacement directory under the same name')
})

type Ref = Parameters<ReadPromptImage>[0]
const image = (bytes = 3): Extract<PromptMessage['content'][number], { type: 'image' }> => ({ type: 'image', attachment: {
  attachmentId: ('sha256:' + 'a'.repeat(64)) as Ref['attachmentId'], width: 1, height: 1, mediaType: 'image/png', bytes,
} })

test('only negotiated image references read verified attachment bytes, never raw file names or historical images', async () => {
  const msgs: PromptMessage[] = [ { role: 'user', content: [image()] }, { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
    { role: 'user', content: [{ type: 'text', text: 'before' }, image(), { type: 'file', attachment: { name: '/etc/passwd', attachmentId: 'id', bytes: 55 } }, { type: 'text', text: 'after' }] } ]
  let reads = 0
  const resolve: ReadPromptImage = async ref => { reads++; return { ref, data: new Uint8Array([1, 2, 3]) } }
  for (const caps of [undefined, {}, { image: false }]) {
    const blocks = await buildPromptBlocksWithAttachments(msgs, false, undefined, caps, resolve)
    assert.equal(blocks.some(b => b.type === 'image'), false); assert.match(JSON.stringify(blocks), /peer does not support image/)
  }
  assert.equal(reads, 0)
  const good = await buildPromptBlocksWithAttachments(msgs, true, undefined, { image: true }, resolve)
  assert.equal(reads, 1); assert.equal(good[1]?.type, 'text'); assert.deepEqual(good[2], { type: 'image', data: 'AQID', mimeType: 'image/png' })
  assert.match(JSON.stringify(good[3]), /no readable handle supplied/)
  assert.ok(buildAuxiliaryPromptBlocks(msgs).every(b => b.type === 'text'))
})

test('per-image, aggregate and actual-byte budgets are checked before base64; honor offload and cancellation', async () => {
  let reads = 0
  const resolve: ReadPromptImage = async ref => { reads++; return { ref, data: new Uint8Array(0) } }
  const msg: PromptMessage = { role: 'user', content: [image(maxImage + 1), ...Array.from({ length: 6 }, () => image(maxImage)), Object.assign(image(), { offloaded: true as const })] }
  const blocks = await buildPromptBlocksWithAttachments([msg], false, undefined, { image: true }, resolve)
  assert.equal(reads, 5); assert.ok(blocks.every(b => b.type === 'text'))
  assert.match(JSON.stringify(blocks), /offloaded by DSH/); assert.match(JSON.stringify(blocks), /verified attachment unavailable/)
  await assert.rejects(buildPromptBlocksWithAttachments([msg], false, undefined, { image: true }, resolve, AbortSignal.abort()), /abort/i)
})

test('real DSH file refs emit negotiated ACP audio and text/blob resources without filesystem paths', async () => {
  const bodies = new Map<string, Buffer>()
  const file = (name: string, text: string) => {
    const data = Buffer.from(text); const attachmentId = `sha256:${createHash('sha256').update(data).digest('hex')}`
    bodies.set(attachmentId, data); return { type: 'file' as const, attachment: { attachmentId, name, bytes: data.byteLength } }
  }
  const text = file('notes.md', '中文笔记'), audio = file('sound.wav', 'RIFF\0\0\0\0WAVEfmt '), pdf = file('paper.pdf', '%PDF-1.7\n%%EOF')
  let reads = 0
  const resolve: ReadPromptFile = async function* (ref) { reads++; const data = bodies.get(ref.attachmentId)!; yield data.subarray(0, 3); yield data.subarray(3) }
  const messages: PromptMessage[] = [{ role: 'user', content: [text, audio, pdf] }]
  const noCaps = await buildPromptBlocksWithAttachments(messages, false, undefined, {}, undefined, undefined, resolve)
  assert.equal(reads, 0); assert.match(JSON.stringify(noCaps), /lacks required attachment capability/)
  const blocks = await buildPromptBlocksWithAttachments(messages, false, undefined, { embeddedContext: true, audio: true }, undefined, undefined, resolve)
  assert.equal(reads, 3)
  assert.deepEqual(blocks, [
    { type: 'resource', resource: { uri: `urn:dsh:attachment:${text.attachment.attachmentId}`, mimeType: 'text/markdown', text: '中文笔记' } },
    { type: 'audio', mimeType: 'audio/wav', data: bodies.get(audio.attachment.attachmentId)!.toString('base64') },
    { type: 'resource', resource: { uri: `urn:dsh:attachment:${pdf.attachment.attachmentId}`, mimeType: 'application/pdf', blob: bodies.get(pdf.attachment.attachmentId)!.toString('base64') } },
  ])
  const refs = [file('large.txt', ''), file('../outside.pdf', 'x'), file('bad.pdf', 'not a PDF'), file('bad.mp3', 'not mp3'), file('bad.txt', 'x\0y'), file('a.unknown', 'text')]
  refs[0]!.attachment.bytes = 2 * 1024 * 1024
  const rejected = await buildPromptBlocksWithAttachments([{ role: 'user', content: refs }], false, undefined, { audio: true, embeddedContext: true }, undefined, undefined, resolve)
  assert.equal(reads, 6, 'oversized, path-like and unknown files are never opened')
  assert.ok(rejected.every(b => b.type === 'text'))
  const failed = await buildPromptBlocksWithAttachments(messages, false, undefined, { embeddedContext: true }, undefined, undefined, async function* () { yield Buffer.alloc(1000) })
  assert.match(JSON.stringify(failed), /invalid attachment stream/)
  const corrupt = await buildPromptBlocksWithAttachments(messages, false, undefined, { embeddedContext: true }, undefined, undefined, async function* (ref) { yield Buffer.alloc(ref.bytes) })
  assert.match(JSON.stringify(corrupt), /integrity mismatch/)
})
