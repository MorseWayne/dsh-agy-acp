// Native-feeling DSH conversation panel renderer for `agy_acp_tool` (`tool.call.toolview` slot).
// Uses `@deepseek-ai/dsh-client-ui-primitives` provided by DSH's `PLATFORM_MODULES` when running
// inside DSH Web, with a clean self-contained fallback when primitives are unavailable.

// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import {
  deriveAgyMirrorRowModel,
  type AgyMirrorRowViewModel,
  type AgyStepsCardData,
  type AgyToolBlockLike,
  type AgyToolCategory,
} from './mirror-tool-model.ts'
import { ensureAgyAcpStyles } from './theme.ts'

const h = React.createElement

declare const require: ((id: string) => unknown) | undefined

interface PrimitivesModule {
  DisclosureRow?: React.ComponentType<Record<string, unknown>>
  TextShimmer?: React.ComponentType<Record<string, unknown>>
  TerminalBlock?: React.ComponentType<Record<string, unknown>>
  DiffBlock?: React.ComponentType<Record<string, unknown>>
  ReadBlock?: React.ComponentType<Record<string, unknown>>
  SearchBlock?: React.ComponentType<Record<string, unknown>>
  WebBlock?: React.ComponentType<Record<string, unknown>>
  Tag?: React.ComponentType<Record<string, unknown>>
  diffTotals?: (diffs: ReadonlyArray<{ path: string; oldText: string | null; newText: string }>) => { added: number; removed: number }
  IconApiOutlineRegular?: React.ComponentType<{ size?: number }>
  IconBrowseOutlineRegular?: React.ComponentType<{ size?: number }>
  IconEditOutlineRegular?: React.ComponentType<{ size?: number }>
  IconSearchOutlineRegular?: React.ComponentType<{ size?: number }>
  IconGlobeOutlineRegular?: React.ComponentType<{ size?: number }>
  IconChecklistOutlineRegular?: React.ComponentType<{ size?: number }>
  IconUsersOutlineRegular?: React.ComponentType<{ size?: number }>
  IconClockOutlineRegular?: React.ComponentType<{ size?: number }>
  IconSparkleRegular?: React.ComponentType<{ size?: number }>
  IconInspectOutlineRegular?: React.ComponentType<{ size?: number }>
  IconCheckOutlineRegular?: React.ComponentType<{ size?: number }>
  IconPlayOutlineRegular?: React.ComponentType<{ size?: number }>
}

let cachedPrimitives: PrimitivesModule | null | undefined

function getPrimitives(): PrimitivesModule | null {
  if (cachedPrimitives !== undefined) return cachedPrimitives
  try {
    if (typeof require === 'function') {
      const mod = require('@deepseek-ai/dsh-client-ui-primitives')
      if (mod && typeof mod === 'object') {
        cachedPrimitives = mod as PrimitivesModule
        return cachedPrimitives
      }
    }
  } catch {
    // Running outside DSH web (e.g., Node unit tests or older host)
  }
  cachedPrimitives = null
  return null
}

export interface AgyToolViewSlotProps {
  useDisclosure?: () => { expanded: boolean; toggle: () => void }
  callId: string
  toolName: string
  cwd?: string
  home?: string
  openFile?: (path: string, options?: { line?: number }) => void
  inspect?: () => void
  phase: 'preparing' | 'start' | 'result'
  block: AgyToolBlockLike
}

function detectLocale(): 'zh' | 'en' {
  if (typeof document !== 'undefined') {
    const lang = (document.documentElement?.lang || '').toLowerCase()
    if (lang.startsWith('en')) return 'en'
    if (lang.startsWith('zh')) return 'zh'
  }
  if (typeof navigator !== 'undefined') {
    const lang = (navigator.language || '').toLowerCase()
    if (lang.startsWith('en')) return 'en'
  }
  return 'zh'
}

