import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error React is supplied without its declaration package
import React from 'react'
// @ts-expect-error ReactDOM is supplied without its declaration package
import { renderToStaticMarkup } from 'react-dom/server'
import { addUsageCounters, emptyUsageCounter } from '../src/common/account-usage.ts'
import type {
  AccountHealthSnapshot, AccountUsageEntry, AccountUsageSnapshot, StatusSnapshot, UsageCounter,
} from '../src/common/types.ts'
import {
  AccountUsagePanel, initialUsagePanel, renderAccountUsagePanel, type AccountUsagePanelProps,
} from '../src/client/account-usage-panel.ts'
import { SettingsView } from '../src/client/index.ts'
import { formatTime, SegmentedControl } from '../src/client/ui-primitives.ts'

const account: AccountHealthSnapshot = {
  id: 'work', label: '工作号', enabled: false, hasSandboxHome: true, activeLeases: 0, families: {}, lastError: null, lastUsedAt: null,
}
const timestamp = 1_700_000_000_000
const counter = (delta: Partial<UsageCounter>) => addUsageCounters(emptyUsageCounter(), delta)
function entry(id: string, families: AccountUsageEntry['families'], accountLabel?: string): AccountUsageEntry {
  return { accountId: id, accountLabel, lastUsedAt: timestamp, families,
    totals: Object.values(families).reduce(addUsageCounters, emptyUsageCounter()) }
}
function windowOf(...accounts: AccountUsageEntry[]) {
  return { accounts, totals: accounts.reduce((total, e) => addUsageCounters(total, e.totals), emptyUsageCounter()) }
}
const work = entry('work', {
  gpt: counter({ inputTokens: 100, requests: 1 }), other: emptyUsageCounter(),
  claude: counter({ inputTokens: 900, cachedReadTokens: 150, cachedWriteTokens: 50, outputTokens: 50, reasoningTokens: 20, requests: 2, rateLimited: 1 }),
}, '旧备注')
const gone = entry('removed', { 'gemini-pro': counter({ inputTokens: 600, outputTokens: 150, requests: 4, failed: 2 }) }, '历史账号')
const weekGone = entry('removed', { 'gemini-pro': counter({ inputTokens: 3600, outputTokens: 150, requests: 8, failed: 2 }) }, '历史账号')
const old = entry('old-id', { other: counter({ outputTokens: 5000, requests: 9 }) })
const usage: AccountUsageSnapshot = {
  today: windowOf(work, gone), last7Days: windowOf(weekGone, work), allTime: windowOf(old, weekGone, work), retentionDays: 30, updatedAt: timestamp,
}
const empty: AccountUsageSnapshot = { ...usage, today: windowOf(), last7Days: windowOf(), allTime: windowOf() }
const props: AccountUsagePanelProps = { accountUsage: usage, accounts: [account], applyStatus() {} }

// Re-render the controlled view after invoking the actual rendered button handlers,
// including the buttons inside the same SegmentedControl used in production.
function dashboard(overrides: Partial<AccountUsagePanelProps> = {}) {
  let state = initialUsagePanel
  const input = { ...props, ...overrides }
  const view = () => renderAccountUsagePanel(input, state, next => { state = next })
  function button(label: string) {
    function lookup(node: ReturnType<typeof React.createElement>): ReturnType<typeof React.createElement> {
      if (!React.isValidElement(node)) return
      if (node.type === SegmentedControl) return lookup(SegmentedControl(node.props))
      if (node.type === 'button' && node.props.children === label) return node.props
      for (const child of React.Children.toArray(node.props.children)) {
        const match = lookup(child)
        if (match) return match
      }
    }
    const result = lookup(view())
    assert.ok(result, `missing button: ${label}`)
    return result
  }
  return { html: (): string => renderToStaticMarkup(view()), button, click(label: string) {
    const p = button(label)
    assert.ok(!p.disabled, `disabled: ${label}`)
    return p.onClick()
  } }
}

