# 阶段三设计规格：配置原子持久化与前端控制台升级

- **日期**：2026-11-25
- **项目**：`@morsewayne/dsh-agy-acp`
- **范围**：阶段三（运行配置原子持久化与重置、强制刷新模型目录端点、前端模块级单例 SSE 状态中心、DSH 官方主题变量适配、模型下拉选择、诊断横幅与会话/表单交互升级）
- **明确非目标**：
  - 多账号配置（`accounts`、`homeDir`、`proxyUrl`、`env`、`credentialSlotDir`）仍由 `cordis.patch.yml` / 宿主配置只读管理，不开放本地 HTTP 接口修改账号凭据目录或任意环境变量。

---

## 1. 目标与核心问题

经过阶段一与阶段二的后端改造后，配置与前端控制台仍存在以下体验缺陷：

1. **配置修改重启即丢失**：`src/index.ts` 的 `onConfigPatch` 仅修改内存变量 `cfg`，DSH 重启或插件重载后所有修改全部还原，且前端未提供重置回默认值的入口。
2. **SSE 长连接随组件实例膨胀**：`src/client/index.ts` 的 `useAgyAcpStatus()` 每次挂载都独立创建一条 `EventSource('/plugins/agy-acp/events')`；顶栏徽标、设置页、弹窗或插件配置页同时存在时会占用多条浏览器同源并发连接。
3. **浅色主题违和与 UI 粗糙**：控制台弹窗写死 `#18181b` / `#f4f4f5` 深色样式，未接入 DSH 官方 `--dsw-alias-*` 主题变量；默认模型明明已有 `status.models` 却仍是纯文本输入框；无法在 UI 中调整超时/空闲 TTL、查看 `status.lastError` 排障信息或手动触发模型目录刷新；保存配置后也未即时将返回快照同步回全局状态。

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

新增与共享模块归属：
- `src/common/types.ts` & `src/common/config.ts`：定义 `PersistedConfigPatch`、配置取值上下限常量及共用校验辅助（`common` 层无外部依赖，同步对齐 `resolveConfig` 的超时上下限）。
- `src/runtime/config-store.ts`：配置原子持久化读写、字段白名单校验与重置（仅依赖 `node:*` 与 `src/common/`，与 `session-pool.ts` 互不引用）。
- `src/client/status-store.ts`：前端单例 SSE + `StatusSnapshot` 状态中心（仅依赖 `src/common/` 与 `src/client/snapshot-state.ts`）。
- `src/client/theme.ts`：DSH 官方 `--dsw-alias-*` 主题样式令牌（纯样式对象，零外部依赖）。

---

## 3. 模块详细设计

### 3.1 配置白名单与原子持久化（`src/common/config.ts`、`src/runtime/config-store.ts`、`src/index.ts`）

#### 1. 持久化字段白名单与严格校验
在 `src/common/types.ts` 定义 `PersistedConfigPatch`，在 `src/common/config.ts` 导出共享范围常量与校验函数：

```ts
export interface PersistedConfigPatch {
  mcpBridge?: boolean
  defaultModel?: string
  defaultEffort?: string
  agyBin?: string
  workspaceRoot?: string
  sessionIdleTtlMs?: number
  requestTimeoutMs?: number
}

export const SESSION_IDLE_TTL_MIN_MS = 60_000        // 1 分钟
export const SESSION_IDLE_TTL_MAX_MS = 86_400_000    // 24 小时
export const REQUEST_TIMEOUT_MIN_MS = 10_000         // 10 秒
export const REQUEST_TIMEOUT_MAX_MS = 3_600_000      // 60 分钟
```

字段校验规则：
- `mcpBridge`：必须是 `boolean`。
- `agyBin` / `workspaceRoot` / `defaultModel`：必须是 `string`（自动 `.trim()`），长度 ≤ 2048，禁止包含任何 ASCII 控制字符（`/[\u0000-\u001f\u007f]/`）。
- `defaultEffort`：必须是 `string`（自动 `.trim()`），为空字符串 `""` 或匹配 `/^[a-zA-Z0-9._-]{1,64}$/`（防止换行、空白或无效长文本写入后卡死前端表单）。
- `sessionIdleTtlMs`：必须是安全整数，范围 `[SESSION_IDLE_TTL_MIN_MS, SESSION_IDLE_TTL_MAX_MS]`。
- `requestTimeoutMs`：必须是安全整数，范围 `[REQUEST_TIMEOUT_MIN_MS, REQUEST_TIMEOUT_MAX_MS]`。
- 同步调整 `resolveConfig` 对 `sessionIdleTtlMs` / `requestTimeoutMs` 取整并限制在合法区间内，确保前后端基线一致。