function buildCopy(zh: boolean) {
  const codeToolbar = {
    codeLabel: zh ? '代码' : 'Code',
    wrapLabel: zh ? '自动换行' : 'Wrap lines',
    unwrapLabel: zh ? '取消换行' : 'Unwrap lines',
  }
  const copy = zh ? '复制' : 'Copy'
  const copied = zh ? '已复制' : 'Copied'
  const collapse = zh ? '收起' : 'Collapse'

  return {
    input: zh ? '输入' : 'IN',
    output: zh ? '输出' : 'OUT',
    inspect: zh ? '查看' : 'Inspect',
    preparing: zh ? '正在准备调用' : 'Preparing tool call',
    running: zh ? '运行中' : 'Running',
    failed: zh ? '失败' : 'Failed',
    stopped: zh ? '已停止' : 'Stopped',
    stepStatus: {
      done: zh ? '已完成' : 'Completed',
      in_progress: zh ? '进行中' : 'In progress',
      pending: zh ? '待处理' : 'Pending',
      skipped: zh ? '已跳过' : 'Skipped',
      failed: zh ? '失败' : 'Failed',
    },
    terminal: {
      commandLine: (n: number) => (zh ? `命令第 ${n} 行` : `Command line ${n}`),
      signal: (s: string) => (zh ? `信号 ${s}` : `signal ${s}`),
      exitCode: (c: number) => (zh ? `退出码 ${c}` : `exit code ${c}`),
      noExitCode: zh ? '未正常退出' : 'no exit code',
      running: zh ? '运行中' : 'Running',
      failed: zh ? '失败' : 'Failed',
      done: zh ? '已完成' : 'Done',
      copy,
      copied,
      noOutput: zh ? '无输出' : 'No output',
      collapseAria: zh ? '收起输出' : 'Collapse output',
      collapse,
      expandAria: (n: number) => (zh ? `展开其余 ${n} 行输出` : `Expand the remaining ${n} output lines`),
      expand: (n: number) => (zh ? `… 其余 ${n} 行` : `… ${n} more lines`),
    },
    diff: {
      ...codeToolbar,
      copy,
      copied,
      collapseAria: zh ? '收起差异' : 'Collapse diff',
      expandAria: (n: number) => (zh ? `展开其余 ${n} 行差异` : `Expand ${n} more diff lines`),
      collapse,
      expand: (n: number) => (zh ? `… 其余 ${n} 行` : `… ${n} more lines`),
    },
    read: {
      ...codeToolbar,
      window: (shown: number, total: number) => (zh ? `显示 ${shown} / ${total} 行` : `Showing ${shown} of ${total} lines`),
      copy,
      copied,
      collapseAria: zh ? '收起内容' : 'Collapse content',
      expandAria: (n: number) => (zh ? `展开其余 ${n} 行` : `Expand ${n} more lines`),
      collapse,
      expand: (n: number) => (zh ? `… 其余 ${n} 行` : `… ${n} more lines`),
    },
    search: {
      pathsSummary: (shown: number, total: number, truncated: boolean) =>
        truncated
          ? (zh ? `显示 ${shown} / 共 ${total} 个路径` : `Showing ${shown} of ${total} paths`)
          : (zh ? `${shown} 个路径` : `${shown} paths`),
      matchesSummary: (shown: number, total: number, files: number, truncated: boolean) =>
        truncated
          ? (zh ? `显示 ${shown} / 共 ${total} 处匹配 · ${files} 个文件` : `Showing ${shown} of ${total} matches · ${files} files`)
          : (zh ? `${shown} 处匹配 · ${files} 个文件` : `${shown} matches · ${files} files`),
      copy,
      copied,
      noResults: zh ? '无结果' : 'No results',
      collapseAria: zh ? '收起结果' : 'Collapse results',
      expandAria: (n: number) => (zh ? `展开其余 ${n} 行结果` : `Expand ${n} more result lines`),
      collapse,
      expand: (n: number) => (zh ? `… 其余 ${n} 行` : `… ${n} more lines`),
    },
    web: {
      noResults: zh ? '未找到结果' : 'No results found',
      sourcesTruncated: zh ? '来源列表已截断' : 'Source list truncated',
      http: 'HTTP',
      contentTruncated: zh ? '内容已截断' : 'Content truncated',
      markdown: {
        code: { copyLabel: copy, copiedLabel: copied, toolbarLabels: codeToolbar },
        footnotes: zh ? '脚注' : 'Footnotes',
      },
    },
  }
}

