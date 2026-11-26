export const DSH_DISCOVER_TOOLS_NAME = 'dsh_discover_tools'
export const DSH_CALL_TOOL_NAME = 'dsh_call_tool'

/**
 * Antigravity (`agy acp`) injects per-tool wrapper overhead onto every MCP tool declaration
 * (`mcp_<server>_<name>`, server attribution line, and the synthetic `toolSummary` parameter),
 * and silently evicts the largest eager MCP tools once total declaration size crosses ~64 KiB.
 */
export const AGY_PER_TOOL_OVERHEAD_BYTES = 280
export const DEFAULT_MAX_EAGER_SCHEMA_BYTES = 52_000
/** Estimated bytes occupied by the two built-in meta-gateway tools (`dsh_discover_tools` + `dsh_call_tool`). */
export const META_GATEWAY_ESTIMATED_BYTES = 1_850

export const MAX_TOOL_OVERRIDES = 200
export const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export type SupplementGroupId =
  | 'memory_core'
  | 'delivery_skills'
  | 'documents_office'
  | 'goals_teams_workflow'
  | 'memory_admin'
  | 'media_system'
  | 'other_plugins'

export type ReplaceGroupId =
  | 'subagents'
  | 'web_search'
  | 'file_ops'
  | 'shell_jobs'
  | 'planning_schedule'

export type ToolGroupId = SupplementGroupId | ReplaceGroupId

export type SupplementGroupMode = 'eager' | 'lazy' | 'off'
export type ReplaceGroupMode = 'native' | 'replace' | 'lazy'
export type ToolExposureMode = 'eager' | 'lazy' | 'off'

export interface McpToolPolicyConfig {
  groups?: Partial<Record<SupplementGroupId, SupplementGroupMode>>
  replace?: Partial<Record<ReplaceGroupId, ReplaceGroupMode>>
  overrides?: Record<string, ToolExposureMode>
}

export interface SupplementGroupMeta {
  readonly id: SupplementGroupId
  readonly kind: 'supplement'
  readonly label: string
  readonly description: string
  readonly defaultMode: SupplementGroupMode
  readonly tools: readonly string[]
}

export interface ReplaceGroupMeta {
  readonly id: ReplaceGroupId
  readonly kind: 'replace'
  readonly label: string
  readonly description: string
  readonly nativeLabel: string
  readonly defaultMode: ReplaceGroupMode
  readonly tools: readonly string[]
  readonly replacementGuidance: string
}

export const SUPPLEMENT_GROUPS: readonly SupplementGroupMeta[] = [
  {
    id: 'memory_core',
    kind: 'supplement',
    label: 'Mnemon 核心记忆与文档',
    description: '日常热记忆读写、检索与项目文档（runtime_memory / recall / remember / document_*）',
    defaultMode: 'eager',
    tools: [
      'mnemon_runtime_memory',
      'mnemon_recall',
      'mnemon_remember',
      'mnemon_related',
      'mnemon_document_search',
      'mnemon_document_create',
      'mnemon_document_manage',
      'mnemon_status',
    ],
  },
  {
    id: 'delivery_skills',
    kind: 'supplement',
    label: '交付物、技能与工作区扩展',
    description: '成果交付（present）、DSH 技能、网页全文抓取、图片读取与 Worktree 管理',
    defaultMode: 'eager',
    tools: [
      'present',
      'skill',
      'create_skill',
      'web_fetch',
      'read_image',
      'working_directory',
      'create_worktree',
    ],
  },
  {
    id: 'documents_office',
    kind: 'supplement',
    label: 'Office 与结构化文档解析',
    description: 'PDF / DOCX / 表格读取，以及 Office 文档转换、渲染与公式重算',
    defaultMode: 'lazy',
    tools: [
      'office_render',
      'office_convert',
      'office_recalculate',
      'ops_read_pdf',
      'ops_read_docx',
      'ops_read_table',
    ],
  },
  {
    id: 'goals_teams_workflow',
    kind: 'supplement',
    label: '目标、团队任务与多代理工作流',
    description: '长时目标（goal）、团队共享任务板、JS 多代理 workflow 与 Plan 模式退出',
    defaultMode: 'lazy',
    tools: [
      'get_goal',
      'create_goal',
      'update_goal',
      'team_task_create',
      'team_task_list',
      'team_task_get',
      'team_task_update',
      'workflow',
      'exit_plan_mode',
    ],
  },
  {
    id: 'memory_admin',
    kind: 'supplement',
    label: 'Mnemon 高级记忆空间管理',
    description: '记忆空间增改合并、实体链接、遗忘、视图路由与子代理回传',
    defaultMode: 'lazy',
    tools: [
      'mnemon_memory_bodies',
      'mnemon_memory_body_create',
      'mnemon_memory_body_update',
      'mnemon_memory_body_merge',
      'mnemon_link',
      'mnemon_forget',
      'mnemon_view_route',
      'mnemon_view_action',
      'mnemon_subagent_result',
    ],
  },
  {
    id: 'media_system',
    kind: 'supplement',
    label: '图像生成与宿主插件管理',
    description: 'Codex 生图、订阅偏好与 DSH 插件管理器',
    defaultMode: 'lazy',
    tools: [
      'codex_image_generate',
      'codex_subscription_preferences',
      'plugin_manager',
    ],
  },
  {
    id: 'other_plugins',
    kind: 'supplement',
    label: '其他 DSH / 第三方插件工具',
    description: '自动归类未显式分组的新增或第三方 DSH 插件工具，默认按需发现不占常驻体积',
    defaultMode: 'lazy',
    tools: [],
  },
] as const

