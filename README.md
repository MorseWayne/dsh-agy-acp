# dsh-agy-acp

新一代 **DeepSeek Harness (DSH) × Google Antigravity (`agy acp`)** 桥接插件，基于官方持久化 ACP JSON-RPC 2.0 长连接协议构建，提供实时原生工具卡片镜像、会话级权限沙箱对齐、出口地域合规防风控熔断、`session/load` 跨重启会话恢复、反向 MCP 桥接与多账号配额感知运维闭环。

## 安装与本地联调

需要 **Node.js >= 24** 以及已登录的 Antigravity CLI（`agy >= 1.5`）。

从 npm 安装到 DSH Web 配置：

```bash
dsh plugin --profile web add @morsewayne/dsh-agy-acp --registry=https://registry.npmjs.org
```

本地源码构建与链接调试：

```bash
pnpm install
pnpm run verify
dsh plugin --profile web add /path/to/dsh-agy-acp
```

启动或重启 `dsh web` 后，可在聊天框输入 `/agy-acp` 查看运行状态，或输入 `/agy-acp doctor` 执行一键只读环境自检。

---

## 核心特性

### 1. 持久 `agy acp` 长连接与 `session/load` 原生连续性
- **零冷启动长连接**（`src/acp/` + `src/runtime/session-pool.ts`）：按 DSH 会话与权限指纹维护长驻 `agy acp` 进程，动态同步 `model` / `thought_level` / `mode` 及 `config_option_update`、`session_info_update` 实时通知，支持 `AbortSignal` 毫秒级 `session/cancel`。
- **`session/load` 跨空闲与重启恢复**（`src/runtime/session-index.ts`）：轻量级索引持久化于 `~/.dsh/agy-acp/sessions.json`（`0600` 权限，上限 200 条、7 天自动过期，**不落盘任何对话正文或凭据**）。当空闲 TTL 回收或 DSH 重启后，若账号、工作目录与权限指纹未变且对端支持 `loadSession`，优先调用 `session/load` 原生恢复上下文与服务端 Prompt Cache；若不可用则无感降级至 `session/new` + 24K 预算制 `<prior_conversation_digest>` 摘要。
- **`options.system` 与只读辅助调用**：优先通过 `_meta.antigravity.systemPrompt.append` 注入宿主系统提示词并按哈希增量更新；针对标题生成、上下文压缩等 `options.purpose` 请求，使用独立只读沙箱、拒绝全部工具审批且不污染主会话池。

### 2. 实时工具流式镜像与全系原生卡片
- **增量工具聚合**（`src/provider/run-store.ts` + `src/provider/mirror-tool.ts`）：在工具进入 `in_progress` 时即向前端发射实时运行卡片，支持同轮并发工具批量发射与无序完成合并，原生投影 `terminal`、`diff`、`read`、`search`、`web`、`generic` 卡片。

### 3. 网络出口合规探测与防风控硬熔断（Egress Probe & GeoFence Guard）
- **与 Go `agy` 一致的代理探测**（`src/runtime/egress-guard.ts`）：零外部依赖，严格按 `NO_PROXY` → `HTTPS_PROXY` → `ALL_PROXY` → `HTTP_PROXY` 解析路由，原生支持 HTTP `CONNECT`（含 Basic Auth）、SOCKS5/SOCKS5H（RFC 1928/1929，`ATYP=0x03` 远端域名解析防本地 DNS 泄露）及直连/TUN 模式。
- **全 4 条出站链路统一守门**：覆盖主对话（含新建与长连接复用防漂移）、辅助调用、启动模型目录探测（地域阻断时自动暂停后台重试）与配额查询；当出口落入 `HK` / `CN` 等受限地区时**在本地直接硬熔断，零子进程启动、零流量发往 Google**。
- **多模式与漏网 400 瞬时熔断**：支持 `block`（默认）、`strict`、`warn`、`off` 四档策略；若缓存期内 VPN 瞬时漂移触发上游 Google `400 FAILED_PRECONDITION` 地域错误，立即作废缓存并触发 60 秒本地保护熔断与多账号池自动故障转移。

