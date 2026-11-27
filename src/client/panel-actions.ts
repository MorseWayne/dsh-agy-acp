import { emptyUsageCounter } from '../common/account-usage.ts'
import type {
  AccountLoginSessionSnapshot,
  AccountUsageSnapshot,
  UsageCounter,
  AgyInstallTaskSnapshot,
  EnvironmentCheckReport,
  ManagedAccountRecord,
  ModelAccountRoutingConfig,
  StatusSnapshot,
} from '../common/types.ts'
import { isValidSnapshot } from './status-store.ts'

interface PostJsonResult<TExtra = Record<string, unknown>> {
  ok: boolean
  status?: StatusSnapshot
  error?: string
  data?: TExtra
}

export async function postJson<TExtra = Record<string, unknown>>(
  url: string,
  body: Record<string, unknown>,
  request = fetch,
): Promise<PostJsonResult<TExtra>> {
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data: (TExtra & { status?: StatusSnapshot; error?: string }) | undefined
    try {
      data = (await res.json()) as TExtra & { status?: StatusSnapshot; error?: string }
    } catch {
      // ignore non-JSON body
    }
    return {
      ok: res.ok,
      ...(isValidSnapshot(data?.status) ? { status: data.status } : {}),
      ...(typeof data?.error === 'string' && data.error.trim() ? { error: data.error.trim() } : {}),
      ...(data ? { data } : {}),
    }
  } catch {
    return { ok: false, error: '未能连接到插件，请重试' }
  }
}

const usageKeys = Object.keys(emptyUsageCounter()) as (keyof UsageCounter)[]
function validCounter(c: UsageCounter): boolean {
  return Boolean(c && usageKeys.every(key => Number.isSafeInteger(c[key]) && c[key] >= 0))
}

// The generic status validator intentionally accepts snapshots from older backends.
// A reset acknowledgement, however, must include usage that the panel can actually render.
function validResetUsage(usage?: AccountUsageSnapshot): boolean {
  return Boolean(usage && Number.isFinite(usage.updatedAt) && Number.isFinite(usage.retentionDays) &&
    [usage.today, usage.last7Days, usage.allTime].every(w => w && validCounter(w.totals) && Array.isArray(w.accounts) &&
      w.accounts.every(e => e && typeof e.accountId === 'string' && (e.accountLabel === undefined || typeof e.accountLabel === 'string') &&
        (e.lastUsedAt === null || Number.isFinite(e.lastUsedAt)) && validCounter(e.totals) && e.families &&
        typeof e.families === 'object' && !Array.isArray(e.families) && Object.values(e.families).every(validCounter))))
}

export async function resetAccountUsage(request = fetch): Promise<{ ok: boolean; status?: StatusSnapshot; error?: string }> {
  const res = await postJson<{ ok?: boolean }>('/plugins/agy-acp/usage/reset', {}, request)
  if (!res.ok) return { ok: false, error: res.error || '插件拒绝了清空请求，请稍后重试。' }
  if (res.data?.ok !== true || !res.status || !validResetUsage(res.status.accountUsage)) {
    return { ok: false, error: res.error || '未收到有效的用量快照，请刷新后重试。' }
  }
  return { ok: true, status: res.status }
}

export async function saveModelAccountRouting(
  routing: ModelAccountRoutingConfig,
  request = fetch,
): Promise<{ ok: boolean; status?: StatusSnapshot; error?: string }> {
  const { ok, status, error } = await postJson('/plugins/agy-acp/config', { modelAccountRouting: routing }, request)
  return { ok, status, error }
}

export interface ReviewModelOption {
  id: string
  name: string
}

export interface FetchReviewModelsResult {
  ok: boolean
  models: ReviewModelOption[]
  error?: string
}

export async function fetchReviewModels(provider: string, request = fetch): Promise<FetchReviewModelsResult> {
  try {
    const res = await request(`/plugins/agy-acp/review-models?provider=${encodeURIComponent(provider)}`)
    let data: { models?: unknown; error?: string } = {}
    try {
      data = (await res.json()) as { models?: unknown; error?: string }
    } catch {
      // ignore non-JSON body
    }
    if (!res.ok) {
      return {
        ok: false,
        models: [],
        error: typeof data.error === 'string' && data.error.trim() ? data.error.trim() : '获取模型列表失败，可手动输入模型 ID',
      }
    }
    const models = Array.isArray(data.models)
      ? data.models.filter(
          (m): m is ReviewModelOption =>
            Boolean(m) &&
            typeof m === 'object' &&
            typeof (m as { id?: unknown }).id === 'string' &&
            (m as { id: string }).id.trim().length > 0 &&
            typeof (m as { name?: unknown }).name === 'string',
        )
      : []
    return { ok: true, models }
  } catch {
    return { ok: false, models: [], error: '获取模型列表失败，可手动输入模型 ID' }
  }
}

export type SessionResetTarget = { kind: 'one'; sessionKey: string } | { kind: 'all' }