export const REPLACE_GROUPS: readonly ReplaceGroupMeta[] = [
  {
    id: 'subagents',
    kind: 'replace',
    label: '子代理与跨 Provider 模型路由',
    description: '用 DSH subagent 体系替代 agy 原生 invoke_subagent，使任务分类路由与跨模型生效',
    nativeLabel: 'invoke_subagent / manage_subagents',
    defaultMode: 'replace',
    tools: [
      'subagent',
      'subagent_fork',
      'list_agents',
      'wait_agent',
      'send_message',
      'list_subagent_models',
    ],
    replacementGuidance:
      'When host instructions (such as task-category model routing or Agent Teams) direct you to delegate or coordinate via `subagent`, `subagent_fork`, `list_agents`, `wait_agent`, `send_message`, or `list_subagent_models`, call the bridged DSH `dsh-tools` MCP tool (for example `mcp_dsh-tools_subagent`) instead of Antigravity\'s native `invoke_subagent`, so host routing policies and cross-provider models take effect.',
  },
  {
    id: 'web_search',
    kind: 'replace',
    label: '联网搜索',
    description: '用 DSH 配置的 web_search（如 Codex / 自定义搜索源）替代 agy 原生 search_web',
    nativeLabel: 'search_web',
    defaultMode: 'native',
    tools: ['web_search'],
    replacementGuidance:
      'When performing web searches, prefer `mcp_dsh-tools_web_search` instead of Antigravity\'s native `search_web` so DSH\'s configured search provider is used.',
  },
  {
    id: 'file_ops',
    kind: 'replace',
    label: '文件读写、编辑与代码搜索',
    description: '用 DSH 的 read/write/edit/glob/grep 及 ops_* 文件工具替代 agy 原生文件操作',
    nativeLabel: 'read_file / write_file / edit_file',
    defaultMode: 'native',
    tools: [
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'ops_inspect_local_file',
      'ops_glob',
      'ops_grep',
      'ops_read_files',
      'ops_write_file',
      'ops_edit_file',
      'ops_replace',
      'ops_diff',
      'ops_stat',
      'ops_copy',
      'ops_move',
      'ops_remove',
      'ops_result',
      'ops_discover_tools',
    ],
    replacementGuidance:
      'When reading, searching, editing, or managing workspace files, prefer the bridged DSH file tools (`mcp_dsh-tools_ops_*` or `mcp_dsh-tools_read`/`write`/`edit`/`glob`/`grep`) instead of Antigravity\'s native `read_file`, `write_file`, or `edit_file`.',
  },
  {
    id: 'shell_jobs',
    kind: 'replace',
    label: '终端命令与后台任务',
    description: '用 DSH 的 bash 与 job_* 替代 agy 原生 run_command 与 manage_task',
    nativeLabel: 'run_command / manage_task',
    defaultMode: 'native',
    tools: ['bash', 'job_output', 'job_list', 'job_kill'],
    replacementGuidance:
      'When executing shell commands or inspecting/stopping background command jobs, prefer `mcp_dsh-tools_bash` and `mcp_dsh-tools_job_*` instead of Antigravity\'s native `run_command` and `manage_task`.',
  },
  {
    id: 'planning_schedule',
    kind: 'replace',
    label: '任务清单、提问与定时计划',
    description: '用 DSH 的 todo_write / ask_user_question / schedule_* 替代 agy 原生同类工具',
    nativeLabel: 'update_steps / ask_question / schedule',
    defaultMode: 'native',
    tools: [
      'todo_write',
      'ask_user_question',
      'schedule_create',
      'schedule_list',
      'schedule_view',
      'schedule_edit',
    ],
    replacementGuidance:
      'When updating task checklists, asking multiple-choice user questions, or creating/managing scheduled tasks, prefer the bridged DSH tools (`mcp_dsh-tools_todo_write`, `mcp_dsh-tools_ask_user_question`, `mcp_dsh-tools_schedule_*`) instead of Antigravity\'s native `update_steps`, `ask_question`, or `schedule`.',
  },
] as const

