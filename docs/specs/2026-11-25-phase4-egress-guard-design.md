# 阶段四设计规格：网络出口合规探测与防风控熔断（Egress Probe & GeoFence Guard）

- **日期**：2026-11-25
- **项目**：`@morsewayne/dsh-agy-acp`
- **前置基线**：阶段一（`7406eeb`）、阶段二（`7a6d2c1`）、阶段三（`0189a5c`）
- **范围**：阶段四（与 `agy` 代理语义一致的轻量出口地域探测器、全四条出站链路统一本地熔断、多账号池自动避障、漏网 400 瞬时失效与诊断、持久化防护策略配置、HTTP/SSE 接口与控制台出口自检 UI）
- **明确非目标**：
  - 不内置代理服务器或自动切换用户 VPN 节点（插件仅负责探测、预警、本地拦截与多账号池内切换）；
  - 不开放 HTTP 接口修改账号的 `proxyUrl` / `homeDir` / `env`（多账号配置仍由宿主配置文件只读管理）；
  - 不在插件中引入重型第三方代理或 GeoIP 数据库依赖（保持纯 Node.js 原生实现）。

---

## 1. 目标与核心问题

在真实运行 `@morsewayne/dsh-agy-acp` 时，Google Cloud / Gemini API 对出口地域有严格 Geo-fencing 限制，导致以下高风险痛点：

1. **受限地域请求直击 Google 后端，存在封号风险**：当用户默认代理位于中国香港（HK）或分流规则遗漏 `*.googleapis.com` 时，请求直接打到 Google 后端并持续返回 `FAILED_PRECONDITION (code 400): User location is not supported for the API use`。高频触发此类错误会显著提升账号风控与封禁概率。
2. **工具调用与后台辅助链路放大触发面**：插件中共有 **4 条**会实际访问 Google 的出站链路——主对话（`session/prompt`）、辅助调用（`runAuxiliaryPrompt` 如标题生成/压缩）、启动期自动模型目录探测（`probeCatalog`，失败后还会自动重试 3 次）、以及配额刷新（`probeAccountQuota`）。若只拦主对话，后台仍会持续向 Google 发送违规地域流量。
3. **Node 探测与 Go `agy` 代理行为分叉风险**：`agy`（Go 二进制）同时遵循 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含 `http://`、`https://`、`socks5://`、`socks5h://`）与 `NO_PROXY` 以及系统 TUN 虚拟网卡；而 Node.js 原生 `fetch` 默认不读取代理环境变量也不支持 SOCKS5。若直接调用 `fetch()`，极易出现“探针判断合规但 `agy` 实际直连撞墙”的误判。
4. **缺少前置可视与事后熔断闭环**：用户无法在控制台提前看到每个账号的真实出口国家与代理生效状态；即便在多账号池中，也无法自动跳过出口漂移到受限区的账号；且在缓存窗口内若 VPN 临时漂移导致一次 400，后续连环工具调用仍会继续发包撞墙。

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

新增与改动模块归属：
- `src/common/geo.ts`（新增）：纯规则与辅助函数——受限国家代码集合、`isUnsupportedGeoCountry`、`isGeoUnsupportedError`、`maskIpAddress`、`GEO_FENCE_MODES` 常量（零外部依赖，供 `common`、`runtime`、`provider`、`client` 共享）。
- `src/common/types.ts` & `src/common/config.ts`：扩展 `GeoFenceMode`、`AccountEgressSnapshot`、`AccountHealthSnapshot.egress`、`PersistedConfigPatch.geoFenceMode`、`PluginConfig.geoFenceMode` 与白名单校验。
- `src/runtime/egress-guard.ts`（新增）：代理路由解析（HTTP CONNECT / SOCKS5 / 直连 TUN）、多源轻量出口探测、单飞与分态 TTL 缓存、`EgressBlockedError`、运行期 400 瞬时熔断状态管理（仅依赖 `node:*` 与 `src/common/`）。
- `src/runtime/account-pool.ts`：在 `MultiAccountPool` 接入出口受限状态查询/标记，选号时自动避开已知受限账号。
- `src/runtime/session-pool.ts`：持有 `EgressGuard` 实例，在全部 4 条出站路径统一执行 `assertEgressAllowed(...)`，并对 `StatusSnapshot.accounts` 合并注入 `egress` 快照。
- `src/provider/adapter.ts`：在多账号循环中识别 `EgressBlockedError`（作为账号级避障转移，绝不计入 `crashRetried`），并在捕获漏网 `isGeoUnsupportedError(err)` 时立即触发 `pool.recordGeoRejection(...)`、作废缓存并输出人类可读中文诊断。
- `src/transport/sse.ts`：新增 `POST /plugins/agy-acp/accounts/egress/check`。
- `src/client/account-card.ts` & `src/client/index.ts`：账号卡展示出口合规状态与「检测出口」按钮；设置页提供 `geoFenceMode` 策略选择。

