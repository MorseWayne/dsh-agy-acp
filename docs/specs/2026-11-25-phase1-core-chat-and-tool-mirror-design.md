# 阶段一设计规格：核心对话质量与实时工具体验

- **日期**：2026-11-25
- **项目**：`@morsewayne/dsh-agy-acp`
- **范围**：阶段一（实时工具流式镜像、原生多类型卡片投影、`options.system` 透传、`options.purpose` 安全辅助调用、会话重建上下文恢复、`detectContinuation` 修复收尾）
- **明确非目标（留待后续阶段）**：
  - 权限审批弹窗文案美化、8KB 截断阈值修改、`workspace-write` 路径放宽与非致命报错进程保留（阶段二）
  - 配置持久化落盘、前端单例 SSE 共享与控制台 UI 重构（阶段三）

---

## 1. 目标与核心问题

当前实现虽然通过基础集成测试，但在真实 DSH 使用场景存在以下核心体验缺陷：

1. **工具调用执行期间无实时反馈**：`AcpAdapter.driveRecording` 仅在收到 `status === 'completed' | 'failed'` 时切分 Span，耗时命令或审批等待期间界面完全静止。
2. **增量工具帧未按 `toolCallId` 合并**：ACP 协议允许首帧 `tool_call` 携带 `name` / `kind` / `rawInput` / `locations`，而后续完成帧 `tool_call_update` 仅携带结果。当前代码仅读取完成帧，导致卡片退化为缺参通用 `tool` 卡片；Code Mode（`run_code`）也未传递 `input`。
3. **未利用 DSH 原生富卡片能力**：`@deepseek-ai/dsh-tools` 原生支持 `read`、`search`、`web`、`terminal`、`diff` 五类完成态卡片，目前只实现了 `terminal` 与 `diff`。
4. **完全丢弃 DSH `options.system`**：虽然 `agy 1.5.16` 声明并接受 `session/new` 的 `_meta.antigravity.systemPrompt.append`，插件并未透传 DSH 系统提示词。
5. **辅助调用直接失败**：遇到 `options.purpose`（`session-title` / `compaction`）直接抛错，导致自动生成对话标题与上下文压缩失败。
6. **上下文重建严重失忆与回溯越界**：`buildPromptBlocks` 在首轮重建时仅取最近 10 条纯文本且截断至 600 字符、丢弃全部工具记录；回溯 `trailingUsers` 时遇到 `role === 'tool'` 未停止。

---

## 2. 架构约束

必须严格遵守 [scripts/lint-arch.mjs](../../scripts/lint-arch.mjs) 定义的单向分层依赖，不新增跨层或循环依赖：

```
common -> (none)
acp    -> common
mcp    -> common, acp
runtime -> common, acp
provider -> common, acp, runtime
transport -> common, runtime
client -> common
index  -> common, acp, mcp, runtime, provider, transport
```

**跨层边界约定**：`runtime` 层绝不导入 `provider` 层。系统提示词格式化与哈希计算归属 `provider` 层（`src/provider/prompt-builder.ts`），调用 `AcpSessionPool` 时仅传递纯字符串参数（`systemPromptAppend`、`systemFallbackBlock` 等）。

---

## 3. 模块详细设计

### 3.1 `toolCallId` 增量聚合与异步等待（`src/provider/run-store.ts`）

在 `AcpRunRecording` 内引入按 `toolCallId` 聚合的 `MergedToolCall` 状态机：

```ts
export interface NormalizedLocation {
  path: string
  line?: number
}

export interface MergedToolCall {
  toolCallId: string
  step: number
  name?: string
  kind?: string
  title?: string
  rawInput?: unknown
  args?: Record<string, unknown>
  locations?: NormalizedLocation[]
  rawOutput?: unknown
  content?: Array<{ type: string; content?: { type: string; text?: string } }>
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  settled: boolean
}

export interface ToolCompletionResult {
  tool: MergedToolCall | null
  aborted: boolean
  runError?: string
}
```