const SUPPLEMENT_GROUP_BY_ID = new Map<SupplementGroupId, SupplementGroupMeta>(
  SUPPLEMENT_GROUPS.map((g) => [g.id, g]),
)
const REPLACE_GROUP_BY_ID = new Map<ReplaceGroupId, ReplaceGroupMeta>(
  REPLACE_GROUPS.map((g) => [g.id, g]),
)

const TOOL_TO_GROUP = new Map<string, SupplementGroupMeta | ReplaceGroupMeta>()
for (const g of SUPPLEMENT_GROUPS) {
  for (const tool of g.tools) TOOL_TO_GROUP.set(tool, g)
}
for (const g of REPLACE_GROUPS) {
  for (const tool of g.tools) TOOL_TO_GROUP.set(tool, g)
}

export const SUPPLEMENT_GROUP_IDS = new Set<string>(SUPPLEMENT_GROUPS.map((g) => g.id))
export const REPLACE_GROUP_IDS = new Set<string>(REPLACE_GROUPS.map((g) => g.id))
const VALID_EXPOSURE_MODES = new Set<string>(['eager', 'lazy', 'off'])
const VALID_REPLACE_MODES = new Set<string>(['native', 'replace', 'lazy'])

export function isSupplementGroupId(v: string): v is SupplementGroupId {
  return SUPPLEMENT_GROUP_IDS.has(v)
}

export function isReplaceGroupId(v: string): v is ReplaceGroupId {
  return REPLACE_GROUP_IDS.has(v)
}

export function isToolExposureMode(v: unknown): v is ToolExposureMode {
  return typeof v === 'string' && VALID_EXPOSURE_MODES.has(v)
}

export function isReplaceGroupMode(v: unknown): v is ReplaceGroupMode {
  return typeof v === 'string' && VALID_REPLACE_MODES.has(v)
}

export function classifyDshTool(toolName: string): SupplementGroupMeta | ReplaceGroupMeta {
  return TOOL_TO_GROUP.get(toolName) ?? SUPPLEMENT_GROUP_BY_ID.get('other_plugins')!
}

export interface EffectiveMcpToolPolicy {
  groups: Record<SupplementGroupId, SupplementGroupMode>
  replace: Record<ReplaceGroupId, ReplaceGroupMode>
  overrides: Record<string, ToolExposureMode>
}

export function resolveEffectiveMcpToolPolicy(
  policy?: McpToolPolicyConfig | null,
  legacyExposeOverlappingTools?: boolean,
): EffectiveMcpToolPolicy {
  const groups = {} as Record<SupplementGroupId, SupplementGroupMode>
  for (const g of SUPPLEMENT_GROUPS) {
    const raw = policy?.groups?.[g.id]
    groups[g.id] = isToolExposureMode(raw) ? raw : g.defaultMode
  }

  const replace = {} as Record<ReplaceGroupId, ReplaceGroupMode>
  for (const g of REPLACE_GROUPS) {
    const raw = policy?.replace?.[g.id]
    if (isReplaceGroupMode(raw)) {
      replace[g.id] = raw
    } else if (legacyExposeOverlappingTools && g.defaultMode === 'native') {
      replace[g.id] = 'replace'
    } else {
      replace[g.id] = g.defaultMode
    }
  }

  const overrides: Record<string, ToolExposureMode> = {}
  if (policy?.overrides && typeof policy.overrides === 'object') {
    for (const [name, mode] of Object.entries(policy.overrides)) {
      if (TOOL_NAME_RE.test(name) && isToolExposureMode(mode)) {
        overrides[name] = mode
      }
    }
  }

  return { groups, replace, overrides }
}

