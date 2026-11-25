# 阶段五设计规格：ACP 协议能力深化与跨会话连续性（`session/load` 恢复、通知实时同步与反向 MCP 健壮化）

- **日期**：2026-11-25
- **项目**：`@morsewayne/dsh-agy-acp`
- **前置基线**：阶段一（`7406eeb`）、阶段二（`7a6d2c1`）、阶段三（`0189a5c`）、阶段四（`7f488b6`）
- **范围**：阶段五（`session/load` 原生会话恢复与轻量持久化索引、`config_option_update` / `session_info_update` 协议通知实时同步、`ReverseMcpBridge` 工具调用超时与并发上限保护及状态快照摘要）
- **明确非目标**：
  - 不在本地索引中存储任何用户/助手对话正文、图片数据、凭据或环境变量；
  - 在权限边界（工作区、沙箱模式、审批策略）或账号发生变化时，绝不跨边界复用原 `acpSessionId`；
  - 在中断工具审批重建（`recoveryPolicy`）场景下，强制走全新 `session/new` 以防残留半完成工具状态。

---

## 1. 目标与核心问题

1. **空闲回收与重启丢失原生上下文及 Prompt Cache**：`agy 1.5.16+` 已在 `initialize` 中声明 `loadSession: true`（及 `sessionCapabilities.load`），但插件过去仅调用 `session/new`；每当空闲 TTL 回收、空闲子进程退出或 DSH 重载后，只能重新 `session/new` 并拼接 24K 文本摘要，损失原生上下文与服务端缓存命中率。
2. **动态协议通知未同步**：服务端在会话生命周期内推送的 `config_option_update`（模型/思考档位/模式选项变化）与 `session_info_update`（会话标题）未被消费，导致内存会话状态与控制台展示滞后。
3. **反向 MCP 桥接缺少防护与运行态可观测性**：`ReverseMcpBridge` 缺少单次工具调用超时与并发上限控制，慢工具可能长期占用连接；控制台也无法直观看到反向桥接调用次数、在途调用与最近脱敏错误。

---

## 2. 架构约束与模块归属

严格遵守 [scripts/lint-arch.mjs](../../scripts/lint-arch.mjs) 单向分层规则：

- `src/acp/protocol.ts` & `src/acp/client.ts`：扩展 `SessionLoadParams`、`SessionLoadResult`、`supportsSessionLoad` 与 `AcpClient.sessionLoad(...)`。
- `src/common/types.ts`：扩展 `SessionSummary`（`title`、`resumed`）与 `McpBridgeSnapshot`、`StatusSnapshot.mcpBridge`、`StatusSnapshot.persistedSessions`。
- `src/runtime/session-index.ts`（新增）：轻量级原子持久化会话映射表（`~/.dsh/agy-acp/sessions.json`，权限 `0600`，上限 200 条、默认 7 天过期清理，仅存标识与安全指纹，零对话内容）。
- `src/runtime/session-pool.ts`：在 `getOrCreateSession` 实现条件化 `session/load` 优先恢复与 100% 平滑回退 `session/new`；绑定会话级常驻 `onSessionUpdate` 同步 `config_option_update`、`session_info_update` 及 `session/load` 回放的 `usage_update`。
- `src/mcp/server.ts` & `src/mcp/bridge.mjs`：为 `ReverseMcpBridge` 增加单次调用超时（绑定 `AbortSignal` 并主动中断挂起请求）、最大并发限制（默认 8）、`dispose()` 强制断连与运行指标聚合。
- `src/index.ts` & `src/client/index.ts`：注入 `SessionIndex` 与桥接聚合指标，控制台展示会话原生恢复徽标、会话标题及反向 MCP 桥接运行摘要。

---

## 3. 核心详细设计

