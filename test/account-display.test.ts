import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error React is supplied without its declaration package
import React from 'react'
// @ts-expect-error ReactDOM is supplied without its declaration package
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountHealthSnapshot, StatusSnapshot } from '../src/common/types.ts'
import { initialSnapshot, reduceSnapshot, snapshotNotice } from '../src/client/snapshot-state.ts'
import { AccountCard } from '../src/client/account-card.ts'
import { activeCooldowns, bucketDisplay, lowQuotaWarnings, nextAccountExpiry, requestAccountAction, sessionAccountLabel } from '../src/client/account-display.ts'
import { resetSessions, type SessionResetTarget } from '../src/client/panel-actions.ts'
import { ConfigFieldset, SettingsView } from '../src/client/index.ts'
import { createStatusStore, type EventSourceLike } from '../src/client/status-store.ts'

const account: AccountHealthSnapshot = {
  id: 'default', label: '本机默认账号', enabled: true, hasSandboxHome: false,
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

test('createStatusStore shares one EventSource across subscribers, avoids fake-online after grace close, and is SSR-safe', async () => {
  const fullSnap = (updatedAt: number): StatusSnapshot => ({
    providerId: 'antigravity-acp',
    enabled: true,
    connected: true,
    agentName: 'agy',
    agentVersion: '1.5.16',
    tierName: 'Pro',
    activeSessions: 0,
    sessions: [],
    mcpBridgeActive: false,
    usageTotals: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, reasoningTokens: 0 },
    accounts: [account],
    models: [],
    config: { agyBin: '', workspaceRoot: '', defaultModel: '', defaultEffort: '', mcpBridge: false, sessionIdleTtlMs: 1_800_000, requestTimeoutMs: 600_000 },
    hasPersistedConfig: false,
    lastError: null,
    updatedAt,
  })

  let createdEs = 0
  let closedEs = 0
  let fetchCalls = 0
  const hooks: {
    status: ((ev: MessageEvent<string>) => void) | null
    error: (() => void) | null
    timer: (() => void) | null
  } = { status: null, error: null, timer: null }

  const store = createStatusStore({
    closeGraceMs: 100,
    fetchStatus: async () => {
      fetchCalls++
      return fullSnap(100)
    },
    createEventSource: () => {
      createdEs++
      const mock: EventSourceLike = {
        addEventListener(type, listener) {
          if (type === 'status') hooks.status = listener
          if (type === 'error') hooks.error = listener as () => void
        },
        removeEventListener(type) {
          if (type === 'status') hooks.status = null
          if (type === 'error') hooks.error = null
        },
        close() {
          closedEs++
        },
      }
      return mock
    },
    setTimeoutFn: (fn) => {
      hooks.timer = fn
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutFn: () => {
      hooks.timer = null
    },
  })

  let n1 = 0
  let n2 = 0
  const unsub1 = store.subscribe(() => { n1++ })
  const unsub2 = store.subscribe(() => { n2++ })
  assert.equal(createdEs, 1)
  assert.equal(fetchCalls, 1)

  // Live SSE event updates both subscribers
  hooks.status?.({ data: JSON.stringify(fullSnap(200)) } as MessageEvent<string>)
  assert.equal(store.getSnapshot().stream, 'live')
  const stableRef = store.getSnapshot()
  // Duplicate disconnect/error must keep referential stability if nothing changed
  hooks.error?.()
  const afterDisconnect = store.getSnapshot()
  assert.notEqual(afterDisconnect, stableRef)
  const notificationsBeforeDup = n1
  hooks.error?.()
  assert.equal(store.getSnapshot(), afterDisconnect)
  assert.equal(n1, notificationsBeforeDup)

  // Back to live, then unsubscribe all -> within grace period resubscribe reuses connection
  hooks.status?.({ data: JSON.stringify(fullSnap(250)) } as MessageEvent<string>)
  assert.equal(store.getSnapshot().stream, 'live')
  unsub1()
  unsub2()
  assert.ok(hooks.timer)
  const unsub3 = store.subscribe(() => {})
  assert.equal(hooks.timer, null)
  assert.equal(createdEs, 1)
  assert.equal(closedEs, 0)

  // Unsubscribe all and let grace timer expire -> closes ES and resets stream from 'live' to 'connecting'
  unsub3()
  const fireTimer = hooks.timer as (() => void) | null
  assert.ok(fireTimer)
  fireTimer()
  assert.equal(closedEs, 1)
  assert.equal(store.getSnapshot().stream, 'connecting')

  // Resubscribing creates fresh EventSource and stays 'connecting' until new SSE frame arrives
  const unsub4 = store.subscribe(() => {})
  assert.equal(createdEs, 2)
  assert.equal(store.getSnapshot().stream, 'connecting')
  store.applyStatus(fullSnap(300))
  assert.equal(store.getSnapshot().status?.updatedAt, 300)
  unsub4()
  store.dispose()

  // SSR environment without EventSource does not throw
  const ssrStore = createStatusStore({ fetchStatus: async () => null, createEventSource: () => null })
  const unsubSsr = ssrStore.subscribe(() => {})
  unsubSsr()
  ssrStore.dispose()
})

function panelFixture(): StatusSnapshot {
  return {
    providerId: 'antigravity-acp',
    enabled: true,
    connected: true,
    agentName: 'Antigravity ACP Server',
    agentVersion: '1.5.16',
    tierName: 'Pro',
    activeSessions: 1,
    sessions: [
      {
        dshSessionKey: 'conv-1',
        acpSessionId: 'acp-1',
        accountId: 'default',
        cwd: '/work',
        currentModel: 'gemini-4-neon',
        currentEffort: 'high',
        currentMode: 'default',
        title: '修复鉴权缓存逻辑',
        resumed: true,
        contextUsed: 160_000,
        contextSize: 200_000,
        lastActiveAt: now,
      },
    ],
    persistedSessions: 2,
    mcpBridgeActive: true,
    mcpBridge: {
      enabled: true,
      activeBridges: 1,
      inFlightCalls: 0,
      totalCalls: 4,
      failedCalls: 1,
      lastToolName: 'search_docs',
      lastCallAt: now,
      lastError: '工具 "search_docs" 调用超时（>60000ms）',
    },
    usageTotals: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 400, cachedWriteTokens: 50, reasoningTokens: 80 },
    accounts: [account],
    models: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high'] },
      { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['medium', 'high'] },
    ],
    config: {
      agyBin: '',
      workspaceRoot: '',
      defaultModel: 'legacy-custom-model',
      defaultEffort: '',
      mcpBridge: true,
      sessionIdleTtlMs: 900_000,
      requestTimeoutMs: 120_000,
    },
    hasPersistedConfig: true,
    lastError: 'ACP 模型目录探测超时，请检查 agy CLI 登录状态',
    updatedAt: now,
  }
}

