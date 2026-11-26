export const PROVIDER_ID = 'antigravity-acp'
export const MIRROR_TOOL_NAME = 'agy_acp_tool'
export const WRAPPER_TOOL_NAME = 'run_code'
export const LOW_QUOTA_THRESHOLD = 0.15

export type ModelFamily = 'gemini-pro' | 'gemini-flash' | 'claude' | 'gpt' | 'other'

export interface AccountProfileConfig {
  id: string
  label?: string
  enabled?: boolean
  /** Isolated HOME / USERPROFILE sandbox directory for this account. */
  homeDir?: string
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
  source?: 'direct' | 'cli'
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
  /** Probe source identifier, e.g. "google-aistudio" | "google-cloudcode" | "runtime-400". */
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
  tosBlocked?: boolean
  tosBlockedAt?: number
  tosBlockedReason?: string
  id: string
  label: string
  enabled: boolean
  hasSandboxHome: boolean
  activeLeases: number
  families: Partial<Record<ModelFamily, FamilyQuotaState>>
  lastError: string | null
  lastUsedAt: number | null
}

export interface PersistedConfigPatch {
  mcpBridge?: boolean
  mcpExposeOverlappingTools?: boolean
  quotaAwareScheduling?: boolean
  defaultModel?: string
  defaultEffort?: string
  autoReviewProvider?: string
  autoReviewModel?: string
  autoReviewEffort?: string
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
  /** Optional LLM provider ID for DSH Auto review (empty or `antigravity-acp` uses ACP). */
  autoReviewProvider: string
  /** Optional model ID for DSH Auto review (empty follows the active conversation model). */
  autoReviewModel: string
  /** Optional reasoning effort for DSH Auto review (empty auto-selects lowest effort on ACP). */
  autoReviewEffort: string
  sessionIdleTtlMs: number
  requestTimeoutMs: number
  /** Attach session-scoped reverse MCP bridge via ACP session/new. */
  mcpBridge: boolean
  /** Expose DSH base tools that overlap with Antigravity native tools over reverse MCP (default: false). */
  mcpExposeOverlappingTools?: boolean
  /** Opt-in: feed sampled account quotas into MultiAccountPool scheduler weights (default: false). */
  quotaAwareScheduling: boolean
  /** Local egress geo-fence protection policy (default: 'block'). */
  geoFenceMode: GeoFenceMode
  /** Optional multi-account pool profiles (Phase 3). */
  accounts: AccountProfileConfig[]
  /** Optional shared directory for cross-process credential slot leases. */
  credentialSlotDir: string
}

export interface ReviewProviderOption {
  id: string
  name: string
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
  resumedVia?: 'resume' | 'load'
  mcpTransport?: 'http' | 'stdio' | 'none'
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
  transport?: 'http' | 'stdio' | 'mixed'
  lastToolName: string | null
  lastCallAt: number | null
  lastError: string | null
}

export interface AcpCapabilitiesSnapshot {
  resumeSession?: boolean
  loadSession?: boolean
  mcpHttp?: boolean
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
  systemPromptAppend?: boolean
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
  capabilities?: AcpCapabilitiesSnapshot
  activeSessions: number
  persistedSessions?: number
  sessions: SessionSummary[]
  mcpBridgeActive: boolean
  mcpBridge?: McpBridgeSnapshot
  usageTotals: UsageTotals
  accounts: AccountHealthSnapshot[]
  models: AcpModelOption[]
  reviewProviders?: ReviewProviderOption[]
  config: {
    agyBin: string
    workspaceRoot: string
    defaultModel: string
    defaultEffort: string
    autoReviewProvider?: string
    autoReviewModel?: string
    autoReviewEffort?: string
    mcpBridge: boolean
    mcpExposeOverlappingTools?: boolean
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

export interface AccountFailureOptions {
  /** Upstream-provided cooldown reset timestamp (Unix ms) if available. */
  resetAt?: number
  code?: string
}

export interface AccountProvider {
  acquire(sessionKey: string, model: string, excludeAccountIds?: ReadonlySet<string>): Promise<AccountLease>
  reportSuccess?(accountId: string, model: string): void
  reportFailure?(accountId: string, model: string, error: unknown, options?: AccountFailureOptions): void
  updateQuota?(
    accountId: string,
    family: ModelFamily,
    buckets: { fiveHour?: QuotaBucketState; sevenDay?: QuotaBucketState },
  ): void
  clearQuotaSamples?(accountId?: string): void
  /** Acquire only this profile's environment, without invoking model selection or changing stickiness. */
  acquireQuotaLease?(accountId: string): Promise<AccountLease & { requiresFileCredentialMode?: boolean; directQuotaHome?: string }>
  /** Read effective environment for egress probing without mutating lease counters or stickiness. */
  getAccountEnv?(accountId: string): NodeJS.ProcessEnv | undefined
  markGeoBlocked?(accountId: string, untilMs: number, reason?: string): void
  clearGeoBlock?(accountId?: string): void
  getHealthSnapshots?(): AccountHealthSnapshot[]
  clearCooldown?(accountId?: string): void
  dispose?(): void
}
