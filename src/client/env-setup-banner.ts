// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import { getOfficialAgyInstallCommand } from '../common/account-validation.ts'
import type { EnvironmentSnapshot, StatusSnapshot } from '../common/types.ts'
import { copyToClipboard, runEnvironmentCheck, startAgyInstall } from './panel-actions.ts'
import { theme } from './theme.ts'
import { formatTime } from './ui-primitives.ts'

const h = React.createElement

export interface EnvSetupBannerProps {
  environment?: EnvironmentSnapshot
  agentVersion?: string | null
  applyStatus: (next: StatusSnapshot) => void
  onOpenConfig?: () => void
  onOpenAccounts?: () => void
}

function levelColor(level: 'pass' | 'warn' | 'fail'): string {
  if (level === 'pass') return theme.stateSuccess
  if (level === 'warn') return theme.stateWarn
  return theme.stateError
}

function levelLabel(level: 'pass' | 'warn' | 'fail'): string {
  if (level === 'pass') return '正常'
  if (level === 'warn') return '提示'
  return '需处理'
}

export const EnvSetupBanner = React.memo(function EnvSetupBanner({
  environment,
  agentVersion,
  applyStatus,
  onOpenConfig,
  onOpenAccounts,
}: EnvSetupBannerProps): unknown {
  const agyFound = environment?.agyFound ?? true
  const task = environment?.installTask
  const isInstalling = task?.state === 'running'
  const lastCheck = environment?.lastCheck
  const hasFailedCheck = Boolean(lastCheck && !lastCheck.ok)

  const [expanded, setExpanded] = React.useState(!agyFound)
  const [checking, setChecking] = React.useState(false)
  const [startingInstall, setStartingInstall] = React.useState(false)
  const [proxyInput, setProxyInput] = React.useState('')
  const [feedback, setFeedback] = React.useState('')
  const [copiedCmd, setCopiedCmd] = React.useState(false)

  // Auto-open whenever agy is missing or an installation/check failure demands attention.
  React.useEffect(() => {
    if (!agyFound || isInstalling || task?.state === 'failed') {
      setExpanded(true)
    }
  }, [agyFound, isInstalling, task?.state])

  if (!environment) return null

  const versionText = environment.agyVersion || agentVersion || ''
  const manualCmd = environment.manualInstallCommand || getOfficialAgyInstallCommand(environment.platform)

  const handleCheck = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setFeedback('')
    setExpanded(true)
    try {
      const res = await runEnvironmentCheck()
      if (res.status) applyStatus(res.status)
      if (!res.ok) {
        setFeedback(res.error || '环境检查失败，请重试。')
      } else if (res.report?.ok) {
        setFeedback('环境检查全部通过，可以正常使用。')
      } else {
        setFeedback('检查完成，请根据下方标记项进行修复。')
      }
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async (action: 'install' | 'update'): Promise<void> => {
    if (startingInstall || isInstalling) return
    setStartingInstall(true)
    setFeedback('')
    setExpanded(true)
    try {
      const res = await startAgyInstall({ action, proxyUrl: proxyInput.trim() || undefined })
      if (res.status) applyStatus(res.status)
      if (!res.ok) {
        setFeedback(res.error || (action === 'update' ? '无法启动升级任务' : '无法启动安装任务'))
      }
    } finally {
      setStartingInstall(false)
    }
  }

  const handleCopyManual = async (): Promise<void> => {
    const ok = await copyToClipboard(manualCmd)
    if (ok) {
      setCopiedCmd(true)
      setTimeout(() => setCopiedCmd(false), 2000)
    }
  }

  // Compact green status bar when agy is ready and user hasn't opened details
  if (!expanded && agyFound && !isInstalling && !hasFailedCheck) {
    return h(
      'div',
      { className: 'agy-acp-env-bar' },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 } },
        h('span', { className: 'agy-acp-dot', style: { backgroundColor: theme.stateSuccess } }),
        h(
          'span',
          { style: { fontSize: '12.5px', fontWeight: 500 } },
          `本地环境已就绪 · agy${versionText ? ` ${versionText}` : ''}`,
        ),
        lastCheck
          ? h('span', { className: 'agy-acp-caption' }, `上次检查：${formatTime(lastCheck.checkedAt)}`)
          : null,
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        h(
          'button',
          {
            type: 'button',
            disabled: checking,
            onClick: () => void handleCheck(),
            className: 'agy-acp-btn agy-acp-btn--sm',
          },
          checking ? '检查中…' : '一键环境检查',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => setExpanded(true),
            className: 'agy-acp-btn agy-acp-btn--sm',
          },
          '环境与升级',
        ),
      ),
    )
  }

  const cardClass = !agyFound || hasFailedCheck || task?.state === 'failed'
    ? 'agy-acp-card agy-acp-env-card agy-acp-env-card--alert'
    : 'agy-acp-card agy-acp-env-card'

  return h(
    'section',
    { className: cardClass, 'aria-label': '环境检查与一键准备' },
    h(
      'div',
      { className: 'agy-acp-section-head', style: { marginBottom: '10px' } },
      h(
        'div',
        null,
        h(
          'h3',
          { className: 'agy-acp-section-title', style: { display: 'flex', alignItems: 'center', gap: '7px' } },
          h('span', {
            className: 'agy-acp-dot',
            style: {
              backgroundColor: !agyFound || hasFailedCheck ? theme.stateWarn : theme.stateSuccess,
            },
          }),
          agyFound ? '环境检查与准备' : '首次使用：先一键安装 Antigravity CLI (agy)',
        ),
        h(
          'p',
          { className: 'agy-acp-caption', style: { margin: '3px 0 0' } },
          agyFound
            ? `已检测到 agy：${environment.agyBinPath}${versionText ? `（版本 ${versionText}）` : ''}。你可以随时做全套环境检查或升级到最新版。`
            : '本插件通过本机的 agy 程序连接 Google Antigravity（多账号也只需装一份）。点击下方按钮即可自动安装，无需手动敲命令。',
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        h(
          'button',
          {
            type: 'button',
            disabled: checking || isInstalling,
            onClick: () => void handleCheck(),
            className: 'agy-acp-btn agy-acp-btn--sm',
          },
          checking ? '正在检查…' : '一键环境检查',
        ),
        agyFound && !isInstalling
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => setExpanded(false),
                className: 'agy-acp-btn agy-acp-btn--sm',
              },
              '收起',
            )
          : null,
      ),
    ),

    // One-click install / update toolbar with optional proxy input
    h(
      'div',
      { className: 'agy-acp-env-actions' },
      h('input', {
        type: 'text',
        value: proxyInput,
        disabled: isInstalling || startingInstall,
        onChange: (ev: { target: { value: string } }) => setProxyInput(ev.target.value),
        placeholder: '可选：下载代理地址，如 http://127.0.0.1:7890（留空则直连）',
        'aria-label': '安装或升级时使用的可选代理地址',
        className: 'agy-acp-input',
        style: { flex: '1 1 240px', minWidth: '200px' },
      }),
      h(
        'button',
        {
          type: 'button',
          disabled: isInstalling || startingInstall,
          onClick: () => void handleInstall(agyFound ? 'update' : 'install'),
          className: agyFound ? 'agy-acp-btn agy-acp-btn--sm' : 'agy-acp-btn agy-acp-btn--primary agy-acp-btn--sm',
        },
        isInstalling
          ? task?.action === 'update'
            ? '正在升级 agy…'
            : '正在安装 agy…'
          : agyFound
            ? '一键升级 agy'
            : '一键安装 agy',
      ),
      !agyFound && onOpenConfig
        ? h(
            'button',
            {
              type: 'button',
              onClick: onOpenConfig,
              className: 'agy-acp-btn agy-acp-btn--sm',
            },
            '手动指定路径',
          )
        : null,
      agyFound && onOpenAccounts
        ? h(
            'button',
            {
              type: 'button',
              onClick: onOpenAccounts,
              className: 'agy-acp-btn agy-acp-btn--sm',
            },
            '前往账号登录',
          )
        : null,
    ),

    // Install / update live progress & logs
    task && (task.state !== 'idle' || task.logs.length > 0)
      ? h(
          'div',
          {
            role: 'status',
            className:
              task.state === 'failed'
                ? 'agy-acp-notice agy-acp-notice--error'
                : task.state === 'succeeded'
                  ? 'agy-acp-notice'
                  : 'agy-acp-notice agy-acp-notice--warn',
            style: { marginTop: '10px', marginBottom: 0, display: 'block' },
          },
          h(
            'div',
            { style: { fontWeight: 600, fontSize: '12.5px', marginBottom: task.logs.length ? '6px' : 0 } },
            task.message,
          ),
          task.logs.length > 0
            ? h(
                'pre',
                { className: 'agy-acp-env-log' },
                task.logs.join('\n'),
              )
            : null,
        )
      : null,

    // Manual command fallback when agy is missing or install failed
    !agyFound || task?.state === 'failed'
      ? h(
          'div',
          { className: 'agy-acp-env-fallback' },
          h('span', { className: 'agy-acp-caption' }, '也可在终端手动运行官方命令：'),
          h('code', { className: 'agy-acp-code-inline' }, manualCmd),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void handleCopyManual(),
              className: 'agy-acp-btn agy-acp-btn--sm',
            },
            copiedCmd ? '已复制' : '复制命令',
          ),
        )
      : null,

    // Structured check results
    lastCheck
      ? h(
          'div',
          { style: { marginTop: '10px' } },
          h(
            'div',
            { className: 'agy-acp-caption', style: { marginBottom: '6px' } },
            `最近一次环境自检（${formatTime(lastCheck.checkedAt)}）`,
          ),
          h(
            'div',
            { className: 'agy-acp-list' },
            ...lastCheck.items.map((item) =>
              h(
                'div',
                { key: item.id, className: 'agy-acp-list-row', style: { alignItems: 'flex-start' } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: '150px' } },
                  h('span', { className: 'agy-acp-dot', style: { backgroundColor: levelColor(item.level) } }),
                  h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, item.title),
                  h(
                    'span',
                    {
                      className: 'agy-acp-caption',
                      style: { color: levelColor(item.level), fontWeight: 600 },
                    },
                    levelLabel(item.level),
                  ),
                ),
                h(
                  'div',
                  { className: 'agy-acp-caption', style: { flex: '1 1 240px', color: theme.textSecondary } },
                  item.detail,
                ),
              ),
            ),
          ),
        )
      : null,

    feedback
      ? h('div', { role: 'status', className: 'agy-acp-caption', style: { marginTop: '8px' } }, feedback)
      : null,
  )
})
