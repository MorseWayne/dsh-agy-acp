# 阶段二设计规格：权限审批体验与连接容错稳定性

- **日期**：2026-11-25
- **项目**：`@morsewayne/dsh-agy-acp`
- **范围**：阶段二（结构化人类可读审批文案与大体积载荷处理、`workspace-write` 路径兜底与防绕过校验、类型化 ACP 错误与统一凭据脱敏诊断、僵尸会话 `onExit` 自清理、健康 `AcpRpcError` 进程保留与首帧前断连自动重建重试 1 次）
- **明确非目标（留待阶段三）**：
  - 配置持久化落盘、前端单例 SSE 连接与控制台 UI 重构（阶段三）

---

## 1. 目标与核心问题

阶段一补齐了实时工具卡片、系统提示词与安全辅助调用，但在真实使用中仍存在四类权限与稳定性硬伤：

1. **审批弹窗体验差且大文件直接静默拒绝**：`permission-manager.ts` 直接将未格式化的 `JSON.stringify(...)` 展示给用户，并且载荷超过 8192 字节时连弹窗都不弹直接 `denied()`，导致大文件编辑/写入静默失败。
2. **`workspace-write` 路径识别不完整**：当前仅检查 `req.toolCall.locations`，当 `agy` 将目标文件路径放在 `rawInput` / `args`（如 `Path`、`TargetFile`、`file_path`）而未填充 `locations` 时，工作区内正常编辑仍会频繁弹窗。
3. **非致命错误误杀持久进程 & 僵尸会话残留**：`adapter.ts` 在 `session/prompt` 发生任何错误（包括正常返回的 `AcpRpcError`）时都无条件 `invalidate(sessionKey)` 杀死 `agy acp` 进程，丢弃上下文与 Prompt Cache；同时 `AcpClient.onExit` 未接线到会话池，子进程空闲崩溃后会留下僵尸会话。
4. **错误诊断信息被吞掉且存在泄露风险**：`AcpClient` 虽缓存了 `stderrRing`，但进程退出/超时错误中未附带脱敏后的 `stderr`；`probeCatalog` 失败时用固定笼统提示覆盖了真实根因；`MultiAccountPool.reportFailure` 直接把原始 `error.message` 写入 `StatusSnapshot.accounts[].lastError`。

---

## 2. 架构约束与模块归属

严格遵守 [scripts/lint-arch.mjs](../../scripts/lint-arch.mjs) 单向分层规则：

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

- **统一诊断脱敏归属 `src/common/sanitize.ts`**：导出 `sanitizeDiagnosticText(raw: string, maxChars?: number): string`，供 `acp`（`client.ts`）、`runtime`（`session-pool.ts`、`account-pool.ts`）共同复用，完全满足单向分层且无循环依赖。
- **类型化错误归属 `src/acp/client.ts`**：导出 `AcpRpcError`、`AcpTimeoutError`、`AcpProcessExitError`。
- **必须保留的全部安全不变量**：
  - 审批放行结果唯一认可 `'allowed-once'`；
  - 审批期间策略变化或信号中止立即拒绝；
  - `read-only` 绝不弹窗询问写/执行操作，直接拒绝；
  - `auto` 残留请求交 DSH 询问，不自动同意；
  - 受限模式依旧要求宿主 `sandbox.confine` 返回 `enforcement === 'full'`；
  - 任何向外暴露的诊断文本（错误信息、`status.lastError`、`account.lastError`）均经 `sanitizeDiagnosticText` 处理，绝不泄露代理凭据、Token、API Key、Cookie 或原始完整环境变量。

---

## 3. 模块详细设计

### 3.1 统一诊断脱敏（`src/common/sanitize.ts`）

导出 `sanitizeDiagnosticText(raw: string, maxChars = 400): string`，**严格按以下顺序处理**（先对完整原文执行全部脱敏，再做尾部截断，杜绝先截断将凭据拦腰切开导致后半段绕过脱敏）：

