export const PROVIDER_ID = 'antigravity-acp'
export const MIRROR_TOOL_NAME = 'agy_acp_tool'
export const WRAPPER_TOOL_NAME = 'run_code'

export type PermissionMode = 'skip' | 'default' | 'accept-edits' | 'plan'

export type ModelFamily = 'gemini-pro' | 'gemini-flash' | 'claude' | 'other'

export interface AccountProfileConfig {
  id: string
  label?: string
  enabled?: boolean
  /** Isolated HOME / USERPROFILE sandbox directory for this account. */
  homeDir?: string
  /** Per-account HTTP/SOCKS proxy URL injected into `agy acp`. */
  proxyUrl?: string
  /** Optional extra environment variables for this account. */
  env?: Record<string, string>
}

export interface QuotaBucketState {
  /** Remaining quota fraction in [0, 1]. */
  remainingFraction: number
  /** Unix ms timestamp when this bucket resets, if known. */
  resetAt?: number
}

export interface FamilyQuotaState {
  fiveHour?: QuotaBucketState
  sevenDay?: QuotaBucketState
  cooldownUntil?: number
  consecutiveFailures: number
}

export interface AccountHealthSnapshot {
  id: string
  label: string
  enabled: boolean
  hasSandboxHome: boolean
  hasProxy: boolean
  activeLeases: number
  families: Partial<Record<ModelFamily, FamilyQuotaState>>
  lastError: string | null
  lastUsedAt: number | null
}

export interface PluginConfig {
  enabled: boolean
  agyBin: string
  permissionMode: PermissionMode
  workspaceRoot: string
  defaultModel: string
  defaultEffort: string
  sessionIdleTtlMs: number
  requestTimeoutMs: number
  /** Attach session-scoped reverse MCP bridge via ACP session/new. */
  mcpBridge: boolean
  /** Optional multi-account pool profiles (Phase 3). */
  accounts: AccountProfileConfig[]
  /** Optional shared directory for cross-process credential slot leases. */
  credentialSlotDir: string
}

export interface AcpModelOption {
  value: string
  name: string
  efforts: string[]
}

export interface SessionSummary {
  dshSessionKey: string
  acpSessionId: string
  cwd: string
  currentModel: string
  currentEffort: string
  currentMode: string
  contextUsed: number
  contextSize: number
  lastActiveAt: number
}

export interface PendingPermissionOption {
  optionId: string
  name: string
  kind: string
}

export interface PendingPermission {
  requestId: string
  sessionId: string
  toolCallId: string
  toolName: string
  title?: string
  kind?: string
  rawInput?: unknown
  options: PendingPermissionOption[]
  createdAt: number
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  reasoningTokens: number
}

export interface StatusSnapshot {
  providerId: string
  enabled: boolean
  connected: boolean
  agentName: string | null
  agentVersion: string | null
  tierName: string | null
  activeSessions: number
  sessions: SessionSummary[]
  pendingPermissions: PendingPermission[]
  mcpBridgeActive: boolean
  usageTotals: UsageTotals
  accounts: AccountHealthSnapshot[]
  models: AcpModelOption[]
  permissionMode: PermissionMode
  lastError: string | null
  updatedAt: number
}

/**
 * Extension seam for Phase 3 multi-account pooling.
 * Phase 1/2 uses SingleAccountProvider (current machine login);
 * Phase 3 uses MultiAccountPool with sandbox HOME, proxies, quota buckets, and failover.
 */
export interface AccountLease {
  accountId: string
  env?: NodeJS.ProcessEnv
  release: () => void
}

export interface AccountProvider {
  acquire(sessionKey: string, model: string, excludeAccountIds?: ReadonlySet<string>): Promise<AccountLease>
  reportSuccess?(accountId: string, model: string): void
  reportFailure?(accountId: string, model: string, error: unknown): void
  getHealthSnapshots?(): AccountHealthSnapshot[]
  clearCooldown?(accountId?: string): void
  dispose?(): void
}