核心行为：
1. **增量合并（`pushUpdate`）**：
   - 当收到 `sessionUpdate === 'tool_call' | 'tool_call_update'` 时，以 `update.toolCallId` 作为键创建或更新 `MergedToolCall`。若极少数帧缺失 `toolCallId`，回退为 `step:${idx}`（仅覆盖单帧场景，不跨帧合并）。
   - 首帧 `tool_call` 若省略可选 `status`，默认视为 `'in_progress'`。
   - 仅当新帧字段有效（非 `undefined`、字符串非空、数组非空）时覆盖合并对应字段；绝不因完成帧省略 `name`、`kind`、`title`、`rawInput`、`args` 或 `locations` 而抹掉首帧已有信息。`locations` 统一规范化为 `{ path: string, line?: number }[]`（丢弃非法或未知附加键）。
   - 维护 `stepToToolCallId: Map<number, string>` 与 `toolResults: Map<number, AcpToolCallUpdate>`（保持旧测试按 `step` 查找的向后兼容，且每当合并后进入终态时将完整合并快照同步写入对应 `step`）。
   - 当 `status === 'completed' || status === 'failed'` 时标记 `settled = true` 并唤醒所有等待者。
2. **去重跟踪**：
   - `AcpRunRecording` 持有 `emittedToolCallIds = new Set<string>()`，提供 `markToolEmitted(toolCallId)` / `isToolEmitted(toolCallId)` / `getToolCall(key: string | number)`，确保同一 `toolCallId` 在整个轮次中最多切出一次 DSH 工具卡片。
3. **异步完成等待（`waitForToolCompletion(key: string | number, signal?: AbortSignal): Promise<ToolCompletionResult>`）**：
   - `key` 支持传入 `toolCallId` 或数字 `step`（兼容旧测试调用）；`signal` 可选（`undefined` 时空安全）。
   - 若 `signal?.aborted` 在入口已为真：立即调用 `this.requestCancel()` 并返回 `{ tool: current, aborted: true }`。
   - 若对应 `MergedToolCall` 已 `settled === true`，立即返回 `{ tool, aborted: false }`。
   - 否则挂起等待，直到以下任一条件满足：
     - 目标 `MergedToolCall` 达到 `settled === true` → 返回 `{ tool, aborted: false }`；
     - 整个 `AcpRunRecording` 结束（`done` 或 `error`）→ 返回 `{ tool: current, aborted: false, ...(runError ? { runError } : {}) }`，绝不死锁；
     - `signal` 触发 abort → 立即调用 `this.requestCancel()` 向 `agy` 发 `session/cancel`，清理监听并返回 `{ tool: current, aborted: true }`。

---

### 3.2 实时工具切分、批量边界与续跑（`src/provider/adapter.ts`）

#### 实时切分与空占位帧规则
在 `driveRecording` 中处理 `items[idx]` 为 `tool_call` / `tool_call_update` 且 `cutOnTool === true` 时：
1. 取 `toolCallId = u.toolCallId || \`step:${idx}\``，若 `rec.isToolEmitted(toolCallId)` 已为 `true`，直接 `idx++` 跳过（避免重复切分）。
2. 从 `rec.getToolCall(toolCallId)` 获取当前合并后的 `MergedToolCall`。判断是否就绪可发射：
   - 若 `status` 为 `'completed'` / `'failed'` / `'pending'`，或 `in_progress` 已携带 `name` / `rawInput` / `args` / `title` / `locations` 任一有效展示字段：立即就绪。
   - 若为无任何元数据的纯空占位 `in_progress` 帧：
     - **若下一项 `rec.items[idx + 1]` 已在缓冲队列中**：跳过当前索引继续消费下一帧以便合并；
     - **若下一项尚未到达**：不阻塞等待，立即以占位信息发射（`tool: 'tool'`），确保在 `agy` 紧接着弹出权限审批前用户即可看到运行中卡片；待完成后由 `presentResult` 通过 `presentationMeta` 回填升级为完整卡片。
