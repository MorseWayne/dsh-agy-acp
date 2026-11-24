import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error React is supplied without its declaration package
import React from 'react'
// @ts-expect-error ReactDOM is supplied without its declaration package
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountHealthSnapshot, StatusSnapshot } from '../src/common/types.ts'
import { initialSnapshot, reduceSnapshot, snapshotNotice } from '../src/client/snapshot-state.ts'
import { AccountCard } from '../src/client/account-card.ts'
import { activeCooldowns, bucketDisplay, nextAccountExpiry, requestAccountAction, sessionAccountLabel } from '../src/client/account-display.ts'

const account: AccountHealthSnapshot = {
  id: 'default', label: '本机默认账号', enabled: true, hasProxy: false, hasSandboxHome: false,
  activeLeases: 0, families: {}, lastError: null, lastUsedAt: null,
}
const now = 10_000

test('only a fresh status event can restore live attribution after an SSE disconnection', () => {
  const snapshot = { updatedAt: now, accounts: [account] } as StatusSnapshot
  const first = reduceSnapshot(initialSnapshot, { type: 'initial', value: snapshot })
  assert.match(snapshotNotice(first), /等待实时连接；显示上次快照/)
  const live = reduceSnapshot(first, { type: 'sse', value: { ...snapshot, updatedAt: now + 1 } })
  assert.equal(snapshotNotice(live), '')
  const stale = reduceSnapshot(live, { type: 'disconnect' })
  assert.equal(stale.status, live.status)
  assert.match(snapshotNotice(stale), /实时连接中断；显示上次快照/)
  const action = reduceSnapshot(stale, { type: 'action', value: { ...snapshot, updatedAt: now + 2 } })
  assert.equal(action.stream, 'offline')
  assert.equal(reduceSnapshot(action, { type: 'sse', value: snapshot }), action)
  const resumed = reduceSnapshot(action, { type: 'sse', value: { ...snapshot, updatedAt: now + 3 } })
  assert.equal(resumed.stream, 'live')
  assert.equal(snapshotNotice(resumed), '')
})

test('a delayed initial GET never replaces an accepted SSE snapshot or clears a disconnect', () => {
  const snapshot = { updatedAt: now, accounts: [account] } as StatusSnapshot
  const live = reduceSnapshot(initialSnapshot, { type: 'sse', value: snapshot })
  const late = { ...snapshot, updatedAt: now + 100, accounts: [] }
  assert.equal(reduceSnapshot(live, { type: 'initial', value: late }), live)
  assert.equal(reduceSnapshot(live, { type: 'readFailed' }), live)
  const disconnected = reduceSnapshot(initialSnapshot, { type: 'disconnect' })
  assert.equal(reduceSnapshot(disconnected, { type: 'initial', value: late }).stream, 'offline')
})

test('use the session lease ID, not the first, enabled or default account', () => {
  const accounts = [account, { id: 'work', label: '研发账号' }]
  assert.equal(sessionAccountLabel('work', accounts), '研发账号 (work)')
  assert.equal(sessionAccountLabel('default', accounts), '本机默认账号 (default)')
  assert.equal(sessionAccountLabel('removed', accounts), 'removed')
})

test('measured zero, small positive quotas, unknown and expired buckets have distinct labels', () => {
  assert.equal(bucketDisplay(undefined, now), '未获取')
  assert.equal(bucketDisplay({ remainingFraction: 0, resetAt: now + 1 }, now), '0%')
  assert.equal(bucketDisplay({ remainingFraction: 0.00005 }, now), '<0.1%')
  assert.equal(bucketDisplay({ remainingFraction: 0.57 }, now), '57%')
  assert.equal(bucketDisplay({ remainingFraction: 0, resetAt: now }, now), '已过期，待刷新')
  assert.equal(bucketDisplay({ remainingFraction: -1 }, now), '未获取')
})