1. **剥离控制字符**：去除 ANSI CSI/OSC 转义序列以及除 `\n`、`\r`、`\t` 外的不可见控制字符。
2. **全量凭据脱敏（均使用大小写不敏感标志 `/gi`）**：
   - **HTTP 认证与 Cookie 整行头**：
     - `\b(?:proxy-)?authorization\s*[:=]\s*[^\r\n"']+` → 保留头名并替换为 `[REDACTED]`；
     - `\b(?:set-)?cookie\s*[:=]\s*[^\r\n"']+` → 保留头名并替换为 `[REDACTED]`（避免多段 `Cookie: a=1; b=2` 漏脱敏后续段）。
   - **Bearer / Basic 凭证**：`\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}` → `$1 [REDACTED]`。
   - **URL 用户信息（同时覆盖 `user:pass@` 与单令牌 `token@`）**：`([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@` → `$1***@`。
   - **URL 查询参数中的敏感键**：`([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|secret|password|auth)=)[^&\s#'"]+` → `$1[REDACTED]`。
   - **环境变量与 JSON/KV 凭据（允许带前缀如 `GOOGLE_API_KEY`、`PROXY_PASSWORD` 及键名引号如 `"access_token": "..."`）**：
     - 匹配 `(^|[\s,{(\[;])(["']?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;\])}`"']+)` → 保留前缀与键名，值替换为 `[REDACTED]`。
   - **已知明文令牌特征**：
     - Google API Key `AIza[0-9A-Za-z_-]{20,}` → `[REDACTED]`；
     - Google OAuth `ya29\.[0-9A-Za-z._-]+` → `[REDACTED]`；
     - 通用 `sk-[A-Za-z0-9_-]{16,}`（覆盖 `sk-ant-...`、`sk-proj-...` 等）→ `[REDACTED]`；
     - JWT `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` → `[REDACTED]`。
3. **空白规范化与尾部截取**：将连续空白/多行折叠为紧凑单行（以单个空格或 ` | ` 连接），若长度超过 `maxChars`，取最后 `maxChars` 字符并在开头加 `...`（真实根因通常位于 stderr 尾部）。

同时在 `src/runtime/account-pool.ts` 的 `reportFailure` 中对写入 `acc.lastError` 的消息调用 `sanitizeDiagnosticText(message, 240)`，闭合状态快照防泄密链路。

---

### 3.2 权限审批摘要与防绕过路径校验（`src/runtime/permission-manager.ts`）

#### 1. `workspace-write` 目标路径严格校验（`extractEditTargets`）
在 `disposition(p, req)` 处理 `p.mode === 'workspace-write' && p.preset === 'workspace-write' && kind === 'edit'` 时，执行严格的 fail-closed 目标提取与真实路径校验：

1. **同时检查全部输入来源（绝不因 `locations` 存在或 `rawInput` 为 `{}` 而跳过其余来源）**：
   - 检查 `req.toolCall.locations`、`req.toolCall.rawInput` 与 `req.toolCall.args` 三者：
   - **校验 `locations`**：若 `locations !== undefined`，必须为数组且每个元素均须为非空 `path: string`（任一元素缺失/为空/非字符串立即 fail-closed 返回 `null` → `'ask'`）。
   - **校验 `rawInput` 与 `args`**：对每个非 `undefined` 的输入源：
     - 若不是普通对象（如字符串 patch、数组、原始值），立即 fail-closed 返回 `null` → `'ask'`；
     - 遍历对象的**全部键**，不做“命中首个键即停止”：
       - **已知单路径键集合**：`Path`、`TargetFile`、`AbsolutePath`、`file_path`、`filePath`、`path`、`File`、`file`。只要键出现且值非 `undefined`，值**必须是非空字符串**（否则立即 fail-closed 返回 `null`），并加入目标列表。
       - **已知多路径数组键集合**：`files`、`paths`、`targets`、`file_paths`、`filePaths`。只要键出现且值非 `undefined`，值必须为非空数组，且**每一个元素**都必须是合法非空字符串或仅通过上述单路径键可识别的普通对象（若混入数字、空串、未知结构对象立即 fail-closed 返回 `null`）。
       - **未解析的补丁/多目标/疑似路径键黑名单检测**：对于任何不在已知单/多路径键内、也不在已知纯内容/编辑元数据键（如 `Target`、`Replacement`、`TargetContent`、`ReplacementContent`、`ReplacementChunks`、`chunks`、`old_string`、`new_string`、`oldText`、`newText`、`Content`、`CodeContent`、`content`、`StartLine`、`EndLine`、`EmptyFile`、`Description`、`description`、`AllowMultiple`、`Overwrite`、`Append`）中的键，只要键名匹配疑似路径或补丁语义（`/(?:path|file|dir|root|dest|target|source|src|from|to|patch|diff|edits|changes|rename|move)/i`），**一律 fail-closed 返回 `null` → `'ask'`**，彻底杜绝 `apply_patch` / 多文件 diff / 未知路径键绕过。
