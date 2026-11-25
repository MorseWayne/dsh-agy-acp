import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/common/config.ts'
import type { StatusSnapshot } from '../src/common/types.ts'
import { formatAgyStatusReport, runAgyDoctor } from '../src/runtime/doctor.ts'
import { EgressGuard } from '../src/runtime/egress-guard.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { fakeHost } from './fixtures/session-policy.ts'

const FAKE_AGY_BIN = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))

test('formatAgyStatusReport outputs structured Chinese overview and redacts any embedded secrets', () => {
  const now = 1_000_000
  const snap: StatusSnapshot = {
    providerId: 'antigravity-acp',
    enabled: true,
    connected: true,
    agentName: 'Antigravity ACP Server',
    agentVersion: '1.5.17',
    tierName: 'Google AI Ultra',
    activeSessions: 1,
    persistedSessions: 3,
    sessions: [],
    mcpBridgeActive: true,
    mcpBridge: {
      enabled: true,
      activeBridges: 1,
      inFlightCalls: 0,
      totalCalls: 6,
      failedCalls: 1,
      lastToolName: 'search_code',
      lastCallAt: now,
      lastError: 'failed with Bearer super_secret_token_abc123456',
    },
    usageTotals: {
      inputTokens: 12_500,
      outputTokens: 3_200,
      cachedReadTokens: 80_000,
      cachedWriteTokens: 4_000,
      reasoningTokens: 1_100,
    },
    accounts: [
      {
        id: 'acct-1',
        label: '主力账号',
        enabled: true,
        hasSandboxHome: true,
        hasProxy: true,
        activeLeases: 1,
        families: { claude: { consecutiveFailures: 1, cooldownUntil: now + 60_000 } },
        lastError: null,
        lastUsedAt: now,
        egress: {
          status: 'supported',
          country: 'SG',
          ipMasked: '203.0.113.*',
          proxyMode: 'proxy',
          probeSource: 'cloudflare-trace',
          checkedAt: now,
          expiresAt: now + 300_000,
        },
        quota: {
          sampledAt: now,
          groups: [{ name: 'Gemini Models', fiveHour: { remainingFraction: 0.08, resetAt: now + 3_600_000 } }],
        },
      },
    ],
    models: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['high'] }],
    config: {
      agyBin: '',
      workspaceRoot: '',
      defaultModel: '',
      defaultEffort: '',
      mcpBridge: true,
      quotaAwareScheduling: true,
      sessionIdleTtlMs: 1_800_000,
      requestTimeoutMs: 600_000,
      geoFenceMode: 'strict',
    },
    hasPersistedConfig: true,
    lastError: 'err https://u:myPass999@proxy.local:8080 GOOGLE_API_KEY=AIzaSySecretKey1234567890123456789',
    updatedAt: now,
  }

  const text = formatAgyStatusReport(snap, now)
  assert.match(text, /Antigravity ACP 状态概览/)
  assert.match(text, /Google AI Ultra/)
  assert.match(text, /可原生恢复索引 3 个/)
  assert.match(text, /地域防护=strict · 配额调度=开启 · 本机覆盖配置=已启用/)
  assert.match(text, /出口=SG\/代理 \(203\.0\.113\.\*\)/)
  assert.match(text, /低配额预警\[Gemini Models 5h=8%\]/)
  assert.match(text, /\/agy-acp doctor/)
  assert.equal(text.includes('super_secret_token_abc123456'), false)
  assert.equal(text.includes('myPass999'), false)
  assert.equal(text.includes('AIzaSySecretKey'), false)
})

test('runAgyDoctor verifies healthy setup, enforces read-only sandbox confinement, and skips upstream probe when geo-blocked', async () => {
  // 1. Healthy setup: all 5 checks PASS under read-only confinement
  const observedPolicies: string[] = []
  const healthyPool = new AcpSessionPool({
    ...fakeHost,
    egressGuard: new EgressGuard({
      probeFn: async () => ({
        status: 'supported',
        country: 'US',
        ipMasked: '198.51.100.*',
        proxyMode: 'proxy',
        probeSource: 'mock',
      }),
    }),
    getConfig: () => resolveConfig({}),
    resolveBin: () => FAKE_AGY_BIN,
    prepareArgv: async (argv, policy) => {
      observedPolicies.push(`${policy.sessionId}:${policy.mode}`)
      if (argv[1] === '--version') {
        return [process.execPath, '-e', 'console.log("agy version 1.5.17")']
      }
      return [process.execPath, FAKE_AGY_BIN]
    },
  })

  try {
    const okReport = await runAgyDoctor({
      pool: healthyPool,
      resolveBin: () => FAKE_AGY_BIN,
      prepareArgv: async (argv, policy) => {
        observedPolicies.push(`${policy.sessionId}:${policy.mode}`)
        if (argv[1] === '--version') {
          return [process.execPath, '-e', 'console.log("agy version 1.5.17")']
        }
        return [process.execPath, FAKE_AGY_BIN]
      },
    })
    assert.equal(okReport.ok, true)
    assert.match(okReport.text, /PASS=5, WARN=0, FAIL=0/)
    assert.match(okReport.text, /版本 1\.5\.17（独立文件凭据支持=是）/)
    assert.ok(observedPolicies.every((p) => p.endsWith(':read-only')))
  } finally {
    healthyPool.dispose()
  }

  // 2. Partial/refused sandbox confinement + HK geo-block: fails closed with ZERO subprocess launches!
  let childLaunches = 0
  const blockedPool = new AcpSessionPool({
    ...fakeHost,
    egressGuard: new EgressGuard({
      probeFn: async () => ({
        status: 'unsupported',
        country: 'HK',
        ipMasked: '203.0.113.*',
        proxyMode: 'direct',
        probeSource: 'mock',
      }),
    }),
    getConfig: () => resolveConfig({ geoFenceMode: 'block' }),
    resolveBin: () => FAKE_AGY_BIN,
    prepareArgv: async () => {
      childLaunches++
      throw new Error('refusing unconfined startup')
    },
  })

  try {
    const failReport = await runAgyDoctor({
      pool: blockedPool,
      resolveBin: () => FAKE_AGY_BIN,
      prepareArgv: async () => {
        throw new Error('refusing unconfined startup')
      },
    })
    assert.equal(failReport.ok, false)
    assert.match(failReport.text, /\[FAIL\] 宿主只读沙箱/)
    assert.match(failReport.text, /\[FAIL\] 网络出口与 Google 地域合规/)
    assert.match(failReport.text, /\[WARN\] ACP 模型目录：因当前网络出口受限，已安全跳过/)
    assert.equal(childLaunches, 0)
  } finally {
    blockedPool.dispose()
  }
})
