import {
  LOW_QUOTA_THRESHOLD,
  type AccountHealthSnapshot,
  type EnvironmentCheckItem,
  type EnvironmentCheckReport,
  type StatusSnapshot,
} from '../common/types.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import { readCliVersion } from './account-quota.ts'
import type { FilePolicy } from './permission-manager.ts'
import type { AcpSessionPool } from './session-pool.ts'

export interface DoctorDeps {
  pool: AcpSessionPool
  resolveBin: () => string | null
  prepareArgv: (argv: string[], policy: FilePolicy, signal?: AbortSignal) => Promise<string[]>
  configFilePath?: string
  sessionsFilePath?: string
}

function formatTokenShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function summarizeAccountLine(account: AccountHealthSnapshot, now: number): string {
  const parts: string[] = [
    `${account.label}${account.id !== account.label ? ` (${account.id})` : ''}`,
    account.enabled ? '启用' : '停用',
  ]
  if (account.egress) {
    const mode = account.egress.proxyMode === 'proxy' ? '代理' : '直连'
    if (account.egress.status === 'supported') {
      parts.push(`出口=${account.egress.country ?? 'Google可用'}/${mode}${account.egress.ipMasked ? ` (${account.egress.ipMasked})` : ''}`)
    } else if (account.egress.status === 'unsupported') {
      const region = account.egress.country ?? (account.egress.probeSource === 'runtime-400' ? '上游400' : 'Google受限')
      parts.push(`出口=${region}/${mode} [已拦截]`)
    } else {
      parts.push(`出口=异常/${mode}`)
    }
  } else {
    parts.push('出口=待检测')
  }

  if (account.tosBlocked) {
    parts.push('风控隔离(TOS)')
  }

  const activeCooldowns = Object.entries(account.families).filter(
    ([, st]) => st?.cooldownUntil != null && st.cooldownUntil > now,
  )
  if (activeCooldowns.length > 0) {
    parts.push(`冷却中(${activeCooldowns.map(([f]) => f).join(',')})`)
  }

  const lowGroups: string[] = []
  for (const g of account.quota?.groups ?? []) {
    for (const [label, b] of [['5h', g.fiveHour], ['7d', g.sevenDay]] as const) {
      if (!b || (b.resetAt != null && b.resetAt <= now)) continue
      if (b.remainingFraction <= LOW_QUOTA_THRESHOLD) {
        lowGroups.push(`${g.name} ${label}=${Math.round(b.remainingFraction * 100)}%`)
      }
    }
  }
  if (lowGroups.length > 0) {
    parts.push(`低配额预警[${lowGroups.join(', ')}]`)
  }
  if (account.activeLeases > 0) {
    parts.push(`活跃租约=${account.activeLeases}`)
  }
  return `  - ${sanitizeDiagnosticText(parts.join(' · '), 260)}`
}

/**
 * Formats a structured, credential-sanitized status overview for `/agy-acp` / `/agy-acp status`.
 */
export function formatAgyStatusReport(status: StatusSnapshot, now = Date.now()): string {
  const connText = status.connected
    ? `已连接（${sanitizeDiagnosticText(`${status.agentName ?? 'agy'} ${status.agentVersion ?? ''}`.trim(), 80)}）`
    : status.agentVersion
      ? `待机中（上次探测 ${sanitizeDiagnosticText(`${status.agentName ?? 'agy'} ${status.agentVersion}`.trim(), 80)}）`
      : '待机中（首轮对话自动建连）'

  const lines: string[] = [
    `Antigravity ACP 状态概览 (${status.providerId})`,
    `• 连接状态：${connText} · 套餐：${sanitizeDiagnosticText(status.tierName ?? '未知', 60)}`,
    `• 会话连续性：活跃长连接 ${status.activeSessions} 个 · 可原生恢复索引 ${status.persistedSessions ?? 0} 个`,
    `• 策略与持久化：地域防护=${status.config.geoFenceMode ?? 'block'} · 配额调度=${status.config.quotaAwareScheduling ? '开启' : '仅观测'} · 本机覆盖配置=${status.hasPersistedConfig ? '已启用' : '默认'}`,
  ]

  if (status.mcpBridge) {
    const b = status.mcpBridge
    const transportLabel =
      b.transport === 'http'
        ? 'HTTP 直连'
        : b.transport === 'mixed'
          ? 'HTTP+stdio 混合'
          : b.transport === 'stdio'
            ? 'stdio 桥接'
            : ''
    const mcpLine = [
      `反向 MCP=${b.enabled ? '开启' : '关闭'}`,
      transportLabel ? `传输=${transportLabel}` : '',
      `挂载=${b.activeBridges}`,
      `在途=${b.inFlightCalls}`,
      `累计调用=${b.totalCalls}`,
      b.failedCalls > 0 ? `失败/超时=${b.failedCalls}` : '',
    ].filter(Boolean).join(' · ')
    lines.push(`• 桥接指标：${mcpLine}`)
    if (b.lastError) {
      lines.push(`  ⚠ 最近桥接告警：${sanitizeDiagnosticText(b.lastError, 180)}`)
    }
  } else {
    lines.push(`• 反向 MCP：${status.mcpBridgeActive ? '活跃' : '关闭'}`)
  }

  const u = status.usageTotals
  lines.push(
    `• 模型与用量：已缓存模型 ${status.models.length} 个 · Tokens in=${formatTokenShort(u.inputTokens)} cacheRead=${formatTokenShort(u.cachedReadTokens)} cacheWrite=${formatTokenShort(u.cachedWriteTokens)} out=${formatTokenShort(u.outputTokens)} think=${formatTokenShort(u.reasoningTokens)}`,
  )

  if (status.accounts.length > 0) {
    lines.push(`• 账号健康与出口 (${status.accounts.length})：`)
    for (const acc of status.accounts) {
      lines.push(summarizeAccountLine(acc, now))
    }
  }

  if (status.lastError) {
    lines.push(`• 最近诊断错误：${sanitizeDiagnosticText(status.lastError, 240)}`)
  }

  lines.push('• 提示：输入 `/agy-acp doctor` 执行一键只读环境与出口合规自检。')
  return lines.join('\n')
}