#### 2. 路径解析与原子持久化（`src/runtime/config-store.ts`）
- **路径解析**：
  - 优先采用构造参数 `filePath`，其次 `process.env.DSH_AGY_ACP_CONFIG_PATH?.trim()`，默认 `path.join(os.homedir(), '.dsh', 'agy-acp', 'config.json')`。
  - 若路径含控制字符（含 `\0`），拒绝并回退默认路径或抛错；统一 `path.resolve` 规范化。
- **`load()`**：
  - 标记 `loaded = true`；文件不存在（`ENOENT`）时置 `persisted = {}` 并返回 `{ patch: {}, exists: false }`。
  - 读取前先 `statSync` 校验：非普通文件（如目录 `EISDIR`）或体积 > `64 * 1024` 字节时记录脱敏警告并安全降级为 `{}`，绝不 OOM 或阻断启动。
  - 解析 JSON 后校验为普通对象（非数组、`null`），使用 `Object.hasOwn` 逐字段按白名单校验；合法字段写入 `persisted`，单个非法字段丢弃且记警告，不影响其余合法项。
- **`savePatch(patch: PersistedConfigPatch)`**：
  - 若尚未调用过 `load()`，先隐式执行一次 `load()`，避免直接 `savePatch` 意外覆盖磁盘中已有字段。
  - 先基于当前 `persisted` 构造候选对象 `nextPersisted = { ...this.persisted, ...validatedPatch }`（**不提前修改 `this.persisted`**）。
  - 创建父目录 `mkdirSync(dir, { recursive: true, mode: 0o700 })`。
  - 使用 `writeFileSync(tmpPath, JSON.stringify({ version: 1, config: nextPersisted }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })` 写入同目录随机临时文件（`flag: 'wx'` 防止符号链接/同名竞态覆写），再执行 `renameSync(tmpPath, filePath)`；任一步失败均 `rmSync(tmpPath, { force: true })` 并抛出错误。
  - **仅在 `renameSync` 成功后**，才更新 `this.persisted = nextPersisted`。
- **`reset()`**：
  - 执行 `rmSync(filePath, { force: true })`；**仅在 `rmSync` 成功后**，才清空 `this.persisted = {}` 并标记 `loaded = true`。
- **`hasPersistedOverrides`**：返回 `Object.keys(this.persisted).length > 0`。

#### 3. 启动合并、热更新与 `SessionPoolDeps`（`src/index.ts`、`src/runtime/session-pool.ts`）
- `SessionPoolDeps` 新增可选回调：
  - `onConfigReset?: () => void | Promise<void>`
  - `hasPersistedConfig?: () => boolean`
- `StatusSnapshot` 新增可选字段 `hasPersistedConfig?: boolean`，由 `pool.getStatus()` 填充。
- `src/index.ts` 启动时：
  - `baseCfg = resolveConfig(entryConfig)`；
  - `configStore = new ConfigStore({ log })`；
  - `cfg = { ...baseCfg, ...configStore.load().patch }`。
- `onConfigPatch(patch)`：
  - **先落盘后改内存**：`configStore.savePatch(patch)` 成功后，记录变更前 `prevBin = cfg.agyBin` / `prevRoot = cfg.workspaceRoot`，再更新 `cfg = { ...cfg, ...patch }`；
  - 若 `!cfg.mcpBridge` 释放所有 `ReverseMcpBridge`；
  - 若 `cfg.agyBin !== prevBin || cfg.workspaceRoot !== prevRoot`，调用 `pool.invalidateCatalog()` 并在后台触发 `void pool.refreshModels().catch(() => {})`。
