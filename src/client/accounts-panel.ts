// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import { DEFAULT_ACCOUNT_ID } from '../common/account-validation.ts'
import type {
  AccountAuthStatus,
  AccountHealthSnapshot,
  AccountLoginSessionSnapshot,
  GeoFenceMode,
  StatusSnapshot,
} from '../common/types.ts'
import { AccountCard } from './account-card.ts'
import {
  AUTO_QUOTA_RETRY_COOLDOWN_MS,
  AUTO_QUOTA_TTL_MS,
  requestAccountAction,
  requestAllAccountsEgressCheck,
  shouldAutoFetchQuota,
} from './account-display.ts'
import {
  cancelAccountLogin,
  copyToClipboard,
  removeManagedAccount,
  selectActiveAccount,
  startAccountLogin,
  submitAccountLoginCode,
  updateManagedAccount,
} from './panel-actions.ts'
import { theme } from './theme.ts'

const h = React.createElement
const autoQuotaAttempted = new Map<string, { at: number; authStatus?: AccountAuthStatus }>()

export interface AccountsPanelProps {
  accounts: AccountHealthSnapshot[]
  preferredAccountId?: string | null
  geoFenceMode?: GeoFenceMode
  agyFound?: boolean
  activeLogin?: AccountLoginSessionSnapshot | null
  applyStatus: (next: StatusSnapshot) => void
}

function openOAuthPopupShell(): Window | null {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return null
  try {
    const popup = window.open('', '_blank')
    if (!popup) return null
    try {
      popup.document.title = '正在打开 Google 登录…'
      if (popup.document.body) {
        popup.document.body.style.fontFamily = 'system-ui, -apple-system, sans-serif'
        popup.document.body.style.padding = '32px'
        popup.document.body.style.color = '#334155'
        popup.document.body.textContent = '正在准备 Google OAuth 授权登录页面，请稍候…'
      }
    } catch {
      // ignore cross-origin or restricted popup document
    }
    return popup
  } catch {
    return null
  }
}

function navigateOAuthPopup(popup: Window | null, authUrl: string): boolean {
  if (!popup || popup.closed) return false
  try {
    popup.opener = null
    popup.location.replace(authUrl)
    return true
  } catch {
    return false
  }
}

function closeOAuthPopup(popup: Window | null): void {
  if (!popup || popup.closed) return
  try {
    popup.close()
  } catch {
    // ignore
  }
}

