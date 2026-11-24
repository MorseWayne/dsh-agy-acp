import type { PermissionMode, PluginConfig } from './types.ts'

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
  }
}