3. 发射单个工具块：
   - 标记 `rec.markToolEmitted(toolCallId)`；
   - 关闭当前开放的 `text` / `reasoning` 块；
   - 构造镜像工具参数（对 `locations` 规范化为 `{ path, line? }[]`）：
     - 标准模式：`{ run: rec.id, step: idx, toolCallId, tool: tc.name ?? 'tool', ...(title/kind/locations), ...(input !== undefined ? { input } : {}) }`
     - Code Mode（`isCodeMode === true`）：透传上述字段；对 `input` 做受控裁剪（若 JSON 序列化超过 16KB，仅保留卡片投影所需的摘要字段如 `CommandLine`/`command`/`cmd`/`Cwd`/`cwd`/`Path`/`TargetFile`/`file_path`/`path`/`Query`/`Pattern`/`Url`/`Description`/`StartLine`/`offset`），确保 `run_code` 代码块不被大文本撑爆同时保留卡片投影能力。
   - 发射 `block-start(tool-call)` → `block-end(tool-call)`（`id = encodeMirrorCallId(rec.id, idx)`）。

#### 批量并发工具边界
- **标准模式（`!isCodeMode`）**：发射第一个就绪工具后，可继续向后查看 `rec.items[idx + 1]`——**仅当下一项已在缓冲中且为 `tool_call` / `tool_call_update`（绝不跨越 `agent_message_chunk`、`agent_thought_chunk`、`done` 或 `error`）**且对应新 `toolCallId` 未发射并已就绪时，推进 `idx` 并在同一 Span 内连续发射该工具（因 `mirrorTool.isConcurrencySafe()` 返回 `true`）。随后统一发射 `finish(reason: { kind: 'tool-calls' })` 并返回。
- **Code Mode（`isCodeMode`）**：每次 Span 严格最多发射 **1 个** `run_code` 工具调用，不做同 Span 批量发射，保证 `callId` 与续跑游标 1:1 对应。

#### `detectContinuation` 修复与批量游标对齐
正式纳入并增强工作区的 `detectContinuation` 兼容逻辑：
- 从 `messages` 末尾向前扫描：
  - 跳过位于工具结果之后的 `role === 'user'` 且 `source?.kind === 'runtime-context'` 宿主快照消息；
  - 收集尾部**所有连续的工具结果消息**（同时兼容新版 `role === 'tool'` 顶层 `toolCallId` 与旧版 `role === 'user'` 内含 `tool-result` block）；
  - 遇到首个非工具结果消息（如 `assistant` 或普通 `user` 消息）即停止扫描；
  - 取与最末尾工具结果**同一 `runId`** 的所有解码项中的**最大 `itemIndex`**，返回 `{ runId, itemIndex: maxItemIndex }`，随后从 `maxItemIndex + 1` 续跑。这样即使并发工具完成顺序与发射顺序不同，续跑游标也绝不会回退重扫或漏项。

---

### 3.3 原生全系卡片投影与严格 Schema 契约（`src/provider/mirror-tool.ts`）

#### `defineTool` 的 `parameters` 与 `output.schema` 契约
`@deepseek-ai/dsh-tools` 在 `presentCall`/`presentResult`/`isConcurrencySafe` 前会静默校验 `parameters`，在 `presentationMeta` 前会用 `output.schema` 严格校验 `execute()` 返回值（且所有嵌套 `object` 节点必须显式声明 `additionalProperties`）。因此明确如下定义：

1. **`parameters`**：
   - `run`: `{ type: 'string', required: true }`
   - `step`: `{ type: 'integer', required: true }`
   - `toolCallId`: `{ type: 'string' }`
   - `tool`: `{ type: 'string' }`
   - `title`: `{ type: 'string' }`
   - `kind`: `{ type: 'string' }`
   - `input`: `{ type: 'json' }`
   - `locations`: `{ type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, line: { type: 'integer' } } } }`