function renderCategoryIcon(category: AgyToolCategory, prim: PrimitivesModule | null): unknown {
  if (prim) {
    if (category === 'terminal' && prim.IconApiOutlineRegular) return h(prim.IconApiOutlineRegular, { size: 14 })
    if (category === 'diff' && prim.IconEditOutlineRegular) return h(prim.IconEditOutlineRegular, { size: 14 })
    if ((category === 'read' || category === 'web_fetch') && prim.IconBrowseOutlineRegular) {
      return h(prim.IconBrowseOutlineRegular, { size: 14 })
    }
    if (category === 'search' && prim.IconSearchOutlineRegular) return h(prim.IconSearchOutlineRegular, { size: 14 })
    if (category === 'web_search' && prim.IconGlobeOutlineRegular) return h(prim.IconGlobeOutlineRegular, { size: 14 })
    if ((category === 'steps' || category === 'task') && prim.IconChecklistOutlineRegular) {
      return h(prim.IconChecklistOutlineRegular, { size: 14 })
    }
    if (category === 'agent' && prim.IconUsersOutlineRegular) return h(prim.IconUsersOutlineRegular, { size: 14 })
    if (category === 'schedule' && prim.IconClockOutlineRegular) return h(prim.IconClockOutlineRegular, { size: 14 })
    if (category === 'file_op' && prim.IconEditOutlineRegular) return h(prim.IconEditOutlineRegular, { size: 14 })
    if (prim.IconSparkleRegular) return h(prim.IconSparkleRegular, { size: 14 })
  }
  const fallbackGlyph: Record<AgyToolCategory, string> = {
    terminal: '>_',
    diff: '✎',
    read: '◉',
    search: '⌕',
    web_search: '◎',
    web_fetch: '↗',
    steps: '☑',
    agent: '◈',
    schedule: '◷',
    task: '☰',
    file_op: '✎',
    other: '✦',
  }
  return h('span', { className: 'agy-tool-fallback-glyph', 'aria-hidden': true }, fallbackGlyph[category])
}

function computeSimpleDiffTotals(diffs: ReadonlyArray<{ oldText: string | null; newText: string }>): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const d of diffs) {
    const oldLines = d.oldText ? d.oldText.split('\n').length : 0
    const newLines = d.newText ? d.newText.split('\n').length : 0
    if (d.oldText === null) {
      added += newLines
    } else {
      added += newLines
      removed += oldLines
    }
  }
  return { added, removed }
}

function renderStepsCard(steps: AgyStepsCardData, prim: PrimitivesModule | null, copy: ReturnType<typeof buildCopy>): unknown {
  return h(
    'div',
    { className: 'agy-tool-steps-card' },
    h(
      'ul',
      { className: 'agy-tool-steps-list' },
      steps.items.map((item, idx) => {
        const statusGlyph =
          item.status === 'done'
            ? (prim?.IconCheckOutlineRegular ? h(prim.IconCheckOutlineRegular, { size: 13 }) : '✓')
            : item.status === 'in_progress'
              ? (prim?.IconPlayOutlineRegular ? h(prim.IconPlayOutlineRegular, { size: 13 }) : '●')
              : item.status === 'failed'
                ? '✕'
                : item.status === 'skipped'
                  ? '−'
                  : h('span', { className: 'agy-tool-step-box' })
        return h(
          'li',
          { key: `${idx}-${item.title}`, className: 'agy-tool-step-item', 'data-status': item.status },
          h('span', { className: 'agy-tool-step-icon', 'aria-hidden': true }, statusGlyph),
          h('span', { className: 'agy-tool-step-title' }, item.title),
          h('span', { className: 'agy-tool-step-status' }, copy.stepStatus[item.status]),
        )
      }),
    ),
  )
}

function renderIoFallback(
  inputText: string | undefined,
  outputText: string | undefined,
  isError: boolean,
  copy: ReturnType<typeof buildCopy>,
): unknown {
  if (!inputText && !outputText) return null
  return h(
    'div',
    { className: 'agy-tool-io-card' },
    inputText
      ? h(
          'div',
          { className: 'agy-tool-io-section' },
          h('span', { className: 'agy-tool-io-label' }, copy.input),
          h('span', { className: 'agy-tool-io-text' }, inputText),
        )
      : null,
    inputText && outputText ? h('span', { className: 'agy-tool-io-divider', 'aria-hidden': true }) : null,
    outputText
      ? h(
          'div',
          { className: 'agy-tool-io-section' },
          h('span', { className: 'agy-tool-io-label' }, copy.output),
          h('span', { className: 'agy-tool-io-text', 'data-error': isError || undefined }, outputText),
        )
      : null,
  )
}

