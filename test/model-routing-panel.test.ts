import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error React is supplied without its declaration package
import React from 'react'
// @ts-expect-error ReactDOM is supplied without its declaration package
import { renderToStaticMarkup } from 'react-dom/server'
import { MAX_MODEL_ROUTE_OVERRIDES, MODEL_FAMILY_META, MODEL_FAMILY_ORDER } from '../src/common/account-routing.ts'
import type { AccountHealthSnapshot, ModelAccountRoutingConfig, StatusSnapshot } from '../src/common/types.ts'
import {
  initialRoutingEditor, ModelRoutingPanel, reduceRoutingEditor, renderRoutingEditor, type ModelRoutingPanelProps,
} from '../src/client/model-routing-panel.ts'
import { SettingsView } from '../src/client/index.ts'
import { SegmentedControl } from '../src/client/ui-primitives.ts'

const base: AccountHealthSnapshot = {
  id: 'work', label: '工作号', enabled: true, hasSandboxHome: true, activeLeases: 0, families: {}, lastError: null, lastUsedAt: null,
}
const props: ModelRoutingPanelProps = {
  accounts: [{ ...base, id: 'backup', label: '备用号', enabled: false }, base], preferredAccountId: 'work',
  models: [{ value: 'gemini-4-neon', name: 'Neon', efforts: [] }, { value: 'alpha', name: 'Alpha', efforts: [] }],
  applyStatus() {}, onRefreshModels() {},
}

// SSR checks the complete markup; use the controlled view's actual event callbacks for
// edits and requests, feeding actions through the same reducer as the React component.
function editor(overrides: Partial<ModelRoutingPanelProps> = {}) {
  const inputs = { ...props, ...overrides }
  let state = initialRoutingEditor(inputs.routing)
  const dispatch = (action: Parameters<typeof reduceRoutingEditor>[1]) => { state = reduceRoutingEditor(state, action) }
  const view = () => renderRoutingEditor(inputs, state, dispatch)
  function control(label: string) {
    function lookup(node: ReturnType<typeof React.createElement>): ReturnType<typeof React.createElement> {
      if (!React.isValidElement(node)) return undefined
      const p = node.props
      if (p['aria-label'] === label || (node.type === 'button' && p.children === label)) return p
      if (node.type === SegmentedControl && p.ariaLabel === label) return p
      for (const child of React.Children.toArray(p.children)) {
        const found = lookup(child)
        if (found) return found
      }
    }
    const result = lookup(view())
    assert.ok(result, `missing control: ${label}`)
    return result
  }
  return {
    state: () => state, html: () => renderToStaticMarkup(view()), control,
    click: (label: string) => { const p = control(label); assert.ok(!p.disabled, label); return p.onClick() },
    change: (label: string, value: string) => control(label).onChange({ target: { value } }),
    policy: (label: string, value: 'auto' | 'strict') => control(label).onChange(value),
    sync: (routing?: ModelAccountRoutingConfig) => dispatch({ type: 'sync', routing }),
  }
}

test('renders five families in order, sorted specific overrides, account warnings and catalogue fallback', () => {
  const routing = {
    families: { 'gemini-pro': { accountId: 'backup' }, claude: { accountId: 'gone', fallback: 'strict' } },
    models: { 'gemini-4-neon': { accountId: 'gone' }, alpha: { accountId: 'auto' } },
  } as const
  const html = renderToStaticMarkup(React.createElement(ModelRoutingPanel, { ...props, routing }))
  let prev = -1
  for (const family of MODEL_FAMILY_ORDER) {
    const { label, description } = MODEL_FAMILY_META[family]
    const pos = html.indexOf(`>${label}</strong>`)
    assert.ok(pos > prev, `missing/out-of-order ${label}`)
    assert.ok(html.includes(description))
    prev = pos
  }
  assert.match(html, /Alpha \(alpha\)[^]*Neon \(gemini-4-neon\)/)
  assert.match(html, /覆盖 Gemini 专业版/)
  assert.match(html, /跟随全局默认（主力号：工作号）/)
  assert.match(html, /备用号（已停用）/)
  assert.match(html, /gone（账号已移除）/)
  assert.match(html, /首选账号已停用。将尝试借用其他可用账号/)
  assert.match(html, /首选账号已移除。严格锁定时可能无法发起请求/)
  const empty = renderToStaticMarkup(React.createElement(ModelRoutingPanel, { ...props, models: [], preferredAccountId: null, refreshingModels: true }))
  assert.match(empty, /跟随全局默认（自动按余量轮换）/)
  assert.match(empty, /placeholder="输入模型 ID，例如 gemini-4-neon"/)
  assert.doesNotMatch(empty, /新增具体模型|手动输入/)
  assert.match(empty, /<button[^>]*disabled=""[^>]*>刷新中…/)
})