### 4. 配置原子持久化、多账号池与控制台 UI
- **配置持久化**（`src/runtime/config-store.ts`）：控制台修改的白名单运行项原子写入 `~/.dsh/agy-acp/config.json`（`0600` 权限），支持一键恢复默认。多账号敏感目录与代理（`accounts`、`credentialSlotDir`）仅由宿主配置只读管理。
- **多账号配额观测与可选配额感知调度**（`src/runtime/account-pool.ts` + `src/runtime/account-quota.ts`）：支持在只读沙箱中手动刷新 5 小时 / 7 天双窗口配额并展示 ≤15% 低配额预警；开启「配额感知多账号调度」开关后，将采集到的配额样本映射至 `MultiAccountPool` 权重，优先调度高余量账号。
- **前端单例 SSE 与主题适配**（`src/client/`）：模块级共享单条 `/plugins/agy-acp/events` 连接，全面接入 DSH `--dsw-alias-*` 浅色/深色主题令牌。

### 5. 会话级反向 MCP 桥接与 `/agy-acp` 诊断工具箱
- **反向 MCP 桥接加固**（`src/mcp/server.ts`）：通过 `session/new` / `session/load` 动态注入本机 `127.0.0.1` Bearer 鉴权桥接，不污染全局 `~/.gemini/config/mcp_config.json`；内置单次工具调用超时（触发 `AbortSignal` 中断慢工具并返回 `-32001`）与单会话并发上限保护（`-32005`）。
- **斜杠命令诊断**（`src/runtime/doctor.ts`）：
  - `/agy-acp`（或 `/agy-acp status`）：输出连接套餐、活跃/已索引会话、地域防护与配额调度状态、反向 MCP 统计、账号出口与 Token 概览；
  - `/agy-acp doctor`：执行只读 5 步自检（`agy` 可执行文件与版本、宿主只读沙箱强制约束、启用账号出口地域合规性、ACP 模型目录握手、本机持久化文件状态），全量输出经凭据与 IP 脱敏处理。

---

## 权限与安全不变量

权限策略始终归属发起请求的 DSH 会话（旧 `permissionMode` 已废弃，HTTP 接口不可覆盖会话权限）：

| 主会话选择 | `agy` 的执行与审批 |
| --- | --- |
| 仅可查看 | 从启动起使用 DSH 只读文件沙箱。已上报的读、搜索请求可放行，修改、命令和未知请求拒绝。 |
| 工作区内修改 | 使用会话的 `full` 工作区进程沙箱。经路径与 `realpathSync` 防软链逃逸校验的工作区内编辑/删除/移动，以及沙箱内常规终端命令自动放行；命中高危命令拦截（提权、高危删除、`git push`/`reset --hard`/`clean -f`、远端脚本执行、外网上传/远端主机、凭据读取、发包/部署等）、超长/未知命令或越界路径时交由 DSH 审批。 |
| 自动审查 | CLI 和账号提供原生 `auto` 时使用它；它仍上报的请求交给 DSH。没有原生 `auto` 时用 `default`，由 DSH 处理请求，不降级为自动同意。 |
| 完全权限 | 不包文件沙箱，但保留 ACP 权限回调，只批准本次操作，不写入 `always allow`。 |

受限模式（含目录探测、辅助调用、配额查询、`doctor` 自检）必须由宿主 `sandbox.confine` 返回 `enforcement === 'full'`；无法提供时直接拒绝启动，绝不无沙箱降级执行。

---

## 开发与验证

```bash
pnpm install
pnpm run verify   # lint:arch && tsc --noEmit && tsdown && node --test
```

## 发布到 npm

在准备发布的 `main` 分支上运行以下命令，GitHub Actions 将校验版本标签、执行 `pnpm run verify` 并发布构建包：

```bash
npm version patch   # 或 minor / major
git push --atomic origin main "v$(node -p "require('./package.json').version")"
```
