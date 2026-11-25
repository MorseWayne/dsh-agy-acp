export const PROVIDER_ID = 'antigravity-acp'
export const MIRROR_TOOL_NAME = 'agy_acp_tool'
export const WRAPPER_TOOL_NAME = 'run_code'
export const LOW_QUOTA_THRESHOLD = 0.15

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

/** Upstream CLI groups need not match the local scheduler's model families. */
export interface AccountQuotaGroup {
  name: string
  fiveHour?: QuotaBucketState
  sevenDay?: QuotaBucketState
}

export interface AccountQuotaSample {
  sampledAt: number
  groups: AccountQuotaGroup[]
}

export type GeoFenceMode = 'block' | 'strict' | 'warn' | 'off'

export type EgressCheckStatus = 'supported' | 'unsupported' | 'unknown' | 'error'

export interface AccountEgressSnapshot {
  status: EgressCheckStatus
  /** ISO 3166-1 alpha-2 uppercase country/region code, e.g. "US", "JP", "HK"; null when unknown. */
  country: string | null
  /** Masked egress IP (e.g. "203.0.113.*" / "2001:db8::*") to avoid exposing full public IP. */
  ipMasked: string | null
  /** Actual outbound routing mode used for this probe. */
  proxyMode: 'proxy' | 'direct'
  /** Probe source identifier, e.g. "cloudflare-trace" | "ipsb" | "runtime-400". */
  probeSource: string | null
  checkedAt: number
  expiresAt: number
  /** Sanitized concise Chinese explanation (populated when restricted or degraded). */
  reason?: string
}

export interface AccountHealthSnapshot {
  egress?: AccountEgressSnapshot
  quota?: AccountQuotaSample
  quotaRefreshUnavailable?: string
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

export interface PersistedConfigPatch {
  mcpBridge?: boolean
  quotaAwareScheduling?: boolean
  defaultModel?: string
  defaultEffort?: string
  agyBin?: string
  workspaceRoot?: string
  sessionIdleTtlMs?: number
  requestTimeoutMs?: number
  geoFenceMode?: GeoFenceMode
}

export interface PluginConfig {
  enabled: boolean
  agyBin: string
  workspaceRoot: string
  defaultModel: string
  defaultEffort: string
  sessionIdleTtlMs: number
  requestTimeoutMs: number
  /** Attach session-scoped reverse MCP bridge via ACP session/new. */
  mcpBridge: boolean
  /** Opt-in: feed sampled account quotas into MultiAccountPool scheduler weights (default: false). */
  quotaAwareScheduling: boolean
  /** Local egress geo-fence protection policy (default: 'block'). */
  geoFenceMode: GeoFenceMode
  /** Optional multi-account pool profiles (Phase 3). */
  accounts: AccountProfileConfig[]
  /** Optional shared directory for cross-process credential slot leases. */
  credentialSlotDir: string
}

export interface AcpModelOption {
  value: string
  name: string
  efforts: string[]
  nativeEffort?: string
  /** Fixed-effort compatibility route; only its base belongs in a model picker. */
  variantOf?: string
}

export interface SessionSummary {
  accountId: string
  dshSessionKey: string
  acpSessionId: string
  cwd: string
  currentModel: string
  currentEffort: string
  currentMode: string
  title?: string
  resumed?: boolean
  contextUsed: number | null
  contextSize: number
  lastActiveAt: number
}

export interface McpBridgeSnapshot {
  enabled: boolean
  activeBridges: number
  inFlightCalls: number
  totalCalls: number
  failedCalls: number
  lastToolName: string | null
  lastCallAt: number | null
  lastError: string | null
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
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
  persistedSessions?: number
  sessions: SessionSummary[]
  mcpBridgeActive: boolean
  mcpBridge?: McpBridgeSnapshot
  usageTotals: UsageTotals
  accounts: AccountHealthSnapshot[]
  models: AcpModelOption[]
  config: {
    agyBin: string
    workspaceRoot: string
    defaultModel: string
    defaultEffort: string
    mcpBridge: boolean
    quotaAwareScheduling?: boolean
    sessionIdleTtlMs: number
    requestTimeoutMs: number
    geoFenceMode?: GeoFenceMode
  }
  hasPersistedConfig?: boolean
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
  updateQuota?(
    accountId: string,
    family: ModelFamily,
    buckets: { fiveHour?: QuotaBucketState; sevenDay?: QuotaBucketState },
  ): void
  clearQuotaSamples?(): void
  /** Acquire only this profile's environment, without invoking model selection or changing stickiness. */
  acquireQuotaLease?(accountId: string): Promise<AccountLease & { requiresFileCredentialMode?: boolean }>
  /** Read effective environment for egress probing without mutating lease counters or stickiness. */
  getAccountEnv?(accountId: string): NodeJS.ProcessEnv | undefined
  markGeoBlocked?(accountId: string, untilMs: number, reason?: string): void
  clearGeoBlock?(accountId?: string): void
  getHealthSnapshots?(): AccountHealthSnapshot[]
  clearCooldown?(accountId?: string): void
  dispose?(): void
}