test('accounts tab passes the active snapshot to a separate allocation card after its account list', () => {
  const status = { accounts: props.accounts, models: props.models, preferredAccountId: 'work', sessions: [], updatedAt: 1,
    config: { modelAccountRouting: { models: { 'gemini-4-neon': { accountId: 'backup' } } } } } as unknown as StatusSnapshot
  const html = renderToStaticMarkup(React.createElement(SettingsView, { status, stream: 'live', failed: false, initialPanel: 'accounts', applyStatus() {} }))
  assert.match(html, /账号状态 \(2\)[^]*<\/section><section class="agy-acp-card" aria-label="模型账号分配（额度共享）"/)
  assert.match(html, /<strong>Neon \(gemini-4-neon\)<\/strong>/)
  assert.match(html, /跟随全局默认（主力号：工作号）/)
  assert.match(html, /首选账号已停用。将尝试借用/)
})

test('family inheritance, automatic rotation, strict and borrowing policies use distinct rules', () => {
  const ui = editor()
  const label = 'Gemini 专业版'
  assert.equal(ui.control('保存分配规则').disabled, true)
  ui.change(`${label}首选账号`, 'work')
  ui.policy(`${label}共享策略`, 'strict')
  assert.deepEqual(ui.state().draft.families?.['gemini-pro'], { accountId: 'work', fallback: 'strict' })
  ui.policy(`${label}共享策略`, 'auto')
  assert.equal(ui.control(`${label}共享策略`).value, 'auto')
  ui.policy(`${label}共享策略`, 'strict')
  ui.change(`${label}首选账号`, 'auto')
  assert.deepEqual(ui.state().draft.families?.['gemini-pro'], { accountId: 'auto' })
  assert.doesNotMatch(ui.html(), /aria-label="Gemini 专业版共享策略"/)
  ui.change(`${label}首选账号`, '')
  assert.deepEqual(ui.state().draft, {})
  assert.equal(ui.control('保存分配规则').disabled, true)
})

test('adds catalogue/manual overrides, rejects empty, duplicate and excess models, edits and removes rules', () => {
  const ui = editor()
  assert.equal(ui.control('新增规则首选账号').value, 'work')
  ui.click('+ 添加规则')
  assert.match(ui.html(), /请先选择或输入模型 ID/)
  ui.change('新增具体模型', 'gemini-4-neon')
  ui.policy('新增规则共享策略', 'strict')
  ui.click('+ 添加规则')
  assert.deepEqual(ui.state().draft.models, { 'gemini-4-neon': { accountId: 'work', fallback: 'strict' } })
  assert.doesNotMatch(ui.html(), /<option value="gemini-4-neon"/)
  ui.click('手动输入')
  ui.change('新增模型 ID', '  GEMINI-4-NEON ')
  ui.click('+ 添加规则')
  assert.match(ui.html(), /这个模型已有规则/)
  ui.change('新增模型 ID', 'gpt-new')
  ui.change('新增规则首选账号', 'auto')
  ui.click('+ 添加规则')
  assert.deepEqual(ui.state().draft.models?.['gpt-new'], { accountId: 'auto' })
  ui.click('返回下拉')
  ui.change('gpt-new首选账号', 'work')
  ui.policy('gpt-new共享策略', 'strict')
  assert.deepEqual(ui.state().draft.models?.['gpt-new'], { accountId: 'work', fallback: 'strict' })
  ui.click('移除 gpt-new 规则')
  assert.doesNotMatch(ui.html(), /gpt-new/)
  let refreshes = 0
  const full = editor({ models: [], accounts: [], onRefreshModels: () => refreshes++, routing: {
    models: Object.fromEntries(Array.from({ length: MAX_MODEL_ROUTE_OVERRIDES }, (_, i) => [`model-${i}`, { accountId: 'auto' }])),
  } })
  assert.equal(full.control('新增规则首选账号').value, 'auto')
  full.click('刷新模型目录')
  assert.equal(refreshes, 1)
  full.change('新增模型 ID', 'extra')
  full.click('+ 添加规则')
  assert.ok(full.html().includes(`最多可添加 ${MAX_MODEL_ROUTE_OVERRIDES} 条具体模型规则`))
  assert.equal(Object.keys(full.state().draft.models ?? {}).length, MAX_MODEL_ROUTE_OVERRIDES)
})

