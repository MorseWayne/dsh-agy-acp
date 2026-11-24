# dsh-agy-acp 开发路线图与会话交接（Roadmap & Handoff）

## 1. 项目定位

`dsh-agy-acp` 是新一代 **DeepSeek Harness (DSH) × Google Antigravity** 桥接插件，融合了两个参考项目的核心优势：
- 借鉴 **T3 Code**：使用官方 `agy acp`（Agent Client Protocol，stdio JSON-RPC 2.0 长连接）替代每轮 `spawn agy -p` 短进程，消除冷启动并支持双向交互。
- 借鉴 **`dsh-agy-link`**：采用严格单向分层架构（`common -> acp -> runtime -> provider -> transport -> index`，`client` 仅依赖 `common`），保留 DSH 原生工具卡片镜像（`agy_acp_tool` Span 切分），并用 **SSE** 替代前端定时轮询。

## 2. 已实测的 `agy 1.5.16` ACP 协议事实（请勿重复踩坑）

- **握手与生命周期**：`initialize` ~100ms，`session/new` ~3.1s（首轮鉴权，后续 `session/prompt` 零冷启动），`session/set_config_option` ~1ms，`session/close` 0ms。
- **动态模型与思考档**：`session/new` 返回 `configOptions`（`model` / `thought_level` / `mode`）；切换模型时服务端会实时推送 `config_option_update` 自动裁剪合法的 `thought_level`，无需维护 effort 拒绝黑名单。
- **权限模式边界**：`agy acp` 声明的模式仅有 `default` / `accept-edits` / `plan`（无 `yolo`）；全自动跳过审批需在启动子进程时传 `--dangerously-skip-permissions`。
- **工具调用与权限审批**：
  - 流程：`tool_call (in_progress)` → `tool_call_update (pending)` → 服务端发起 RPC `session/request_permission`（含 `options: allow_once / reject_once`）→ 客户端回复 `{ outcome: { outcome: "selected", optionId } }` → `tool_call_update (completed)`。
  - 完成事件原生自带完整 `rawInput`、`rawOutput`（含 `output` / `exit_code`）与 `content`，**无需反查 `agy` 本地 DB**。
- **多模态与会话级 MCP**：`promptCapabilities.image: true`、`embeddedContext: true`；`session/new` 直接接受 `mcpServers: [...]`；CLI 还支持 `--ide-mcp-port` 与 `--process-per-session`。
- **Thinking 现状**：`agy 1.5.16` 在 `usage.thoughtTokens` 中精确上报思考 token，但暂未流式吐 `agent_thought_chunk`（适配器已同时兼容两者）。

## 3. 已完成（Phase 1 MVP — `pnpm run verify` 全绿）

- `src/common/`：配置解析、状态快照契约、预留的 `AccountProvider` 多账号扩展接口。
- `src/acp/`：双向 JSON-RPC 2.0 客户端（并发请求匹配、`session/request_permission` 回调、`session/cancel`、`session/update` 订阅）。
- `src/runtime/`：`agy` 路径探测、长驻 `AcpSessionPool`（会话复用、动态同步选项、空闲 TTL 清理）。
- `src/provider/`：`AcpAdapter`（`LlmAdapter` 实现、原生图片 Prompt 组装、精确缓存 Token 统计、`AcpRunStore` + `agy_acp_tool` Span 切分镜像）。
- `src/transport/sse.ts` & `src/client/index.ts`：`/plugins/agy-acp/status` + `/plugins/agy-acp/events` SSE 推送与顶栏 `AGY·ACP` 状态徽标。

## 4. 未来工作计划（待新会话推进）

### Phase 1.5 — 端到端联调与健壮性补齐
- [ ] 编写真实 `AcpAdapter.stream()` 端到端集成测试（覆盖多轮上下文复用、工具调用 Span 切分续跑、`AbortSignal -> session/cancel` 中途取消）。
- [ ] 完善 `agy_acp_tool` 的 `presentCall` / `presentResult` 卡片投影（让 `run_command` 渲染为终端卡片、文件编辑渲染为 diff 卡片，对齐 DSH 原生观感）。
- [ ] 在本地 DSH 实例中实际加载 `dsh-agy-acp` 并完成端到端联调。

### Phase 2 — 工具生态 + 交互式权限 + 前端控制台
- [ ] **会话级反向 MCP 桥接**（`src/mcp/`）：复用本地回环 HTTP + Bearer Token + 零依赖 stdio `bridge.mjs`，但通过 `session/new` 的 `mcpServers` 参数动态注入（**不污染全局 `~/.gemini/config/mcp_config.json`**），并屏蔽 `run_code` / `agy_acp_tool` 防递归。
- [ ] **ACP 原生交互式权限审批**：将 `session/request_permission` 回调通过 SSE 推到前端控制台（或对接 DSH 原生审批机制），支持用户在界面上实时点击 Allow / Deny / Always Allow。
- [ ] **前端管理控制台**（`src/client/`）：基于 SSE 扩展设置页与插件详情页（支持切换权限模式、查看活跃 ACP 会话、一键重置会话、实时查看上下文占用与 Token 用量）。

### Phase 3 — 多账号池化与高可用（基于 `AccountProvider` 扩展点）
- [ ] 实现多账号池（独立 `HOME` / Keychain 沙箱、单账号独立代理注入）。
- [ ] Windows 凭据槽位升级为**跨进程文件锁 + 引用计数租约**（避免多 DSH 实例互相踩踏，且 ACP 长连接建连鉴权后即可释放槽位）。
- [ ] 接入官方多 Bucket 配额监控（5h 滚动 + 7d 周额度）、按模型族独立冷却、429 / 额度耗尽自动故障转移。
- [ ] 补齐架构单向依赖校验脚本（`lint:arch`），防止代码膨胀后出现循环依赖。