2. **符号链接安全的真实路径包含检查（`isWithinRoots`）**：
   - 目标路径列表必须非空；任意路径若包含 `\0` 字节直接判定越界。
   - 定义 `resolveRealPath(targetPath)`:
     - 先 `path.resolve(targetPath)`；
     - 尝试 `realpathSync`；若目标文件尚未创建（`ENOENT`），沿 `path.dirname` 向上找到最近的已存在祖先目录做 `realpathSync`，再把剩余子路径段拼回（若祖先链解析失败则直接 fail-closed 返回 `false`）。
   - 对每个允许根目录 `[p.workspaceRoot, ...(p.additionalWritableRoots ?? [])]` 先执行 `resolveRealPath(path.resolve(root))`；
   - 对提取出的**每一条去重目标路径**，先按 `path.resolve(p.workspaceRoot, target)` 解析，再经 `resolveRealPath` 规范化，验证对至少一个已规范化根目录满足：`!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)`（且 Windows 忽略盘符/路径大小写差异）。
   - 仅当全部目标路径均通过真实路径包含校验时返回 `'allow'`；否则返回 `'ask'` 交由 DSH 弹窗审批。

#### 2. 结构化人类可读审批文案（`formatApprovalReason`）
取代原本 `JSON.stringify(...)` + `details.length > 8192` 静默拒绝的逻辑，始终生成清晰可读的中文审批文案（确保 `reason` 中保留 `req.toolCall.kind` 原词如 `execute`/`edit` 兼容审计与现有测试）：
- **`execute`（命令执行）**：
  - 提取命令（`CommandLine` / `command` / `cmd` / `script`）、结构化参数数组（`args` / `argv` / `Args`）、工作目录（`Cwd` / `cwd` / `workdir` / `workingDirectory`）与标题。
  - 若同时存在命令与 `args`/`argv` 数组，将其格式化并完整拼接展示（例如 `bash ["-c", "rm -rf /"]`），绝不隐藏命令参数造成误导。
  - 若命令及参数总字节数 ≤ `16_384`：完整展示。
  - 若 > `16_384`：展示前 8,000 字符 + `\n...（省略中间内容）...\n` + 后 4,000 字符，并醒目标注 `⚠️ 命令超长已截断（共 ${bytes} 字节），请谨慎确认`。
  - 若未提取到任何命令字段：回退展示格式化后的参数摘要（≤ 4,000 字符，超长标明总字节数与截断提示），绝不展示空白命令。
- **`edit`（文件编辑/写入）**：
  - 完整列出所有可提取到的目标路径（绝不截断路径列表）。
  - 提取变更内容（单处替换 / 多块替换 `ReplacementChunks` / 整文件写入 `Content`/`CodeContent`/`content`），统计总字节数、总行数或替换块数。
  - 展示可读内容预览（总上限 2,000 字符；超出时保留前 1,200 字符 + `\n...（已截断预览，共 ${bytes} 字节 / ${lines} 行）...\n` + 后 400 字符）。
  - **彻底移除 >8KB 静默拒绝**，所有大文件编辑正常弹窗交由用户决策。
