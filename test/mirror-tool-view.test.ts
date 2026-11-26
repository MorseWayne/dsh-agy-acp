import assert from 'node:assert/strict'
import test from 'node:test'
import { validateJsonSchemaValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { deriveAgyMirrorRowModel, relativizeDisplayPath } from '../src/client/mirror-tool-model.ts'
import { defineAgyAcpMirrorTool, presentMirrorResult } from '../src/provider/mirror-tool.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'

test('mirror-tool extracts ACP content diffs and text exit code into canonical output and presentationMeta', async () => {
  const store = new AcpRunStore()
  const rec = store.create('sess-vis')

  const editStep = rec.pushUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_edit_diff',
    name: 'edit_file',
    kind: 'edit',
    title: 'Edit src/app.ts',
    status: 'completed',
    content: [
      {
        type: 'diff',
        path: '/repo/src/app.ts',
        oldText: 'const x = 1\n',
        newText: 'const x = 2\nconst y = 3\n',
      },
    ],
  })

  const cmdStep = rec.pushUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_cmd_fail',
    name: 'run_command',
    kind: 'execute',
    title: 'Run tests',
    status: 'completed',
    rawInput: { CommandLine: 'pnpm test', toolSummary: 'Unit test execution' },
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Created At: 2026-11-27T01:00:00+08:00\nCompleted At: 2026-11-27T01:00:02+08:00\nCommand exited with code 2.\n\nCommand output:\nAssertionError: boom',
        },
      },
    ],
  })

  const mirror = defineAgyAcpMirrorTool(store)

  // 1. ACP content diff is persisted and validates strictly against output.schema
  const editArgs = { run: rec.id, step: editStep, toolCallId: 'tc_edit_diff', tool: 'edit_file', kind: 'edit' }
  const editVal = (await mirror.execute(editArgs, { agent: { session: { id: 'sess-vis' } } } as ToolRunContext)) as Record<string, unknown>
  validateJsonSchemaValue(mirror.output.schema, editVal)
  assert.deepEqual(editVal.diffs, [
    { path: '/repo/src/app.ts', oldText: 'const x = 1\n', newText: 'const x = 2\nconst y = 3\n' },
  ])
  const editMeta = mirror.output.presentationMeta?.(editArgs, editVal as never)
  const editView = presentMirrorResult(editArgs, {
    content: [{ type: 'text', text: String(editVal.output) }],
    isError: false,
    meta: editMeta,
  })
  assert.equal(editView.card, 'diff')
  if (editView.card === 'diff') {
    assert.equal(editView.diffs.length, 1)
    assert.equal(editView.diffs[0]?.path, '/repo/src/app.ts')
  }

  // 2. Exit code is extracted from agy command preamble text
  const cmdArgs = {
    run: rec.id,
    step: cmdStep,
    toolCallId: 'tc_cmd_fail',
    tool: 'run_command',
    kind: 'execute',
    input: { CommandLine: 'pnpm test', toolSummary: 'Unit test execution' },
  }
  const cmdVal = (await mirror.execute(cmdArgs, { agent: { session: { id: 'sess-vis' } } } as ToolRunContext)) as Record<string, unknown>
  validateJsonSchemaValue(mirror.output.schema, cmdVal)
  assert.equal(cmdVal.exitCode, 2)
  assert.equal(cmdVal.isError, true)
})