---

## 3. 模块详细设计

### 3.1 地域规则、错误识别与 IP 脱敏（`src/common/geo.ts`、`src/common/types.ts`、`src/common/config.ts`）

#### 1. 类型定义（`src/common/types.ts`）
```ts
export type GeoFenceMode = 'block' | 'strict' | 'warn' | 'off'

export type EgressCheckStatus = 'supported' | 'unsupported' | 'unknown' | 'error'

export interface AccountEgressSnapshot {
  status: EgressCheckStatus
  /** ISO 3166-1 alpha-2 大写国家/地区码，如 "US"、"JP"、"HK"；无法识别时为 null */
  country: string | null
  /** 脱敏后的出口 IP（如 "203.0.113.*" / "2001:db8::*"），防 UI 截屏泄露完整公网 IP */
  ipMasked: string | null
  /** 本次探测实际采用的出站模式 */
  proxyMode: 'proxy' | 'direct'
  /** 探测来源标识，如 "cloudflare-trace" | "ipsb" | "runtime-400" */
  probeSource: string | null
  checkedAt: number
  expiresAt: number
  /** 经 sanitizeDiagnosticText 处理的简短中文说明（仅受限/异常时填充） */
  reason?: string
}
```
- `AccountHealthSnapshot` 新增可选字段 `egress?: AccountEgressSnapshot`。
- `PersistedConfigPatch`、`PluginConfig` 与 `StatusSnapshot['config']` 新增 `geoFenceMode?: GeoFenceMode`（`PluginConfig` 必填，默认 `'block'`）。

#### 2. 配置校验（`src/common/config.ts`）
- 将 `'geoFenceMode'` 加入 `ALLOWED_PERSIST_KEYS`，复用阶段三 `ConfigStore` 原子持久化机制；
- `validateConfigPatchInput` 校验值必须属于 `'block' | 'strict' | 'warn' | 'off'`，非法值返回 `400`；
- `resolveConfig` 默认解析为 `'block'`。

#### 3. 地域黑名单与错误特征（`src/common/geo.ts`）
- `GEO_BLOCKED_COUNTRIES`: 明确已知被 Google Generative AI / Antigravity 限制的地区集合：
  `CN`（中国大陆）、`HK`（中国香港）、`MO`（中国澳门）、`RU`（俄罗斯）、`BY`（白俄罗斯）、`IR`（伊朗）、`KP`（朝鲜）、`SY`（叙利亚）、`CU`（古巴）。
- `isUnsupportedGeoCountry(code: string | null | undefined): boolean`：标准化为大写 2 字母后查表。
- `isGeoUnsupportedError(error: unknown): boolean`：匹配 `user location is not supported for the api use` 或同时含 `failed_precondition` 与 `location is not supported`（大小写不敏感）。
- `maskIpAddress(ip: string): string`：IPv4 掩蔽末段（`a.b.c.*`），IPv6 仅保留前 2–3 段（`xxxx:xxxx::*`），非法格式返回 `unknown`。

---

### 3.2 代理一致性探测与熔断引擎（`src/runtime/egress-guard.ts`）