- **其他类型（`delete` / `move` / `fetch` / `other`）**：
  - 展示工具名、类型（`kind`）、标题、目标路径或 URL（若有），以及精简格式化的参数摘要（上限 4,000 字符，超长标明总字节数与截断提示）。

---

### 3.3 类型化 ACP 错误与完整退出清理（`src/acp/client.ts`）

#### 1. 三类显式错误
- `AcpRpcError`（保留）：对端通过 JSON-RPC 正常返回的业务错误（`code`, `message`, `data`）。
- `AcpTimeoutError extends Error`（新增）：含 `readonly method: string`、`readonly timeoutMs: number`、`readonly stderrTail: string`；消息格式含方法名、超时毫秒数及脱敏 `stderrTail`（若有）。
- `AcpProcessExitError extends Error`（新增）：含 `readonly code: number | null`、`readonly signal: NodeJS.Signals | null`、`readonly stderrTail: string`、`readonly causeError?: string`；消息清晰反映退出的 `code`/`signal` 或 spawn/pipe 错误原因（如 `ENOENT`/`EACCES`/`EPIPE`）以及脱敏后的 `stderrTail`（若有）。

#### 2. `stderr` 排空、`stdin` 防崩、`dispose` 隔离与防重入退出处理
- **限制 `stderrRing` 内存上限**：除保留最多 50 块外，增加总字节上限 64KB（超出时从头部裁剪），防止异常子进程疯狂刷 stderr 撑爆内存。
- **`child.stdin` 错误保护**：在 `start()` 中注册 `child.stdin.on('error', () => {})`，避免子进程突发退出时 `notify()` / `writeResponse()` / `writeError()` 触发未捕获 `EPIPE` 异常崩溃宿主；在 `request()` 的 `stdin.write` 回调收到 `err` 时，若 `!this.disposedByCaller`，构造 `AcpProcessExitError`（附带 `causeError: err.message` 与脱敏 `stderr`）拒绝该 pending 请求。
- **主动销毁标记 `disposedByCaller`**：
  - `dispose()` 立即设置 `this.disposedByCaller = true`、`this.closed = true`，向所有 pending 请求抛出普通 `new Error('AcpClient disposed')`（**绝不是 `AcpProcessExitError`**），杀死子进程并清空监听；
  - 一旦 `disposedByCaller === true`，后续异步到达的 `child` `exit`/`close`/`error` 事件直接忽略，**绝不再回调 `opts.onExit`**。
- **统一单次退出结算（`settleProcessTermination`）**：
  - 维护 `exitSettled = false` 防重入标志；
  - 监听 `child.on('close', (code, signal) => ...)` 作为正常退出结算点——Node.js 保证 `close` 在 `stdout` 与 `stderr` stdio 管道全部排空后才触发，确保最后一行 `stdout` 响应和完整 `stderrRing` 均已收集完毕后再构造 `AcpProcessExitError`、拒绝剩余 pending 并触发 `opts.onExit?.(code, signal, this)`；
  - 同时在 `child.on('exit', ...)` 时立即标记 `this.closed = true`（确保 `isRunning` 立刻变为 `false`，不再接收新请求），并启动一个短兜底定时器（如 250ms，`unref()`）以防极少数孙进程继承 stdio 导致 `close` 迟迟不触发，定时器到期后强制结算并关闭 `rl`；
  - 在 `child.on('error', (err) => ...)`（如 `ENOENT` / `EACCES` 等 spawn 失败）中同样通过 `settleProcessTermination(null, null, err)` 完整置 `closed = true`、清理 `child`/`rl`、以含 `causeError: err.message` 的 `AcpProcessExitError` 拒绝所有 pending 并单次回调 `opts.onExit`。

---

### 3.4 僵尸会话自清理与精准目录错误诊断（`src/runtime/session-pool.ts`）