test('SettingsView renders model select, lastError banner, timeout inputs, context progressbar, and uses DSH theme tokens', () => {
  const snap = panelFixture()

  const html = renderToStaticMarkup(
    React.createElement(SettingsView, { status: snap, stream: 'live', failed: false, applyStatus: () => {} }),
  )
  assert.match(html, /<select/)
  assert.match(html, /Gemini 4 Neon \(gemini-4-neon\)/)
  assert.match(html, /legacy-custom-model（当前已存，不在目录中）/)
  assert.match(html, /目录\/连接诊断/)
  assert.match(html, /重新探测目录/)
  assert.match(html, /空闲会话回收/)
  assert.match(html, /单次请求超时/)
  assert.match(html, /地域合规防护（防封号拦截）/)
  assert.match(html, /拦截受限地区（推荐，默认）/)
  assert.match(html, /严格模式（受限与未知均拦截）/)
  assert.match(html, /桥接运行态：挂载会话 1 · 在途调用 0 · 累计调用 4 · 失败\/超时 1 · 最近工具 search_docs/)
  assert.match(html, /最近桥接告警/)
  assert.match(html, /恢复索引：2 个/)
  assert.match(html, /已恢复（方式未上报）/)
  assert.match(html, /标题：修复鉴权缓存逻辑/)
  assert.match(html, /配额感知多账号调度（Quota-Aware Scheduling）/)
  assert.match(html, /恢复默认/)
  assert.match(html, /role="progressbar"/)
  assert.match(html, /--dsw-alias-/)
  assert.doesNotMatch(html, /#18181b/)
})

test('AccountCard renders supported, unsupported, error, and unchecked egress states and posts egress/check action safely', async () => {
  const uncheckedHtml = markup(account)
  assert.match(uncheckedHtml, /网络出口合规/)
  assert.match(uncheckedHtml, /出口：待检测/)
  assert.match(uncheckedHtml, /检测出口/)

  const supportedHtml = markup({
    ...account,
    egress: {
      status: 'supported',
      country: 'US',
      ipMasked: '203.0.113.*',
      proxyMode: 'proxy',
      probeSource: 'cloudflare-trace',
      checkedAt: now,
      expiresAt: now + 300_000,
    },
  })
  assert.match(supportedHtml, /出口：US（代理）· 合规/)
  assert.match(supportedHtml, /IP 203\.0\.113\.\*/)

  const googleSupportedHtml = markup({
    ...account,
    egress: {
      status: 'supported',
      country: null,
      ipMasked: null,
      proxyMode: 'proxy',
      probeSource: 'google-aistudio',
      checkedAt: now,
      expiresAt: now + 300_000,
    },
  })
  assert.match(googleSupportedHtml, /出口：Google 可用（代理）· 合规/)
  assert.match(googleSupportedHtml, /Google 匿名预检/)

  const googleUnknownHtml = markup({
    ...account,
    egress: {
      status: 'unknown',
      country: null,
      ipMasked: null,
      proxyMode: 'proxy',
      probeSource: 'google-cloudcode',
      checkedAt: now,
      expiresAt: now + 30_000,
      reason: 'daily-cloudcode-pa.googleapis.com 代理通道可达',
    },
  })
  assert.match(googleUnknownHtml, /出口：地域待确认（代理）/)
  assert.match(googleUnknownHtml, /Google API 连通检查/)

  const unsupportedHtml = markup({
    ...account,
    egress: {
      status: 'unsupported',
      country: 'HK',
      ipMasked: '198.51.100.*',
      proxyMode: 'direct',
      probeSource: 'cloudflare-trace',
      checkedAt: now,
      expiresAt: now + 60_000,
      reason: '当前出口位于不受 Google 支持的地区（HK）',
    },
  })
  assert.match(unsupportedHtml, /出口：HK（直连）· 不支持 Gemini（策略拦截）/)
  assert.match(unsupportedHtml, /当前出口位于不受 Google 支持的地区（HK）/)

  const errorHtml = markup({
    ...account,
    egress: {
      status: 'error',
      country: null,
      ipMasked: null,
      proxyMode: 'proxy',
      probeSource: null,
      checkedAt: now,
      expiresAt: now + 30_000,
      reason: 'HTTP 代理认证失败（HTTP 407）',
    },
  })
  assert.match(errorHtml, /出口：探测异常（代理）/)
  assert.match(errorHtml, /HTTP 代理认证失败（HTTP 407）/)

  const calls: unknown[] = []
  const status = { accounts: [account], updatedAt: now }
  const res = await requestAccountAction('egress', 'default', async (url, init) => {
    calls.push([url, init?.method, JSON.parse(String(init?.body))])
    return Response.json({ status })
  })
  assert.deepEqual(calls, [['/plugins/agy-acp/accounts/egress/check', 'POST', { accountId: 'default' }]])
  assert.deepEqual(res, status)

  await assert.rejects(
    requestAccountAction('egress', 'default', async () => Response.json({ error: 'secret-proxy' }, { status: 404 })),
    { message: '账号不存在，请检查账号配置。' },
  )
  await assert.rejects(
    requestAccountAction('refresh', 'default', async () => Response.json({ error: 'blocked' }, { status: 451 })),
    { message: '当前网络出口位于受限地区，已在本地拦截配额查询以防触发风控。' },
  )

  // Low-quota warning helper & AccountCard alert banner
  const warnings = lowQuotaWarnings(
    {
      sampledAt: now,
      groups: [
        { name: 'Gemini Models', fiveHour: { remainingFraction: 0.12, resetAt: now + 60_000 }, sevenDay: { remainingFraction: 0.8 } },
        { name: 'Claude Models', fiveHour: { remainingFraction: 0, resetAt: now - 1 } }, // expired -> ignored
      ],
    },
    now,
  )
  assert.deepEqual(warnings, [{ group: 'Gemini Models', windowLabel: '5 小时', remainingFraction: 0.12, exhausted: false }])
  const lowHtml = markup({
    ...account,
    quota: {
      sampledAt: now,
      groups: [{ name: 'Gemini Models', fiveHour: { remainingFraction: 0.12, resetAt: Date.now() + 60_000 } }],
    },
  })
  assert.match(lowHtml, /低配额预警：Gemini Models · 5 小时仅剩 12%/)

  const tosHtml = markup({
    ...account,
    tosBlocked: true,
    tosBlockedAt: now,
    tosBlockedReason: 'TOS_VIOLATION',
  })
  assert.match(tosHtml, /风控\/TOS 隔离中/)
  assert.match(tosHtml, /解除隔离与冷却/)
})

function panelMarkup(status: StatusSnapshot | null, stream: 'live' | 'offline' | 'connecting' = 'live', initialPanel = 'sessions'): string {
  return renderToStaticMarkup(React.createElement(SettingsView, { status, stream, failed: false, initialPanel, applyStatus: () => {} }))
}

test('handshake capabilities, actual session recovery and negotiated bridge transport remain distinct', () => {
  const snap = panelFixture()
  snap.capabilities = { mcpHttp: true, resumeSession: true, loadSession: false, audio: false }
  snap.sessions = [
    { ...snap.sessions[0]!, dshSessionKey: 'resume', resumedVia: 'resume', mcpTransport: 'stdio' },
    { ...snap.sessions[0]!, dshSessionKey: 'load', resumedVia: 'load', mcpTransport: 'http' },
    { ...snap.sessions[0]!, dshSessionKey: 'unbridged', resumed: false, mcpTransport: 'none' },
  ]
  snap.mcpBridge = { ...snap.mcpBridge!, activeBridges: 2, transport: 'mixed' }
  const html = panelMarkup(snap)
  for (const text of ['session/resume：支持', 'session/load：不支持', 'HTTP MCP：支持', '音频：不支持', '图像：未上报',
    'session/resume 已恢复', 'session/load 已恢复', '实际传输：HTTP + stdio', 'MCP 实际传输：stdio', 'MCP 实际传输：HTTP', 'MCP 实际传输：未挂载']) {
    assert.ok(html.includes(text), text)
  }
  snap.sessions = [{ ...snap.sessions[0]!, resumedVia: undefined, mcpTransport: undefined }]
  snap.mcpBridge.activeBridges = 0
  const legacy = panelMarkup(snap)
  assert.match(legacy, /已恢复（方式未上报）/)
  assert.match(legacy, /MCP 实际传输：未上报/)
  assert.match(legacy, /实际传输：未挂载/)
  assert.doesNotMatch(legacy, /session\/load 已恢复|session\/resume 已恢复|实际传输：HTTP/)
})

test('account cards label direct, CLI and unknown quota sources without inventing observations', () => {
  for (const [source, expected] of [['direct', '上游接口'], ['cli', 'agy CLI /usage'], [undefined, '未上报']] as const) {
    const html = markup({ ...account, quota: { source, groups: [], sampledAt: now } })
    assert.ok(html.includes(`来源：${expected}`))
    assert.match(html, /本次查询没有返回配额窗口/)
    assert.doesNotMatch(html, /低配额预警/)
  }
  assert.doesNotMatch(markup(account), /来源：/)
})

test('offline and waiting panels never label a cached connected snapshot as a live connection', () => {
  const snap = panelFixture()
  assert.match(panelMarkup(snap), /ACP 已连接/)
  for (const stream of ['connecting', 'offline'] as const) {
    const html = panelMarkup(snap, stream)
    assert.match(html, /显示上次快照/)
    assert.match(html, /快照中的会话/)
    assert.doesNotMatch(html, /ACP 已连接|ACP 待机/)
  }
  assert.match(panelMarkup(null, 'offline'), /暂时无法读取 ACP 状态/)
})

test('panel navigation surfaces only enabled-account alerts; empty states point to the next action', () => {
  const snap = panelFixture()
  snap.accounts = [{ ...account, tosBlocked: true }, { ...account, id: 'disabled', enabled: false, tosBlocked: true }]
  const flagged = panelMarkup(snap, 'live', 'config')
  assert.match(flagged, /账号与配额 · 2（1 个快照告警）/)
  assert.match(flagged, /aria-pressed="true"[^>]*>桥接配置/)
  assert.match(flagged, /会话与用量 · 1（桥接告警）/)
  snap.accounts = []; snap.models = []; snap.sessions = []; snap.persistedSessions = 0
  const empty = panelMarkup(snap)
  assert.doesNotMatch(empty, /重置全部会话|个快照告警/)
  assert.match(empty, /模型目录为空。可点击「刷新模型目录」探测/)
  assert.match(empty, /尚未收到账号状态。请检查账号配置/)
  assert.match(empty, /选择 Antigravity \(ACP\) 模型并发送消息/)
})

test('restricted egress reflects warn/off policy rather than claiming every request is blocked', () => {
  const sample: AccountHealthSnapshot = { ...account, egress: { status: 'unsupported', country: 'HK', ipMasked: null,
    proxyMode: 'direct', probeSource: null, checkedAt: now, expiresAt: now + 20_000 } }
  for (const [geoFenceMode, expected] of [['warn', '仅告警'], ['off', '本地防护关闭']] as const) {
    const html = renderToStaticMarkup(React.createElement(AccountCard, { account: sample, geoFenceMode, applyStatus: () => {} }))
    assert.ok(html.includes(`不支持 Gemini（${expected}）`))
    assert.doesNotMatch(html, /已拦截|策略拦截/)
  }
})

test('session actions scope the request and only acknowledge a validated host reply', async () => {
  const status = panelFixture()
  const bodies: unknown[] = []
  const respond: typeof fetch = async (url, init) => {
    assert.equal(url, '/plugins/agy-acp/sessions/reset')
    assert.equal(init?.method, 'POST')
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ status })
  }
  for (const invalid of [undefined, null, {}, { kind: 'one' }, { kind: 'one', sessionKey: null },
    { kind: 'one', sessionKey: 42 }, { kind: 'one', sessionKey: '' }, { kind: 'one', sessionKey: ' ' }]) {
    assert.match((await resetSessions(invalid as SessionResetTarget, respond)).message, /未执行关闭/)
  }
  assert.deepEqual(bodies, [])
  assert.deepEqual(await resetSessions({ kind: 'one', sessionKey: 'session-A' }, respond), { status, message: '已关闭会话 session-A' })
  assert.match((await resetSessions({ kind: 'all' }, respond)).message, /已重置全部/)
  assert.deepEqual(bodies, [{ sessionKey: 'session-A' }, {}])
  for (const response of [Response.json({ status: {} }), Response.json({ status: { ...status, sessions: [{}] } }), Response.json({ error: 'raw-host-error' }, { status: 500 })]) {
    const result = await resetSessions({ kind: 'one', sessionKey: 'session-A' }, async () => response)
    assert.equal(result.status, undefined)
    assert.match(result.message, /未完成/)
    assert.doesNotMatch(result.message, /raw-host-error|已关闭/)
  }
})


