import { isGeoFenceMode } from './geo.ts'
import type { AccountProfileConfig, PersistedConfigPatch, PluginConfig } from './types.ts'

export const SESSION_IDLE_TTL_MIN_MS = 60_000
export const SESSION_IDLE_TTL_MAX_MS = 86_400_000
export const REQUEST_TIMEOUT_MIN_MS = 10_000
export const REQUEST_TIMEOUT_MAX_MS = 3_600_000
export const MAX_CONFIG_STRING_LEN = 2048

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const EFFORT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/

const HOST_ONLY_CONFIG_KEYS = new Set(['accounts', 'credentialSlotDir', 'enabled'])
const ALLOWED_PERSIST_KEYS = new Set<keyof PersistedConfigPatch>([
  'mcpBridge',
  'mcpExposeOverlappingTools',
  'quotaAwareScheduling',
  'defaultModel',
  'defaultEffort',
  'agyBin',
  'workspaceRoot',
  'sessionIdleTtlMs',
  'requestTimeoutMs',
  'geoFenceMode',
])

function parseBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'no') return false
  }
  return fallback
}

function parseNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < min) return fallback
  return Math.min(rounded, max)
}

function parseAccounts(raw: unknown): AccountProfileConfig[] {
  if (!Array.isArray(raw)) return []
  const result: AccountProfileConfig[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id.trim() : ''
    if (!id) continue
    const env: Record<string, string> = {}
    if (rec.env && typeof rec.env === 'object' && !Array.isArray(rec.env)) {
      for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v
      }
    }
    result.push({
      id,
      ...(typeof rec.label === 'string' && rec.label.trim() ? { label: rec.label.trim() } : {}),
      enabled: parseBool(rec.enabled, true),
      ...(typeof rec.homeDir === 'string' && rec.homeDir.trim() ? { homeDir: rec.homeDir.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    })
  }
  return result
}

function validateSafeString(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: `${label}必须为字符串` }
  if (CONTROL_CHAR_RE.test(value)) return { ok: false, error: `${label}不能包含控制字符或换行` }
  const trimmed = value.trim()
  if (trimmed.length > MAX_CONFIG_STRING_LEN) return { ok: false, error: `${label}长度不能超过 ${MAX_CONFIG_STRING_LEN} 字符` }
  return { ok: true, value: trimmed }
}

/** Strict validation for HTTP `POST /plugins/agy-acp/config` payloads. */
export function validateConfigPatchInput(
  body: Record<string, unknown>,
): { ok: true; patch: PersistedConfigPatch } | { ok: false; error: string } {
  if (Object.hasOwn(body, 'permissionMode')) {
    return { ok: false, error: 'Permission policy belongs to the DSH session' }
  }

  const patch: PersistedConfigPatch = {}
  let count = 0

  for (const key of Object.keys(body)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return { ok: false, error: `不允许修改非法键: ${key}` }
    }
    if (HOST_ONLY_CONFIG_KEYS.has(key)) {
      return { ok: false, error: `配置项 ${key} 仅支持通过宿主配置文件管理` }
    }
    if (!ALLOWED_PERSIST_KEYS.has(key as keyof PersistedConfigPatch)) {
      return { ok: false, error: `不支持的配置项: ${key}` }
    }

    const val = body[key]
    if (key === 'mcpBridge' || key === 'mcpExposeOverlappingTools' || key === 'quotaAwareScheduling') {
      if (typeof val !== 'boolean') return { ok: false, error: `${key} 必须为布尔值` }
      patch[key] = val
      count++
    } else if (key === 'agyBin' || key === 'workspaceRoot' || key === 'defaultModel') {
      const checked = validateSafeString(val, key)
      if (!checked.ok) return checked
      patch[key] = checked.value
      count++
    } else if (key === 'defaultEffort') {
      const checked = validateSafeString(val, 'defaultEffort')
      if (!checked.ok) return checked
      if (checked.value !== '' && !EFFORT_ID_RE.test(checked.value)) {
        return { ok: false, error: 'defaultEffort 格式无效，仅允许字母、数字、点、下划线或短横线' }
      }
      patch.defaultEffort = checked.value
      count++
    } else if (key === 'sessionIdleTtlMs') {
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < SESSION_IDLE_TTL_MIN_MS || val > SESSION_IDLE_TTL_MAX_MS) {
        return {
          ok: false,
          error: `sessionIdleTtlMs 必须为 ${SESSION_IDLE_TTL_MIN_MS / 60_000} 分钟至 ${SESSION_IDLE_TTL_MAX_MS / 60_000} 分钟之间的整数毫秒值`,
        }
      }
      patch.sessionIdleTtlMs = val
      count++
    } else if (key === 'requestTimeoutMs') {
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < REQUEST_TIMEOUT_MIN_MS || val > REQUEST_TIMEOUT_MAX_MS) {
        return {
          ok: false,
          error: `requestTimeoutMs 必须为 ${REQUEST_TIMEOUT_MIN_MS / 1_000} 秒至 ${REQUEST_TIMEOUT_MAX_MS / 1_000} 秒之间的整数毫秒值`,
        }
      }
      patch.requestTimeoutMs = val
      count++
    } else if (key === 'geoFenceMode') {
      if (!isGeoFenceMode(val)) {
        return { ok: false, error: 'geoFenceMode 必须为 block、strict、warn 或 off' }
      }
      patch.geoFenceMode = val
      count++
    }
  }

  if (count === 0) {
    return { ok: false, error: '未提供可更新的配置项' }
  }
  return { ok: true, patch }
}

/** Resilient field-by-field sanitization when loading persisted JSON from disk. */
export function sanitizePersistedConfigObject(raw: Record<string, unknown>): PersistedConfigPatch {
  const out: PersistedConfigPatch = {}
  for (const key of ALLOWED_PERSIST_KEYS) {
    if (!Object.hasOwn(raw, key)) continue
    const single = validateConfigPatchInput({ [key]: raw[key] })
    if (single.ok) {
      Object.assign(out, single.patch)
    }
  }
  return out
}

export function resolveConfig(raw: Record<string, unknown> = {}): PluginConfig {
  const rawGeoMode = typeof raw.geoFenceMode === 'string' ? raw.geoFenceMode.trim() : ''
  return {
    enabled: parseBool(raw.enabled, true),
    agyBin: typeof raw.agyBin === 'string' ? raw.agyBin.trim() : '',
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot.trim() : '',
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '',
    defaultEffort: typeof raw.defaultEffort === 'string' ? raw.defaultEffort.trim() : '',
    sessionIdleTtlMs: parseNumber(raw.sessionIdleTtlMs, 30 * 60_000, SESSION_IDLE_TTL_MIN_MS, SESSION_IDLE_TTL_MAX_MS),
    requestTimeoutMs: parseNumber(raw.requestTimeoutMs, 10 * 60_000, REQUEST_TIMEOUT_MIN_MS, REQUEST_TIMEOUT_MAX_MS),
    mcpBridge: parseBool(raw.mcpBridge, false),
    mcpExposeOverlappingTools: parseBool(raw.mcpExposeOverlappingTools, false),
    quotaAwareScheduling: parseBool(raw.quotaAwareScheduling, false),
    geoFenceMode: isGeoFenceMode(rawGeoMode) ? rawGeoMode : 'block',
    accounts: parseAccounts(raw.accounts),
    credentialSlotDir: typeof raw.credentialSlotDir === 'string' ? raw.credentialSlotDir.trim() : '',
  }
}