#### 1. `onExit` 主动清理僵尸会话
- `newClient(...)` 增加可选 `onExit?: (code: number | null, signal: NodeJS.Signals | null, client: AcpClient) => void` 并透传给 `AcpClient`。
- 在 `getOrCreateSession(...)` 创建会话专用客户端时绑定 `onExit: (code, signal, exitedClient) => { ... }`：
  - **严格实例匹配守卫**：`if (this.clients.get(key) !== exitedClient) return`（利用 `exitedClient` 形参而非外层可能尚未赋值的 `let client`，彻底杜绝 `initialize()` 期间退出导致的 `undefined === undefined` 误清理）。
  - 命中后同步执行：
    - `this.clients.delete(key)`、`this.sessions.delete(key)`、`this.policies.delete(key)`；
    - 若存在 `this.active.get(key)` 则 `controller.abort(); settle(); this.active.delete(key)`；
    - 调用 `this.deps.onSessionClosed?.(key)` 释放关联 `ReverseMcpBridge`；
    - 记录日志并调用 `this.emitStatus()`，控制台会话数立即归零。
- 同步加固 `invalidate(key)` 与 `resetAllSessions()`：判定存在性时额外包含 `this.clients.has(key)` / `this.clients.keys()`，且先删除 Map 引用再调用 `client.dispose()`。

#### 2. `probeCatalog` 精准可排障 `lastError`（`formatCatalogProbeError`）
在 `refreshModels` 失败分支用 `formatCatalogProbeError(err)` 替代写死文案，输出清晰、脱敏、可定位的中文错误：
- 找不到二进制（`/binary not found|ENOENT/i`）：`'未找到 agy 可执行文件，请检查 PATH 或插件配置中的 agyBin 路径。'`
- 宿主只读沙箱受限（`/refusing unconfined startup/i`）：`'宿主只读沙箱不可用（未满足完整受限约束），已拒绝无沙箱探测模型目录。'`
- `AcpTimeoutError`：`'ACP 模型目录探测超时，请检查 agy CLI 登录状态或网络连接。'` + 脱敏 `stderrTail`（若有）
- `AcpProcessExitError`：若 `causeError` 非空优先展示 `sanitizeDiagnosticText(causeError, 160)`，否则展示 `'ACP 模型目录探测进程异常退出（code=..., signal=...）'` + 脱敏 `stderrTail`（若有）
- 空目录（`/empty ACP model catalog/i`）：`'agy 返回了空的 ACP 模型目录，请检查当前账号登录状态。'`
- 其他错误：`'ACP 模型目录探测失败：'` + `sanitizeDiagnosticText(err.message, 200)`。

---

### 3.5 健康长连接保留、锁顺序修复与首帧前断连重试（`src/provider/adapter.ts`）

#### 1. 同步释放活动锁（消除 `turn.finish()` 微任务竞态）
在 `AcpAdapter.stream()` 中为每轮 `sessionPrompt` 定义幂等 `cleanupTurn()`（执行 `turn.finish()`、`unsubscribe()`、`rec.setCancelHandler(null)`、`options.signal?.removeEventListener('abort', onAbort)`）：
- 在 `.then(...)` 中：**先调用 `cleanupTurn()`，再调用 `rec.finish(...)`**；
- 在 `.catch(...)` 中：**先按条件决定是否 `invalidate`，再调用 `cleanupTurn()`，最后调用 `rec.fail(error)`**；
- `.finally(() => cleanupTurn())` 兜底。
确保消费者收到错误或完成事件后立即发起下一轮请求时，`active` 锁已同步释放，不会误撞 `ACP session already has an active turn`。

#### 2. 精确判定连接保留 vs 销毁
在 `.catch((err) => ...)` 中：
- 仅当 `this.deps.pool.owns(session)` **且** `(!client.isRunning || err instanceof AcpTimeoutError || !(err instanceof AcpRpcError))` 时，调用 `this.deps.pool.invalidate(sessionKey)`。
- 当 `err instanceof AcpRpcError && client.isRunning` 时：**保留长连接与会话上下文**，不杀进程。

