// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import {
  DEFAULT_MAX_EAGER_SCHEMA_BYTES,
  META_GATEWAY_ESTIMATED_BYTES,
  REPLACE_GROUPS,
  resolveToolExposure,
  SUPPLEMENT_GROUPS,
  type EffectiveMcpToolPolicy,
  type ReplaceGroupId,
  type ReplaceGroupMode,
  type SupplementGroupId,
  type SupplementGroupMode,
  type ToolExposureMode,
} from '../common/mcp-tool-policy.ts'
import type { McpToolCatalogSnapshot } from '../common/types.ts'
import { styles, theme } from './theme.ts'

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

export interface McpToolPolicyPanelProps {
  enabled: boolean
  policy: EffectiveMcpToolPolicy
  catalog?: McpToolCatalogSnapshot
  onChangeGroup: (groupId: SupplementGroupId, mode: SupplementGroupMode) => void
  onChangeReplace: (groupId: ReplaceGroupId, mode: ReplaceGroupMode) => void
  onChangeOverride: (toolName: string, mode: ToolExposureMode | '') => void
  onClearOverrides: () => void
  onResetPolicyDefaults: () => void
}

export function McpToolPolicyPanel({
  enabled,
  policy,
  catalog,
  onChangeGroup,
  onChangeReplace,
  onChangeOverride,
  onClearOverrides,
  onResetPolicyDefaults,
}: McpToolPolicyPanelProps): unknown {
  const [filter, setFilter] = React.useState('')

  if (!enabled) return null

  const live = computeLivePolicyBudget(catalog, policy)
  const hasLiveCatalog = Boolean(catalog && catalog.tools.length > 0)
  const pct = live.budgetBytes > 0 ? Math.min(100, (100 * live.estimatedEagerBytes) / live.budgetBytes) : 0
  const barColor = live.willCompact
    ? theme.stateError
    : pct > 80
      ? theme.stateWarn
      : theme.brandPrimary

  const overrideEntries = Object.entries(policy.overrides)
  const normalizedFilter = filter.trim().toLowerCase()
  const visibleTools = (catalog?.tools ?? []).filter((t) => {
    if (!normalizedFilter) return true
    return (
      t.name.toLowerCase().includes(normalizedFilter) ||
      t.description.toLowerCase().includes(normalizedFilter) ||
      t.groupId.toLowerCase().includes(normalizedFilter)
    )
  })

  return React.createElement(
    'div',
    {
      style: {
        padding: '10px 12px',
        borderRadius: '8px',
        border: theme.borderPrimary,
        backgroundColor: theme.surfaceTile,
        marginBottom: '12px',
      },
    },
    React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          marginBottom: '6px',
        },
      },
      React.createElement(
        'div',
        null,
        React.createElement('div', { style: { fontWeight: 500 } }, '反向 MCP 工具策略（补充与替代原生能力）'),
        React.createElement(
          'div',
          { style: { ...styles.secondaryText, fontSize: '11px' } },
          '高频工具保持无损直出，低频与扩展插件默认通过 dsh_discover_tools / dsh_call_tool 按需发现调用。',
        ),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: onResetPolicyDefaults,
          style: styles.ghostButton,
        },
        '恢复推荐默认',
      ),
    ),

    // Live Eager schema budget bar
    React.createElement(
      'div',
      {
        style: {
          padding: '8px 10px',
          borderRadius: '6px',
          border: theme.borderPrimary,
          backgroundColor: theme.surfaceCard,
          marginBottom: '10px',
        },
      },
      React.createElement(
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
        React.createElement(
          'span',
          null,
          hasLiveCatalog
            ? `当前宿主共检测到 ${catalog!.tools.length} 个工具：直出 ${live.eagerCount} · 按需 ${live.lazyCount} · 关闭 ${live.offCount}`
            : '尚未读取到宿主工具清单（DSH 工具服务就绪后自动更新预算估算）',
        ),
        hasLiveCatalog
          ? React.createElement(
              'span',
              {
                style: {
                  fontWeight: 500,
                  color: live.willCompact ? theme.stateError : pct > 80 ? theme.stateWarn : theme.stateSuccess,
                },
              },
              `预计直出体积 ${formatKb(live.estimatedEagerBytes)} / ${formatKb(live.budgetBytes)} 安全线`,
            )
          : null,
      ),
      hasLiveCatalog
        ? React.createElement(
            'div',
            {
              role: 'progressbar',
              'aria-label': '直出工具 Schema 安全预算占用',
              'aria-valuenow': Math.round(pct),
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              style: {
                marginTop: '6px',
                height: '5px',
                borderRadius: '999px',
                backgroundColor: theme.surfaceTile,
                overflow: 'hidden',
              },
            },
            React.createElement('div', {
              style: {
                width: `${pct.toFixed(1)}%`,
                height: '100%',
                backgroundColor: barColor,
              },
            }),
          )
        : null,
      live.willCompact
        ? React.createElement(
            'div',
            { style: { fontSize: '11px', color: theme.stateWarn, marginTop: '5px' } },
            '已超出无损安全线，运行时将自动触发兜底描述裁剪以防止 agy 静默丢弃工具；建议将部分低频分组改回“按需发现”。',
          )
        : null,
    ),

    // Section A: Supplement groups
    React.createElement(
      'div',
      { style: { marginBottom: '10px' } },
      React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } }, '补充能力（agy 原生没有的 DSH 工具）'),
      React.createElement(
        'div',
        { style: { display: 'grid', gap: '6px' } },
        ...SUPPLEMENT_GROUPS.map((g) => {
          const count = live.countsByGroup[g.id] ?? 0
          return React.createElement(
            'div',
            {
              key: g.id,
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                padding: '6px 8px',
                borderRadius: '6px',
                border: theme.borderPrimary,
                backgroundColor: theme.surfaceCard,
              },
            },
            React.createElement(
              'div',
              { style: { flex: '1 1 260px', minWidth: 0 } },
              React.createElement(
                'div',
                { style: { fontSize: '12px', fontWeight: 500 } },
                `${g.label}${hasLiveCatalog ? ` (${count})` : ''}`,
              ),
              React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, g.description),
            ),
            React.createElement(
              'select',
              {
                'aria-label': `补充能力分组 ${g.label}`,
                value: policy.groups[g.id],
                onChange: (e: { target: { value: string } }) =>
                  onChangeGroup(g.id, e.target.value as SupplementGroupMode),
                style: { ...styles.input, width: 'auto', minWidth: '150px', fontSize: '12px', padding: '4px 8px' },
              },
              React.createElement('option', { value: 'eager' }, '直出（无损常驻）'),
              React.createElement('option', { value: 'lazy' }, '按需发现（网关）'),
              React.createElement('option', { value: 'off' }, '关闭'),
            ),
          )
        }),
      ),
    ),

    // Section B: Replace native agy groups
    React.createElement(
      'div',
      { style: { marginBottom: '10px' } },
      React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px' } }, '替代能力（与 agy 原生工具重叠）'),
      React.createElement(
        'div',
        { style: { ...styles.secondaryText, fontSize: '11px', marginBottom: '6px' } },
        '选择“用 DSH 替代”会直出对应 DSH 工具并注入优先路由指令（软替代；agy 协议层仍保留原生工具声明）。',
      ),
      React.createElement(
        'div',
        { style: { display: 'grid', gap: '6px' } },
        ...REPLACE_GROUPS.map((g) => {
          const count = live.countsByGroup[g.id] ?? 0
          return React.createElement(
            'div',
            {
              key: g.id,
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                padding: '6px 8px',
                borderRadius: '6px',
                border: theme.borderPrimary,
                backgroundColor: theme.surfaceCard,
              },
            },
            React.createElement(
              'div',
              { style: { flex: '1 1 260px', minWidth: 0 } },
              React.createElement(
                'div',
                { style: { fontSize: '12px', fontWeight: 500 } },
                `${g.label}${hasLiveCatalog ? ` (${count})` : ''}`,
              ),
              React.createElement(
                'div',
                { style: { ...styles.secondaryText, fontSize: '11px' } },
                `${g.description} · 对应 agy 原生：${g.nativeLabel}`,
              ),
            ),
            React.createElement(
              'select',
              {
                'aria-label': `替代能力分组 ${g.label}`,
                value: policy.replace[g.id],
                onChange: (e: { target: { value: string } }) =>
                  onChangeReplace(g.id, e.target.value as ReplaceGroupMode),
                style: { ...styles.input, width: 'auto', minWidth: '170px', fontSize: '12px', padding: '4px 8px' },
              },
              React.createElement('option', { value: 'native' }, '使用 agy 原生'),
              React.createElement('option', { value: 'replace' }, '用 DSH 替代（直出+引导）'),
              React.createElement('option', { value: 'lazy' }, '两者并存（DSH 按需）'),
            ),
          )
        }),
      ),
    ),

    // Section C: Advanced per-tool overrides
    React.createElement(
      'details',
      null,
      React.createElement(
        'summary',
        { style: { cursor: 'pointer', fontSize: '12px', fontWeight: 500 } },
        `高级：逐工具精细覆写${overrideEntries.length > 0 ? `（已覆写 ${overrideEntries.length} 项）` : ''}`,
      ),
      React.createElement(
        'div',
        { style: { marginTop: '8px' } },
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } },
          React.createElement('input', {
            type: 'text',
            'aria-label': '筛选宿主工具',
            value: filter,
            placeholder: '按工具名、分组或说明筛选…',
            onChange: (e: { target: { value: string } }) => setFilter(e.target.value),
            style: { ...styles.input, flex: '1 1 200px', fontSize: '12px', padding: '5px 8px' },
          }),
          overrideEntries.length > 0
            ? React.createElement(
                'button',
                { type: 'button', onClick: onClearOverrides, style: styles.ghostButton },
                '清除全部覆写',
              )
            : null,
        ),
        !hasLiveCatalog
          ? React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '暂未读取到已注册的 DSH 工具列表。')
          : visibleTools.length === 0
            ? React.createElement('div', { style: { ...styles.secondaryText, fontSize: '11px' } }, '没有匹配当前筛选条件的工具。')
            : React.createElement(
                'div',
                { style: { display: 'grid', gap: '4px', maxHeight: '260px', overflowY: 'auto', paddingRight: '2px' } },
                ...visibleTools.map((t) => {
                  const explicit = Object.hasOwn(policy.overrides, t.name) ? policy.overrides[t.name]! : ''
                  const withoutOverride = resolveToolExposure(t.name, { ...policy, overrides: {} })
                  return React.createElement(
                    'div',
                    {
                      key: t.name,
                      style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '5px 8px',
                        borderRadius: '6px',
                        border: theme.borderPrimary,
                        backgroundColor: theme.surfaceCard,
                      },
                    },
                    React.createElement(
                      'div',
                      { style: { flex: '1 1 220px', minWidth: 0 } },
                      React.createElement(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                        React.createElement('code', { style: { fontSize: '12px', fontWeight: 500 } }, t.name),
                        React.createElement(
                          'span',
                          { style: { ...styles.secondaryText, fontSize: '10px' } },
                          formatKb(t.estimatedBytes),
                        ),
                      ),
                      t.description
                        ? React.createElement(
                            'div',
                            { style: { ...styles.secondaryText, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                            t.description,
                          )
                        : null,
                    ),
                    React.createElement(
                      'select',
                      {
                        'aria-label': `工具 ${t.name} 暴露模式`,
                        value: explicit,
                        onChange: (e: { target: { value: string } }) =>
                          onChangeOverride(t.name, e.target.value as ToolExposureMode | ''),
                        style: { ...styles.input, width: 'auto', minWidth: '140px', fontSize: '11px', padding: '3px 6px' },
                      },
                      React.createElement('option', { value: '' }, `跟随分组（${modeLabel(withoutOverride.mode)}）`),
                      React.createElement('option', { value: 'eager' }, '强制直出'),
                      React.createElement('option', { value: 'lazy' }, '强制按需'),
                      React.createElement('option', { value: 'off' }, '强制关闭'),
                    ),
                  )
                }),
              ),
      ),
    ),
  )
}