test('the configuration fieldset locks all edits for both pending writes', () => {
  const html = panelMarkup(panelFixture(), 'live', 'config')
  const form = html.match(/<fieldset[^>]*aria-label="桥接配置"[^>]*>([\s\S]*?)<\/fieldset>/)?.[1]
  assert.ok(form, 'the native group wraps the actual editable fields')
  assert.equal((form.match(/<(?:input|select)\b/g) ?? []).length, 25)
  assert.equal((html.match(/<(?:input|select)\b/g) ?? []).length, 25)
  assert.match(form, /aria-label="补充能力分组 Mnemon 核心记忆与文档"/)
  assert.match(form, /aria-label="替代能力分组 联网搜索"/)
  assert.match(form, /aria-label="自动审查 Provider"/)
  assert.match(form, /aria-label="自动审查模型"/)
  assert.match(form, /aria-label="自动审查推理强度"/)
  for (const operation of ['save', 'resetConfig', null, 'resetSessions'] as const) {
    const group = renderToStaticMarkup(React.createElement(ConfigFieldset, { operation, hidden: false, onEdit() {} }, React.createElement('input')))
    if (operation === 'save' || operation === 'resetConfig') assert.match(group, /<fieldset[^>]*disabled=""[^>]*aria-busy="true"/)
    else assert.doesNotMatch(group, /<fieldset[^>]*disabled/)
  }
})
