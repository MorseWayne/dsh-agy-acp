export const DEFAULT_ACCOUNT_ID = 'default'
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const MAX_ACCOUNT_LABEL_LEN = 64
export const MAX_PROXY_URL_LEN = 512
export const MAX_AUTH_CODE_LEN = 4096

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'])

export interface ValidatedManagedAccountCreate {
  id: string
  label: string
  enabled: boolean
  proxyUrl?: string
}

export interface ValidatedManagedAccountUpdate {
  accountId: string
  label?: string
  enabled?: boolean
  /** `undefined` = keep unchanged; `""` = clear proxy; non-empty URL = set proxy. */
  proxyUrl?: string
}

/**
 * Generates a safe, deterministic account slug from a human-friendly label.
 * Falls back to `acct-<suffix>` when the label has no ASCII letters/digits.
 */
export function slugifyAccountId(label: string, fallbackSuffix?: string): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32)
  if (ascii && ascii !== DEFAULT_ACCOUNT_ID && ACCOUNT_ID_RE.test(ascii)) {
    return ascii
  }
  const suffix = (fallbackSuffix ?? Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]/g, '').slice(0, 8) || '1'
  return `acct-${suffix}`
}

/**
 * Derives a clean account ID slug from a Google email address (preferring the local part before `@`).
 */
export function slugifyEmailToAccountId(email: string, fallbackSuffix?: string): string {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.indexOf('@')
  const localPart = at > 0 ? trimmed.slice(0, at) : trimmed
  return slugifyAccountId(localPart, fallbackSuffix)
}

export function validateAccountId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '账号 ID 必须为字符串' }
  const id = raw.trim().toLowerCase()
  if (!id) return { ok: false, error: '账号 ID 不能为空' }
  if (id === DEFAULT_ACCOUNT_ID) return { ok: false, error: '账号 ID 不能使用保留名称 default' }
  if (!ACCOUNT_ID_RE.test(id)) {
    return { ok: false, error: '账号 ID 仅支持 1–32 位小写字母、数字、短横线或下划线，且需以字母或数字开头' }
  }
  return { ok: true, value: id }
}

export function validateAccountLabel(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '账号名称必须为字符串' }
  if (CONTROL_CHAR_RE.test(raw)) return { ok: false, error: '账号名称不能包含控制字符或换行' }
  const label = raw.trim()
  if (!label) return { ok: false, error: '请填写账号名称' }
  if (label.length > MAX_ACCOUNT_LABEL_LEN) {
    return { ok: false, error: `账号名称长度不能超过 ${MAX_ACCOUNT_LABEL_LEN} 个字符` }
  }
  return { ok: true, value: label }
}

export function validateProxyUrl(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: '' }
  if (typeof raw !== 'string') return { ok: false, error: '代理地址必须为字符串' }
  if (CONTROL_CHAR_RE.test(raw)) return { ok: false, error: '代理地址不能包含控制字符或换行' }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: '' }
  if (trimmed.length > MAX_PROXY_URL_LEN) {
    return { ok: false, error: `代理地址长度不能超过 ${MAX_PROXY_URL_LEN} 个字符` }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: '代理地址格式无效，请使用如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080' }
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    return { ok: false, error: '代理协议仅支持 http://、https:// 或 socks5://，且必须包含主机地址' }
  }
  return { ok: true, value: trimmed }
}

/** Formats a proxy URL for UI display with embedded credentials redacted. */
export function maskProxyUrlForDisplay(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined
  try {
    const parsed = new URL(raw.trim())
    const port = parsed.port ? `:${parsed.port}` : ''
    const authTag = parsed.username || parsed.password ? '***@' : ''
    return `${parsed.protocol}//${authTag}${parsed.hostname}${port}`
  } catch {
    return undefined
  }
}

export function validateManagedAccountCreateInput(
  body: Record<string, unknown>,
  fallbackSuffix?: string,
): { ok: true; value: ValidatedManagedAccountCreate } | { ok: false; error: string } {
  const labelChecked = validateAccountLabel(body.label)
  if (!labelChecked.ok) return labelChecked

  let id: string
  if (body.id === undefined || body.id === null || (typeof body.id === 'string' && !body.id.trim())) {
    id = slugifyAccountId(labelChecked.value, fallbackSuffix)
  } else {
    const idChecked = validateAccountId(body.id)
    if (!idChecked.ok) return idChecked
    id = idChecked.value
  }

  let enabled = true
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { ok: false, error: '启用状态必须为布尔值' }
    enabled = body.enabled
  }

  const proxyChecked = validateProxyUrl(body.proxyUrl)
  if (!proxyChecked.ok) return proxyChecked

  return {
    ok: true,
    value: {
      id,
      label: labelChecked.value,
      enabled,
      ...(proxyChecked.value ? { proxyUrl: proxyChecked.value } : {}),
    },
  }
}

export function validateManagedAccountUpdateInput(
  body: Record<string, unknown>,
): { ok: true; value: ValidatedManagedAccountUpdate } | { ok: false; error: string } {
  if (typeof body.accountId !== 'string' || !body.accountId.trim()) {
    return { ok: false, error: '请指定要更新的账号 ID' }
  }
  const accountId = body.accountId.trim().toLowerCase()
  if (accountId !== DEFAULT_ACCOUNT_ID && !ACCOUNT_ID_RE.test(accountId)) {
    return { ok: false, error: '无效的账号 ID' }
  }

  const out: ValidatedManagedAccountUpdate = { accountId }
  let changed = 0

  if (Object.hasOwn(body, 'label') && body.label !== undefined) {
    const labelChecked = validateAccountLabel(body.label)
    if (!labelChecked.ok) return labelChecked
    out.label = labelChecked.value
    changed++
  }

  if (Object.hasOwn(body, 'enabled') && body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { ok: false, error: '启用状态必须为布尔值' }
    out.enabled = body.enabled
    changed++
  }

  if (Object.hasOwn(body, 'proxyUrl') && body.proxyUrl !== undefined) {
    const proxyChecked = validateProxyUrl(body.proxyUrl)
    if (!proxyChecked.ok) return proxyChecked
    out.proxyUrl = proxyChecked.value
    changed++
  }

  if (changed === 0) {
    return { ok: false, error: '未提供可更新的账号字段' }
  }

  return { ok: true, value: out }
}

export function validateLoginCodeInput(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '请粘贴 Google 授权码或回调网址' }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: '授权码不能为空，请粘贴浏览器中显示的内容' }
  if (CONTROL_CHAR_RE.test(trimmed)) return { ok: false, error: '授权码不能包含换行或控制字符' }
  if (trimmed.length > MAX_AUTH_CODE_LEN) {
    return { ok: false, error: '授权码内容过长，请确认粘贴了正确的授权码或回调网址' }
  }
  return { ok: true, value: trimmed }
}

export function getOfficialAgyInstallCommand(platform: string): string {
  if (platform === 'win32') {
    return 'irm https://antigravity.google/cli/install.ps1 | iex'
  }
  return 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
}
