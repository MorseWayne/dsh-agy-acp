import type { AccountProfileConfig, PermissionMode, PluginConfig } from './types.ts'

const VALID_MODES = new Set<PermissionMode>(['skip', 'default', 'accept-edits', 'plan'])

function parseBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'no') return false
  }
  return fallback
}

function parseNumber(v: unknown, fallback: number, min: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) && n >= min ? n : fallback
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
      ...(typeof rec.proxyUrl === 'string' && rec.proxyUrl.trim() ? { proxyUrl: rec.proxyUrl.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    })
  }
  return result
}

export function resolveConfig(raw: Record<string, unknown> = {}): PluginConfig {
  const modeRaw = typeof raw.permissionMode === 'string' ? raw.permissionMode.trim() : ''
  const permissionMode: PermissionMode = VALID_MODES.has(modeRaw as PermissionMode)
    ? (modeRaw as PermissionMode)
    : 'accept-edits'

  return {
    enabled: parseBool(raw.enabled, true),
    agyBin: typeof raw.agyBin === 'string' ? raw.agyBin.trim() : '',
    permissionMode,
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot.trim() : '',
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '',
    defaultEffort: typeof raw.defaultEffort === 'string' ? raw.defaultEffort.trim() : '',
    sessionIdleTtlMs: parseNumber(raw.sessionIdleTtlMs, 30 * 60_000, 60_000),
    requestTimeoutMs: parseNumber(raw.requestTimeoutMs, 10 * 60_000, 10_000),
    mcpBridge: parseBool(raw.mcpBridge, false),
    accounts: parseAccounts(raw.accounts),
    credentialSlotDir: typeof raw.credentialSlotDir === 'string' ? raw.credentialSlotDir.trim() : '',
  }
}
