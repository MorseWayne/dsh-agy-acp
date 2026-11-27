import { ACCOUNT_ID_RE } from './account-validation.ts'
import type { AccountRouteRule, ModelAccountRoutingConfig, ModelFamily } from './types.ts'

export type { AccountRouteFallback, AccountRouteRule, ModelAccountRoutingConfig, ModelFamily } from './types.ts'

export const AUTO_ACCOUNT_ID = 'auto'
export const MODEL_FAMILY_ORDER: readonly ModelFamily[] = ['gemini-pro', 'gemini-flash', 'claude', 'gpt', 'other']
export const MODEL_FAMILY_META: Readonly<Record<ModelFamily, { label: string; description: string }>> = {
  'gemini-pro': { label: 'Gemini 专业版', description: 'Gemini Pro、Neon、Carbon、Hydrogen 等非 Flash 模型' },
  'gemini-flash': { label: 'Gemini 快速版', description: '名称中包含 Flash 的 Gemini 模型' },
  claude: { label: 'Claude 系列', description: 'Claude、Opus、Sonnet 和 Haiku 模型' },
  gpt: { label: 'GPT 系列', description: '名称中含有独立 GPT 标识的模型' },
  other: { label: '其他模型', description: '未归入上述大类的模型' },
}

export function classifyModelFamily(model: string): ModelFamily {
  const m = model.trim().toLowerCase()
  if (!m) return 'other'
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
    return 'claude'
  }
  if (/(?:^|[^a-z])gpt(?:$|[^a-z])/.test(m)) return 'gpt'
  if (m.includes('flash')) {
    return 'gemini-flash'
  }
  if (m.includes('gemini') || m.includes('neon') || m.includes('carbon') || m.includes('hydrogen') || m.includes('pro')) {
    return 'gemini-pro'
  }
  return 'other'
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
export const MAX_MODEL_ROUTE_OVERRIDES = 64
export const MAX_MODEL_ROUTE_KEY_LENGTH = 128

function record(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' &&
    (Object.getPrototypeOf(raw) === Object.prototype || Object.getPrototypeOf(raw) === null) && !Array.isArray(raw)
}

type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

function normalizeRule(rule: AccountRouteRule): Required<AccountRouteRule> {
  const accountId = rule.accountId.trim().toLowerCase()
  return { accountId, fallback: accountId === AUTO_ACCOUNT_ID ? 'auto' : rule.fallback ?? 'auto' }
}

function validateRule(raw: unknown): Validation<AccountRouteRule> {
  if (!record(raw) || Object.keys(raw).some(k => k !== 'accountId' && k !== 'fallback')) {
    return { ok: false, error: '账号路由规则只支持 accountId 和 fallback' }
  }
  if (!Object.hasOwn(raw, 'accountId') || typeof raw.accountId !== 'string' || CONTROL.test(raw.accountId)) {
    return { ok: false, error: '账号路由必须指定合法账号 ID' }
  }
  const accountId = raw.accountId.trim().toLowerCase()
  if (!ACCOUNT_ID_RE.test(accountId)) return { ok: false, error: '账号路由的账号 ID 格式无效' }
  if (Object.hasOwn(raw, 'fallback') && raw.fallback !== 'auto' && raw.fallback !== 'strict') {
    return { ok: false, error: '账号路由 fallback 只能为 auto 或 strict' }
  }
  return { ok: true, value: accountId !== AUTO_ACCOUNT_ID && raw.fallback === 'strict'
    ? { accountId, fallback: 'strict' } : { accountId } }
}

/** Validate and canonicalize a complete replacement; {} is a persistable, explicit clear. */
export function validateModelAccountRoutingInput(raw: unknown): Validation<ModelAccountRoutingConfig> {
  if (raw === null) return { ok: true, value: {} }
  if (!record(raw) || Object.keys(raw).some(k => k !== 'families' && k !== 'models')) {
    return { ok: false, error: '模型账号路由仅支持 families 和 models 对象' }
  }
  const cfg: ModelAccountRoutingConfig = {}
  for (const group of ['families', 'models'] as const) {
    if (!Object.hasOwn(raw, group)) continue
    const entries = raw[group]
    if (!record(entries)) return { ok: false, error: `${group} 必须为对象` }
    if (group === 'models' && Object.keys(entries).length > MAX_MODEL_ROUTE_OVERRIDES) {
      return { ok: false, error: `最多可指定 ${MAX_MODEL_ROUTE_OVERRIDES} 条模型覆盖规则` }
    }
    const rules: Record<string, AccountRouteRule> = {}
    for (const [id, value] of Object.entries(entries)) {
      const key = id.trim().toLowerCase()
      if (CONTROL.test(id) || !key || key.length > MAX_MODEL_ROUTE_KEY_LENGTH || FORBIDDEN_KEYS.has(key)) {
        return { ok: false, error: '模型路由键无效或过长' }
      }
      if (group === 'families' && !MODEL_FAMILY_ORDER.includes(key as ModelFamily)) {
        return { ok: false, error: `未知模型大类: ${key}` }
      }
      if (Object.hasOwn(rules, key)) return { ok: false, error: `重复的模型路由键: ${key}` }
      const rule = validateRule(value)
      if (!rule.ok) return rule
      rules[key] = rule.value
    }
    // Stable key order lets consumers compare rules independent of form edit order.
    const keys = Object.keys(rules).sort()
    if (keys.length) cfg[group] = Object.fromEntries(keys.map(k => [k, rules[k]!]))
  }
  return { ok: true, value: cfg }
}

export function compactModelAccountRouting(cfg?: ModelAccountRoutingConfig | null): ModelAccountRoutingConfig | undefined {
  if (!cfg) return undefined
  const checked = validateModelAccountRoutingInput(cfg)
  return checked.ok && (checked.value.families || checked.value.models) ? checked.value : undefined
}

export function equalModelAccountRouting(a?: ModelAccountRoutingConfig | null, b?: ModelAccountRoutingConfig | null): boolean {
  return a === b || JSON.stringify(compactModelAccountRouting(a)) === JSON.stringify(compactModelAccountRouting(b))
}

export function resolveModelAccountRoute(routing: ModelAccountRoutingConfig | undefined, model: string): {
  source: 'model' | 'family'; key: string; rule: Required<AccountRouteRule>
} | null {
  if (!routing) return null
  const key = model.trim().toLowerCase()
  if (routing.models) {
    const models = routing.models
    const rule = Object.hasOwn(models, key) ? models[key] :
      Object.entries(models).find(([k]) => k.trim().toLowerCase() === key)?.[1]
    if (rule) return { source: 'model', key, rule: normalizeRule(rule) }
  }
  const family = classifyModelFamily(model)
  const rule = routing.families?.[family]
  return rule ? { source: 'family', key: family, rule: normalizeRule(rule) } : null
}