export function resolveToolExposure(
  toolName: string,
  effective: EffectiveMcpToolPolicy,
): { mode: ToolExposureMode; group: SupplementGroupMeta | ReplaceGroupMeta; replacedNative: boolean; overridden: boolean } {
  const group = classifyDshTool(toolName)
  const override = Object.hasOwn(effective.overrides, toolName) ? effective.overrides[toolName] : undefined
  if (override) {
    return {
      mode: override,
      group,
      replacedNative: group.kind === 'replace' && override === 'eager' && effective.replace[group.id] === 'replace',
      overridden: true,
    }
  }

  if (group.kind === 'replace') {
    const repMode = effective.replace[group.id]
    const mode: ToolExposureMode = repMode === 'replace' ? 'eager' : repMode === 'lazy' ? 'lazy' : 'off'
    return { mode, group, replacedNative: repMode === 'replace', overridden: false }
  }

  return {
    mode: effective.groups[group.id],
    group,
    replacedNative: false,
    overridden: false,
  }
}

export function compactMcpToolPolicy(policy?: McpToolPolicyConfig | null): McpToolPolicyConfig | undefined {
  if (!policy || typeof policy !== 'object') return undefined

  const groups: Partial<Record<SupplementGroupId, SupplementGroupMode>> = {}
  if (policy.groups) {
    for (const g of SUPPLEMENT_GROUPS) {
      const val = policy.groups[g.id]
      if (isToolExposureMode(val) && val !== g.defaultMode) {
        groups[g.id] = val
      }
    }
  }

  const replace: Partial<Record<ReplaceGroupId, ReplaceGroupMode>> = {}
  if (policy.replace) {
    for (const g of REPLACE_GROUPS) {
      const val = policy.replace[g.id]
      if (isReplaceGroupMode(val) && val !== g.defaultMode) {
        replace[g.id] = val
      }
    }
  }

  const overrides: Record<string, ToolExposureMode> = {}
  if (policy.overrides) {
    for (const [name, val] of Object.entries(policy.overrides)) {
      if (TOOL_NAME_RE.test(name) && isToolExposureMode(val)) {
        overrides[name] = val
      }
    }
  }

  const out: McpToolPolicyConfig = {}
  if (Object.keys(groups).length > 0) out.groups = groups
  if (Object.keys(replace).length > 0) out.replace = replace
  if (Object.keys(overrides).length > 0) out.overrides = overrides
  return Object.keys(out).length > 0 ? out : undefined
}