2. **`output.schema`**（保持 `additionalProperties: false`）：
   - `output`: `{ type: 'string', required: true }`
   - `isError`: `{ type: 'boolean', required: true }`
   - `exitCode`: `{ type: 'integer' }`
   - `signal`: `{ type: 'string' }`
   - `tool`: `{ type: 'string' }`
   - `title`: `{ type: 'string' }`
   - `kind`: `{ type: 'string' }`
   - `input`: `{ type: 'json' }`（执行端写入受控大小的展示子集，序列化上限 16KB；大文件 diff 内容优先保留必要字段或在超限时裁剪）
   - `locations`: 同上规范化数组（上限 32 条）
   - `httpStatus`: `{ type: 'integer' }`（仅当从 `rawOutput` 或输出中确切解析到合法 HTTP 状态码时写入）
   - `webSources`: `{ type: 'array', items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', required: true }, title: { type: 'string' }, snippet: { type: 'string' }, publishedAt: { type: 'string' } } } }`（上限 20 条）
3. **`execute(args, exec)`**：
   - 校验跨会话归属：`if (rec?.owner && rec.owner !== exec.agent?.session.id) throw new Error(...)`。
   - 调用 `const completion = await rec.waitForToolCompletion(args.toolCallId ?? args.step, exec.signal)`（`exec.signal` 可能为 `undefined`，保持空安全）。
   - 若 `completion.aborted`：返回 `{ output: 'Tool execution aborted by caller', isError: true, ... }`。
   - 若 `completion.tool` 缺失：回退友好提示（兼容旧单测与历史失效 run）。
   - 提取 `output`、`isError`、`exitCode`、`signal`、合并后的 `tool` / `title` / `kind` / `input` / `locations`，以及可选 `httpStatus` / `webSources`。
   - `output.presentationMeta` 将上述结构原样投影（确保总尺寸可控，超长 `output` 仅在 `meta` 中截断保护至 64KB，不截断 `render` 给模型的文本）。

#### `presentCall` / `presentResult` 五类卡片路由与无 `meta` 降级
- **Code Mode 与旧日志回放兼容**：在 Code Mode（`exec.parent !== undefined`）下 `@deepseek-ai/dsh-tools` 不会生成 `result.meta`（`result.meta` 为 `undefined`）。`presentResult(args, result)` 必须**始终支持无 `meta` 场景**：优先用 `meta` 合并补齐 `args`（修复首帧缺参），当 `meta` 缺失时直接使用 `args` 与 `extractResultText(result.content)` 进行投影。
- **卡片路由优先级**（任一结构化解析失败或 `result.isError === true` 时优雅回退 `GenericResultView`）：
  1. **Terminal（`card: 'terminal'`）**：`TERMINAL_TOOL_NAMES` 或 `kind === 'execute'` 且具备命令字符串 → `TerminalCallView` / `TerminalResultView`（`output`、`exitCode` / `signal`）。
  2. **Diff（`card: 'diff'`）**：`EDIT_TOOL_NAMES` 或 `kind === 'edit'` 且可提取 `FileDiff[]` → `DiffCallView` / `DiffResultView`。
  3. **Read（完成态 `card: 'read'`）**：`READ_TOOL_NAMES` 或 `kind === 'read'` 且具备 `path` 且非错误：
     - `presentCall` 保持 `GenericCallView (kind: 'read')` + `locations`。
     - `presentResult` 解析文本为 `ReadResultView`：剥离常见行号头（如 `Showing lines X-Y of Z`、`12: text`、`12\ttext`）或按 `StartLine`/`offset`（默认 1）编号，按扩展名推断 `lang`，最多展示 500 行，提供 `totalLines` 与降级 `content`。
  4. **Search（完成态 `card: 'search'`）**：`SEARCH_TOOL_NAMES` 或 `kind === 'search'` 且非错误：
     - `presentCall` 保持 `GenericCallView (kind: 'search')`。
     - 内容搜索（`grep_search` / `grep` / 含 `Query`/`Pattern`）：解析 `path:line:text` 或结构化 JSON 为按文件分组的 `SearchMatchesResultView`（`shape: 'matches'`、`files`、`truncated`、`total`）。
     - 路径搜索（`glob` / `find_by_name` / `list_dir` / `search_files`）：解析路径行或 JSON 数组为 `SearchPathsResultView`（`shape: 'paths'`、`paths`、`truncated`、`total`）。
  5. **Web（完成态 `card: 'web'`）**：`FETCH_TOOL_NAMES` 或 `kind === 'fetch'` 且非错误：
     - `search_web` / `web_search`：存在至少 1 条有效 `WebSource`（来自 `meta.webSources` 或从输出文本解析的 Markdown 链接 `[title](https://...)`）时返回 `WebSearchResultView`（`card: 'web', kind: 'search', sources, truncated`）。
     - `web_fetch` / `read_url_content`：**严格遵守 `WebFetchResultView` 类型契约**（`statusCode: number` 与 `truncated: boolean` 均为必填）：**仅当同时具备有效 `url` 且解析到真实 HTTP `statusCode`（100–599 整数）时**才返回 `WebFetchResultView`；缺失状态码时不伪造 `200`，直接回退 `GenericResultView`。
  6. **Generic（兜底 `card: 'generic'`）**：其他工具、错误结果或无法解析为结构化视图的输出。

