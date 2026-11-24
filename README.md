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
- **扩展预留**：`AccountProvider` 接口已预留在 `src/common/types.ts`，后续可无缝挂载多账号池化、配额监控与故障转移。

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