test('save buttons POST a compact replacement and an explicit empty object; clear can be discarded first', async t => {
  const applied: StatusSnapshot[] = []
  const calls: ModelAccountRoutingConfig[] = []
  const ui = editor({ applyStatus: status => applied.push(status) })
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/plugins/agy-acp/config')
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json')
    const body = JSON.parse(String(init.body))
    assert.deepEqual(Object.keys(body), ['modelAccountRouting'])
    calls.push(body.modelAccountRouting)
    const status = { updatedAt: calls.length, accounts: props.accounts, sessions: [], config: { modelAccountRouting: body.modelAccountRouting } }
    return Response.json({ ok: true, status })
  })
  ui.change('Claude 系列首选账号', 'work')
  ui.policy('Claude 系列共享策略', 'auto')
  ui.change('新增具体模型', 'alpha')
  ui.change('新增规则首选账号', 'auto')
  ui.click('+ 添加规则')
  const save = ui.click('保存分配规则')
  assert.equal(ui.control('保存中…').disabled, true)
  await save
  const expected = { families: { claude: { accountId: 'work' } }, models: { alpha: { accountId: 'auto' } } }
  assert.deepEqual(calls, [expected])
  assert.deepEqual(applied.map(s => s.config?.modelAccountRouting), [expected])
  assert.match(ui.html(), /role="status"[^>]*>分配规则已保存/)
  ui.click('清空全部规则')
  assert.equal(calls.length, 1)
  assert.deepEqual(ui.state().draft, {})
  ui.click('放弃修改')
  assert.deepEqual(ui.state().draft, expected)
  ui.click('清空全部规则')
  await ui.click('保存分配规则')
  assert.deepEqual(calls, [expected, {}])
  assert.deepEqual(applied.map(s => s.config?.modelAccountRouting), [expected, {}])
  assert.equal(ui.control('保存分配规则').disabled, true)
})

test('400, malformed success and offline saves keep edits for retry and never publish an invalid status', async t => {
  const replies = [Response.json({ error: '该账号不可用' }, { status: 400 }), Response.json({ ok: true })]
  t.mock.method(globalThis, 'fetch', async () => { const res = replies.shift(); if (!res) throw new Error('offline'); return res })
  const ui = editor({ applyStatus: () => assert.fail('invalid status published') })
  ui.change('GPT 系列首选账号', 'work')
  for (const error of ['该账号不可用', '未收到有效的保存结果', '未能连接到插件']) {
    await ui.click('保存分配规则')
    assert.ok(ui.html().includes(`保存失败：${error}`))
    assert.deepEqual(ui.state().draft.families, { gpt: { accountId: 'work' } })
    assert.equal(ui.control('保存分配规则').disabled, false)
  }
})

test('SSE synchronizes only changed rules on a clean editor; discard and manual revert adopt the newest server rules', () => {
  const a = { families: { gpt: { accountId: 'auto' } } }
  const b = { models: { alpha: { accountId: 'auto' } } }
  const ui = editor()
  ui.sync(a)
  const clean = ui.state()
  ui.sync(structuredClone(a))
  assert.equal(ui.state(), clean)
  ui.change('GPT 系列首选账号', 'work')
  const edited = ui.state()
  ui.sync(b)
  assert.equal(ui.state().draft, edited.draft)
  assert.equal(ui.state().baseline, edited.baseline)
  assert.equal(ui.control('GPT 系列首选账号').value, 'work')
  ui.click('放弃修改')
  assert.deepEqual(ui.state().draft, b)
  ui.change('Claude 系列首选账号', 'work')
  ui.sync(undefined)
  ui.change('Claude 系列首选账号', '')
  assert.deepEqual(ui.state().draft, {})
  assert.equal(ui.control('保存分配规则').disabled, true)
})