---

### 3.4 `options.system` 原生透传与平滑更新（`src/provider/prompt-builder.ts`、`src/runtime/session-pool.ts`、`src/provider/adapter.ts`）

1. **桥接格式化与哈希（`src/provider/prompt-builder.ts`）**：
   - 导出 `prepareSystemPrompt(system?: string): { append: string; hash: string } | null`：
     - 若 `system` 为空或纯空白，返回 `null`。
     - 否则保留 `system.trim()` 全文，末尾附加简短桥接约束（遵守上述宿主系统指令、规则与语言风格；执行操作时一律以当前实际挂载的工具为准，不调用不存在的工具名，不提及内部镜像工具 `agy_acp_tool`），并用 SHA-256 计算 `hash`。
2. **连接级能力判定（`src/runtime/session-pool.ts`）**：
   - `newClient(...)` 改为返回 `{ client: AcpClient; initResult: InitializeResult }`（同时更新 `this.initResult` 供状态面板展示），消除池级单一 `this.initResult` 在并发建连时的竞态。
   - `getOrCreateSession(key, cwd, model, exclude, systemPromptAppend?)`：
     - 依据**本次连接的 `initResult`** 判定 `supportsSystemPromptAppend = Boolean(initResult.agentCapabilities?._meta?.antigravity?.systemPrompt?.append)`。
     - 若支持且 `systemPromptAppend` 非空，在 `client.sessionNew({ cwd, mcpServers, _meta: { antigravity: { systemPrompt: { append: systemPromptAppend } } } })` 中原生传入。
   - `ManagedAcpSession` 新增：
     - `supportsSystemPromptAppend: boolean`
     - `appliedSystemHash: string | null`（若首轮建连已通过 `_meta` 传入，直接记录对应哈希；否则初始化为 `null`，由调用方在降级/更新路径提交）。
3. **降级与动态更新时机（`src/provider/adapter.ts`）**：
   - 设 `preparedSystem = prepareSystemPrompt(options.system)`：
     - 若 `preparedSystem === null`（包括从非空变为空的情况）：不注入任何空更新标签，直接正常发送当轮消息。
     - 若 `created === true` 且 `!session.supportsSystemPromptAppend`：在当轮 `promptBlocks` 最前方插入 `<host_system_instructions>\n${preparedSystem.append}\n</host_system_instructions>`，标记待提交哈希 `pendingSystemHash = preparedSystem.hash`。
     - 若 `created === false` 且 `preparedSystem.hash !== session.appliedSystemHash`：**不杀进程重建**，在当轮 `promptBlocks` 最前方插入 `<host_system_instructions_updated>\n${preparedSystem.append}\n</host_system_instructions_updated>`，标记 `pendingSystemHash = preparedSystem.hash`。
   - **提交时机**：仅在本次 `session/prompt` 成功返回（`.then(...)`）时才执行 `session.appliedSystemHash = pendingSystemHash`，避免 429 故障转移、超时或中止导致提前写脏哈希而下轮漏发系统提示词。

---

### 3.5 `options.purpose` 安全无工具辅助调用（`src/runtime/session-pool.ts`、`src/provider/adapter.ts`、`src/provider/prompt-builder.ts`）

