// Agent Client Protocol (ACP) JSON-RPC 2.0 types, verified against agy 1.5.16.

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

export interface InitializeParams {
  protocolVersion: number
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean }
    terminal?: boolean
  }
  clientInfo: { name: string; version: string }
}

export interface InitializeResult {
  protocolVersion: number
  agentInfo?: { name: string; title?: string; version: string }
  agentCapabilities?: {
    loadSession?: boolean
    load_session?: boolean
    promptCapabilities?: {
      image?: boolean
      audio?: boolean
      embeddedContext?: boolean
    }
    mcpCapabilities?: {
      http?: boolean
      sse?: boolean
      acp?: boolean
    }
    sessionCapabilities?: Record<string, unknown>
    session_capabilities?: Record<string, unknown>
    _meta?: {
      antigravity?: {
        tier?: boolean
        systemPrompt?: { append?: boolean }
      }
    }
  }
  authMethods?: Array<{ id: string; name: string; description?: string }>
}

export function supportsSessionLoad(init: InitializeResult | null | undefined): boolean {
  const caps = init?.agentCapabilities
  if (!caps) return false
  if (caps.loadSession === true || caps.load_session === true) return true
  if (caps.sessionCapabilities && typeof caps.sessionCapabilities === 'object' && 'load' in caps.sessionCapabilities) {
    return true
  }
  if (caps.session_capabilities && typeof caps.session_capabilities === 'object' && 'load' in caps.session_capabilities) {
    return true
  }
  return false
}

export function supportsSessionResume(init: InitializeResult | null | undefined): boolean {
  const caps = init?.agentCapabilities
  if (!caps) return false
  const values = [caps.sessionCapabilities?.resume, caps.session_capabilities?.resume]
  return !values.includes(false) && values.some(value =>
    value === true || (value !== null && typeof value === 'object' && !Array.isArray(value)))
}

export function supportsMcpHttp(init: InitializeResult | null | undefined): boolean {
  return init?.agentCapabilities?.mcpCapabilities?.http === true
}

export interface AcpConfigOptionValue {
  value: string
  name: string
  description?: string
}

export interface AcpConfigOption {
  id: string
  name: string
  category?: string
  type: string
  currentValue: string
  options?: Array<AcpConfigOptionValue | { groupId: string; name: string; options: AcpConfigOptionValue[] }>
}

export interface AcpStdioMcpServerSpec {
  type?: 'stdio'
  name: string
  command: string
  args: string[]
  env?: Array<{ name: string; value: string }>
}

export interface AcpHttpMcpServerSpec {
  type: 'http'
  name: string
  url: string
  headers?: Array<{ name: string; value: string }>
}

export type AcpMcpServerSpec = AcpStdioMcpServerSpec | AcpHttpMcpServerSpec

export interface SessionNewParams {
  cwd: string
  mcpServers: AcpMcpServerSpec[]
  _meta?: Record<string, unknown>
}

export interface SessionNewResult {
  sessionId: string
  models?: {
    availableModels: Array<{ modelId: string; name: string }>
    currentModelId: string
  }
  modes?: {
    currentModeId: string
    availableModes: Array<{ id: string; name: string; description?: string }>
  }
  configOptions?: AcpConfigOption[]
  _meta?: {
    antigravity?: {
      tier?: { name: string; id: string; upgradeUri?: string }
    }
  }
}

export interface SessionLoadParams {
  sessionId: string
  cwd: string
  mcpServers: AcpMcpServerSpec[]
  _meta?: Record<string, unknown>
}

export interface SessionLoadResult extends Omit<SessionNewResult, 'sessionId'> {
  sessionId?: string
}

export type SessionResumeParams = SessionLoadParams
export type SessionResumeResult = SessionLoadResult

export interface SessionSetConfigOptionParams {
  sessionId: string
  configId: string
  value: string
}

export interface SessionSetConfigOptionResult {
  configOptions?: AcpConfigOption[]
}

export type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; size?: number }
  | { type: 'resource'; resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string }) }

export interface SessionPromptParams {
  sessionId: string
  prompt: PromptContentBlock[]
}

export interface AcpUsage {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  totalTokens?: number
}

export interface SessionPromptResult {
  stopReason: string
  usage?: AcpUsage
}

export interface AcpToolCallContentEntry {
  type: string
  content?: { type: string; text?: string }
  path?: string
  oldText?: string | null
  newText?: string
}

export interface AcpToolCallUpdate {
  sessionUpdate: 'tool_call' | 'tool_call_update'
  toolCallId: string
  name?: string
  args?: Record<string, unknown>
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  kind?: string
  title?: string
  locations?: Array<{ path: string; line?: number }>
  rawInput?: unknown
  rawOutput?: unknown
  content?: AcpToolCallContentEntry[]
  _meta?: Record<string, unknown>
}

export type SessionUpdatePayload =
  | { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'agent_thought_chunk'; content: { type: 'text'; text: string } }
  | AcpToolCallUpdate
  | { sessionUpdate: 'usage_update'; used: number; size: number }
  | { sessionUpdate: 'session_info_update'; title?: string }
  | { sessionUpdate: 'config_option_update'; configOptions: AcpConfigOption[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands?: unknown[] }
  | { sessionUpdate: string; [key: string]: unknown }

export interface SessionUpdateNotification {
  sessionId: string
  update: SessionUpdatePayload
}

export interface PermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
  _meta?: Record<string, unknown>
}

export interface RequestPermissionParams {
  sessionId: string
  toolCall: AcpToolCallUpdate
  options: PermissionOption[]
}

export interface RequestPermissionResult {
  outcome:
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' }
}