#### 1. 代理环境变量解析（对齐 Go `net/http.ProxyFromEnvironment`）
给定有效环境 `env = accountEnv ?? process.env` 和目标探针 `url`（HTTPS）：
1. 读取 `NO_PROXY` / `no_proxy`：若包含 `*` 或匹配目标域名/后缀（如 `.cloudflare.com`），走直连（`proxyMode: 'direct'`）。
2. 按 Go 优先级读取代理变量：`HTTPS_PROXY` → `https_proxy` → `ALL_PROXY` → `all_proxy` → `HTTP_PROXY` → `http_proxy`。
3. 仅提取合法 URL 协议：
   - **`http:` / `https:`**：使用 `node:http` / `node:https` 向代理发起 `CONNECT <host>:443` 隧道握手（若代理 URL 含用户名密码，组装 `Proxy-Authorization: Basic ...` 请求头；**绝不在日志、缓存键原文或报错中保留凭据**），隧道建立后以 `tls.connect({ socket, servername: targetHost })` 升级 TLS 并发送 HTTPS GET。
   - **`socks5:` / `socks5h:` / `socks:`**：通过 `node:net` 执行最小 RFC 1928 握手（支持无认证 `0x00` 及 RFC 1929 用户名密码认证 `0x02`），连接请求强制使用 `ATYP = 0x03`（Domain Name，由代理端解析 DNS，避免本地 DNS 污染与泄露），握手成功后升级 TLS 发送 HTTPS GET。
   - **无代理变量**：直接 `node:https` 请求（自动遵循宿主机路由表及 Clash/Sing-box/Surge TUN 虚拟网卡，与 `agy` 行为一致）。
   - **不支持的协议（如 `socks4://` 或非法 URL）**：不抛未捕获异常，返回 `status: 'error'` 与经脱敏的中文提示。

#### 2. 多源轻量探测与边界保护
按顺序尝试轻量低延迟 HTTPS 探针（单个源超时 `4_000ms`，总响应体上限 `16KB`，严格绑定 `AbortSignal`）：
1. **主源 `cloudflare-trace`**：`GET https://cloudflare.com/cdn-cgi/trace`
   - 解析纯文本键值行 `loc=XX` 与 `ip=...`；体积仅约 150 字节，全球 Anycast 极快且无 API Key / 频率限制。
2. **备用源 `ipsb`**：`GET https://api.ip.sb/geoip`（仅当主源超时、非 200 或未返回合法 2 位国家码时回退）
   - 解析 JSON `country_code` 与 `ip`。
- 所有源均失败时返回 `status: 'error', country: null, ipMasked: null`，保留脱敏失败原因。
- 若返回 `country` 为 2 字母代码（排除 `XX`/`T1` 等无效占位码）：
  - 命中 `GEO_BLOCKED_COUNTRIES` → `status: 'unsupported'`；
  - 否则 → `status: 'supported'`。
- 返回非标准国家码（如 `XX`）→ `status: 'unknown'`。

#### 3. 缓存键、分态 TTL 与单飞防惊群
- **缓存键**：对 `(accountId, 生效代理环境变量集合)` 计算 SHA-256 摘要作为键，避免明文保存代理凭据；代理配置变化自动失效旧缓存。
- **分态 TTL**：
  - `supported`：**5 分钟**（`300_000ms`）——日常连续对话 0ms 零延迟放行；
  - `unsupported`：**60 秒**（`60_000ms`）——防止持续撞墙，同时用户切换 VPN 节点后可快速自动恢复（或点 UI「检测出口」立即刷新）；
  - `unknown` / `error`：**30 秒**（`30_000ms`）——避免探针短暂波动引起长时间误状态。
- **单飞并发合并（`inFlight: Map<string, Promise<AccountEgressSnapshot>>`）**：启动探测、前端刷新与首次对话并发到达时共享同一条探测请求。

#### 4. 四种防护模式裁决（`assertAllowed`）
导出 `EgressBlockedError extends Error`（含 `readonly accountId: string`、`readonly snapshot: AccountEgressSnapshot`、`readonly status = 451`）：

| `geoFenceMode` | `supported` | `unsupported`（命中受限区） | `unknown` / `error`（探测失败） |
| --- | --- | --- | --- |
| **`off`** | 直接放行（不发起探测） | 直接放行 | 直接放行 |
| **`warn`** | 放行 | 放行（记录告警日志并在 UI 标红） | 放行（记录告警） |
| **`block`（默认）** | 放行 | **硬熔断，抛出 `EgressBlockedError`** | 放行并记录告警（避免探针站点故障反锁整个插件） |
| **`strict`** | 放行 | **硬熔断，抛出 `EgressBlockedError`** | **硬熔断，抛出 `EgressBlockedError`**（宁可不发包，绝不冒风控风险） |