### 3.1 `session/load` 原生恢复与安全边界
1. **能力检测（`supportsSessionLoad`）**：检查 `agentCapabilities.loadSession === true`、`load_session === true` 或 `sessionCapabilities.load` 存在（已在真实 `agy 1.5.17` 验证返回 `{ sessionId, models, modes, configOptions, _meta }`）。
2. **轻量会话索引（`SessionIndex`）**：
   - 仅保存 `{ dshSessionKey, acpSessionId, accountId, cwd, policyFingerprint, appliedSystemHash, title, updatedAt }`；
   - **保留索引以供恢复**：空闲 TTL 回收（`sweepIdleSessions`）、空闲子进程退出（`phase === 'idle'`）、插件卸载/DSH 重启（`dispose`）；
   - **立即清除索引强制新建**：用户在控制台点击「关闭」/「重置全部会话」、DSH 会话销毁（`session/disposed`）、权限或工作目录边界变更事件、回合中途异常崩溃。
3. **平滑降级闭环**：
   - 当命中有效索引、账号一致、工作目录与 `policyFingerprint` 完全一致且非 `forceNew` 时，调用 `client.sessionLoad(...)`；
   - 成功时标记 `created = false`、`session.resumed = true`，使 `AcpAdapter` 仅发送本轮新增用户消息，不重复注入 `<prior_conversation_digest>`；且在 `getOrCreateSession` 返回后才挂载本轮流式监听器，避免 `session/load` 历史回放帧混入当前轮输出；
   - 任一失败（RPC 报错、会话不存在、超时或进程退出）立即清理失效索引，在存活进程（或重建进程）上无感回落至 `session/new`（`created = true` + 24K 历史摘要）。

### 3.2 `config_option_update` 与 `session_info_update` 实时同步
- 会话建立或恢复后，由 `AcpSessionPool` 持有会话级 `client.onSessionUpdate(acpSessionId, ...)`：
  - `config_option_update`：同步更新 `session.configOptions`、`currentModel`、`currentEffort`、`currentMode` 及可选模型路由表，并触发 `emitStatus()`；
  - `session_info_update`：脱敏提取 `title` 更新 `session.title` 与 `SessionIndex`，触发 `emitStatus()`；
  - `usage_update`：在 `session/load` 阶段或回合间收到时即时刷新会话上下文占用读数。

### 3.3 `ReverseMcpBridge` 超时、并发上限与状态摘要
- **单次工具超时（`callTimeoutMs`）**：默认受 `Math.min(cfg.requestTimeoutMs, 120_000)` 约束（支持构造参数覆盖）；超时后立即 `abort()` 传给 `callTool` 的 `AbortSignal`，并返回 JSON-RPC 错误 `code: -32001`，不等待失控慢工具永久挂起。
- **最大并发保护（`maxConcurrentCalls`）**：默认单会话桥接上限 `8`；超出时立即拒绝并返回 JSON-RPC 错误 `code: -32005`。
- **可观测指标（`McpBridgeSnapshot`）**：汇总挂载桥接数、在途调用数、累计调用数、失败/超时数、最近调用工具名与经 `sanitizeDiagnosticText` 脱敏的最近错误，在控制台「桥接配置」卡片实时呈现。

---

## 4. 验证与测试矩阵

全部在本地离线环境通过 `pnpm run verify`（`lint:arch` + `tsc --noEmit` + `tsdown` + `node --test`）：
1. **`SessionIndex` 单元测试（`test/session-index.test.ts`）**：`0600` 原子写入、数量上限 LRU 淘汰、过期清理、损坏文件安全降级。
2. **`session/load` 恢复与降级 E2E（`test/adapter.e2e.test.ts`）**：
   - 空闲回收或跨池重启后命中 `session/load` 原生恢复上下文，验证不重复发送 `<prior_conversation_digest>`；
   - 权限策略变更、账号切换或对端 `session/load` 报错/不支持时 100% 平滑回落至 `session/new` + 24K 摘要；
   - `session/load` 期间服务端回放历史 `agent_message_chunk` 不污染本轮输出，回放 `usage_update` 正确恢复上下文占用。
3. **动态协议通知测试（`test/adapter.e2e.test.ts`）**：服务端主动推送 `config_option_update` 与 `session_info_update` 后，`pool.getStatus().sessions` 与 SSE 快照即时同步。
4. **反向 MCP 桥接健壮性测试（`test/phase2.test.ts`）**：慢工具超时触发 `AbortSignal` 并返回 `-32001`、超出并发上限返回 `-32005`、凭据错误脱敏及 `StatusSnapshot.mcpBridge` 指标与前端渲染验证。
