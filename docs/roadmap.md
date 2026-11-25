# `@morsewayne/dsh-agy-acp` 整体迭代路线图

- **更新日期**：2026-11-25
- **项目**：`@morsewayne/dsh-agy-acp`
- **架构基线**：严格遵守 [scripts/lint-arch.mjs](../scripts/lint-arch.mjs) 单向分层规则与既有安全不变量（权限归属 DSH 会话、受限模式必须完整沙箱、脱敏诊断、零明文凭据泄露）。
- **规划原则**：阶段一～三保持独立闭环，不在已有阶段规格上打补丁；所有新增系统能力均按职责边界规划为独立后续阶段（阶段四～六）。

---

## 1. 迭代全景总览

| 阶段 | 状态 | 规格文档 | 目标定位 | 目标里程碑 |
| --- | --- | --- | --- | --- |
| **阶段一** | ✅ 已完成（`7406eeb`） | [阶段一设计规格](./specs/2026-11-25-phase1-core-chat-and-tool-mirror-design.md) | 核心对话质量、实时工具流式镜像、五类原生卡片、`options.system` 透传、`options.purpose` 只读辅助调用、24K 上下文恢复 | `v0.2.0` |
| **阶段二** | ✅ 已完成（`7a6d2c1`） | [阶段二设计规格](./specs/2026-11-25-phase2-permissions-and-stability-design.md) | 结构化权限审批体验、`workspace-write` 真实路径防绕过、统一凭据脱敏、类型化 ACP 错误、僵尸会话自清理、首帧前断连重试 | `v0.2.0` |
| **阶段三** | ✅ 已完成（`0189a5c`） | [阶段三设计规格](./specs/2026-11-25-phase3-config-persistence-and-console-ui-design.md) | 配置白名单原子持久化与重置、模型目录代次隔离与强制刷新、前端单例 SSE 状态中心、DSH 官方主题适配与控制台升级 | `v0.2.0` |
| **阶段四** | 📋 规划完成（下一优先） | [阶段四设计规格](./specs/2026-11-25-phase4-egress-guard-design.md) | 网络出口合规探测与防风控本地硬熔断（Egress Probe & GeoFence Guard）、全四条出站链路守门、多账号避障与控制台可视化自检 | `v0.3.0` |
| **阶段五** | 📋 路线规划 | 待阶段四合入后起草 | ACP 协议能力深化（`session/load` 原生会话恢复、`config_option_update` / `session_info_update` 实时同步）与反向 MCP 桥接健壮化 | `v0.4.0` |
| **阶段六** | 📋 路线规划 | 待阶段五合入后起草 | 多账号配额感知调度闭环、`/agy-acp` 结构化诊断工具箱、文档与发布基线收口 | `v0.4.0` |

```mermaid
flowchart LR
  P1["阶段一\n核心对话与工具镜像\n(已完成)"]
  P2["阶段二\n权限体验与连接稳定\n(已完成)"]
  P3["阶段三\n配置持久化与控制台\n(已完成)"]
  P4["阶段四\n出口探测与防风控熔断\n(下一优先)"]
  P5["阶段五\n协议深化与会话连续性"]
  P6["阶段六\n运维闭环与诊断发布"]

  P1 --> P2 --> P3 --> P4 --> P5 --> P6
```

---

## 2. 已建立的基线与边界（阶段一～三）

阶段一～三共同构成 `v0.2.0` 的核心产品基线，解决“能对话、用得稳、可配置”三个基础层面：

1. **对话与工具层（阶段一）**：
   - `AcpRunRecording` 按 `toolCallId` 增量聚合，`AcpAdapter` 在工具进入 `in_progress` 时即切分 Span，支持同 Span 并发工具批量发射与 `detectContinuation` 游标对齐；
   - `agy_acp_tool` 支持 `terminal`、`diff`、`read`、`search`、`web`、`generic` 全系原生卡片及无 `meta` 降级；
   - 支持 `_meta.antigravity.systemPrompt.append` 透传与哈希增量更新、安全只读无工具 `runAuxiliaryPrompt` 辅助调用，以及 24,000 字符预算制 `<prior_conversation_digest>` 上下文恢复。
2. **安全与稳定性层（阶段二）**：
   - `src/common/sanitize.ts` 对 stderr、目录探测错误、账号错误执行先全量脱敏后尾部截断；
   - `permission-manager.ts` 移除 8KB 大文件静默拒绝，输出人类可读中文审批摘要，并对 `workspace-write` 实施多来源提取 + `realpathSync` 符号链接防绕过校验；
   - `AcpClient` 区分 `AcpRpcError` / `AcpTimeoutError` / `AcpProcessExitError`，健康长连接遇业务错误不误杀，空闲崩溃由 `onExit` 即时清理僵尸会话，首帧前崩溃静默重建重试 1 次。