1. **入口与安全守门（`src/provider/adapter.ts`）**：
   - 当 `options.purpose` 存在（如 `'session-title'` | `'compaction'`）时，进入 `streamAuxiliary(options)`。
   - 当 `!options.sessionId && !options.purpose` 时，维持原样直接抛出错误拒绝。
2. **`AcpSessionPool.runAuxiliaryPrompt` 接口契约（`src/runtime/session-pool.ts`）**：
   ```ts
   export interface AuxiliaryPromptParams {
     sessionKey?: string
     model?: string
     effort?: string
     systemPromptAppend: string
     /** 当连接不支持 systemPrompt.append 时，由调用方预先准备的降级文本块 */
     systemFallbackBlock: PromptContentBlock
     prompt: PromptContentBlock[]
     signal?: AbortSignal
     timeoutMs?: number
     onUpdate?: (update: SessionUpdatePayload) => void
   }

   async runAuxiliaryPrompt(params: AuxiliaryPromptParams): Promise<SessionPromptResult>
   ```
   内部执行与安全边界：
   - **安全 `cwd` 解析**：优先取 `params.sessionKey ? this.sessions.get(params.sessionKey)?.cwd : undefined`；若无则对 `params.sessionKey` 在 `try/catch` 内尝试 `this.policy(params.sessionKey).workspaceRoot`；仍不可得则回退 `cfg.workspaceRoot || process.cwd()`（绝不因无 live agent 而误抛错）。
   - **账号租约**：`accountProvider.acquire('__auxiliary__', requestedModel)`；成功/失败后调用 `reportAccountSuccess` / `reportAccountFailure` 与 `recordTurnUsage`，**不写入 `this.sessions` 主会话池**。
   - **强制只读沙箱 + 生命周期绑定**：合并 `runSignal = AbortSignal.any([this.lifetime.signal, ...(params.signal ? [params.signal] : [])])` 传入 `newClient({ sessionId: '__auxiliary__', mode: 'read-only', workspaceRoot: cwd }, lease.env, runSignal, denyAllPermissions)`；若 `prepareArgv` 无法提供完整只读沙箱（`enforcement !== 'full'`），直接拒绝启动。
   - **权限全拒（`denyAllPermissions`）**：任何 `session/request_permission`（包括 `read`、`search`、`execute`、`edit` 等一切类型）一律返回 `reject_once`（若无该选项则返回 `cancelled`）。
   - **独立安全选项同步（不复用主会话强校验 `syncSessionOptions`）**：
     - `session/new` 强制 `mcpServers: []`；若本次连接支持 `systemPrompt.append` 则通过 `_meta` 传入 `params.systemPromptAppend`，否则将 `params.systemFallbackBlock` 置入 `promptBlocks` 最前方。
     - **强制回退安全模式**：若 `session/new` 返回的 `mode` 选项存在 `'default'` 且当前值不是 `'default'`（例如服务端默认 `accept-edits` 或 `auto`），必须立即显式调用 `session/set_config_option(mode='default')` 并校验生效（无法切回 `'default'` 且当前模式可能自动放行时拒绝执行），彻底杜绝绕过 `session/request_permission`。
     - **宽松模型与思考档同步**：若 `params.model` 非空且在本次目录 `routes` 中存在且不同于当前模型，则切换模型；仅在 `params.effort` 显式传入且被目标模型支持时切换 `thought_level`；绝不因默认 `defaultEffort` 不匹配而令标题生成失败。
   - **超时、取消与无阻塞清理**：
     - 超时取 `params.timeoutMs ?? Math.min(cfg.requestTimeoutMs, 90_000)`；`runSignal` 中止时触发 `client.sessionCancel(acpSessionId)`。
     - `finally` 中：仅当 `!runSignal.aborted && client.isRunning` 时以最多 1 秒竞态（best-effort、吞错）调用 `sessionClose`，随后立即 `unsubscribe()`、`client.dispose()` 与 `lease.release()`，绝不阻塞。