/** The legacy empty-body wire command is reserved for the explicit all-sessions confirmation. */
export async function resetSessions(target: SessionResetTarget, request = fetch): Promise<{ message: string; status?: StatusSnapshot }> {
  let body: Record<string, unknown>
  let success: string
  if (target?.kind === 'all') {
    body = {}
    success = '已重置全部会话及恢复索引。'
  } else if (target?.kind === 'one' && typeof target.sessionKey === 'string' && target.sessionKey.trim()) {
    body = { sessionKey: target.sessionKey }
    success = `已关闭会话 ${target.sessionKey}`
  } else {
    return { message: '未能识别此会话，未执行关闭。' }
  }
  const res = await postJson('/plugins/agy-acp/sessions/reset', body, request)
  if (!res.ok || !res.status) return { message: '会话操作未完成，请检查插件连接后重试。' }
  return { status: res.status, message: success }
}

export async function runEnvironmentCheck(
  request = fetch,
): Promise<{ ok: boolean; report?: EnvironmentCheckReport; status?: StatusSnapshot; error?: string }> {
  const res = await postJson<{ report?: EnvironmentCheckReport }>('/plugins/agy-acp/env/check', {}, request)
  return {
    ok: res.ok,
    report: res.data?.report,
    status: res.status,
    error: res.error,
  }
}

export async function startAgyInstall(
  input: { action?: 'install' | 'update'; proxyUrl?: string },
  request = fetch,
): Promise<{ ok: boolean; task?: AgyInstallTaskSnapshot; status?: StatusSnapshot; error?: string }> {
  const res = await postJson<{ task?: AgyInstallTaskSnapshot }>(
    '/plugins/agy-acp/env/install',
    {
      action: input.action ?? 'install',
      ...(input.proxyUrl?.trim() ? { proxyUrl: input.proxyUrl.trim() } : {}),
    },
    request,
  )
  return {
    ok: res.ok,
    task: res.data?.task,
    status: res.status,
    error: res.error,
  }
}

export async function addManagedAccount(
  input: { id?: string; label: string; proxyUrl?: string; enabled?: boolean },
  request = fetch,
): Promise<{ ok: boolean; account?: ManagedAccountRecord; status?: StatusSnapshot; error?: string }> {
  const res = await postJson<{ account?: ManagedAccountRecord }>(
    '/plugins/agy-acp/accounts/add',
    {
      label: input.label,
      ...(input.id?.trim() ? { id: input.id.trim() } : {}),
      ...(input.proxyUrl?.trim() ? { proxyUrl: input.proxyUrl.trim() } : {}),
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    },
    request,
  )
  return {
    ok: res.ok,
    account: res.data?.account,
    status: res.status,
    error: res.error,
  }
}

export async function updateManagedAccount(
  input: { accountId: string; label?: string; proxyUrl?: string; enabled?: boolean },
  request = fetch,
): Promise<{ ok: boolean; status?: StatusSnapshot; error?: string }> {
  const payload: Record<string, unknown> = { accountId: input.accountId }
  if (input.label !== undefined) payload.label = input.label
  if (input.enabled !== undefined) payload.enabled = input.enabled
  if (input.proxyUrl !== undefined) payload.proxyUrl = input.proxyUrl
  const res = await postJson('/plugins/agy-acp/accounts/update', payload, request)
  return { ok: res.ok, status: res.status, error: res.error }
}

export async function removeManagedAccount(
  accountId: string,
  purgeData = false,
  request = fetch,
): Promise<{ ok: boolean; status?: StatusSnapshot; error?: string }> {
  const res = await postJson('/plugins/agy-acp/accounts/remove', { accountId, purgeData }, request)
  return { ok: res.ok, status: res.status, error: res.error }
}

export async function selectActiveAccount(
  accountId: string | null,
  request = fetch,
): Promise<{ ok: boolean; status?: StatusSnapshot; error?: string }> {
  const res = await postJson('/plugins/agy-acp/accounts/select', { accountId }, request)
  return { ok: res.ok, status: res.status, error: res.error }
}

export async function startAccountLogin(
  input?: { accountId?: string; proxyUrl?: string },
  request = fetch,
): Promise<{ ok: boolean; login?: AccountLoginSessionSnapshot; status?: StatusSnapshot; error?: string }> {
  const payload: Record<string, unknown> = {}
  if (input?.accountId?.trim()) payload.accountId = input.accountId.trim()
  if (input?.proxyUrl?.trim()) payload.proxyUrl = input.proxyUrl.trim()
  const res = await postJson<{ login?: AccountLoginSessionSnapshot }>(
    '/plugins/agy-acp/accounts/login/start',
    payload,
    request,
  )
  return { ok: res.ok, login: res.data?.login, status: res.status, error: res.error }
}

export async function submitAccountLoginCode(
  loginId: string,
  code: string,
  request = fetch,
): Promise<{ ok: boolean; login?: AccountLoginSessionSnapshot; status?: StatusSnapshot; error?: string }> {
  const res = await postJson<{ login?: AccountLoginSessionSnapshot }>(
    '/plugins/agy-acp/accounts/login/submit',
    { loginId, code },
    request,
  )
  return { ok: res.ok, login: res.data?.login, status: res.status, error: res.error }
}

export async function cancelAccountLogin(
  loginId?: string,
  request = fetch,
): Promise<{ ok: boolean; status?: StatusSnapshot; error?: string }> {
  const res = await postJson('/plugins/agy-acp/accounts/login/cancel', loginId ? { loginId } : {}, request)
  return { ok: res.ok, status: res.status, error: res.error }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fallback below
  }
  try {
    if (typeof document !== 'undefined' && document.body) {
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    }
  } catch {
    // ignore
  }
  return false
}