test('deriveAgyMirrorRowModel visualizes terminal, diff, read, search, web, steps, and generic calls cleanly without run-id wrapper', () => {
  const opts = { cwd: '/home/wayne/repo', home: '/home/wayne', locale: 'zh' as const }

  // 1. Terminal with agy timestamp preamble & non-zero exit code
  const term = deriveAgyMirrorRowModel(
    {
      kind: 'tool-result',
      callId: 'c1',
      call: {
        name: 'agy_acp_tool',
        argsRaw: JSON.stringify({
          run: '03516375-450',
          step: 1,
          tool: 'run_command',
          kind: 'execute',
          input: { CommandLine: 'git push origin main', toolSummary: 'Push branch' },
        }),
      },
      content: [
        {
          type: 'text',
          text: 'Created At: 2026-11-27T01:03:05+08:00\nCompleted At: 2026-11-27T01:03:11+08:00\nCommand exited with code 128.\n\nCommand output:\nfatal: unable to access remote',
        },
      ],
      isError: true,
    },
    opts,
  )
  assert.equal(term.category, 'terminal')
  assert.equal(term.title, '运行命令')
  assert.equal(term.summary, 'Push branch')
  assert.equal(term.state, 'error')
  assert.equal(term.exitLabel, '退出码 128')
  assert.equal(term.terminal?.command, 'git push origin main')
  assert.equal(term.terminal?.output, 'fatal: unable to access remote')
  assert.equal(term.terminal?.exitCode, 128)
  assert.equal(term.expandable, true)

  // 2. Edit with ACP meta.diffs (relativized path + clickable filePath)
  const diff = deriveAgyMirrorRowModel(
    {
      kind: 'tool-result',
      callId: 'c2',
      call: {
        name: 'agy_acp_tool',
        argsRaw: JSON.stringify({
          run: '03516375-450',
          step: 2,
          tool: 'edit_file',
          kind: 'edit',
          locations: [{ path: '/home/wayne/repo/src/client/theme.ts', line: 42 }],
        }),
      },
      content: [{ type: 'text', text: '(no output)' }],
      isError: false,
      meta: {
        output: '(no output)',
        isError: false,
        diffs: [{ path: '/home/wayne/repo/src/client/theme.ts', oldText: 'old', newText: 'new' }],
      },
    },
    opts,
  )
  assert.equal(diff.category, 'diff')
  assert.equal(diff.title, '编辑')
  assert.equal(diff.summary, 'src/client/theme.ts')
  assert.equal(diff.filePath, '/home/wayne/repo/src/client/theme.ts')
  assert.equal(diff.filePathLine, 42)
  assert.deepEqual(diff.diff?.diffs, [{ path: 'src/client/theme.ts', oldText: 'old', newText: 'new' }])
  assert.equal(diff.expandable, true)

  // 3. Read file with `(no output)` stays clickable without junk output card
  const readNoOut = deriveAgyMirrorRowModel(
    {
      kind: 'tool-result',
      callId: 'c3',
      call: {
        name: 'agy_acp_tool',
        argsRaw: JSON.stringify({
          run: '03516375-450',
          step: 3,
          tool: 'read_file',
          kind: 'read',
          input: { Path: '/home/wayne/repo/src/index.ts', StartLine: 10, EndLine: 80 },
        }),
      },
      content: [{ type: 'text', text: '(no output)' }],
      isError: false,
    },
    opts,
  )
  assert.equal(readNoOut.category, 'read')
  assert.equal(readNoOut.title, '读取')
  assert.equal(readNoOut.summary, 'src/index.ts:10–80')
  assert.equal(readNoOut.filePath, '/home/wayne/repo/src/index.ts')
  assert.equal(readNoOut.filePathLine, 10)
  assert.equal(readNoOut.outputText, undefined)
  assert.equal(readNoOut.expandable, false)

  // 4. Read file with numbered content produces native ReadBlock data
  const readRich = deriveAgyMirrorRowModel(
    {
      kind: 'tool-result',
      callId: 'c4',
      call: {
        name: 'agy_acp_tool',
        argsRaw: JSON.stringify({
          run: '03516375-450',
          step: 4,
          tool: 'read_file',
          kind: 'read',
          input: { Path: '/home/wayne/repo/src/index.ts', StartLine: 1 },
        }),
      },
      content: [{ type: 'text', text: 'Showing lines 1-2 of 50\n1: import a\n2: export const b = 1\n' }],
      isError: false,
    },
    opts,
  )
  assert.equal(readRich.read?.label, 'src/index.ts')
  assert.equal(readRich.read?.lang, 'ts')
  assert.equal(readRich.read?.totalLines, 50)
  assert.equal(readRich.read?.lines.length, 2)
  assert.equal(readRich.expandable, true)

  // 5. Grep search produces native SearchBlock matches data
  const grep = deriveAgyMirrorRowModel(
    {
      kind: 'tool-result',
      callId: 'c5',
      call: {
        name: 'agy_acp_tool',
        argsRaw: JSON.stringify({
          run: '03516375-450',
          step: 5,
          tool: 'grep_search',
          kind: 'search',
          input: { Query: 'ToolRow', SearchPath: '/home/wayne/repo/src' },
        }),
      },
      content: [{ type: 'text', text: '/home/wayne/repo/src/a.ts:12:export const ToolRow = 1' }],
      isError: false,
    },
    opts,
  )
  assert.equal(grep.category, 'search')
  assert.equal(grep.title, '搜索文件内容')
  assert.equal(grep.summary, 'ToolRow · src')
  assert.equal(grep.search?.kind, 'matches')
  if (grep.search?.kind === 'matches') {
    assert.equal(grep.search.files[0]?.path, 'src/a.ts')
  }

  // 6. update_steps renders checklist progress summary & items
  const steps = deriveAgyMirrorRowModel(
    {
      kind: 'tool-result',
      callId: 'c6',
      call: {
        name: 'agy_acp_tool',
        argsRaw: JSON.stringify({
          run: '03516375-450',
          step: 6,
          tool: 'update_steps',
          input: {
            steps: [
              { title: '分析问题', status: 'done' },
              { title: '实现可视化', status: 'in_progress' },
              { title: '运行测试', status: 'pending' },
            ],
          },
        }),
      },
      content: [{ type: 'text', text: '(no output)' }],
      isError: false,
    },
    opts,
  )
  assert.equal(steps.category, 'steps')
  assert.equal(steps.title, '更新进度')
  assert.equal(steps.summary, '1/3 已完成 · 实现可视化')
  assert.equal(steps.steps?.items.length, 3)
  assert.equal(steps.expandable, true)

  // 7. Generic tool unwraps inner input (never leaks run/step/toolCallId)
  const subagent = deriveAgyMirrorRowModel(
    {
      kind: 'tool-result',
      callId: 'c7',
      call: {
        name: 'agy_acp_tool',
        argsRaw: JSON.stringify({
          run: '03516375-450',
          step: 7,
          toolCallId: 'tc_sub_1',
          tool: 'invoke_subagent',
          input: { Role: 'Codebase Researcher', Prompt: 'Inspect tool slots' },
        }),
      },
      content: [{ type: 'text', text: 'Started subagent' }],
      isError: false,
    },
    opts,
  )
  assert.equal(subagent.category, 'agent')
  assert.equal(subagent.title, '子代理')
  assert.equal(subagent.summary, 'Codebase Researcher')
  assert.ok(subagent.inputText?.includes('Codebase Researcher'))
  assert.equal(subagent.inputText?.includes('03516375-450'), false)
  assert.equal(subagent.inputText?.includes('toolCallId'), false)

  // 8. Historical title-only frame where tool === 'tool'
  const titleOnly = deriveAgyMirrorRowModel(
    {
      phase: 'start',
      callId: 'c8',
      name: 'agy_acp_tool',
      argsRaw: JSON.stringify({
        run: '03516375-450',
        step: 8,
        tool: 'tool',
        kind: 'read',
        title: 'File /home/wayne/repo/package.json',
      }),
    },
    opts,
  )
  assert.equal(titleOnly.category, 'read')
  assert.equal(titleOnly.title, '读取')
  assert.equal(titleOnly.summary, 'package.json')
  assert.equal(titleOnly.filePath, '/home/wayne/repo/package.json')
  assert.equal(titleOnly.state, 'running')
})

test('relativizeDisplayPath handles cwd and POSIX home cleanly', () => {
  assert.equal(relativizeDisplayPath('/home/wayne/repo/src/a.ts', '/home/wayne/repo', '/home/wayne'), 'src/a.ts')
  assert.equal(relativizeDisplayPath('/home/wayne/notes.md', '/home/wayne/repo', '/home/wayne'), '~/notes.md')
  assert.equal(relativizeDisplayPath('/etc/hosts', '/home/wayne/repo', '/home/wayne'), '/etc/hosts')
})