interface CheckOutcome {
  id: EnvironmentCheckItem['id']
  level: 'PASS' | 'WARN' | 'FAIL'
  title: string
  detail: string
}

/**
 * Executes a 5-step strictly read-only, sandbox-confined environment self-check for `/agy-acp doctor`
 * and the console "Environment Setup" wizard.
 */
export async function runAgyDoctor(
  deps: DoctorDeps,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text: string; report: EnvironmentCheckReport }> {
  const checks: CheckOutcome[] = []
  let cliVersion: string | null = null
  let supportsFileCredentials = false
  const initialStatus = deps.pool.getStatus()
  const cwd = initialStatus.config.workspaceRoot || process.cwd()
  const effectiveSignal = signal ?? new AbortController().signal

  // 1 & 2. Binary resolution + Host read-only sandbox confinement + CLI version
  const bin = deps.resolveBin()
  if (!bin) {
    checks.push({
      id: 'binary',
      level: 'FAIL',
      title: 'agy 可执行文件',
      detail: '未在配置路径或 PATH 中找到可执行 agy 二进制，请安装 Antigravity CLI 或配置 agyBin。',
    })
    checks.push({
      id: 'sandbox',
      level: 'WARN',
      title: '宿主只读沙箱与 CLI 版本',
      detail: '因未找到 agy 可执行文件，跳过版本执行检查。',
    })
  } else {
    const roPolicy: FilePolicy = { sessionId: '__doctor__', mode: 'read-only', workspaceRoot: cwd }
    let confinedArgv: string[] | null = null
    try {
      confinedArgv = await deps.prepareArgv([bin, '--version'], roPolicy, effectiveSignal)
      checks.push({
        id: 'sandbox',
        level: 'PASS',
        title: '宿主只读沙箱 (sandbox.confine)',
        detail: '已通过完整只读执行约束校验（enforcement=full）。',
      })
    } catch (err) {
      const msg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 180)
      checks.push({
        id: 'sandbox',
        level: 'FAIL',
        title: '宿主只读沙箱 (sandbox.confine)',
        detail: `宿主未能提供完整只读沙箱约束，已拒绝无沙箱执行（${msg || 'confinement unavailable'}）。`,
      })
    }

    if (confinedArgv) {
      try {
        const ver = await readCliVersion(confinedArgv, undefined, cwd, effectiveSignal)
        cliVersion = ver.version
        supportsFileCredentials = ver.supportsFileCredentials
        checks.push({
          id: 'binary',
          level: ver.version ? 'PASS' : 'WARN',
          title: 'agy CLI 版本',
          detail: ver.version
            ? `版本 ${ver.version}（独立文件凭据支持=${ver.supportsFileCredentials ? '是' : '否'}）`
            : `可执行但未解析出标准版本号（${ver.summary || 'unknown'}）`,
        })
      } catch (err) {
        const msg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 180)
        checks.push({
          id: 'binary',
          level: 'FAIL',
          title: 'agy CLI 版本',
          detail: msg || '在只读沙箱中执行 agy --version 失败。',
        })
      }
    }
  }

  // 3. Egress & Geo-fence compliance check across enabled accounts
  try {
    await deps.pool.checkAccountEgress()
    const afterEgress = deps.pool.getStatus()
    const enabled = afterEgress.accounts.filter((a) => a.enabled)
    const unsupported = enabled.filter((a) => a.egress?.status === 'unsupported')
    const degraded = enabled.filter((a) => a.egress?.status === 'error' || a.egress?.status === 'unknown')
    const summary = enabled
      .map((a) => {
        const eg = a.egress
        const mode = eg?.proxyMode === 'proxy' ? '代理' : '直连'
        const region =
          eg?.country ??
          (eg?.status === 'supported'
            ? 'Google可用'
            : eg?.status === 'unsupported'
              ? eg.probeSource === 'runtime-400'
                ? '上游400'
                : 'Google受限'
              : eg?.status ?? '未知')
        return `${a.label}=${region}(${mode}${eg?.ipMasked ? `, ${eg.ipMasked}` : ''})`
      })
      .join('；')

    if (unsupported.length > 0 && enabled.length === unsupported.length) {
      checks.push({
        id: 'egress',
        level: 'FAIL',
        title: '网络出口与 Google 地域合规',
        detail: sanitizeDiagnosticText(`全部启用账号均处于受限地区，本地硬熔断生效中：${summary}`, 240),
      })
    } else if (unsupported.length > 0 || degraded.length > 0) {
      checks.push({
        id: 'egress',
        level: 'WARN',
        title: '网络出口与 Google 地域合规',
        detail: sanitizeDiagnosticText(`部分账号出口受限或探测异常（多账号池将自动避障）：${summary}`, 240),
      })
    } else {
      checks.push({
        id: 'egress',
        level: 'PASS',
        title: '网络出口与 Google 地域合规',
        detail: sanitizeDiagnosticText(`全部启用账号出口合规：${summary || '无启用账号'}`, 240),
      })
    }
  } catch (err) {
    const msg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 180)
    checks.push({
      id: 'egress',
      level: 'WARN',
      title: '网络出口与 Google 地域合规',
      detail: `出口检测未能完成：${msg}`,
    })
  }

  // 4. ACP Model Catalog connectivity
  const latestBeforeCatalog = deps.pool.getStatus()
  const enabledBeforeCatalog = latestBeforeCatalog.accounts.filter((a) => a.enabled)
  const allBlockedByGeo =
    latestBeforeCatalog.config.geoFenceMode !== 'off' &&
    latestBeforeCatalog.config.geoFenceMode !== 'warn' &&
    enabledBeforeCatalog.length > 0 &&
    enabledBeforeCatalog.every((a) => a.egress?.status === 'unsupported')

  if (latestBeforeCatalog.models.length > 0) {
    checks.push({
      id: 'catalog',
      level: 'PASS',
      title: 'ACP 模型目录',
      detail: `已就绪（共 ${latestBeforeCatalog.models.length} 个可选模型，套餐=${sanitizeDiagnosticText(latestBeforeCatalog.tierName ?? '已识别', 60)}）。`,
    })
  } else if (allBlockedByGeo || !bin) {
    checks.push({
      id: 'catalog',
      level: 'WARN',
      title: 'ACP 模型目录',
      detail: allBlockedByGeo
        ? '因当前网络出口受限，已安全跳过上游模型目录握手（零流量触达 Google）。'
        : '因缺少 agy 二进制，跳过模型目录握手。',
    })
  } else {
    try {
      const models = await deps.pool.refreshModels()
      const visible = models.filter((m) => !m.variantOf)
      checks.push({
        id: 'catalog',
        level: visible.length > 0 ? 'PASS' : 'WARN',
        title: 'ACP 模型目录',
        detail: visible.length > 0 ? `只读握手成功（共发现 ${visible.length} 个模型）。` : '握手返回了空模型列表。',
      })
    } catch (err) {
      const msg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err), 200)
      checks.push({
        id: 'catalog',
        level: 'FAIL',
        title: 'ACP 模型目录',
        detail: msg || '只读模型目录探测失败，请检查 agy 登录状态。',
      })
    }
  }

  // 5. Local persistence & session continuity index
  const finalSnap = deps.pool.getStatus()
  checks.push({
    id: 'persistence',
    level: 'PASS',
    title: '本机持久化与会话索引',
    detail: sanitizeDiagnosticText(
      `配置覆盖=${finalSnap.hasPersistedConfig ? '已启用' : '默认'} · 可恢复会话索引=${finalSnap.persistedSessions ?? 0} 条`,
      200,
    ),
  })

  const passCount = checks.filter((c) => c.level === 'PASS').length
  const warnCount = checks.filter((c) => c.level === 'WARN').length
  const failCount = checks.filter((c) => c.level === 'FAIL').length

  const lines = [
    `Antigravity ACP 环境自检报告 (PASS=${passCount}, WARN=${warnCount}, FAIL=${failCount})`,
    ...checks.map((c) => `[${c.level}] ${c.title}：${c.detail}`),
  ]

  const report: EnvironmentCheckReport = {
    ok: failCount === 0,
    checkedAt: Date.now(),
    cliVersion: cliVersion ?? finalSnap.agentVersion ?? null,
    supportsFileCredentials,
    items: checks.map((c) => ({
      id: c.id,
      level: c.level === 'PASS' ? 'pass' : c.level === 'WARN' ? 'warn' : 'fail',
      title: c.title,
      detail: c.detail,
    })),
  }

  return {
    ok: failCount === 0,
    text: lines.join('\n'),
    report,
  }
}
