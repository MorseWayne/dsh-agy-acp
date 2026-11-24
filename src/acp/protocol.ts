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
  agentInfo?: { name: string; version: string }
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: {
      image?: boolean
      audio?: boolean
      embeddedContext?: boolean
    }
    sessionCapabilities?: Record<string, unknown>
    _meta?: {
      antigravity?: {
        tier?: boolean
        systemPrompt?: { append?: boolean }
      }
    }
  }
  authMethods?: Array<{ id: string; name: string; description?: string }>
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

export interface AcpMcpServerSpec {
  name: string
  command: string
  args: string[]
  env?: Array<{ name: string; value: string }>
}

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
  content?: Array<{ type: string; content?: { type: string; text?: string } }>
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