3. **配置与控制台层（阶段三）**：
   - `ConfigStore` 原子落盘 7 项白名单配置并支持一键恢复默认，串行队列防并发写冲突；
   - `forceRefreshModels` 与 `catalogGeneration` 代次隔离防止过期目录探测回写；
   - 前端引入模块级单例 SSE 状态中心（`status-store.ts`）、DSH 官方 `--dsw-alias-*` 主题令牌（`theme.ts`）、模型下拉选择、诊断横幅与会话上下文进度条。

---

## 3. 阶段四：网络出口合规探测与防风控熔断体系（高优）

详细技术设计见独立规格文档：[2026-11-25-phase4-egress-guard-design.md](./specs/2026-11-25-phase4-egress-guard-design.md)。

### 3.1 解决的核心问题
在真实使用中，一旦代理节点落在中国香港（HK）等受限区域、代理分流遗漏 `*.googleapis.com`，或子进程未命中预期代理，就会在高频工具执行和后台辅助调用期间密集触发 Google 后端 `FAILED_PRECONDITION (400): User location is not supported for the API use`，不仅中断任务，还会持续向 Google 上报违规地域流量、显著拉高账号风控与封禁风险。

### 3.2 核心交付
- **与 `agy` 代理语义一致的出口探测器（`src/runtime/egress-guard.ts`）**：零新增外部依赖，按账号实际 `env` 中的 `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` / `NO_PROXY` 解析路由（原生支持 HTTP CONNECT、SOCKS5/SOCKS5H 远端 DNS 解析及直连/TUN 模式），杜绝 Node `fetch` 忽略代理导致的判定分叉。
- **全 4 条出站链路统一守门**：在 `AcpSessionPool` 层对主对话（`getOrCreateSession` & 复用会话首检）、辅助调用（`runAuxiliaryPrompt`）、模型目录探测（`probeCatalog`）与配额查询（`probeAccountQuota`）实施统一前置地域预检，命中受限区域时**在本地直接熔断，零数据包触达 Google**。
- **三层纵深防护**：
  1. 事前单飞探测 + 分态 TTL 缓存（日常命中 0ms 延迟）；
  2. 多账号池自动跳过出口受限账号，无缝故障转移至合规节点账号；
  3. 事中若因节点在 TTL 内漂移漏网触发 Google 400 地域报错，立即作废缓存、进入地域阻断状态并触发后台重测，阻断后续连续工具调用继续撞墙。
- **可控防护模式与前端可视化**：新增持久化配置 `geoFenceMode`（`block` / `strict` / `warn` / `off`，默认 `block`）；新增 `POST /plugins/agy-acp/accounts/egress/check`；`AccountCard` 展示脱敏出口 IP、归属地合规标签与一键「检测出口」按钮。

---

## 4. 阶段五：ACP 协议能力深化与跨会话连续性

### 4.1 解决的核心问题
当前代码在协议交互和工具桥接层面仍存在三处结构性断层：
1. `src/acp/protocol.ts` 已声明 `agentCapabilities.loadSession`，但 `AcpClient` 与 `AcpSessionPool` 尚未接入 `session/load`；每次空闲 TTL 回收、进程崩溃或 DSH 重启都只能重新 `session/new` 并用 24K 文本摘要拼接历史，导致上下文精度下降且服务端 Prompt Cache 完全失效。
2. `session/update` 中已定义的 `config_option_update` 与 `session_info_update` 尚未消费，当 `agy` 服务端动态更新可用选项、当前模型或思考档时，插件内存状态与控制台会出现漂移。
3. `ReverseMcpBridge`（`src/mcp/server.ts`）目前缺乏单次工具调用超时、并发上限和桥接运行态指标，在慢工具或异常重入场景下缺少防护与可观测性。

### 4.2 规划范围
- **`session/load` 原生恢复与轻量映射存储**：
  - 在 `src/acp/client.ts` 新增 `sessionLoad(...)`；
  - 新增轻量化会话索引（`~/.dsh/agy-acp/sessions.json`，仅保存 `dshSessionKey -> { acpSessionId, accountId, cwd, policyFingerprint, updatedAt }`，带数量上限与过期清理，不存对话内容）；
  - 重建会话时若对端声明 `loadSession === true` 且账号、工作区和权限指纹一致，优先尝试 `session/load`；任一失败即无感降级回 `session/new` + 24K 历史摘要。