export function validateMcpToolPolicyInput(
  raw: unknown,
): { ok: true; value: McpToolPolicyConfig } | { ok: false; error: string } {
  if (raw === null) {
    return { ok: true, value: {} }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'mcpToolPolicy 必须为 JSON 对象' }
  }
  const obj = raw as Record<string, unknown>
  const out: McpToolPolicyConfig = {}

  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return { ok: false, error: `mcpToolPolicy 包含非法键: ${key}` }
    }
    if (key !== 'groups' && key !== 'replace' && key !== 'overrides') {
      return { ok: false, error: `mcpToolPolicy 不支持的字段: ${key}` }
    }
  }

  if (obj.groups !== undefined) {
    if (!obj.groups || typeof obj.groups !== 'object' || Array.isArray(obj.groups)) {
      return { ok: false, error: 'mcpToolPolicy.groups 必须为对象' }
    }
    const groups: Partial<Record<SupplementGroupId, SupplementGroupMode>> = {}
    for (const [k, v] of Object.entries(obj.groups as Record<string, unknown>)) {
      if (!isSupplementGroupId(k)) {
        return { ok: false, error: `未知的补充工具分组: ${k}` }
      }
      if (!isToolExposureMode(v)) {
        return { ok: false, error: `分组 "${k}" 的模式必须为 eager、lazy 或 off` }
      }
      groups[k] = v
    }
    if (Object.keys(groups).length > 0) out.groups = groups
  }

  if (obj.replace !== undefined) {
    if (!obj.replace || typeof obj.replace !== 'object' || Array.isArray(obj.replace)) {
      return { ok: false, error: 'mcpToolPolicy.replace 必须为对象' }
    }
    const replace: Partial<Record<ReplaceGroupId, ReplaceGroupMode>> = {}
    for (const [k, v] of Object.entries(obj.replace as Record<string, unknown>)) {
      if (!isReplaceGroupId(k)) {
        return { ok: false, error: `未知的原生替代分组: ${k}` }
      }
      if (!isReplaceGroupMode(v)) {
        return { ok: false, error: `替代分组 "${k}" 的模式必须为 native、replace 或 lazy` }
      }
      replace[k] = v
    }
    if (Object.keys(replace).length > 0) out.replace = replace
  }

  if (obj.overrides !== undefined) {
    if (!obj.overrides || typeof obj.overrides !== 'object' || Array.isArray(obj.overrides)) {
      return { ok: false, error: 'mcpToolPolicy.overrides 必须为对象' }
    }
    const entries = Object.entries(obj.overrides as Record<string, unknown>)
    if (entries.length > MAX_TOOL_OVERRIDES) {
      return { ok: false, error: `单工具覆写数量不能超过 ${MAX_TOOL_OVERRIDES} 项` }
    }
    const overrides: Record<string, ToolExposureMode> = {}
    for (const [k, v] of entries) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype' || !TOOL_NAME_RE.test(k)) {
        return { ok: false, error: `无效的工具名覆写键: ${k}` }
      }
      if (!isToolExposureMode(v)) {
        return { ok: false, error: `工具 "${k}" 的覆写模式必须为 eager、lazy 或 off` }
      }
      overrides[k] = v
    }
    if (Object.keys(overrides).length > 0) out.overrides = overrides
  }

  return { ok: true, value: compactMcpToolPolicy(out) ?? {} }
}

/** Collects replacement prompt guidance lines for active `'replace'` groups that have available DSH tools. */
export function buildActiveReplacementGuidance(
  effective: EffectiveMcpToolPolicy,
  availableToolNames?: ReadonlySet<string> | null,
): string[] {
  const lines: string[] = []
  for (const group of REPLACE_GROUPS) {
    if (effective.replace[group.id] !== 'replace') continue
    const hasEagerMember = group.tools.some((toolName) => {
      if (availableToolNames && !availableToolNames.has(toolName)) return false
      return resolveToolExposure(toolName, effective).mode === 'eager'
    })
    if (hasEagerMember) {
      lines.push(group.replacementGuidance)
    }
  }
  return lines
}

export interface LazyCatalogBriefItem {
  name: string
  description?: string
}

/** Formats a compact prompt index of on-demand DSH tools exposed via `dsh_discover_tools` / `dsh_call_tool`. */
export function buildLazyToolCatalogGuidance(
  lazyTools: readonly LazyCatalogBriefItem[],
  maxChars = 2_400,
): string | null {
  if (lazyTools.length === 0) return null
  const header =
    `Additional DSH host tools (${lazyTools.length}) are available on demand via \`mcp_dsh-tools_${DSH_DISCOVER_TOOLS_NAME}\` (inspect full schema before calling) and \`mcp_dsh-tools_${DSH_CALL_TOOL_NAME}\` (invoke by exact name & arguments):`
  const byGroup = new Map<string, string[]>()
  for (const t of lazyTools) {
    const group = classifyDshTool(t.name)
    const list = byGroup.get(group.label) ?? []
    list.push(t.name)
    byGroup.set(group.label, list)
  }

  const lines: string[] = [header]
  let used = header.length
  for (const [label, names] of byGroup) {
    const line = `- ${label}: ${names.join(', ')}`
    if (used + line.length + 1 > maxChars) {
      lines.push(`- …(call \`mcp_dsh-tools_${DSH_DISCOVER_TOOLS_NAME}\` to list all remaining tools)`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

export function estimateToolSchemaBytes(
  tool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  perToolOverhead = AGY_PER_TOOL_OVERHEAD_BYTES,
): number {
  const normalized = {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }
  return Buffer.byteLength(JSON.stringify(normalized), 'utf8') + perToolOverhead
}

export function firstLineSummary(text: string | undefined, maxChars = 96): string {
  if (!text) return ''
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`
}