function renderExpandedCard(
  model: AgyMirrorRowViewModel,
  prim: PrimitivesModule | null,
  copy: ReturnType<typeof buildCopy>,
): unknown {
  if (model.terminal && prim?.TerminalBlock) {
    return h(prim.TerminalBlock, {
      command: model.terminal.command,
      cwd: model.terminal.cwd,
      output: model.terminal.output,
      exitCode: model.terminal.exitCode,
      signal: model.terminal.signal,
      running: model.terminal.running,
      maxLines: Infinity,
      labels: copy.terminal,
      className: 'agy-tool-terminal-body',
    })
  }

  if (model.diff && prim?.DiffBlock) {
    return h(
      React.Fragment,
      null,
      h(prim.DiffBlock, {
        diffs: model.diff.diffs,
        labels: copy.diff,
        maxLines: 9,
        className: 'agy-tool-card-body',
      }),
      model.state === 'error' && model.outputText
        ? renderIoFallback(undefined, model.outputText, true, copy)
        : null,
    )
  }

  if (model.read && prim?.ReadBlock) {
    return h(prim.ReadBlock, {
      label: model.read.label,
      lines: model.read.lines,
      totalLines: model.read.totalLines,
      lang: model.read.lang,
      labels: copy.read,
      maxLines: 8,
      className: 'agy-tool-card-body',
    })
  }

  if (model.search && prim?.SearchBlock) {
    return h(prim.SearchBlock, {
      ...model.search,
      labels: copy.search,
      maxLines: 8,
      className: 'agy-tool-card-body',
    })
  }

  if (model.web && prim?.WebBlock) {
    return h(prim.WebBlock, {
      ...model.web,
      labels: copy.web,
      className: 'agy-tool-card-body',
    })
  }

  if (model.steps) {
    return renderStepsCard(model.steps, prim, copy)
  }

  // Fallback when primitives are unavailable (or generic tool)
  const fallbackInput =
    model.inputText ??
    (model.terminal ? model.terminal.command : undefined) ??
    (model.diff ? model.diff.diffs.map(d => `${d.path}\n${d.newText}`).join('\n---\n') : undefined)
  const fallbackOutput =
    model.outputText ??
    model.terminal?.output ??
    (model.read ? model.read.lines.map(l => `${l.number}: ${l.text}`).join('\n') : undefined)

  return renderIoFallback(fallbackInput, fallbackOutput, model.state === 'error', copy)
}

function useFallbackDisclosure(): { expanded: boolean; toggle: () => void } {
  const [expanded, setExpanded] = React.useState(false)
  const toggle = React.useCallback(() => setExpanded((v: boolean) => !v), [])
  return { expanded, toggle }
}

/**
 * Keyed `tool.call.toolview` renderer for `agy_acp_tool`.
 * Replaces the generic `工具调用 · agy_acp_tool · <runId>` fallback with native DSH
 * per-tool rows (Read, Edit/Write Diff, Terminal, Search, Web, Steps, Subagent, etc.).
 */