- `onConfigReset()`：
  - `configStore.reset()` 成功后，比较 `cfg.agyBin` / `cfg.workspaceRoot` 与 `baseCfg`，恢复 `cfg = { ...baseCfg }`；若 `!cfg.mcpBridge` 释放桥接；若二进制/探测目录变化则调用 `pool.invalidateCatalog()` 并触发后台刷新。

---

### 3.2 串行配置操作、模型目录强制刷新与 HTTP 路由（`src/runtime/session-pool.ts`、`src/transport/sse.ts`）

#### 1. 错误隔离的配置串行队列（`AcpSessionPool`）
在 `AcpSessionPool` 内维护 `private configQueue: Promise<void> = Promise.resolve()`：
```ts
private runConfigOp<T>(op: () => Promise<T>): Promise<T> {
  const next = this.configQueue.catch(() => {}).then(async () => {
    if (this.disposed) throw new Error('ACP session pool disposed')
    return await op()
  })
  this.configQueue = next.then(() => {}, () => {})
  return next
}
```
- `updateConfig(patch)` 与 `resetConfig()` 均通过 `runConfigOp` 串行执行并在成功后调用 `this.emitStatus()`；
- 某次磁盘写入失败 reject 时不会污染 `configQueue`，后续保存/重置依然正常排队执行；
- `pool.disposed === true` 时直接拒绝，防止销毁后写入配置。

#### 2. 模型目录探测重构：`refreshModels()` vs `forceRefreshModels()` + 代次隔离
彻底理顺单飞探测、过期回退与手动刷新三条路径：
- 新增 `private catalogGeneration = 0`。
- `invalidateCatalog()`：
  - `this.catalogGeneration++`（作废任何在途旧配置的探测，防止旧 `agyBin`/`workspaceRoot` 的迟到结果覆盖新配置）；
  - `this.catalogExpiresAt = 0`；
  - `clearTimeout(this.catalogRetry); this.catalogRetry = undefined`；
  - `this.catalogRetryCount = 0`（修复重试耗尽后修复配置无法重新自动恢复的缺陷）；
  - `this.catalogProbe = undefined`。
- 内部单飞方法 `private runCatalogProbe(cwd?: string): Promise<AcpModelOption[]>`：
  - 保存**总是抛错的原始探测 Promise** 到 `this.catalogProbe`（带当前 `gen = this.catalogGeneration`）。
  - 探测成功：若 `gen === this.catalogGeneration && !this.disposed`，`captureCatalogFromSession` 更新缓存、清 `lastError`、**触发 `this.emitStatus()`**（确保 SSE 订阅端即时清除错误横幅并拿到新模型列表）并在签名或错误态变化时触发 `emit('models-updated')`。
  - 探测失败：若 `gen === this.catalogGeneration && !this.disposed`，写入 `this.lastError = formatCatalogProbeError(err)`、调用 `this.emitStatus()`、按 `[5_000, 30_000, 60_000]` 调度 `catalogRetry`，然后**原样重抛错误**。
  - `finally`：仅当 `this.catalogProbe === probe` 时置 `this.catalogProbe = undefined`。
- `refreshModels(cwd?: string)`（菜单/自动探测路径，完整兼容 `test/catalog-recovery.test.ts`）：
  - 命中未过期缓存直接返回 `this.cachedModels`；
  - 否则 `try { return await this.runCatalogProbe(cwd) } catch (err) { if (!this.disposed && this.cachedModels.length) { this.catalogExpiresAt = Date.now() + nextRetryDelay; return this.cachedModels } throw err }`。
- `forceRefreshModels(cwd?: string)`（手动刷新路径）：
  - 若 `this.disposed` 抛错；
  - 调用 `this.invalidateCatalog()` 递增代次并清零重试计数；
  - 直接 `return await this.runCatalogProbe(cwd)`——成功时更新缓存并推送 SSE；失败时更新 `lastError`、推送 SSE、**保留 `this.cachedModels`** 并向调用方抛出错误（由 HTTP 返回 `502`）。

#### 3. HTTP 控制端点与严格校验（`src/transport/sse.ts`）
- 增强 `readJsonBody(req)`：
  - 空请求体返回 `{}`；非空体解析 JSON 后**必须是普通对象**（非 `null`、非数组、非原始值），否则抛出 `HttpInputError(400, '请求体必须为 JSON 对象')`；超过 `maxBytes` 抛出 `HttpInputError(413, '请求体过大')`。
