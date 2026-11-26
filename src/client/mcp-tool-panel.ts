// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import {
  DEFAULT_MAX_EAGER_SCHEMA_BYTES,
  matchMcpPolicyPreset,
  MCP_TOOL_POLICY_PRESETS,
  META_GATEWAY_ESTIMATED_BYTES,
  REPLACE_GROUPS,
  resolveEffectiveMcpToolPolicy,
  resolveToolExposure,
  SUPPLEMENT_GROUPS,
  type EffectiveMcpToolPolicy,
  type McpToolPolicyConfig,
  type ReplaceGroupId,
  type ReplaceGroupMode,
  type SupplementGroupId,
  type SupplementGroupMode,
  type ToolExposureMode,
} from '../common/mcp-tool-policy.ts'
import type { McpToolCatalogEntry, McpToolCatalogSnapshot } from '../common/types.ts'
import { theme } from './theme.ts'
import { ProgressBar, SegmentedControl, type SegmentOption } from './ui-primitives.ts'

const h = React.createElement

export interface LivePolicyBudget {
  eagerCount: number
  lazyCount: number
  offCount: number
  estimatedEagerBytes: number
  budgetBytes: number
  willCompact: boolean
  countsByGroup: Record<string, number>
}

export function computeLivePolicyBudget(
  catalog: McpToolCatalogSnapshot | undefined,
  policy: EffectiveMcpToolPolicy,
): LivePolicyBudget {
  const budgetBytes = catalog?.budgetBytes ?? DEFAULT_MAX_EAGER_SCHEMA_BYTES
  const countsByGroup: Record<string, number> = {}
  let eagerCount = 0
  let lazyCount = 0
  let offCount = 0
  let estimatedEagerBytes = 0

  for (const item of catalog?.tools ?? []) {
    countsByGroup[item.groupId] = (countsByGroup[item.groupId] ?? 0) + 1
    const { mode } = resolveToolExposure(item.name, policy)
    if (mode === 'eager') {
      eagerCount++
      estimatedEagerBytes += item.estimatedBytes
    } else if (mode === 'lazy') {
      lazyCount++
    } else {
      offCount++
    }
  }

  if (lazyCount > 0) {
    estimatedEagerBytes += META_GATEWAY_ESTIMATED_BYTES
  }

  return {
    eagerCount,
    lazyCount,
    offCount,
    estimatedEagerBytes,
    budgetBytes,
    willCompact: estimatedEagerBytes > budgetBytes,
    countsByGroup,
  }
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function modeLabel(mode: ToolExposureMode): string {
  if (mode === 'eager') return '直出'
  if (mode === 'lazy') return '按需'
  return '关闭'
}

const SUPPLEMENT_OPTIONS: readonly SegmentOption<SupplementGroupMode>[] = [
  { value: 'eager', label: '直出', title: '直出（无损常驻）', accent: true },
  { value: 'lazy', label: '按需', title: '按需发现（网关）' },
  { value: 'off', label: '关闭', title: '关闭' },
]

const REPLACE_OPTIONS: readonly SegmentOption<ReplaceGroupMode>[] = [
  { value: 'native', label: '原生', title: '使用 agy 原生' },
  { value: 'replace', label: 'DSH 替代', title: '用 DSH 替代（直出+引导）', accent: true },
  { value: 'lazy', label: '按需并存', title: '两者并存（DSH 按需）' },
]

interface ToolOverrideRowProps {
  tool: McpToolCatalogEntry
  explicit: ToolExposureMode | ''
  inheritedMode: ToolExposureMode
  onChangeOverride: (toolName: string, mode: ToolExposureMode | '') => void
}

const ToolOverrideRow = React.memo(function ToolOverrideRow({
  tool,
  explicit,
  inheritedMode,
  onChangeOverride,
}: ToolOverrideRowProps): unknown {
  return h(
    'div',
    { className: 'agy-acp-list-row', style: { padding: '7px 10px' } },
    h(
      'div',
      { style: { flex: '1 1 220px', minWidth: 0 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        h('code', { style: { fontSize: '12px', fontWeight: 500 } }, tool.name),
        h('span', { className: 'agy-acp-caption', style: { fontVariantNumeric: 'tabular-nums' } }, formatKb(tool.estimatedBytes)),
        explicit
          ? h('span', { className: 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--info' }, '已覆写')
          : null,
      ),
      tool.description
        ? h(
            'div',
            {
              className: 'agy-acp-caption',
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' },
            },
            tool.description,
          )
        : null,
    ),
    h(
      'select',
      {
        'aria-label': `工具 ${tool.name} 暴露模式`,
        value: explicit,
        onChange: (e: { target: { value: string } }) =>
          onChangeOverride(tool.name, e.target.value as ToolExposureMode | ''),
        className: 'agy-acp-select agy-acp-select--sm',
        style: { width: 'auto', minWidth: '132px' },
      },
      h('option', { value: '' }, `跟随分组（${modeLabel(inheritedMode)}）`),
      h('option', { value: 'eager' }, '强制直出'),
      h('option', { value: 'lazy' }, '强制按需'),
      h('option', { value: 'off' }, '强制关闭'),
    ),
  )
})

export interface McpToolPolicyPanelProps {
  enabled: boolean
  policy: EffectiveMcpToolPolicy
  catalog?: McpToolCatalogSnapshot
  onChangeGroup: (groupId: SupplementGroupId, mode: SupplementGroupMode) => void
  onChangeReplace: (groupId: ReplaceGroupId, mode: ReplaceGroupMode) => void
  onChangeOverride: (toolName: string, mode: ToolExposureMode | '') => void
  onApplyPreset?: (policy: EffectiveMcpToolPolicy) => void
  onClearOverrides: () => void
  onResetPolicyDefaults: () => void
}

export const McpToolPolicyPanel = React.memo(function McpToolPolicyPanel({
  enabled,
  policy,
  catalog,
  onChangeGroup,
  onChangeReplace,
  onChangeOverride,
  onApplyPreset,
  onClearOverrides,
  onResetPolicyDefaults,
}: McpToolPolicyPanelProps): unknown {
  const [overridesExpanded, setOverridesExpanded] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const deferredFilter: string =
    typeof React.useDeferredValue === 'function' ? React.useDeferredValue(filter) : filter

  const live = React.useMemo(() => computeLivePolicyBudget(catalog, policy), [catalog, policy])
  const activePresetId = React.useMemo(() => matchMcpPolicyPreset(policy), [policy])
  const policyWithoutOverrides = React.useMemo(
    () => ({ groups: policy.groups, replace: policy.replace, overrides: {} }),
    [policy.groups, policy.replace],
  )

  const visibleTools: McpToolCatalogEntry[] = React.useMemo(() => {
    if (!overridesExpanded) return []
    const all = catalog?.tools ?? []
    const q = deferredFilter.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.groupId.toLowerCase().includes(q),
    )
  }, [overridesExpanded, catalog, deferredFilter])

  if (!enabled) return null

  const hasLiveCatalog = Boolean(catalog && catalog.tools.length > 0)
  const pct = live.budgetBytes > 0 ? Math.min(100, (100 * live.estimatedEagerBytes) / live.budgetBytes) : 0
  const barColor = live.willCompact
    ? theme.stateError
    : pct > 80
      ? theme.stateWarn
      : theme.accentBlue

  const overrideCount = Object.keys(policy.overrides).length

  const applyPreset = (presetPolicy: McpToolPolicyConfig): void => {
    const resolved = resolveEffectiveMcpToolPolicy(presetPolicy)
    if (onApplyPreset) {
      onApplyPreset(resolved)
    } else {
      onResetPolicyDefaults()
    }
  }

  return h(
    'div',
    { style: { marginTop: '12px' } },
    // Header + quick presets
    h(
      'div',
      { className: 'agy-acp-section-head', style: { marginBottom: '8px' } },
      h(
        'div',
        null,
        h('div', { style: { fontWeight: 600, fontSize: '13px' } }, '反向 MCP 工具策略'),
        h(
          'div',
          { className: 'agy-acp-caption' },
          '高频工具无损直出，低频与扩展工具通过 dsh_discover_tools / dsh_call_tool 按需发现。',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: onResetPolicyDefaults,
          className: 'agy-acp-btn agy-acp-btn--sm',
        },
        '恢复推荐默认',
      ),
    ),

    // Quick preset chips
    h(
      'div',
      { className: 'agy-acp-preset-bar', role: 'group', 'aria-label': '工具策略快捷预设' },
      ...MCP_TOOL_POLICY_PRESETS.map((preset) =>
        h(
          'button',
          {
            key: preset.id,
            type: 'button',
            'aria-pressed': activePresetId === preset.id,
            title: preset.description,
            className: 'agy-acp-preset-chip',
            onClick: () => applyPreset(preset.policy),
          },
          preset.label,
        ),
      ),
    ),

    // Live Eager schema budget bar
    h(
      'div',
      {
        style: {
          padding: '10px 12px',
          borderRadius: '10px',
          border: theme.borderSubtle,
          backgroundColor: theme.surfaceTile,
          marginBottom: '12px',
        },
      },
      h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            fontSize: '12px',
          },
        },
        h(
          'span',
          null,
          hasLiveCatalog
            ? `已检测 ${catalog!.tools.length} 个宿主工具：直出 ${live.eagerCount} · 按需 ${live.lazyCount} · 关闭 ${live.offCount}`
            : '尚未读取到宿主工具清单（DSH 工具服务就绪后自动更新预算估算）',
        ),
        hasLiveCatalog
          ? h(
              'span',
              {
                style: {
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  color: live.willCompact ? theme.stateError : pct > 80 ? theme.stateWarn : theme.stateSuccess,
                },
              },
              `${formatKb(live.estimatedEagerBytes)} / ${formatKb(live.budgetBytes)} 安全线`,
            )
          : null,
      ),
      hasLiveCatalog
        ? h(ProgressBar, {
            valuePct: pct,
            ariaLabel: '直出工具 Schema 安全预算占用',
            color: barColor,
            style: { marginTop: '7px' },
          })
        : null,
      live.willCompact
        ? h(
            'div',
            { style: { fontSize: '11px', color: theme.stateWarn, marginTop: '6px' } },
            '已超出无损安全线，运行时将自动触发兜底描述裁剪以防止 agy 静默丢弃工具；建议将部分低频分组改回「按需」。',
          )
        : null,
    ),

    // Section A: Supplement groups
    h(
      'div',
      { style: { marginBottom: '12px' } },
      h(
        'div',
        { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: theme.textSecondary } },
        '补充能力（agy 原生没有的 DSH 工具）',
      ),
      h(
        'div',
        { className: 'agy-acp-list' },
        ...SUPPLEMENT_GROUPS.map((g) => {
          const count = live.countsByGroup[g.id] ?? 0
          return h(
            'div',
            { key: g.id, className: 'agy-acp-list-row' },
            h(
              'div',
              { style: { flex: '1 1 240px', minWidth: 0 } },
              h(
                'div',
                { style: { fontSize: '12.5px', fontWeight: 500 } },
                `${g.label}${hasLiveCatalog ? ` (${count})` : ''}`,
              ),
              h('div', { className: 'agy-acp-caption' }, g.description),
            ),
            h(SegmentedControl<SupplementGroupMode>, {
              ariaLabel: `补充能力分组 ${g.label}`,
              value: policy.groups[g.id],
              options: SUPPLEMENT_OPTIONS,
              onChange: (mode: SupplementGroupMode) => onChangeGroup(g.id, mode),
            }),
          )
        }),
      ),
    ),

    // Section B: Replace native agy groups
    h(
      'div',
      { style: { marginBottom: '12px' } },
      h(
        'div',
        { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px', color: theme.textSecondary } },
        '替代能力（与 agy 原生工具重叠）',
      ),
      h(
        'div',
        { className: 'agy-acp-caption', style: { marginBottom: '6px' } },
        '选择「DSH 替代」会直出对应 DSH 工具并注入优先路由引导（软替代；agy 协议层仍保留原生工具声明）。',
      ),
      h(
        'div',
        { className: 'agy-acp-list' },
        ...REPLACE_GROUPS.map((g) => {
          const count = live.countsByGroup[g.id] ?? 0
          return h(
            'div',
            { key: g.id, className: 'agy-acp-list-row' },
            h(
              'div',
              { style: { flex: '1 1 240px', minWidth: 0 } },
              h(
                'div',
                { style: { fontSize: '12.5px', fontWeight: 500 } },
                `${g.label}${hasLiveCatalog ? ` (${count})` : ''}`,
              ),
              h('div', { className: 'agy-acp-caption' }, `${g.description} · 原生：${g.nativeLabel}`),
            ),
            h(SegmentedControl<ReplaceGroupMode>, {
              ariaLabel: `替代能力分组 ${g.label}`,
              value: policy.replace[g.id],
              options: REPLACE_OPTIONS,
              onChange: (mode: ReplaceGroupMode) => onChangeReplace(g.id, mode),
            }),
          )
        }),
      ),
    ),

    // Section C: Controlled lazy-rendered per-tool overrides (ZERO DOM rows while collapsed!)
    h(
      'div',
      { className: 'agy-acp-collapsible' },
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': overridesExpanded,
          className: 'agy-acp-collapse-trigger',
          onClick: () => setOverridesExpanded((v: boolean) => !v),
        },
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { fontSize: '10px', opacity: 0.7 } }, overridesExpanded ? '▼' : '▶'),
          '高级：逐工具精细覆写',
          overrideCount > 0
            ? h('span', { className: 'agy-acp-pill agy-acp-pill--sm agy-acp-pill--info' }, `已覆写 ${overrideCount} 项`)
            : null,
        ),
        h('span', { className: 'agy-acp-caption' }, overridesExpanded ? '收起' : `展开${hasLiveCatalog ? ` (${catalog!.tools.length})` : ''}`),
      ),
      overridesExpanded
        ? h(
            'div',
            { className: 'agy-acp-collapsible-body' },
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } },
              h('input', {
                type: 'text',
                'aria-label': '筛选宿主工具',
                'data-agy-ignore-edit': 'true',
                value: filter,
                placeholder: '按工具名、分组或说明筛选…',
                onChange: (e: { target: { value: string } }) => setFilter(e.target.value),
                className: 'agy-acp-input agy-acp-input--sm',
                style: { flex: '1 1 200px' },
              }),
              overrideCount > 0
                ? h(
                    'button',
                    { type: 'button', onClick: onClearOverrides, className: 'agy-acp-btn agy-acp-btn--sm' },
                    '清除全部覆写',
                  )
                : null,
            ),
            !hasLiveCatalog
              ? h('div', { className: 'agy-acp-caption' }, '暂未读取到已注册的 DSH 工具列表。')
              : visibleTools.length === 0
                ? h('div', { className: 'agy-acp-caption' }, '没有匹配当前筛选条件的工具。')
                : h(
                    'div',
                    { className: 'agy-acp-list', style: { maxHeight: '280px', overflowY: 'auto' } },
                    ...visibleTools.map((t) => {
                      const explicit = Object.hasOwn(policy.overrides, t.name) ? policy.overrides[t.name]! : ''
                      const withoutOverride = resolveToolExposure(t.name, policyWithoutOverrides)
                      return h(ToolOverrideRow, {
                        key: t.name,
                        tool: t,
                        explicit,
                        inheritedMode: withoutOverride.mode,
                        onChangeOverride,
                      })
                    }),
                  ),
          )
        : null,
    ),
  )
})