拦截文案清晰且可操作：
> `[安全拦截] 已在本地阻断发往 Google 的请求（未发送任何上游流量）：检测到账号“${label}”当前出口位于不受支持的地区（${country}），代理模式=${proxyMode}。请切换至 US / JP / SG / TW 等支持区域节点后重试，或在控制台点击「检测出口」刷新状态。`

#### 5. 事后 400 瞬时熔断（`recordGeoRejection`）
当某次请求在 `supported` 缓存期内因 VPN 节点漂移而触发上游 Google 400 `isGeoUnsupportedError(err)` 时：
1. 立即清除该账号当前缓存，写入合成快照 `{ status: 'unsupported', probeSource: 'runtime-400', expiresAt: now + 60_000, reason: '上游 Google API 返回地域不受支持（400），已即时触发本地保护熔断' }`；
2. 通知 `MultiAccountPool` 标记该账号短暂地域不可用，并触发 `emitStatus()` 推送至前端；
3. 异步触发一次受限频率的后台出口重测（不阻塞当前错误返回），以便控制台立刻更新真实的最新出口国家码。

---

### 3.3 全四条出站链路守门与多账号避障（`src/runtime/session-pool.ts`、`src/runtime/account-pool.ts`、`src/provider/adapter.ts`）

#### 1. `AcpSessionPool` 四大出站入口全覆盖
在 `AcpSessionPool` 内部持有 `egressGuard: EgressGuard`（支持通过 `SessionPoolDeps` 注入 mock 便于离线单测），并提供统一方法：
- `assertEgressAllowed(accountId: string, env: NodeJS.ProcessEnv | undefined, signal?: AbortSignal): Promise<void>`
- `checkAccountEgress(accountId?: string): Promise<void>`（强制忽略缓存重测单账号或全部已启用账号，并 `emitStatus()`）
- `recordGeoRejection(accountId: string, env?: NodeJS.ProcessEnv): void`

四条出站链路接入点：
1. **主对话建连与复用**：
   - `getOrCreateSession(...)`：拿到 `lease` 后、调用 `newClient(...)` 前，执行 `await this.assertEgressAllowed(lease.accountId, lease.env, opening.signal)`；
   - **复用长连接防护**：`ManagedAcpSession` 保存不对外暴露的 `env?: NodeJS.ProcessEnv`（或由 `accountProvider` 解析），在 `getOrCreateSession` 复用已有运行中会话返回前（或 `beginPrompt` 前）再次调用 `assertEgressAllowed`——缓存有效时为同步级 0ms 返回；缓存过期且节点已漂移至 HK 时，直接在本地阻断，不向已存活的 `agy acp` 发送 `session/prompt`！
2. **辅助调用（`runAuxiliaryPrompt`）**：获取 `lease` 后、`newClient(...)` 前执行 `assertEgressAllowed`；
3. **模型目录探测（`probeCatalog`）**：获取 `lease` 后、`newClient(...)` 前执行 `assertEgressAllowed`。若抛出 `EgressBlockedError`：
   - `formatCatalogProbeError` 识别 `EgressBlockedError` 并写入清晰脱敏 `lastError`；
   - **停止自动 5s/30s/60s 后台重试循环**（避免用户在受限节点挂着时插件每分钟反复撞探测或刷告警），待用户切换节点后点击「检测出口」或「重新探测目录」即刻恢复。
4. **配额查询（`probeAccountQuota`）**：获取 `lease` 后、启动 `agy --version` / `agy -p /usage` 前执行 `assertEgressAllowed`（拦截时抛出 `AccountQuotaError(err.message, 451)`）。