- **协议通知实时同步**：
  - 在 `AcpAdapter` / `AcpSessionPool` 监听 `config_option_update`，同步刷新 `ManagedAcpSession.configOptions`、`currentModel`、`currentEffort`、`currentMode` 并触发 SSE 推送；
  - 按需消费 `session_info_update` 更新会话展示元信息。
- **反向 MCP 桥接健壮化**：
  - 为 `ReverseMcpBridge` 增加单次工具调用超时（可配置或受 `requestTimeoutMs` 约束）与最大并发呼叫保护；
  - 在 `StatusSnapshot` 扩展桥接摘要（挂载会话数、最近一次调用状态与脱敏错误），便于在控制台排查反向工具调用问题。

### 4.3 验收标准
- 支持 `loadSession` 的环境下，空闲回收或重启后能命中原 `acpSessionId` 恢复上下文；不支持或加载报错时 100% 平滑回落至 `session/new` + 摘要。
- 服务端推送 `config_option_update` 后，内存会话与控制台状态即时一致。
- 反向 MCP 慢工具超时后能正确中止 `AbortSignal` 并返回规范 JSON-RPC 错误，不泄漏挂起请求。

---

## 5. 阶段六：多账号生产化运维、诊断工具箱与发布基线

### 5.1 解决的核心问题
1. **配额观测与调度的断层**：`MultiAccountPool.updateQuota()` 已完整实现 5 小时/7 天双桶配额加权调度，但当前 `probeAccountQuota()` 仅将结果用于前端展示，未提供按需接入调度的开关与低配额预警。
2. **命令行排障能力薄弱**：`/agy-acp` 命令仅输出 8 行静态字段，缺少 `lastError`、出口地域状态、多账号健康详情、持久化覆盖状态与环境自检。
3. **文档与发布版本滞后**：`package.json` 停留在 `0.1.0`，`README.md` 尚未覆盖阶段一～五的新增特性、配置持久化路径与地域防护说明。

### 5.2 规划范围
- **多账号配额感知调度（显式可选）**：
  - 增加配置开关（默认保持保守的仅观测模式，避免未授权后台高频刷配额）；开启后，手动或按需采集到的配额样本按模型族映射回 `MultiAccountPool.updateQuota()`，并在剩余配额低于阈值时在控制台展示预警、优先路由至高余量账号。
- **结构化 `/agy-acp` 诊断工具箱**：
  - 丰富 `/agy-acp` 默认状态输出（包含出口合规概览、`lastError`、账号健康与持久化配置状态）；
  - 新增 `/agy-acp doctor`（或参数化子命令）执行一键只读自检：`agy` 可执行文件与版本、宿主只读沙箱可用性、当前出口国家/代理模式、模型目录连通性、配置文件合法性，全部输出经 `sanitizeDiagnosticText` 脱敏。
- **文档与版本化交付**：
  - 全面更新 `README.md` 与 `CHANGELOG.md`；
  - 按语义化版本推进发布验证流水线（`pnpm run verify` + 标签发布）。

---

## 6. 里程碑与依赖节奏

| 里程碑 | 包含阶段 | 准出条件 |
| --- | --- | --- |
| **`v0.2.0`** | 阶段一 + 阶段二 + 阶段三 | 阶段三前端与测试收口，`pnpm run verify` 全绿，DSH 本地构建安装回归通过 |
| **`v0.3.0`** | 阶段四 | 4 条出站路径全部受 `EgressGuard` 保护，HTTP/SOCKS5/直连探测单测与 E2E 熔断测试全绿，控制台可实时查看并重测出口 |
| **`v0.4.0`** | 阶段五 + 阶段六 | `session/load` 恢复与降级全覆盖、MCP 桥接超时与并发单测全绿、`/agy-acp` 诊断与 `README.md` 同步完成 |

---

## 7. 跨阶段全局架构不变量

所有后续阶段（阶段四～六）均必须遵守以下硬约束：
1. **单向分层与无环依赖**：严格通过 `pnpm run lint:arch`，新增逻辑不得打破 `common -> acp/mcp/runtime -> provider/transport -> index` 及 `client -> common` 边界。
2. **权限与沙箱不变量**：权限策略始终归属发起请求的 DSH 会话；受限模式（含目录探测、辅助调用、配额查询）必须由宿主 `sandbox.confine` 提供 `enforcement === 'full'`，绝不降级为无沙箱执行。
3. **零敏感信息泄露**：任何错误信息、SSE 快照、HTTP 响应与 `/agy-acp` 输出均不得暴露代理账号密码、Bearer Token、API Key、Cookie 或原始完整环境变量；出口 IP 默认脱敏展示。
4. **本地开发验证约定**：代码改动完成后均通过 `pnpm run verify` 全量校验，本地联调执行 `npm run build` 后由 DSH 插件管理器直接安装本地项目目录验证。
