export const PROVIDER_ID = 'antigravity-acp'
export const MIRROR_TOOL_NAME = 'agy_acp_tool'
export const WRAPPER_TOOL_NAME = 'run_code'

export type PermissionMode = 'skip' | 'default' | 'accept-edits' | 'plan'

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
  models: AcpModelOption[]
  permissionMode: PermissionMode
  lastError: string | null
  updatedAt: number
}

/**
 * Extension seam for Phase 3 multi-account pooling.
 * Phase 1/2 uses SingleAccountProvider (current machine login).
 */
export interface AccountLease {
  accountId: string
  env?: NodeJS.ProcessEnv
  release: () => void
}

export interface AccountProvider {
  acquire(sessionKey: string, model: string): Promise<AccountLease>
}