// Assert each account's own share, not just a percentage somewhere in the panel.
function assertRows(html: string, expected: [string, string][]) {
  const rows = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(match => match[1])
  assert.equal(rows.length, expected.length)
  expected.forEach(([name, pct], i) => {
    const row = rows[i]
    assert.ok(row, `missing account row ${i}`)
    assert.ok(row.includes(`<strong>${name}</strong>`), `${name} at position ${i}`)
    assert.ok(row.includes(`占比 ${pct}%`))
    assert.ok(row.includes('role="progressbar"') && row.includes(`width:${Number(pct).toFixed(1)}%`))
  })
}

test('missing accountUsage is distinct from an empty window on older backends', () => {
  const html = renderToStaticMarkup(React.createElement(AccountUsagePanel, { ...props, accountUsage: undefined }))
  assert.match(html, /暂未收到用量统计，等待连接或插件更新。/)
  assert.doesNotMatch(html, /agy-acp-kpi-tile|总 Token|暂无账号用量记录/)
  assert.equal(dashboard({ accountUsage: undefined }).button('清空统计').disabled, true)
})

test('range buttons switch pool KPIs, ranked accounts, shares and model-family details together', () => {
  const ui = dashboard()
  let html = ui.html()
  assert.equal(ui.button('今日')['aria-checked'], true)
  assertRows(html, [['工作号', '62.5'], ['历史账号', '37.5']])
  assert.match(html, /总 Token[^]*?>2\.0k<[^]*?请求轮次[^]*?>7 次</)
  assert.match(html, /限流 1 · 失败 2/)
  assert.match(html, /输入 \/ 缓存读[^]*?>1\.6k \/ 150<[^]*?>缓存写 50<[^]*?输出 \/ 推理[^]*?>200 \/ 20</)
  assert.match(html, /工作号<[^]*?>已停用<[^]*?agy-acp-pill--warn">限流 1</)
  assert.match(html, /历史账号<[^]*?>已移除<[^]*?agy-acp-pill--error">失败 2</)
  assert.ok(html.includes(`最近使用 ${formatTime(timestamp)}`))
  assert.match(html, /输入 1\.0k · 缓存读 150 · 缓存写 50 · 输出 50 · 推理 20/)
  assert.match(html, /Claude 系列 · 1\.1k · 2 次[^]*GPT 系列 · 100 · 1 次/)
  assert.doesNotMatch(html, /其他模型|旧备注/)
  ui.click('近 7 天')
  html = ui.html()
  assert.equal(ui.button('近 7 天')['aria-checked'], true)
  assertRows(html, [['历史账号', '75'], ['工作号', '25']])
  assert.match(html, /总 Token[^]*?>5\.0k<[^]*?请求轮次[^]*?>11 次</)
  assert.match(html, /Gemini 专业版 · 3\.8k · 8 次/)
  ui.click('累计')
  html = ui.html()
  assert.equal(ui.button('累计')['aria-checked'], true)
  assertRows(html, [['old-id', '50'], ['历史账号', '37.5'], ['工作号', '12.5']])
  assert.match(html, /总 Token[^]*?>10\.0k<[^]*?请求轮次[^]*?>20 次</)
  assert.match(html, /其他模型 · 5\.0k · 9 次/)
})

test('shares fall back to requests, then rate limits plus failures; failures-only families remain visible', () => {
  const problems = windowOf(entry('a', { gpt: counter({ rateLimited: 1, failed: 2 }) }), entry('b', { claude: counter({ rateLimited: 1 }) }))
  const requests = windowOf(entry('a', { other: counter({ requests: 4 }) }), entry('b', { other: counter({ requests: 1, failed: 2 }) }))
  const ui = dashboard({ accountUsage: { ...empty, today: problems, last7Days: requests, allTime: problems } })
  assertRows(ui.html(), [['a', '75'], ['b', '25']])
  assert.match(ui.html(), /限流与失败占比 75%/)
  assert.match(ui.html(), /GPT 系列 · 0 · 0 次 · 限流 1 · 失败 2/)
  assert.equal(ui.button('清空统计').disabled, false)
  ui.click('近 7 天')
  assertRows(ui.html(), [['a', '80'], ['b', '20']])
  assert.match(ui.html(), /请求占比 80%/)
})

test('empty windows link users to relevant history without enabling reset for a genuinely empty pool', () => {
  const ui = dashboard({ accountUsage: { ...usage, today: windowOf() } })
  assert.match(ui.html(), /暂无账号用量记录。可切换到「近 7 天」或「累计」查看历史记录。/)
  assert.equal(ui.button('清空统计').disabled, false)
  const older = dashboard({ accountUsage: { ...empty, allTime: usage.allTime } })
  older.click('近 7 天')
  assert.match(older.html(), /可切换到「累计」查看历史记录/)
  const fresh = dashboard({ accountUsage: empty })
  assert.equal(fresh.button('清空统计').disabled, true)
  assert.match(fresh.html(), /当前时段暂无账号用量记录。/)
  assert.doesNotMatch(fresh.html(), /查看历史记录|暂未收到用量/)
})

test('reset requires explicit confirmation, locks controls while submitting and applies the returned status', async t => {
  const status = { updatedAt: 2, sessions: [], accounts: [], accountUsage: empty }
  const applied: StatusSnapshot[] = []
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/plugins/agy-acp/usage/reset')
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(String(init.body)), {})
    return Response.json({ ok: true, status })
  })
  const ui = dashboard({ applyStatus: next => applied.push(next) })
  ui.click('清空统计')
  assert.match(ui.html(), /确认清空全部历史与每日用量统计？此操作不可撤销。/)
  ui.click('取消')
  assert.doesNotMatch(ui.html(), /确认清空/)
  ui.click('清空统计')
  assert.equal(request.mock.callCount(), 0)
  const pending = ui.click('确认清空')
  for (const label of ['取消', '清空中…', '清空统计', '累计']) assert.equal(ui.button(label).disabled, true)
  await pending
  assert.equal(request.mock.callCount(), 1)
  assert.deepEqual(applied, [status])
  assert.match(ui.html(), /role="status"[^>]*>用量统计已清空。/)
  assert.doesNotMatch(ui.html(), /确认清空/)
})