#### 3. 重试循环重构（429 账号转移 + 首帧前断连重建重试 1 次）
将原固定 `for (let attempt = 0; attempt < maxAttempts; attempt++)` 重构为清晰的状态驱动循环，解决 `triedAccounts` 与 `crashRetried` 的相互作用：
- 状态变量：`const triedAccounts = new Set<string>()`，`let crashRetried = false`，`const maxAccounts = Math.max(1, cfg.accounts.filter(a => a.enabled !== false).length || 1)`。
- **关键修正**：`triedAccounts.add(session.accountId)` **仅在触发 429/配额故障转移时加入**，不在发起请求前提前加入！这样首帧前崩溃重试时可复用当前同一账号重建，单账号与多账号池均不会误排除唯一健康账号。
- **覆盖 `syncSessionOptions` 阶段的隐蔽断连**：若复用持久会话在 `syncSessionOptions(...)` 阶段抛出 `AcpProcessExitError`（例如子进程刚刚退出但 `close` 尚未派发，或写入触发 `EPIPE`）：
  - 销毁该故障会话（`if (this.deps.pool.owns(session)) this.deps.pool.invalidate(sessionKey)`）；
  - 若 `!crashRetried && !options.signal?.aborted`，置 `crashRetried = true`、`continue` 立即重建重试 1 次；否则向上抛错。
- **覆盖 `sessionPrompt` 首帧前断连**（定义与既有 429 转移一致：即 `firstItem = await rec.waitFor(0, options.signal)` 为 `error` 项）：
  1. 若 `isQuotaOrRateLimitError(firstItem.error)` 且 `!options.signal?.aborted`：
     - 执行 `triedAccounts.add(session.accountId)`；
     - 若 `triedAccounts.size < maxAccounts`：记录日志、`await this.deps.pool.closeSession(sessionKey)`、`continue` 故障转移到备用账号。
  2. 否则，若 `firstItem.error instanceof AcpProcessExitError` 且 `!crashRetried` 且 `!options.signal?.aborted`：
     - 置 `crashRetried = true`；
     - 记录日志、`await this.deps.pool.closeSession(sessionKey)`、`continue` 静默重建会话（自动携带阶段一 24K 历史摘要与系统提示词）重试 1 次。
  3. 其余情况（包含 `AcpTimeoutError`、`AcpRpcError`、流式输出中途断连或已耗尽重试次数）：直接交由 `driveRecording` 输出结果或错误，绝不重复执行。

---

## 4. 错误处理与边界矩阵

| 场景 | 预期行为 |
| --- | --- |
| `workspace-write` 编辑 50KB 文件，仅在 `rawInput.Path` 给出工作区内路径 | 真实路径校验通过，自动放行（OS 沙箱仍硬隔离），无需弹窗 |
| `workspace-write` 编辑同时带 `locations: ['src/a.ts']` 与 `rawInput.TargetFile: '../outside'` | 全部路径合并校验发现越界，转交 DSH 弹窗审批 |
| `workspace-write` 编辑指向工作区内符号链接 `link -> /etc` 下的 `link/passwd` | `realpathSync` 穿透识别位于工作区外，转交 DSH 弹窗审批 |
| `workspace-write` 编辑包含 `patch` / `edits` / 非字符串数组项 | fail-closed 转交 DSH 弹窗审批 |
| 编辑 50KB 文件需要弹窗审批 | 展示完整路径、总字节数/行数与可读预览，**不再静默拒绝** |
| 执行 `{ command: 'bash', args: ['-c', 'rm -rf /'] }` 需审批 | 命令与 `args` 完整一并展示，绝不隐瞒参数 |
| 执行 25KB 超长命令需审批 | 展示首尾预览并醒目警告 `命令超长已截断（共 N 字节）` |
| `session/prompt` 返回正常 `AcpRpcError`（子进程存活） | 保留长连接与上下文，同步释放 `active` 锁，下轮直接复用原会话 |
| `session/prompt` 发生 `AcpTimeoutError` | 销毁进程，**绝不自动重试**，错误信息附带脱敏 stderr |
| 已有会话在 `syncSessionOptions` 或首帧前发生 `AcpProcessExitError` | 清理故障进程并以同账号静默重建重试 1 次（带 24K 历史摘要）；若再次失败则上报带脱敏 stderr 的清晰错误 |
| 流式输出文本后子进程中途崩溃 | 已经过首帧（不重试），清理进程并 yield `finish(error)` |
| 空闲子进程被外部杀死 | `close` 结算触发 `onExit`，立即清理僵尸会话与 MCP 桥并推送状态更新 |
| `dispose()` 主动关闭客户端 | 设置 `disposedByCaller`，绝不触发 `onExit` 也不产生 `AcpProcessExitError` |
| `stderr` 含 `GOOGLE_API_KEY=...`、`Cookie: a=1; b=2`、`https://tok@proxy`、JSON `"access_token"` | 经 `sanitizeDiagnosticText` 先全量脱敏再截取尾部，零明文泄露 |