export const AccountsPanel = React.memo(function AccountsPanel({
  accounts,
  preferredAccountId,
  geoFenceMode,
  agyFound = true,
  activeLogin,
  applyStatus,
}: AccountsPanelProps): unknown {
  const [checkingAll, setCheckingAll] = React.useState(false)
  const [switchingId, setSwitchingId] = React.useState('')
  const [batchMsg, setBatchMsg] = React.useState('')
  const [autoRefreshingIds, setAutoRefreshingIds] = React.useState({} as Record<string, boolean>)
  const [autoQuotaErrors, setAutoQuotaErrors] = React.useState({} as Record<string, string>)
  const mountedRef = React.useRef(true)
  const inFlightAutoRef = React.useRef(new Set<string>())

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Lazily fetch quota for eligible enabled accounts when the Accounts panel is open.
  React.useEffect(() => {
    const now = Date.now()
    const targets = accounts.filter(account => {
      if (!shouldAutoFetchQuota(account, now, agyFound, AUTO_QUOTA_TTL_MS)) return false
      if (inFlightAutoRef.current.has(account.id)) return false
      const prev = autoQuotaAttempted.get(account.id)
      const justLoggedIn = prev && prev.authStatus !== 'logged_in' && account.authStatus === 'logged_in'
      if (prev && !justLoggedIn && now - prev.at < AUTO_QUOTA_RETRY_COOLDOWN_MS) return false
      return true
    })
    if (targets.length === 0) return

    for (const account of targets) {
      const id = account.id
      inFlightAutoRef.current.add(id)
      autoQuotaAttempted.set(id, { at: now, authStatus: account.authStatus })
      setAutoRefreshingIds((prev: Record<string, boolean>) => ({ ...prev, [id]: true }))
      setAutoQuotaErrors((prev: Record<string, string>) => {
        if (!prev[id]) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      void requestAccountAction('refresh', id, fetch, { maxAgeMs: AUTO_QUOTA_TTL_MS })
        .then(nextStatus => {
          if (!mountedRef.current) return
          applyStatus(nextStatus)
        })
        .catch(error => {
          if (!mountedRef.current) return
          const msg = error instanceof Error ? error.message : '自动获取配额失败，可点击「刷新配额」重试。'
          setAutoQuotaErrors((prev: Record<string, string>) => ({ ...prev, [id]: msg }))
        })
        .finally(() => {
          inFlightAutoRef.current.delete(id)
          if (!mountedRef.current) return
          setAutoRefreshingIds((prev: Record<string, boolean>) => {
            if (!prev[id]) return prev
            const next = { ...prev }
            delete next[id]
            return next
          })
        })
    }
  }, [accounts, agyFound, applyStatus])

  // Edit existing managed account form state (rename / proxy)
  const [editingAccount, setEditingAccount] = React.useState(null as AccountHealthSnapshot | null)
  const [labelInput, setLabelInput] = React.useState('')
  const [proxyInput, setProxyInput] = React.useState('')
  const [clearProxy, setClearProxy] = React.useState(false)
  const [savingEdit, setSavingEdit] = React.useState(false)
  const [editError, setEditError] = React.useState('')

  // Direct OAuth login wizard state (used for both "+ 添加账号" and existing account re-login)
  const [localLogin, setLocalLogin] = React.useState(null as AccountLoginSessionSnapshot | null)
  const [startingTarget, setStartingTarget] = React.useState('') // '__new__' | accountId | ''
  const [authCodeInput, setAuthCodeInput] = React.useState('')
  const [submittingCode, setSubmittingCode] = React.useState(false)
  const [loginFeedback, setLoginFeedback] = React.useState('')
  const [popupNotice, setPopupNotice] = React.useState('')
  const [copiedUrl, setCopiedUrl] = React.useState(false)
  const [showNewProxyBox, setShowNewProxyBox] = React.useState(false)
  const [newAccountProxy, setNewAccountProxy] = React.useState('')

  // Prefer server SSE activeLogin when present; never keep a succeeded wizard box pinned above cards.
  const rawWizardLogin = activeLogin ?? localLogin
  const wizardLogin = rawWizardLogin && rawWizardLogin.state === 'succeeded' ? null : rawWizardLogin
  const prevActiveLoginRef = React.useRef(activeLogin ?? null)
  const prevAccountsCountRef = React.useRef(accounts.length)
  const cancelledLoginIdRef = React.useRef('')
  const handledSubmitLoginIdRef = React.useRef('')

  React.useEffect(() => {
    const prev = prevActiveLoginRef.current
    const prevCount = prevAccountsCountRef.current
    prevActiveLoginRef.current = activeLogin ?? null
    prevAccountsCountRef.current = accounts.length

    if (activeLogin) {
      if (activeLogin.state === 'succeeded') {
        setLocalLogin(null)
        setAuthCodeInput('')
        setLoginFeedback('')
        setPopupNotice('')
        setShowNewProxyBox(false)
        setNewAccountProxy('')
        setBatchMsg(
          activeLogin.isNewAccount
            ? `已成功登录账号「${activeLogin.accountLabel}」并设为当前使用账号。`
            : `账号「${activeLogin.accountLabel}」已完成 Google 登录！`,
        )
      } else {
        setLocalLogin(activeLogin)
      }
      return
    }

    if (prev) {
      // Backend cleared activeLogin (e.g. on success or cancel): close non-error local wizard cleanly.
      setLocalLogin((cur: AccountLoginSessionSnapshot | null) =>
        cur && (cur.state === 'failed' || cur.state === 'cancelled') ? cur : null,
      )
      setAuthCodeInput('')
      setPopupNotice('')
      setShowNewProxyBox(false)
      setNewAccountProxy('')
      const wasCancelled = cancelledLoginIdRef.current === prev.loginId
      const alreadyHandled = handledSubmitLoginIdRef.current === prev.loginId
      if (prev.state === 'succeeded') {
        setLoginFeedback('')
        setBatchMsg(
          prev.isNewAccount
            ? `已成功登录账号「${prev.accountLabel}」并设为当前使用账号。`
            : `账号「${prev.accountLabel}」已完成 Google 登录！`,
        )
      } else if (!wasCancelled && !alreadyHandled && (prev.state === 'awaiting_code' || prev.state === 'exchanging')) {
        if (prev.isNewAccount) {
          if (accounts.length > prevCount) {
            setLoginFeedback('')
            setBatchMsg('已完成新 Google 账号登录并设为当前使用账号。')
          }
        } else if (accounts.find(a => a.id === prev.accountId)?.authStatus === 'logged_in') {
          setLoginFeedback('')
          setBatchMsg(`账号「${prev.accountLabel}」已完成 Google 登录！`)
        }
      }
    }
  }, [activeLogin, accounts])

  const enabledAccounts = accounts.filter(a => a.enabled)
  const enabledCount = enabledAccounts.length
  const hasMultipleAccounts = accounts.length > 1
  const activeAccount =
    accounts.find(a => a.isEffectiveActive) ??
    (preferredAccountId ? accounts.find(a => a.id === preferredAccountId && a.enabled) : undefined) ??
    (enabledAccounts.length === 1 ? enabledAccounts[0] : undefined)
  const collapsedDefault =
    accounts.length > 1 ? (accounts.find(a => a.id === DEFAULT_ACCOUNT_ID && !a.enabled) ?? null) : null
  const visibleAccounts = collapsedDefault ? accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID) : accounts

  const openEditForm = (account: AccountHealthSnapshot): void => {
    setEditingAccount(account)
    setLabelInput(account.label)
    setProxyInput('')
    setClearProxy(false)
    setEditError('')
  }

  const closeEditForm = (): void => {
    setEditingAccount(null)
    setEditError('')
  }

  const launchOAuthFlow = async (opts: { accountId?: string; proxyUrl?: string }): Promise<void> => {
    if (startingTarget || !agyFound) return
    const targetKey = opts.accountId || '__new__'
    setStartingTarget(targetKey)
    setLoginFeedback('')
    setPopupNotice('')
    setAuthCodeInput('')
    setBatchMsg('')

    // Open a blank tab synchronously inside the click gesture so browsers do not block the OAuth popup.
    const popup = openOAuthPopupShell()

    try {
      const res = await startAccountLogin(opts)
      if (res.status) applyStatus(res.status)
      if (res.login) setLocalLogin(res.login)
      if (res.ok && res.login?.authUrl) {
        const navigated = navigateOAuthPopup(popup, res.login.authUrl)
        if (navigated) {
          setPopupNotice('已在新标签页打开 Google 授权页面，完成授权后把授权码贴回下方即可。')
        } else {
          closeOAuthPopup(popup)
          setPopupNotice('浏览器拦截了自动弹出窗口，请点击下方「打开 Google 登录页 ↗」继续。')
        }
      } else {
        closeOAuthPopup(popup)
        const msg = res.error || '无法生成 Google 登录链接，请检查 agy 是否已正确安装。'
        if (res.login) {
          setLoginFeedback(msg)
        } else {
          setBatchMsg(msg)
        }
      }
    } catch {
      closeOAuthPopup(popup)
      setBatchMsg('启动 Google 登录失败，请稍后重试。')
    } finally {
      setStartingTarget('')
    }
  }

  const handleSaveEdit = async (): Promise<void> => {
    if (savingEdit || !editingAccount) return
    const label = labelInput.trim()
    if (!label) {
      setEditError('请填写账号名称')
      return
    }
    setSavingEdit(true)
    setEditError('')
    try {
      const payload: { accountId: string; label?: string; proxyUrl?: string } = {
        accountId: editingAccount.id,
        label,
      }
      if (clearProxy) {
        payload.proxyUrl = ''
      } else if (proxyInput.trim()) {
        payload.proxyUrl = proxyInput.trim()
      }
      const res = await updateManagedAccount(payload)
      if (res.status) applyStatus(res.status)
      if (!res.ok) {
        setEditError(res.error || '更新账号失败，请重试')
        return
      }
      closeEditForm()
      setBatchMsg(`已保存账号「${label}」的配置（立即生效）。`)
    } finally {
      setSavingEdit(false)
    }
  }

  const handleToggleEnabled = async (account: AccountHealthSnapshot): Promise<void> => {
    setBatchMsg('')
    const nextEnabled = !account.enabled
    const res = await updateManagedAccount({ accountId: account.id, enabled: nextEnabled })
    if (res.status) applyStatus(res.status)
    setBatchMsg(
      res.ok
        ? `账号「${account.label}」已${nextEnabled ? '启用' : '停用'}。`
        : res.error || '切换账号状态失败，请重试。',
    )
  }

  const handleRemoveAccount = async (account: AccountHealthSnapshot, purgeData: boolean): Promise<void> => {
    setBatchMsg('')
    const res = await removeManagedAccount(account.id, purgeData)
    if (res.status) applyStatus(res.status)
    setBatchMsg(
      res.ok
        ? `已删除账号「${account.label}」${purgeData ? '并清理本地登录目录' : ''}。`
        : res.error || '删除账号失败，请重试。',
    )
  }

  const handleSelectAccount = async (accountId: string | null): Promise<void> => {
    if (switchingId) return
    const targetKey = accountId ?? '__auto__'
    setSwitchingId(targetKey)
    setBatchMsg('')
    try {
      const targetAccount = accountId ? accounts.find(a => a.id === accountId) : undefined
      const res = await selectActiveAccount(accountId)
      if (res.status) applyStatus(res.status)
      if (res.ok) {
        if (accountId) {
          const updatedLabel =
            res.status?.accounts.find(a => a.id === accountId)?.label ?? targetAccount?.label ?? accountId
          setBatchMsg(`已切换为「${updatedLabel}」，下一轮对话将立即使用此账号。`)
        } else {
          setBatchMsg('已切换为多账号自动轮换模式。')
        }
      } else {
        setBatchMsg(res.error || '切换账号失败，请重试。')
      }
    } finally {
      setSwitchingId('')
    }
  }

  const handleSubmitCode = async (): Promise<void> => {
    if (!wizardLogin || submittingCode) return
    const code = authCodeInput.trim()
    if (!code) {
      setLoginFeedback('请先粘贴浏览器里显示的授权码（或跳转后的完整网址）。')
      return
    }
    setSubmittingCode(true)
    setLoginFeedback('')
    try {
      const res = await submitAccountLoginCode(wizardLogin.loginId, code)
      if (res.status) applyStatus(res.status)
      if (res.ok) {
        handledSubmitLoginIdRef.current = wizardLogin.loginId
        const finalLabel = res.login?.accountLabel || wizardLogin.accountLabel
        setLocalLogin(null)
        setAuthCodeInput('')
        setLoginFeedback('')
        setPopupNotice('')
        setShowNewProxyBox(false)
        setNewAccountProxy('')
        setBatchMsg(
          wizardLogin.isNewAccount
            ? `已成功登录账号「${finalLabel}」并设为当前使用账号。`
            : `账号「${finalLabel}」已完成 Google 登录！`,
        )
      } else {
        if (res.login) setLocalLogin(res.login)
        setLoginFeedback(res.error || '授权码验证失败，请重新打开登录页后再试。')
      }
    } finally {
      setSubmittingCode(false)
    }
  }

  const handleCancelLogin = async (): Promise<void> => {
    if (wizardLogin) {
      cancelledLoginIdRef.current = wizardLogin.loginId
      const res = await cancelAccountLogin(wizardLogin.loginId)
      if (res.status) applyStatus(res.status)
    }
    setLocalLogin(null)
    setAuthCodeInput('')
    setLoginFeedback('')
    setPopupNotice('')
    setShowNewProxyBox(false)
  }

  const handleCopyAuthUrl = async (url: string): Promise<void> => {
    const ok = await copyToClipboard(url)
    if (ok) {
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 2000)
    }
  }

  const handleCheckAllEgress = async (): Promise<void> => {
    if (checkingAll || enabledCount === 0) return
    setCheckingAll(true)
    setBatchMsg('')
    try {
      const nextStatus = await requestAllAccountsEgressCheck()
      applyStatus(nextStatus)
      const enabledAfter = nextStatus.accounts.filter(a => a.enabled)
      const supportedCount = enabledAfter.filter(a => a.egress?.status === 'supported').length
      const unsupportedCount = enabledAfter.filter(a => a.egress?.status === 'unsupported').length
      if (unsupportedCount > 0) {
        setBatchMsg(`已完成全部出口检测：${supportedCount} 个合规，${unsupportedCount} 个受限。`)
      } else {
        setBatchMsg(`已完成全部出口检测（${supportedCount}/${enabledAfter.length} 个合规）。`)
      }
    } catch (error) {
      setBatchMsg(error instanceof Error ? error.message : '全部出口检测失败，请稍后重试。')
    } finally {
      setCheckingAll(false)
    }
  }

  const renderLoginWizard = (): unknown => {
    if (!wizardLogin) return null
    const isWaiting = wizardLogin.state === 'awaiting_code'
    const isBusy = wizardLogin.state === 'starting' || wizardLogin.state === 'exchanging'
    const isDone = wizardLogin.state === 'succeeded'
    const isFailed = wizardLogin.state === 'failed' || wizardLogin.state === 'cancelled'
    const isNew = Boolean(wizardLogin.isNewAccount)

    return h(
      'div',
      {
        className: 'agy-acp-wizard',
        role: 'region',
        'aria-label': 'Google 账号登录向导',
      },
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h(
            'strong',
            { style: { fontSize: '13.5px' } },
            isNew && !isDone ? '添加新账号 · Google OAuth 登录' : `Google 登录 · ${wizardLogin.accountLabel}`,
          ),
          h(
            'span',
            {
              className: isDone
                ? 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--success'
                : isFailed
                  ? 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--error'
                  : 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--warn',
            },
            isDone
              ? '登录成功'
              : isFailed
                ? '登录未完成'
                : wizardLogin.state === 'exchanging'
                  ? '正在验证授权并识别账号…'
                  : wizardLogin.state === 'starting'
                    ? '正在打开 Google 登录页…'
                    : '等待粘贴授权码',
          ),
          wizardLogin.proxyDisplay
            ? h('span', { className: 'agy-acp-pill agy-acp-pill--sm' }, `代理 ${wizardLogin.proxyDisplay}`)
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => void handleCancelLogin(),
            className: 'agy-acp-btn agy-acp-btn--sm',
          },
          isDone || isFailed ? '关闭' : '取消登录',
        ),
      ),

      popupNotice
        ? h(
            'p',
            { className: 'agy-acp-caption', style: { margin: '6px 0 0', color: theme.textPrimary, fontWeight: 500 } },
            popupNotice,
          )
        : h('p', { className: 'agy-acp-caption', style: { margin: '6px 0 0', color: theme.textSecondary } }, wizardLogin.message),

      isWaiting && wizardLogin.authUrl
        ? h(
            'div',
            { style: { marginTop: '10px', display: 'grid', gap: '10px' } },
            // Primary focus: Paste authorization code right away (OAuth tab already opened automatically)
            h(
              'div',
              { className: 'agy-acp-wizard-step' },
              h(
                'div',
                { style: { fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' } },
                '在浏览器同意授权后，粘贴授权码（或跳转后的完整网址）：',
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('input', {
                  type: 'text',
                  value: authCodeInput,
                  autoFocus: true,
                  disabled: submittingCode,
                  onChange: (ev: { target: { value: string } }) => setAuthCodeInput(ev.target.value),
                  onKeyDown: (ev: { key: string }) => {
                    if (ev.key === 'Enter') void handleSubmitCode()
                  },
                  placeholder: '粘贴浏览器里给出的授权码，或跳转后的完整网址',
                  'aria-label': 'Google 授权码或回调网址',
                  className: 'agy-acp-input',
                  style: { flex: '1 1 260px', minWidth: '200px' },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: submittingCode || !authCodeInput.trim(),
                    onClick: () => void handleSubmitCode(),
                    className: 'agy-acp-btn agy-acp-btn--primary agy-acp-btn--sm',
                  },
                  submittingCode ? '正在验证…' : '提交完成登录',
                ),
              ),
              isNew
                ? h(
                    'p',
                    { className: 'agy-acp-caption', style: { margin: '5px 0 0' } },
                    '登录完成后会自动识别 Google 邮箱并命名账号，创建独立隔离目录，无需手动填写表单。',
                  )
                : null,
            ),

            // Secondary actions: Re-open OAuth page / Copy link for Incognito / Optional proxy
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h(
                'a',
                {
                  href: wizardLogin.authUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className: 'agy-acp-btn agy-acp-btn--sm',
                  style: { textDecoration: 'none' },
                },
                '打开 Google 登录页 ↗',
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => void handleCopyAuthUrl(wizardLogin.authUrl!),
                  className: 'agy-acp-btn agy-acp-btn--sm',
                },
                copiedUrl ? '已复制链接' : '复制登录链接（适合无痕窗口）',
              ),
              isNew
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setShowNewProxyBox((v: boolean) => !v),
                      className: 'agy-acp-btn agy-acp-btn--sm',
                    },
                    showNewProxyBox ? '收起代理设置' : '为此账号指定专属代理…',
                  )
                : null,
            ),

            isNew && showNewProxyBox
              ? h(
                  'div',
                  { className: 'agy-acp-wizard-step' },
                  h(
                    'div',
                    { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
                    '专属代理地址（可选，仅在该账号需走独立网络出口时填写）',
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                    h('input', {
                      type: 'text',
                      value: newAccountProxy,
                      disabled: Boolean(startingTarget),
                      onChange: (ev: { target: { value: string } }) => setNewAccountProxy(ev.target.value),
                      placeholder: '如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080',
                      className: 'agy-acp-input',
                      style: { flex: '1 1 220px', minWidth: '180px' },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        disabled: Boolean(startingTarget),
                        onClick: () => void launchOAuthFlow({ proxyUrl: newAccountProxy.trim() || undefined }),
                        className: 'agy-acp-btn agy-acp-btn--sm',
                      },
                      '使用此代理重新打开登录页',
                    ),
                  ),
                )
              : null,
          )
        : null,

      isFailed
        ? h(
            'div',
            { style: { marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                disabled: Boolean(startingTarget),
                onClick: () =>
                  void launchOAuthFlow(
                    isNew
                      ? { proxyUrl: newAccountProxy.trim() || undefined }
                      : { accountId: wizardLogin.accountId },
                  ),
                className: 'agy-acp-btn agy-acp-btn--primary agy-acp-btn--sm',
              },
              '重新打开 Google 登录页',
            ),
          )
        : null,

      isBusy
        ? h('div', { className: 'agy-acp-caption', style: { marginTop: '6px' } }, '请稍候，正在与官方 agy 进程通信…')
        : null,

      loginFeedback
        ? h(
            'div',
            {
              role: 'status',
              className: 'agy-acp-caption',
              style: { marginTop: '8px', color: isDone ? theme.stateSuccess : theme.stateWarn, fontWeight: 500 },
            },
            loginFeedback,
          )
        : null,
    )
  }

  const renderEditForm = (): unknown => {
    if (!editingAccount) return null
    return h(
      'div',
      { className: 'agy-acp-wizard', role: 'form', 'aria-label': '编辑账号' },
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
        h('strong', { style: { fontSize: '13.5px' } }, `编辑账号 · ${editingAccount.label}`),
        h(
          'button',
          { type: 'button', onClick: closeEditForm, className: 'agy-acp-btn agy-acp-btn--sm' },
          '关闭',
        ),
      ),
      h(
        'div',
        { className: 'agy-acp-form-grid' },
        h(
          'label',
          { style: { display: 'grid', gap: '4px' } },
          h('span', { className: 'agy-acp-caption', style: { fontWeight: 600, color: theme.textPrimary } }, '账号备注名称'),
          h('input', {
            type: 'text',
            value: labelInput,
            disabled: savingEdit,
            onChange: (ev: { target: { value: string } }) => setLabelInput(ev.target.value),
            placeholder: '例如：主力号 (US) / alice@gmail.com',
            className: 'agy-acp-input',
          }),
        ),
        h(
          'label',
          { style: { display: 'grid', gap: '4px' } },
          h('span', { className: 'agy-acp-caption', style: { fontWeight: 600, color: theme.textPrimary } }, '账号 ID'),
          h('input', {
            type: 'text',
            value: editingAccount.id,
            disabled: true,
            className: 'agy-acp-input',
          }),
        ),
        h(
          'label',
          { style: { display: 'grid', gap: '4px', gridColumn: '1 / -1' } },
          h(
            'span',
            { className: 'agy-acp-caption', style: { fontWeight: 600, color: theme.textPrimary } },
            editingAccount.proxyDisplay
              ? `专属代理地址（当前：${editingAccount.proxyDisplay}，留空保持不变）`
              : '专属代理地址（可选，留空走系统默认网络）',
          ),
          h('input', {
            type: 'text',
            value: proxyInput,
            disabled: savingEdit || clearProxy,
            onChange: (ev: { target: { value: string } }) => setProxyInput(ev.target.value),
            placeholder: '例如：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080',
            className: 'agy-acp-input',
          }),
          editingAccount.hasProxy
            ? h(
                'label',
                { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '4px', cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: clearProxy,
                  disabled: savingEdit,
                  onChange: (ev: { target: { checked: boolean } }) => setClearProxy(ev.target.checked),
                }),
                h('span', { className: 'agy-acp-caption' }, '清除当前专属代理（恢复默认网络）'),
              )
            : null,
        ),
      ),
      editError
        ? h('div', { role: 'alert', className: 'agy-acp-caption', style: { color: theme.stateError, marginTop: '6px' } }, editError)
        : null,
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
        h(
          'button',
          {
            type: 'button',
            disabled: savingEdit,
            onClick: () => void handleSaveEdit(),
            className: 'agy-acp-btn agy-acp-btn--primary agy-acp-btn--sm',
          },
          savingEdit ? '保存中…' : '保存修改',
        ),
        h(
          'button',
          { type: 'button', disabled: savingEdit, onClick: closeEditForm, className: 'agy-acp-btn agy-acp-btn--sm' },
          '取消',
        ),
      ),
    )
  }

  return h(
    'section',
    { className: 'agy-acp-card' },
    h(
      'div',
      { className: 'agy-acp-section-head' },
      h(
        'div',
        null,
        h('h3', { className: 'agy-acp-section-title' }, `账号状态 (${accounts.length})`),
        h(
          'p',
          { className: 'agy-acp-caption', style: { margin: '3px 0 0' } },
          '点击「+ 添加账号」直接打开 Google OAuth 登录，完成后自动识别邮箱并加入隔离账号池；打开此面板时自动获取配额（3 分钟缓存），也可随时手动刷新。',
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        h(
          'button',
          {
            type: 'button',
            disabled: Boolean(startingTarget) || !agyFound,
            title: !agyFound ? '请先在顶部一键安装 agy CLI' : '直接打开 Google 登录页添加独立账号',
            onClick: () => void launchOAuthFlow({}),
            className: 'agy-acp-btn agy-acp-btn--primary agy-acp-btn--sm',
          },
          startingTarget === '__new__' ? '正在打开 Google 登录…' : '+ 添加账号',
        ),
        enabledCount > 0
          ? h(
              'button',
              {
                type: 'button',
                disabled: checkingAll,
                className: 'agy-acp-btn agy-acp-btn--sm',
                onClick: () => void handleCheckAllEgress(),
              },
              checkingAll ? '正在检测全部出口…' : '检测全部出口',
            )
          : null,
      ),
    ),

    renderLoginWizard(),
    renderEditForm(),

    batchMsg
      ? h(
          'div',
          { role: 'status', className: 'agy-acp-notice', style: { padding: '8px 11px', marginBottom: '10px' } },
          h('span', { style: { flex: '1 1 200px' } }, batchMsg),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setBatchMsg(''),
              'aria-label': '关闭提示',
              className: 'agy-acp-btn agy-acp-btn--sm',
              style: { padding: '1px 7px', fontSize: '12px' },
            },
            '×',
          ),
        )
      : null,

    accounts.length > 0
      ? h(
          'div',
          { className: 'agy-acp-active-bar', role: 'status' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 8px', minWidth: 0 } },
            activeAccount
              ? [
                  h('span', { key: 'dot', className: 'agy-acp-dot', style: { backgroundColor: theme.stateSuccess } }),
                  h(
                    'span',
                    { key: 'label' },
                    '当前使用：',
                    h('strong', null, activeAccount.label),
                  ),
                  h(
                    'span',
                    { key: 'cap', className: 'agy-acp-caption' },
                    preferredAccountId && enabledCount > 1
                      ? '已指定优先 · 限流时自动切备用'
                      : enabledCount === 1
                        ? '唯一启用账号'
                        : '限流时自动切备用',
                  ),
                ]
              : enabledCount > 1
                ? [
                    h('span', { key: 'dot', className: 'agy-acp-dot', style: { backgroundColor: theme.accentBlue } }),
                    h(
                      'span',
                      { key: 'label' },
                      '当前模式：',
                      h('strong', null, `自动轮换（${enabledCount} 个可用账号）`),
                    ),
                    h(
                      'span',
                      { key: 'cap', className: 'agy-acp-caption' },
                      '点击下方任意账号的「使用此账号」可立即手动切换',
                    ),
                  ]
                : [
                    h('span', { key: 'dot', className: 'agy-acp-dot', style: { backgroundColor: theme.stateWarn } }),
                    h('span', { key: 'label', style: { fontWeight: 500 } }, '当前无启用账号'),
                  ],
          ),
          preferredAccountId && enabledCount > 1
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: Boolean(switchingId),
                  onClick: () => void handleSelectAccount(null),
                  className: 'agy-acp-btn agy-acp-btn--sm',
                },
                switchingId === '__auto__' ? '切换中…' : '切为自动轮换',
              )
            : null,
        )
      : null,

    accounts.length > 0
      ? visibleAccounts.map(account => {
          const canSwitch =
            account.enabled &&
            !account.isPreferred &&
            !(enabledCount === 1 && account.isEffectiveActive)
          return h(AccountCard, {
            key: account.id,
            account,
            geoFenceMode,
            agyFound,
            canToggleEnabled: account.editable || (account.id === DEFAULT_ACCOUNT_ID && hasMultipleAccounts),
            canSwitch,
            switching: switchingId === account.id,
            hasMultipleAccounts,
            startingLogin: startingTarget === account.id,
            autoRefreshing: Boolean(autoRefreshingIds[account.id]),
            autoQuotaError: autoQuotaErrors[account.id] || '',
            applyStatus,
            onSelect: () => void handleSelectAccount(account.id),
            onStartLogin: () => void launchOAuthFlow({ accountId: account.id }),
            onEdit: account.editable ? () => openEditForm(account) : undefined,
            onToggleEnabled: () => void handleToggleEnabled(account),
            onRemove: account.editable ? (purgeData: boolean) => void handleRemoveAccount(account, purgeData) : undefined,
          })
        })
      : h(
          'div',
          { className: 'agy-acp-muted', style: { padding: '12px 0' } },
          '尚未收到账号状态。请检查账号配置及插件是否启用，或点击右上角「+ 添加账号」直接登录。',
        ),

    collapsedDefault
      ? h(
          'div',
          { className: 'agy-acp-collapsed-default' },
          h(
            'span',
            { className: 'agy-acp-caption' },
            `已停用：本机默认账号 (${DEFAULT_ACCOUNT_ID}) · 复用终端 agy 登录态`,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'agy-acp-btn agy-acp-btn--sm',
              onClick: () => void handleToggleEnabled(collapsedDefault),
            },
            '启用',
          ),
        )
      : null,
  )
})