test('HTTP, invalid status or usage payloads, and offline resets show a Chinese error without applying status', async t => {
  const base = { updatedAt: 3, accounts: [], sessions: [] }
  const replies = [
    Response.json({ error: '存储不可写' }, { status: 500 }),
    Response.json({ ok: true, status: {} }),
    Response.json({ ok: true, status: base }),
    Response.json({ ok: true, status: { ...base, accountUsage: { ...empty, today: { accounts: [] } } } }),
  ]
  t.mock.method(globalThis, 'fetch', async () => {
    const res = replies.shift()
    if (!res) throw new Error('offline')
    return res
  })
  const ui = dashboard({ applyStatus: () => assert.fail('invalid status published') })
  for (const message of ['存储不可写', '未收到有效的用量快照', '未收到有效的用量快照', '未收到有效的用量快照', '未能连接到插件']) {
    ui.click('清空统计')
    await ui.click('确认清空')
    assert.ok(ui.html().includes(`清空失败：${message}`))
    assert.match(ui.html(), /role="alert"/)
    assert.doesNotMatch(ui.html(), /用量统计已清空/)
    assert.equal(ui.button('清空统计').disabled, false)
  }
})

test('accounts tab passes live usage and renders the dashboard before account status and routing', () => {
  const status = { accounts: [account], models: [], sessions: [], updatedAt: 1, config: {}, accountUsage: usage }
  const html = renderToStaticMarkup(React.createElement(SettingsView, { status, stream: 'live', failed: false, initialPanel: 'accounts', applyStatus() {} }))
  assert.match(html, /多账号用量看板<\/h3>[^]*Token占比 62\.5%[^]*账号状态 \(1\)<\/h3>[^]*模型账号分配（额度共享）<\/h3>/)
})