- **`POST /plugins/agy-acp/config`**：
  - 保持不强制 `415 Content-Type`（严格兼容 `test/phase2.test.ts:115` 断言发送无 `Content-Type` 的 `{ permissionMode: 'skip' }` 返回 `400`）。
  - **第一段 `try`（解析与校验，失败返回 `400`/`413`）**：
    - 使用 `Object.hasOwn(body, key)` 遍历全部自有键（不误触原型链如 `'constructor' in body`）：
      - 存在 `'permissionMode'` → `400` (`Permission policy belongs to the DSH session`)；
      - 存在 `'accounts'` / `'credentialSlotDir'` / `'enabled'` / 任意未知键或原型污染键（`__proto__`、`constructor`、`prototype`）→ `400`（明确提示不被允许的配置项）；
      - 7 个白名单键逐一按 3.1.1 规则严格校验类型、控制字符、正则与数值上下限，任一非法即返回 `400` 附清晰中文说明；
      - 若未提供任何可更新键 → 返回 `400`。
  - **第二段 `try`（执行持久化，失败返回 `500`）**：
    - 调用 `await pool.updateConfig(patch)`；捕获异常并返回 `500` `{ error: '配置写入磁盘失败，未应用更改' }`（绝不透出文件路径或底层系统错误）。
    - 成功返回 `200` `{ ok: true, persisted: true, status: pool.getStatus() }`。
- **`POST /plugins/agy-acp/config/reset`**（新增）：
  - 要求 `Content-Type` 为 `application/json`（防跨站简单请求 CSRF，否则返回 `415`）。
  - 调用 `await pool.resetConfig()`；成功返回 `200` `{ ok: true, status: pool.getStatus() }`，失败返回 `500` `{ error: '重置配置失败，请重试' }`（不泄露路径）。
- **`POST /plugins/agy-acp/models/refresh`**（新增）：
  - 要求 `Content-Type` 为 `application/json`（否则返回 `415`）。
  - 调用 `await pool.forceRefreshModels()`；成功返回 `200` `{ ok: true, status: pool.getStatus() }`；失败返回 `502` `{ error: pool.getStatus().lastError || '模型目录刷新失败', status: pool.getStatus() }`。

---

### 3.3 前端单例 SSE 状态中心（`src/client/status-store.ts`）

导出 `createStatusStore(deps?)` 与浏览器默认单例 `getSharedStatusStore()`：

```ts
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void
  removeEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void
  close(): void
}

export interface StatusStoreDeps {
  fetchStatus?: () => Promise<StatusSnapshot | null>
  createEventSource?: (url: string) => EventSourceLike | null
  closeGraceMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export interface StatusStore {
  getSnapshot(): SnapshotState
  subscribe(listener: () => void): () => void
  applyStatus(next: StatusSnapshot): void
  dispose(): void
}
```

核心不变量与边界处理：
1. **单连接共享与引用计数**：
   - 第 1 个订阅者加入时：取消待执行的 `closeTimer`；若无活跃 `EventSource` 且未 `disposed`，递增 `generation++`、建立唯一一条 `EventSource('/plugins/agy-acp/events')`；若尚无 `status` 快照且当前无在途 `fetchStatus`（`!inFlightFetch`），发起一次初始 `GET /plugins/agy-acp/status`。
   - 第 2..N 个订阅者加入时：**不新建 `EventSource`、不重复 `fetch`**，直接复用共享连接与 `state`。
2. **宽限期关闭防“假在线”**：
   - 最后一个订阅者卸载后启动 `closeGraceMs`（默认 `1500ms`）定时器；
   - 定时器到期且订阅数为 0 时：关闭 `EventSource`、递增 `generation++`、置 `es = null`，若此时 `state.stream === 'live'`，同步将内部 `state` 的 `stream` 切回 `'connecting'`（保持 `state.status` 保留上次快照，但不再误标为实时在线）；
   - 当后续有新组件重新订阅建立新 `EventSource` 时，直到收到新 SSE `status` 帧才恢复 `'live'`，彻底消除关闭宽限期后重连的“假在线”陈旧展示（同时不改动 `reduceSnapshot` 既有事件契约，`test/account-display.test.ts` 全绿）。