#### 2. 多账号池自动避障（`src/runtime/account-pool.ts` & `src/provider/adapter.ts`）
- `MultiAccountPool` 新增按账号维护的 `geoBlockedUntil: Map<string, number>`（以及 `markGeoBlocked(accountId, untilMs)` / `clearGeoBlock(accountId)`）：
  - 在 `acquire(...)` 过滤候选账号时，若 `geoBlockedUntil.get(id) > now`，将其跳过并纳入 `earliestReset` 提示；
  - 当用户手动点击「检测出口」且探测结果为 `supported` 时，自动调用 `clearGeoBlock(accountId)` 即刻恢复调度资格；
  - `clearCooldown(accountId)` 同步清理本地地域冷却。
- `AcpAdapter.stream(...)` 重试循环联动：
  - 在 `getOrCreateSession(...)` 阶段若捕获 `EgressBlockedError`：
    - 将该 `err.accountId` 记入 `triedAccounts` 并标记 `markGeoBlocked`；
    - 若多账号池中仍有未尝试的启用账号（`triedAccounts.size < maxAccounts`），自动 `continue` 切换至下一个候选账号（可能配置了不同地区的 `proxyUrl`）；
    - 若单账号或所有账号均受限，直接向用户输出清晰的本地安全拦截提示（**绝不触发 `crashRetried`**）。
  - 在 `sessionPrompt` 返回漏网 `isGeoUnsupportedError(error)` 时：
    - 保留健康进程或按错误类型处理，立即调用 `pool.recordGeoRejection(session.accountId)`；
    - 若存在其他未尝试的多账号且位于首帧前，可尝试转移至备用账号；否则返回附带当前检测国家与切换建议的中文错误。

---

### 3.4 HTTP 控制面与前端控制台展示（`src/transport/sse.ts`、`src/client/account-card.ts`、`src/client/index.ts`）

#### 1. HTTP 端点（`src/transport/sse.ts`）
- 新增 **`POST /plugins/agy-acp/accounts/egress/check`**：
  - 强制要求 `Content-Type: application/json`（缺省返回 `415` 防 CSRF）；
  - 可选请求体 `{ accountId?: string }`：传入有效 `accountId` 时仅强制重测该账号（未知 ID 返回 `404`）；不传则重测全部已启用账号；
  - 完成后推送 SSE `status` 并返回 `200 { ok: true, status: pool.getStatus() }`（探测本身发现受限区仍返回 `200`，由 `status.accounts[].egress` 反映受限态；仅参数错误或池已销毁返回 `400`/`409`）。
- 既有 **`POST /plugins/agy-acp/config`**：自动支持持久化更新 `geoFenceMode`（受阶段三白名单与串行队列保护）。

#### 2. 前端 UI（`src/client/account-card.ts`、`src/client/index.ts`）
- **`AccountCard`**：
  - 在账号元信息下方增加「网络出口合规」行，展示：
    - 合规状态徽标（沿用 `theme.ts` 状态色）：
      - `supported`：`出口：US（代理）· 合规`（绿色）
      - `unsupported`：`出口：HK（直连）· 不支持 Gemini（已拦截）`（红色）
      - `unknown` / `error`：`出口：探测异常`（黄色，附脱敏原因）
      - 尚未检测：`出口：待检测`
    - 脱敏 IP 与上次检测时间；
    - 「检测出口」按钮（点击调用 `POST /plugins/agy-acp/accounts/egress/check`，成功后 `applyStatus` 同步全局状态；若检测转为合规且当前 `status.lastError` 为地域阻断错误，可顺带触发一次模型目录刷新）。
- **`SettingsView`**：
  - 增加「地域合规防护（防封号拦截）」下拉框：
    - `拦截受限地区（推荐，默认）`（`block`）
    - `严格模式（受限与未知均拦截）`（`strict`）
    - `仅告警不拦截`（`warn`）
    - `关闭`（`off`）
  - 纳入表单 `dirty` 计算、保存原子持久化与「恢复默认」重置闭环。

---

## 4. 错误处理与边界矩阵