---

## 5. 验证与测试矩阵

需全部通过 `pnpm run verify`（`lint:arch` + `tsc --noEmit` + `tsdown` + `node --test`），覆盖以下新增与既有测试：

1. **统一脱敏测试（`test/core.test.ts`）**：
   - 验证大小写不敏感、带前缀环境变量（`GOOGLE_API_KEY`、`PROXY_PASSWORD`）、JSON `"access_token"`、多段 `Cookie: a=1; b=2`、`Authorization: Bearer ...`、URL `user:pass@` 与 `token@`、Query `?key=...`、`sk-ant-...`、JWT、ANSI 转义码全部脱敏；
   - 验证先全量脱敏再截断尾部（位于截断边界处的长 Token 不会泄露后半段）。
2. **权限审批与防绕过路径校验（`test/session-permissions.test.ts`）**：
   - `workspace-write` 仅在 `rawInput.Path` / `file_path` 给出工作区内路径时自动放行；
   - 混合冲突（`locations` 在内但 `rawInput.TargetFile` 在外）、畸形数组项（`['src/a.ts', 123]`）、疑似补丁键（`{ Path: 'src/a.ts', patch: '...' }`）、以及工作区内指向外部的真实符号链接均必须 fail-closed 走 `ask`；
   - >8KB 大文件写入不再静默拒绝，调用 `ask` 且审批文案展示完整路径、字节/行数与预览；
   - `{ command: 'bash', args: ['-c', 'echo hi'] }` 在审批文案中完整展示 `args`；>16KB 超长命令包含显式截断警告；
   - 既有安全不变量测试全绿。
3. **错误分级、目录诊断与账号快照脱敏（`test/catalog-recovery.test.ts`、`test/phase3.test.ts`）**：
   - `probeCatalog` 分别在缺二进制、半沙箱、带敏感 stderr 的进程退出、超时场景下产生清晰且脱敏的 `status.lastError`；
   - `MultiAccountPool.reportFailure` 写入 `acc.lastError` 的错误文本已脱敏。
4. **连接保留、僵尸清理与首帧前自动重试（`test/adapter.e2e.test.ts` + `test/fixtures/fake-agy.mjs`）**：
   - 正常 `AcpRpcError` 后会话进程保持存活，且紧接着发起的下一轮立即复用同一 `sess_1`（无 `active turn` 锁竞态）；
   - `AcpTimeoutError` 后进程被立即销毁且绝不自动重试；
   - 首帧前子进程崩溃（含带敏感 stderr）自动静默重建并重试 1 次成功（新会话收到历史摘要），连续崩溃 2 次则报错并附带脱敏 stderr；
   - 复用会话在 `syncSessionOptions` 阶段遇到子进程断连也能触发 1 次重建重试；
   - 空闲子进程意外退出后 `onExit` 立即清理僵尸会话（`activeSessions === 0`），下轮可无缝重建；
   - 既有 429 多账号自动故障转移测试保持全绿。