3. **SSR 安全与 `useSyncExternalStore` 快照稳定性**：
   - 默认 `createEventSource` 先检测 `typeof globalThis.EventSource === 'function'`，在 Node SSR / 测试环境缺失 `EventSource` 时返回 `null` 不抛 `ReferenceError`。
   - `dispatch(event)` 调用 `reduceSnapshot(state, event)` 后比较字段（`next.status === state.status && next.stream === state.stream && next.failed === state.failed`），无实质变化时不替换 `state` 引用也不触发监听者。
   - `getSnapshot()` 始终返回稳定的 `SnapshotState` 引用；`useAgyAcpStatus()` 使用 `React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)` 读取稳定 `snapshot`，再在外层组合 `applyStatus` 返回（绝不在 `getSnapshot` 内每次创建新对象）。
   - 在途 `fetchStatus()` 与旧 `EventSource` 回调均校验 `gen === generation && !disposed`，防止关闭/重连后的陈旧响应回写。

---

### 3.4 主题适配与控制台 UI 升级（`src/client/theme.ts`、`src/client/index.ts`、`src/client/account-card.ts`）

#### 1. DSH 官方主题令牌（`src/client/theme.ts`）
集中定义主题样式对象，彻底移除硬编码深色背景 `#18181b` / `#f4f4f5`：
- 弹窗表面：`backgroundColor: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, Canvas))'`，`color: 'var(--dsw-alias-label-primary, CanvasText)'`
- 卡片背景：`var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.06))`
- 子条目背景：`var(--dsw-alias-card-tile-fill, rgba(127, 127, 127, 0.08))`
- 边框：`1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-primary, rgba(127, 127, 127, 0.28)))`
- 主文字 / 次文字：`var(--dsw-alias-label-primary, inherit)` / `var(--dsw-alias-label-secondary, inherit)`
- 主按钮：`backgroundColor: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))'`，`color: 'var(--dsw-alias-label-on-color, #ffffff)'`
- 遮罩：`var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))`
- 状态色：`--dsw-alias-state-success-primary` / `--dsw-alias-state-warn-primary` / `--dsw-alias-state-error-primary` / `--dsw-alias-state-idle-primary`。

#### 2. 控制台交互与导出（`src/client/index.ts`、`src/client/account-card.ts`）
- **导出 `SettingsView`**（供 SSR 渲染单测直接验证 UI 结构）。
- **升级 `postJson` 返回完整结果**：`{ ok: boolean; status?: StatusSnapshot; error?: string }`，确保：
  - 保存配置失败（`400`/`500`）向用户展示后端返回的安全中文原因；
  - 刷新模型目录返回 `502` 时仍消费并 `applyStatus(res.status)` 同步最新 `lastError`；
  - `handleResetSessions`、`handleSaveConfig`、`handleResetConfig` 成功后均调用 `applyStatus(res.status)` 同步所有已挂载视图。
- **排障横幅**：当 `status.lastError` 非空时展示醒目告警条（脱敏原因 + 一键「重新探测目录」）。
- **模型选择器与目录刷新**：
  - `status.models.length > 0` 时，默认模型使用 `<select>`（`自动（使用 ACP 默认）` + 目录模型 + 保留不在目录中的已存自定义值兼容项）；目录为空时回退 `<input>`；旁置「刷新目录」按钮。
- **超时/空闲 TTL 编辑、脏状态与恢复默认**：
  - 空闲会话回收（分钟，1–1440）与单次请求超时（秒，10–3600），以归一化后的基线（`Math.round` 并夹逼至合法区间）计算 `dirty` 状态，避免非整分钟宿主机配置导致开页误报脏状态；
  - 「保存并应用」按钮仅在无校验错误且不忙时可用；保存成功后立即同步表单基线；
  - 「恢复默认」按钮在 `status.hasPersistedConfig` 为真时可用，点击调用 `POST /plugins/agy-acp/config/reset` 并用返回快照更新表单与全局状态。
- **会话卡片与弹窗体验**：
  - 会话行在 `contextUsed != null && contextSize > 0` 时展示细长进度条（>80% 告警色、>92% 错误色）与最近活跃时间；
  - 弹窗打开期间锁定 `document.body.style.overflow` 并在关闭/卸载时精确恢复原值；
  - `AccountCard` 视觉对齐 `theme.ts`，**完整保留既有测试断言与无障碍文案**。

