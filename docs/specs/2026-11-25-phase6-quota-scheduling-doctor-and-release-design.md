# 阶段六设计规格：多账号配额感知调度、结构化 `/agy-acp` 诊断工具箱与发布基线

- **日期**：2026-11-25
- **项目**：`@morsewayne/dsh-agy-acp`
- **前置基线**：阶段一（`7406eeb`）、阶段二（`7a6d2c1`）、阶段三（`0189a5c`）、阶段四（`7f488b6`）、阶段五（`b237d35`）
- **范围**：阶段六（显式可选的配额感知多账号调度与低余量预警、`/agy-acp [status | doctor]` 结构化诊断与只读环境自检、`README.md` / `CHANGELOG.md` 与 `v0.4.0` 版本基线收口）
- **明确非目标**：
  - 默认不开启未经授权的后台定时轮询刷配额（`quotaAwareScheduling` 默认 `false`，仅在用户显式开启时将已采集配额样本映射至 `MultiAccountPool` 调度权重）；
  - `/agy-acp doctor` 严格保持只读且受宿主 `sandbox.confine` 约束，绝不修改配置、不发起对话计费请求、不打印任何明文凭据或完整公网 IP。

---

## 1. 目标与核心问题

1. **配额观测与账号调度的闭环缺失**：`MultiAccountPool.updateQuota()` 已具备 5 小时 / 7 天双桶剩余比例加权选号与耗尽避障能力，但 `refreshAccountQuota()` 采集到的样本尚未提供映射开关接入调度器，且控制台缺少低配额（≤15%）视觉预警。
2. **命令行排障信息不足**：`/agy-acp` 仅输出 8 行静态英文简报，缺少出口地域合规状态、持久化覆盖状态、反向 MCP 运行指标、`lastError` 诊断，也不支持一键环境自检（`doctor`）。
3. **文档与包版本滞后**：`package.json` 仍停留在 `0.1.0`，`README.md` 尚未涵盖阶段一～六的完整特性矩阵，缺少 `CHANGELOG.md` 版本演进记录。

---

## 2. 架构约束与模块归属

严格遵守 [scripts/lint-arch.mjs](../../scripts/lint-arch.mjs) 单向分层规则：

- `src/common/types.ts` & `src/common/config.ts`：新增 `quotaAwareScheduling` 配置项（默认 `false`）并纳入 `ALLOWED_PERSIST_KEYS` 白名单。
- `src/runtime/account-quota.ts` & `src/runtime/account-pool.ts`：实现 `mapQuotaGroupsToFamilies(groups)` 将 CLI 分组安全映射至 `ModelFamily`（通用池优先于专用子池防误杀），并在 `MultiAccountPool` 增加 `clearQuotaSamples()` 以支持关闭开关时即时还原等权调度。
- `src/runtime/session-pool.ts`：在 `quotaAwareScheduling === true` 时将手动刷新的配额样本同步至 `accountProvider.updateQuota(...)`，并在配置切换或重置时同步/清理。
- `src/runtime/doctor.ts`（新增）：实现脱敏的 `formatAgyStatusReport(status)` 与只读自检 `runAgyDoctor(deps, signal)`（覆盖 `agy` 二进制与版本、宿主只读沙箱完整性、出口地域与代理模式、模型目录连通性、本机配置文件与会话索引状态）。
- `src/index.ts`：升级 `/agy-acp` 命令定义（声明 `input: { hint: '[status | doctor]' }`），分发默认状态报告、`doctor` 自检与非法子命令提示。
- `src/client/account-display.ts`、`src/client/account-card.ts`、`src/client/index.ts`：新增低配额预警（≤15%）徽标展示与设置页「配额感知多账号调度」持久化开关。
- `package.json`、`README.md`、`CHANGELOG.md`：同步升级至 `0.4.0` 发布基线并补全文档。

---

## 3. 核心详细设计

### 3.1 配额感知调度与低余量预警
1. **持久化开关 `quotaAwareScheduling`**：默认 `false`（纯观测模式）；开启后，已采集与新刷新的 `AccountQuotaSample` 通过 `mapQuotaGroupsToFamilies` 注入 `MultiAccountPool.updateQuota()`；关闭或重置配置时调用 `clearQuotaSamples()` 清空调度器内的配额权重（保留 UI 观测样本）。
2. **分组映射规则（`mapQuotaGroupsToFamilies`）**：
   - 通用分组（如 `Gemini Models`、`Claude Models`）映射至对应模型族（`gemini-pro` + `gemini-flash` 或 `claude`）；
   - 显式模型族分组（如 `Gemini Pro`、`Gemini Flash`）精确覆盖对应族；
   - 专用变体子池（如 `Gemini 4 Argon`）仅在无通用分组时按最大可用余量兜底，避免单一实验变体耗尽误封整个 `gemini-pro` 模型族。
3. **低配额预警（`LOW_QUOTA_THRESHOLD = 0.15`）**：当任意未过期窗口剩余比例 `<= 15%` 时，`AccountCard` 在对应窗口与卡片状态展示醒目预警提示（`0%` 标红、`<=15%` 标黄）。

### 3.2 `/agy-acp` 结构化状态与 `/agy-acp doctor` 自检
- `/agy-acp` 或 `/agy-acp status`：输出中文结构化运行面板（连接与套餐、活跃/已索引会话、地域防护与配置状态、反向 MCP 统计、逐账号出口合规与冷却/低配额摘要、累计 Token 与最近脱敏错误）。
- `/agy-acp doctor`：顺序执行 5 项只读检查并汇总 `[PASS]` / `[WARN]` / `[FAIL]`：
  1. `agy` CLI 路径与版本检测（在宿主 `read-only` 沙箱约束下运行 `--version`）；
  2. 宿主只读沙箱 `sandbox.confine` 强制约束检查（拒绝 `partial` 降级）；
  3. 启用账号网络出口探测与 Google 地域支持性检查；
  4. ACP 模型目录可用性检查（已缓存或只读拉取验证）；
  5. 本机 `config.json` 与 `sessions.json` 存储状态检查。
  全部文本均经过 `sanitizeDiagnosticText` 处理，杜绝泄露任何凭据或原始代理 URL。

---

## 4. 验证与测试矩阵

全部通过 `pnpm run verify`（`lint:arch` + `tsc --noEmit` + `tsdown` + `node --test`）：
1. **配额映射与调度联动单测（`test/account-quota.test.ts`、`test/account-status.test.ts`、`test/config-store.test.ts`）**：验证 `quotaAwareScheduling` 持久化校验、`mapQuotaGroupsToFamilies` 通用池/专用池优先级、开启后优先选高余量账号及关闭后即时清除调度权重。
2. **诊断命令与 `doctor` 自检测试（`test/doctor.test.ts`）**：验证 `/agy-acp` 状态输出、`/agy-acp doctor` 在正常/受限出口/沙箱不可用/缺少二进制各场景下的只读自检与凭据脱敏、未知子命令报错。
3. **前端低配额预警与开关渲染测试（`test/account-display.test.ts`）**：验证 `<=15%` / `0%` 预警徽标与 `SettingsView` 配额调度开关渲染。
