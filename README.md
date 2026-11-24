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