3. **流式输出与错误处理（`AcpAdapter.streamAuxiliary`）**：
   - 将 `options.system` 与固定辅助约束（仅作纯文本输出、严格禁止调用任何工具）合成为 `systemPromptAppend` 与降级 `systemFallbackBlock`；调用 `buildAuxiliaryPromptBlocks(options.messages)` 组装一次性全历史 prompt。
   - 通过异步队列接收 `onUpdate` 中的 `agent_thought_chunk` / `agent_message_chunk` 实时 yield `reasoning-delta` / `text-delta`（忽略任何工具事件）。
   - 正常结束时 yield `usage`（若存在）与 `finish({ kind: 'stop' })`；中止时 yield `finish({ kind: 'aborted', failure: { code: 'ABORTED', message: ... } })`；运行报错时 yield `finish({ kind: 'error', failure: { code: 'ACP_ERROR', message: ... } })`，与主 `driveRecording` 流契约完全一致。

---

### 3.6 `buildPromptBlocks` 修复与预算制上下文恢复（`src/provider/prompt-builder.ts`）

使用结构化兼容类型 `PromptMessage`（兼容 `role: 'system' | 'user' | 'assistant' | 'tool' | string`、`source?: { kind?: string }`、`toolCallId?: unknown`）确保在旧版 `@deepseek-ai/dsh-llm` 类型定义下也能通过 `tsc --noEmit`。

1. **修复 `trailingUsers` 回溯越界**：
   - 从 `messages` 末尾向前收集当前轮次用户输入时：
     - 遇到 `role === 'assistant'` 或 `role === 'tool'` 立即 `break`；
     - 若 `role === 'user'` 消息包含 `tool-result` block 且无普通用户输入（旧格式工具结果消息），同样视为工具边界立即 `break`；
     - 组装内容块时只提取 `text` 与 `image`，忽略 `tool-result`。
2. **预算制 `<prior_conversation_digest>`（`isFirstTurn === true` 且存在早于 `trailingUsers` 的历史消息）**：
   - 默认总预算 **24,000 字符**，从最近的历史消息向前贪心收录（逆序累计、正序输出），尽量完整保留最近轮次。
   - 过滤历史中过时的 `source?.kind === 'runtime-context'` 快照消息，防止重复环境快照迅速耗尽预算。
   - 全内容块摘要格式化：
     - `text`：单条上限 4,000 字符，超长截断并标注；
     - `tool-call`：若为 `agy_acp_tool` 或包裹 `tools["agy_acp_tool"](...)` 的 `run_code`，解析其真实 `tool` 名与关键输入摘要，绝不在摘要中暴露内部镜像工具名；其他工具输出 `[tool_call: name]`；
     - `tool-result` / `role === 'tool'`：格式化为 `[tool_result]: ...`（单条上限 1,200 字符）；
     - `image`：标注 `[image attachment]`。
   - 仍以 `<prior_conversation_digest>...</prior_conversation_digest>` 包裹输出。

---

## 4. 错误处理与边界矩阵

| 场景 | 预期行为 |
| --- | --- |
| 首帧 `tool_call(in_progress)` 缺 `rawInput`，后续 `completed` 补齐 | 等待完成后由 `presentationMeta` 回填，`presentResult` 正确投影为对应原生卡片 |
| 首帧带完整 `name`/`rawInput`，完成帧仅带 `toolCallId` + `status: completed` + `rawOutput` | `MergedToolCall` 保留首帧全部输入信息，卡片不退化为 `tool` |
| 首帧为空占位 `in_progress` 且下一帧尚未到达 | 立即发射占位卡片，不阻塞审批；完成态通过 `meta` 升级为最终卡片 |
| 同 Span 多个并发工具乱序完成 | `detectContinuation` 扫尾部连续同 `runId` 结果取最大 `itemIndex`，游标不回退不漏项 |
| `mirrorTool.execute` 等待期间用户点击停止（`exec.signal` abort） | 立即触发 `rec.requestCancel()` 发送 `session/cancel`，解除等待并返回中止结果 |
| ACP 轮次在工具完成前意外报错或提前 `done` | `waitForToolCompletion` 立即返回 `runError` / 最新快照，不发生死锁 |
| Code Mode 下 `result.meta` 为 `undefined` | `presentResult` 回退基于 `args` + `result.content` 投影，保留可读卡片 |
| `web_fetch` 缺少真实 HTTP 状态码 | 不伪造 `200`，回退 `GenericResultView` |
| 辅助调用服务端默认 `mode` 为 `accept-edits` 或 `auto` | 强制切回 `default` 后才执行，且 `onPermission` 全拒一切操作 |
| 辅助调用触发 `session/request_permission`（含 `read`） | 一律拒绝（`reject_once` / `cancelled`） |
| 辅助调用环境无法提供完整只读沙箱 | Fail-closed 拒绝启动 |
| `options.system` 不支持原生 `systemPrompt.append` | 降级为首轮 `<host_system_instructions>`，成功后再写 `appliedSystemHash` |
| 无 `sessionId` 且无 `purpose` | 维持原有安全行为，直接抛错拒绝 |