test('expiry changes local display without requesting a quota refresh', () => {
  const sample = { ...account,
    families: { claude: { cooldownUntil: now + 5, consecutiveFailures: 1 }, other: { cooldownUntil: now, consecutiveFailures: 1 } },
    quota: { sampledAt: now - 5, groups: [{ name: 'Gemini', fiveHour: { remainingFraction: 0, resetAt: now + 10 } }] },
  }
  assert.deepEqual(activeCooldowns(sample.families, now), [{ family: 'claude', until: now + 5 }])
  assert.equal(nextAccountExpiry(sample, now), now + 5)
  assert.deepEqual(activeCooldowns(sample.families, now + 5), [])
  assert.equal(nextAccountExpiry(sample, now + 5), now + 10)
  assert.equal(nextAccountExpiry(sample, now + 10), undefined)
})

function markup(sample: AccountHealthSnapshot): string {
  return renderToStaticMarkup(React.createElement(AccountCard, { account: sample, applyStatus: () => {} }))
}

test('unattributable account shows the reason and disabled refresh, but no fake percentage or clear action', () => {
  const html = markup({ ...account, enabled: false, quotaRefreshUnavailable: '此环境不能归属到唯一账号', lastError: 'secret-marked-raw-error' })
  assert.match(html, /已停用/)
  assert.match(html, /最近分配：暂无记录/)
  assert.match(html, /暂无配额样本/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>刷新配额/)
  assert.match(html, /此环境不能归属到唯一账号/)
  assert.doesNotMatch(html, /0%|清除本地冷却|secret-marked-raw-error/)
})

test('account draws the sampled groups, update time, and only active local cooldown families', () => {
  const html = markup({ ...account, lastUsedAt: now,
    families: { claude: { cooldownUntil: Date.now() + 100_000, consecutiveFailures: 1 }, other: { cooldownUntil: now, consecutiveFailures: 99 } },
    quota: { sampledAt: now, groups: [
      { name: 'Gemini Pro', fiveHour: { remainingFraction: 0 } },
      { name: 'Claude Opus', sevenDay: { remainingFraction: 0, resetAt: now } },
    ] },
  })
  for (const text of ['已启用', '上次成功更新', 'claude · 冷却至', '清除本地冷却', 'Gemini Pro', 'Claude Opus', '5 小时', '7 天', '0%', '未获取', '已过期，待刷新']) assert.ok(html.includes(text), text)
  assert.doesNotMatch(html, /other · 冷却至|最近分配：暂无记录/)
})

test('manual refresh posts the exact account once and consumes returned status', async () => {
  const calls: unknown[] = []
  const status = { accounts: [account], updatedAt: now }
  const result = await requestAccountAction('refresh', 'default', async (url, init) => {
    calls.push([url, init?.method, JSON.parse(String(init?.body))])
    return Response.json({ status })
  })
  assert.deepEqual(calls, [['/plugins/agy-acp/accounts/quota/refresh', 'POST', { accountId: 'default' }]])
  assert.deepEqual(result, status)
})

test('known HTTP statuses provide actionable, locally authored reasons', async () => {
  const failures = new Map([[404, '账号不存在，请检查账号配置。'], [409, '该账号的查询环境不可用，请检查启用状态与凭据隔离设置。'],
    [502, 'agy CLI 未能读取配额，请检查该账号的登录状态和 CLI 版本。'], [503, '无法启动只读配额查询，请检查 agy CLI 和账号环境。']])
  for (const [status, message] of failures) {
    await assert.rejects(requestAccountAction('refresh', 'default', async () => Response.json({ error: 'secret-marked-error' }, { status })), { message })
  }
})

test('errors, non-JSON replies and network failures never leak raw data or produce a false success', async () => {
  for (const request of [
    async () => Response.json({ error: 'secret-marked-proxy-url' }, { status: 500 }),
    async () => Response.json({}),
    async () => new Response('secret-marked-html'),
    async () => { throw new Error('secret-marked-network-error') },
  ]) await assert.rejects(requestAccountAction('refresh', 'default', request), { message: '配额刷新失败，请稍后重试。' })
})