export const AgyAcpToolRow = React.memo(function AgyAcpToolRow(props: AgyToolViewSlotProps): unknown {
  React.useEffect(() => {
    ensureAgyAcpStyles()
  }, [])

  const prim = getPrimitives()
  const locale = detectLocale()
  const copy = React.useMemo(() => buildCopy(locale === 'zh'), [locale])
  const model = React.useMemo(
    () => deriveAgyMirrorRowModel(props.block, { cwd: props.cwd, home: props.home, locale }),
    [props.block, props.cwd, props.home, locale],
  )

  const useDisc = props.useDisclosure ?? useFallbackDisclosure
  const { expanded, toggle } = useDisc()
  const open = expanded && model.expandable
  const running = model.state === 'running' || model.state === 'preparing'
  const settledWithCue = model.state === 'error' || model.state === 'stopped'

  const diffStat = React.useMemo(() => {
    if (!model.diff || settledWithCue) return null
    return prim?.diffTotals ? prim.diffTotals(model.diff.diffs) : computeSimpleDiffTotals(model.diff.diffs)
  }, [model.diff, settledWithCue, prim])

  const summaryText =
    model.state === 'error' && !model.exitLabel
      ? (model.errorSummary ?? model.summary)
      : model.summary

  const Shimmer = prim?.TextShimmer
  const wrapShimmer = (children: unknown, extraProps?: Record<string, unknown>) =>
    Shimmer ? h(Shimmer, extraProps ?? null, children) : h('span', extraProps ?? null, children)

  const handleOpenFile = React.useMemo(() => {
    if (!model.filePath || !props.openFile || settledWithCue) return undefined
    const targetPath = model.filePath
    const targetLine = model.filePathLine
    return (ev: { stopPropagation?: () => void }) => {
      ev.stopPropagation?.()
      if (targetLine !== undefined) props.openFile!(targetPath, { line: targetLine })
      else props.openFile!(targetPath)
    }
  }, [model.filePath, model.filePathLine, props.openFile, settledWithCue])

  const handleLinkKeyDown = React.useCallback((ev: { key?: string; stopPropagation?: () => void }) => {
    if (ev.key === 'Enter' || ev.key === ' ') ev.stopPropagation?.()
  }, [])

  const exitBadge = model.exitLabel
    ? prim?.Tag
      ? h(
          prim.Tag,
          { tone: 'neutral', className: 'agy-tool-exit-badge' },
          h('span', { className: 'agy-tool-exit-dot', 'aria-hidden': true }),
          model.exitLabel,
        )
      : h(
          'span',
          { className: 'agy-tool-exit-badge agy-tool-exit-badge--fallback' },
          h('span', { className: 'agy-tool-exit-dot', 'aria-hidden': true }),
          model.exitLabel,
        )
    : null

  const collapsedContent =
    summaryText || exitBadge || diffStat
      ? h(
          React.Fragment,
          null,
          h('span', { className: 'agy-tool-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
          !model.exitLabel && handleOpenFile
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'agy-tool-file-link',
                  onClick: handleOpenFile,
                  onKeyDown: handleLinkKeyDown,
                },
                wrapShimmer(summaryText),
              )
            : !model.exitLabel && model.href && !settledWithCue
              ? h(
                  'a',
                  {
                    className: 'agy-tool-file-link',
                    href: model.href,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    onClick: (ev: { stopPropagation?: () => void }) => ev.stopPropagation?.(),
                    onKeyDown: handleLinkKeyDown,
                  },
                  wrapShimmer(summaryText),
                )
              : h(
                  'span',
                  {
                    className: [
                      'agy-tool-summary',
                      !model.exitLabel && model.state === 'error' ? 'agy-tool-summary--error' : '',
                      !model.exitLabel && model.state === 'stopped' ? 'agy-tool-summary--stopped' : '',
                    ]
                      .filter(Boolean)
                      .join(' '),
                  },
                  wrapShimmer(summaryText),
                ),
          exitBadge,
          !settledWithCue && model.summarySuffix
            ? wrapShimmer(model.summarySuffix, { className: 'agy-tool-summary-suffix' })
            : null,
          diffStat
            ? wrapShimmer(
                h(
                  React.Fragment,
                  null,
                  h('span', { className: 'agy-tool-diff-added' }, `+${diffStat.added}`),
                  ' ',
                  h('span', { className: 'agy-tool-diff-removed' }, `-${diffStat.removed}`),
                ),
                { className: 'agy-tool-summary-suffix agy-tool-diff-stat' },
              )
            : null,
        )
      : null

  const expandedContent = open
    ? h(
        'div',
        { className: 'agy-tool-body-wrap' },
        renderExpandedCard(model, prim, copy),
        props.inspect
          ? h(
              'button',
              {
                type: 'button',
                className: 'agy-tool-inspect-btn',
                onClick: props.inspect,
              },
              prim?.IconInspectOutlineRegular ? h(prim.IconInspectOutlineRegular, { size: 12 }) : null,
              copy.inspect,
            )
          : null,
      )
    : undefined

  const icon = renderCategoryIcon(model.category, prim)
  const srStatus =
    model.state === 'preparing'
      ? copy.preparing
      : model.state === 'running'
        ? copy.running
        : model.state === 'error'
          ? copy.failed
          : model.state === 'stopped'
            ? copy.stopped
            : null

  if (prim?.DisclosureRow) {
    return h(
      'div',
      {
        className: 'agy-tool-root',
        'data-category': model.category,
        'data-state': model.state,
      },
      srStatus ? h('span', { className: 'agy-tool-sr-only' }, srStatus) : null,
      h(
        prim.DisclosureRow,
        {
          rowClassName: 'agy-tool-row',
          leadingClassName: 'agy-tool-leading',
          titleClassName: 'agy-tool-title',
          icon,
          title: model.title,
          running,
          open,
          expandable: model.expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: toggle,
          collapsedContent,
        },
        expandedContent,
      ),
    )
  }

  // Fallback layout when DisclosureRow is unavailable
  return h(
    'div',
    {
      className: 'agy-tool-root agy-tool-root--fallback',
      'data-category': model.category,
      'data-state': model.state,
    },
    h(
      'div',
      {
        className: 'agy-tool-row agy-tool-row--fallback',
        role: model.expandable ? 'button' : undefined,
        tabIndex: model.expandable ? 0 : undefined,
        'aria-expanded': model.expandable ? open : undefined,
        onClick: model.expandable ? toggle : undefined,
      },
      h('span', { className: 'agy-tool-leading' }, icon),
      h('span', { className: 'agy-tool-title' }, model.title),
      collapsedContent,
    ),
    expandedContent,
  )
})