---

## 4. 错误处理与边界矩阵

| 场景 | 预期行为 |
| --- | --- |
| `~/.dsh/agy-acp/config.json` 损坏、超 64KB 或为目录 | 记录脱敏警告，降级为空补丁，插件正常启动 |
| `POST /plugins/agy-acp/config` 写盘失败 | 清理临时文件、返回 `500`（不露路径）、**不污染内存 `cfg` 与 `hasPersistedOverrides`**，串行队列不受传染 |
| `POST /plugins/agy-acp/config` 含 `permissionMode` / `accounts` / 未知键 / 越界超时 / 控制字符 | 返回 `400`，附清晰中文说明（兼容无 `Content-Type` 的旧测试） |
| `POST /plugins/agy-acp/config/reset` 或 `/models/refresh` 缺少 `application/json` | 返回 `415` 防 CSRF |
| `POST /plugins/agy-acp/models/refresh` 在已有旧缓存时探测失败 | 更新 `lastError`、推 SSE、保留旧缓存、返回 `502`（含最新 `status`） |
| 并发挂载顶栏徽标 + 设置页 + 插件面板 | 仅创建 **1 条** `EventSource` 与 **1 次** 初始 `fetch` |
| 全员卸载超过 1.5s 后关闭连接，之后再次挂载 | 关闭时将 `stream` 切回 `'connecting'`，避免“假在线”；重订阅时建立新 SSE 并在收到帧后恢复 `'live'` |
| Node SSR / 无 `EventSource` 环境渲染 | 安全跳过 `EventSource` 创建，无 `ReferenceError` |
| 浅色 DSH 主题打开控制台弹窗 | 通过 `--dsw-alias-bg-elevated` / `Canvas` 自适应浅色背景与文字，无写死 `#18181b` |

---

## 5. 验证与测试矩阵

需全部通过 `pnpm run verify`（`lint:arch` + `tsc --noEmit` + `tsdown` + `node --test`），覆盖以下新增与既有测试：

1. **配置持久化单测（`test/config-store.test.ts`）**：
   - 原子保存与重启后重新加载保持一致；未先 `load()` 直接 `savePatch()` 保留已有磁盘键；
   - 仅白名单字段落盘，忽略/拒绝 `permissionMode`、`accounts`、`__proto__`、控制字符、非法 `defaultEffort` 与越界超时；
   - 损坏 JSON、超 64KB 文件与目录路径均安全降级；
   - 写盘失败不污染内存 `hasPersistedOverrides`；
   - `reset()` 删除覆盖文件并恢复 `hasPersistedOverrides === false`；POSIX `0o600` 文件权限校验。
2. **HTTP 路由与目录刷新集成测试（`test/phase2.test.ts`、`test/catalog-recovery.test.ts`）**：
   - `POST /plugins/agy-acp/config` 合法修改持久化生效、非法类型/越界/未知键/禁用键返回 `400`、写盘失败返回 `500` 且队列后续操作可恢复；
   - `POST /plugins/agy-acp/config/reset` 与 `/models/refresh` 校验 `415`、正常执行及 `502` 失败保留旧缓存并更新 `lastError`；
   - 修改 `agyBin`/`workspaceRoot` 后递增代次、重置重试计数并作废过期在途探测；恢复成功后触发 SSE `status` 事件。
3. **前端单例 SSE 与控制台渲染测试（`test/account-display.test.ts`）**：
   - `createStatusStore` 多订阅者仅创建 1 条 `EventSource` 与 1 次 `fetch`；宽限期内重订阅复用连接；超宽限期关闭后 `stream` 切回 `'connecting'` 避免假在线；快照引用稳定无冗余通知；缺失 `EventSource` 时 SSR 安全；
   - `SettingsView` SSR 渲染验证：模型 `<select>` 下拉、兼容旧自定义模型、`lastError` 告警横幅、超时/TTL 输入、「恢复默认」按钮、会话上下文进度条，且输出不含写死 `#18181b`；
   - 既有全部 `AccountCard` / `reduceSnapshot` / `catalog-recovery` / `phase2` 测试 100% 通过。