| 场景 | 预期行为 |
| --- | --- |
| 默认 `block` 模式，账号出口为 `HK` 或 `CN` | 在本地发起前硬熔断，**不启动 `agy` 子进程、不发送任何包到 Google**，主对话 / 辅助调用 / 目录探测 / 配额查询全部拦截并给出清晰中文提示 |
| 默认 `block` 模式，出口为 `US` / `JP` / `SG` / `TW` | 首次探测后缓存 5 分钟；缓存期内所有对话 0ms 放行 |
| `block` 模式，探针站点全部超时/不可达 | 缓存 30s `error` 状态，记录脱敏告警并**放行请求**，避免第三方探针故障反锁插件 |
| `strict` 模式，探针站点超时或返回 `XX` | 本地硬熔断，绝不冒险发包 |
| 账号配置了 `socks5://user:pass@127.0.0.1:7890` | 探测器通过 RFC 1928/1929 SOCKS5（远端域名解析）走同一代理探测；凭据全程不出现在缓存键、日志、SSE 或 UI |
| 复用长连接会话期间用户将 VPN 切到 `HK` 且缓存过期 | 复用会话发送前 `assertEgressAllowed` 触发重测识别 `HK`，本地熔断不发 `session/prompt` |
| 缓存有效期内 VPN 瞬时漂移至 `HK` 导致一次漏网 400 | `isGeoUnsupportedError` 捕获后立即作废缓存并置 60s `runtime-400` 阻断，后续请求不再撞墙，同时后台重测刷新真实国家码 |
| 多账号池：账号 A（HK 代理）与账号 B（US 代理） | 账号 A 被 GeoFence 拦截后自动故障转移至账号 B 成功响应，且后续调度跳过 A 直到其重测恢复合规 |
| 启动期 `probeCatalog` 遇到受限出口 | 立即写入清晰中文 `lastError` 并**暂停后台定时重试**，不空转骚扰用户或刷失败日志 |
| `geoFenceMode === 'off'` | 完全跳过出口探测与拦截（用户主动点「检测出口」仍可手动探测查看） |

---

## 5. 验证与测试矩阵

需全部通过 `pnpm run verify`（`lint:arch` + `tsc --noEmit` + `tsdown` + `node --test`），覆盖以下新增与既有测试（全部在本地 loopback 模拟服务器运行，零外网依赖）：

1. **规则与配置单测（`test/core.test.ts`、`test/config-store.test.ts`）**：
   - `isUnsupportedGeoCountry`、`isGeoUnsupportedError`、`maskIpAddress`（IPv4/IPv6/非法输入）全覆盖；
   - `geoFenceMode` 白名单校验、非法枚举返回 `400`、原子落盘与重置。
2. **代理协议与探测器单测（`test/egress-guard.test.ts`）**：
   - 本地 mock HTTP CONNECT 代理（含 Basic Auth 校验与凭据零泄露断言）；
   - 本地 mock SOCKS5 代理（含无认证与用户名/密码认证、验证 `ATYP=0x03` 远端域名模式）；
   - `NO_PROXY` 命中走直连；主源失败自动回退备用源；
   - 分态 TTL 缓存命中、并发单飞合并（N 个并发请求仅发 1 次探测）、`block` / `strict` / `warn` / `off` 四模式裁决矩阵、`recordGeoRejection` 瞬时作废缓存。
3. **全四条出站链路熔断与多账号避障 E2E（`test/adapter.e2e.test.ts`、`test/catalog-recovery.test.ts`、`test/account-quota.test.ts`）**：
   - 出口 `HK` 时验证 `fake-agy.mjs` **进程启动次数严格为 0**（覆盖主对话、辅助调用、目录探测、配额查询四条链路）；
   - 长连接复用时 TTL 过期且节点切为 `HK`，验证不向已有子进程发 `session/prompt`；
   - 漏网 400 触发 `recordGeoRejection` 后，紧接着的第二轮在本地即被阻断；
   - 多账号池中账号 A 为 `HK`、账号 B 为 `US` 时自动无缝路由到账号 B。
4. **HTTP 与前端渲染测试（`test/phase2.test.ts`、`test/account-display.test.ts`）**：
   - `POST /plugins/agy-acp/accounts/egress/check` 校验 `415` / `404` / 单账号与全量重测并推送 SSE；
   - `AccountCard` 渲染 `supported` / `unsupported` / `error` / 待检测状态及「检测出口」按钮；`SettingsView` 渲染 `geoFenceMode` 下拉框并正确提交持久化配置。
