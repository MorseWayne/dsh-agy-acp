# dsh-agy-acp

新一代 **DeepSeek Harness (DSH) × Google Antigravity** 桥接插件，融合了 **T3 Code 的 `agy acp` 长连接协议驱动** 与 **`dsh-agy-link` 的 DSH 原生工具镜像及分层架构**。

## 安装

需要 Node.js 24 或更高版本，以及已登录的 Antigravity CLI（`agy`）。在 DSH 的 Web 配置中安装插件：

```bash
dsh plugin --profile web add @morsewayne/dsh-agy-acp --registry=https://registry.npmjs.org
```

重新启动 `dsh web` 后，使用 `/agy-acp` 查看插件状态。

## 核心设计

- **持久 `agy acp` JSON-RPC 2.0 长连接**（`src/acp/` + `src/runtime/session-pool.ts`）：告别每轮对话拉起 `agy -p` 子进程的冷启动开销；动态同步 `model` / `thought_level` / `mode`；支持 `AbortSignal` 触发毫秒级 `session/cancel`。
- **原生多模态与精确计量**（`src/provider/prompt-builder.ts` + `src/provider/adapter.ts`）：直接使用 ACP `image` content block 传递图片，直接映射精确的 `inputTokens` / `cachedReadTokens` / `reasoningTokens`。
- **DSH 原生工具卡片镜像**（`src/provider/mirror-tool.ts` + `src/provider/run-store.ts`）：保留 Span 切分与 `agy_acp_tool` 镜像，利用 ACP `tool_call_update` 原生携带的完整 `rawInput` / `rawOutput` 渲染工具卡片，无需反查本地 DB。
- **SSE 实时推送**（`src/transport/sse.ts` + `src/client/index.ts`）：通过 `/plugins/agy-acp/events` 实时向前端推送连接与会话状态，替代轮询。
- **账号与配额**：会话按实际租约标明账号，账号卡分别展示本地路由冷却和上游配额。两者不共用状态。

## 上下文与推理强度

- 对话标题栏 **AGY·ACP** 显示本会话最近一次 ACP 上下文读数；悬停可见容量和占比，点击可在控制台查看。未收到 `usage_update` 时显示「待上报」，不把缺失值当成 0。DSH 自带的上下文压力指标按请求用量计算，不一定与 ACP 内部占用相同；插件在后续解析同一模型时优先使用 ACP 报告的窗口容量。
- 工具卡片是同一个 ACP 请求的中间步骤，不单独计费。请求结束时才向 DSH 上报实际用量，非缓存输入、缓存读取、缓存写入分开统计。
- **先选模型，再调强度**：当 ACP 提供基础模型及其推理档位时，DSH 模型列表只展示一行。选中后点击输入框旁的推理等级即可切换，不需要换模型。旧配置中的 `-high`、`-xhigh` 等固定变体仍可由适配器解析，但不会作为独立选项列出。可选值按模型目录提供，`Extra` 对应 `xhigh`。未显式选择时，先取该模型支持的插件默认值，再取 ACP 公布的初始档位；仅有变体列表时优先取已公布的 High、Medium、Low。不会沿用上一轮的手动覆盖。

## 在控制台查看账号

打开对话标题栏的 **AGY·ACP** 或设置里的 **Antigravity ACP**。未配置账号池时，卡片显示「本机默认账号」：这是 CLI 的运行环境，不代表插件验证过登录、邮箱或套餐。配置多个账号时，会话行显示实际使用的账号，包括故障转移后的新归属。租约数不是正在对话的会话数。

- **本地路由冷却**按模型族展示截止时间；「清除本地冷却」不会改变服务端配额。
- **刷新配额**只查询所点的账号，在宿主只读约束中运行 `agy -p /usage --output-format stream-json`。按 CLI 原始分组展示 5 小时和 7 天剩余量、重置时间及上次成功采集时间。无读数不等于 0%，窗口已过期也不等于已经补满。刷新失败保留上次成功结果；数据仅在内存中保存，不参与账号调度。
- **账号环境无法区分时不会查询。** 多账号需要各自独立的 `homeDir` 和凭据路径，以及对应 CLI 的文件凭据模式（支持该模式的 agy 版本、已有 SSH 登录环境，或 Linux 上显式隔离的私有凭据总线）。只有代理、共享 HOME 或公共桌面钥匙串不能作为账号标识。插件不会伪造 SSH 标记、读取 token 或切换登录来取得配额。未配置账号池或单个使用宿主环境的账号可直接查询。

## 权限：跟随发起请求的 DSH 会话

只在 DSH 聊天框选择权限。旧的 `permissionMode` / `DSH_AGY_ACP_MODE` 不再生效，插件不再弹出自己的审批窗口。不同 DSH 会话不共用执行进程；权限或工作目录改变时，插件停止该会话的 ACP 进程，下一轮按新策略重建。

| 主会话选择 | `agy` 的执行与审批 |
| --- | --- |
| 仅可查看 | 从启动起使用 DSH 只读文件沙箱。已上报的读、搜索请求可放行，修改、命令和未知请求拒绝。 |
| 工作区内修改 | 使用会话的工作区沙箱。目标明确且位于允许根目录的编辑请求可自动放行；命令等请求交给 DSH 审批。允许一次不会扩大文件系统边界。 |
| 自动审查 | CLI 和账号提供原生 `auto` 时使用它；它仍上报的请求交给 DSH。没有原生 `auto` 时用 `default`，由 DSH 处理请求，不降级为自动同意。这不是把原生工具重跑一遍 DSH 的工具审查器。 |
| 完全权限 | 不包文件沙箱，但保留 ACP 权限回调，只批准本次操作，不写入 `always allow`。 |

受限模式需要宿主 `sandbox.confine` 返回完整的执行约束；无法提供时拒绝启动，绝不无沙箱重试。沙箱约束的是文件操作，不是断网或容器。没有 DSH 会话身份、找不到权限服务、审批超时或取消，都不会转成允许。反向 MCP 启用时，仅在对应会话的活动请求中向该会话的 DSH 工具分发。`workspaceRoot` 可用于模型目录探测，不能覆盖会话的可写范围。

## 开发与验证

```bash
pnpm install
pnpm run verify   # tsc --noEmit && tsdown && node --test
```

## 发布到 npm

在准备发布的 `main` 分支上运行以下命令。`npm version patch` 会更新补丁版本、提交并创建对应的 `vX.Y.Z` 标签。

```bash
npm version patch
git push --atomic origin main "v$(node -p "require('./package.json').version")"
```

GitHub Actions 会校验标签与包版本，运行完整检查，并将本次构建的安装包发布到 npm。正式版使用 `latest`，预发布版（例如 `v0.2.0-beta.1`）使用 `next`。在 Actions 页面手动运行 **Publish to npm** 可以仅验证并打包。