---

## 5. 验证与测试矩阵

需全部通过 `pnpm run verify`（`lint:arch` + `tsc --noEmit` + `tsdown` + `node --test`），并覆盖以下测试：

1. **实时流式工具镜像 & 增量合并（`test/adapter.e2e.test.ts` + `test/fixtures/fake-agy.mjs`）**：
   - `tool_call(in_progress)` 立即切分 Span 1 → `mirrorTool.execute()` 异步挂起 → 延迟到达的 `completed` 帧省略 `name`/`rawInput` → 合并后返回 `TerminalResultView` → Span 2 续跑完成；
   - 空占位 `in_progress` 帧未到达下一帧时立刻发射、完成态升级为 `TerminalResultView`；
   - `mirrorTool.execute()` 等待期间 `exec.signal` 中止 → 验证 `session/cancel` 送达并解除等待；
   - 同 Span 并行多工具调用乱序回填结果 → `detectContinuation` 取最大 `itemIndex` 正确续跑且不重复发射；
   - 兼容原有单发 `completed` 帧与三种历史结果格式（`legacy` / `tool role` / `tool role with runtime context`）。
2. **全系原生卡片投影与 Schema 校验（`test/core.test.ts`）**：
   - 用 `mirrorTool.output.schema` 校验 `execute()` 真实返回值，确保无 `additionalProperties` 违规；
   - `read` → `ReadResultView`（带行号、不带行号、`lang` 推导）；
   - `search` → `SearchResultView`（grep 分组匹配 + glob/list 路径列表）；
   - `web` → `WebSearchResultView` + `WebFetchResultView`（有真实状态码时生效，无状态码时回退 `generic`）；
   - 无 `result.meta`（Code Mode / 历史回放）场景的投影验证；
   - Code Mode 下仍保留受控 `input` 投影且不超过大小阈值。
3. **`options.system` 透传与动态更新（`test/adapter.e2e.test.ts` + `test/core.test.ts`）**：
   - 支持 `systemPrompt.append` 时通过 `session/new` `_meta` 透传，后续同值不重复发送，变更时注入增量块且不重建进程，清空时不注入空标签；
   - 不支持 `systemPrompt.append` 时降级到首轮 prompt，且首轮失败不提前写脏 `appliedSystemHash`。
4. **`options.purpose` 安全辅助调用（`test/adapter.e2e.test.ts` + `test/session-permissions.test.ts`）**：
   - `purpose: 'session-title'` 与 `'compaction'` 正常流式返回文本与 usage，且不污染 `sessions` 主池；
   - 服务端默认 `mode: 'accept-edits'` 时被强制切回 `default`；
   - 辅助调用中尝试发起 `read` / `execute` 权限请求均被强制拒绝；
   - 辅助调用在半沙箱（`enforcement: 'partial'`）时拒绝启动；
   - 无 `sessionId` 且无 `purpose` 时依然拒绝。
5. **上下文重建与回溯修复（`test/core.test.ts`）**：
   - `trailingUsers` 遇到 `role === 'tool'` 或旧 `tool-result` 立即停止，不重复携带上一轮用户输入；
   - 预算制 `<prior_conversation_digest>` 过滤旧 `runtime-context`、保留工具调用（展开 `agy_acp_tool` 及 Code Mode 包装）与结果摘要和图片标记，超预算时优先保留最近消息。
