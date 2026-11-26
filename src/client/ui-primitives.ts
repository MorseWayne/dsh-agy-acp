// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import { theme } from './theme.ts'

const h = React.createElement

export interface ToggleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  title: string
  description?: string
  ariaLabel?: string
  style?: Record<string, unknown>
}

export const ToggleSwitch = React.memo(function ToggleSwitch({
  checked,
  onChange,
  title,
  description,
  ariaLabel,
  style,
}: ToggleSwitchProps): unknown {
  return h(
    'label',
    { className: 'agy-acp-switch-row', style },
    h(
      'div',
      { style: { minWidth: 0, flex: '1 1 auto' } },
      h('div', { style: { fontWeight: 500, fontSize: '13px' } }, title),
      description ? h('div', { className: 'agy-acp-caption', style: { marginTop: '2px' } }, description) : null,
    ),
    h(
      'span',
      { className: 'agy-acp-switch' },
      h('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': ariaLabel ?? title,
        'aria-checked': checked,
        checked,
        onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked),
      }),
      h(
        'span',
        { className: 'agy-acp-switch-track', 'aria-hidden': 'true' },
        h('span', { className: 'agy-acp-switch-thumb' }),
      ),
    ),
  )
})

export interface SegmentOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly title?: string
  readonly accent?: boolean
}

export interface SegmentedControlProps<T extends string> {
  ariaLabel: string
  value: T
  options: readonly SegmentOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  disabled,
}: SegmentedControlProps<T>): unknown {
  return h(
    'div',
    {
      role: 'radiogroup',
      'aria-label': ariaLabel,
      className: 'agy-acp-seg',
    },
    ...options.map((opt) => {
      const active = opt.value === value
      return h(
        'button',
        {
          key: opt.value,
          type: 'button',
          role: 'radio',
          'aria-checked': active,
          disabled,
          title: opt.title,
          className: `agy-acp-seg-btn${opt.accent ? ' agy-acp-seg-btn--accent' : ''}`,
          onClick: () => {
            if (!active) onChange(opt.value)
          },
        },
        opt.label,
      )
    }),
  )
}

export interface ProgressBarProps {
  valuePct: number
  ariaLabel: string
  color?: string
  height?: number
  style?: Record<string, unknown>
}

export const ProgressBar = React.memo(function ProgressBar({
  valuePct,
  ariaLabel,
  color = theme.accentBlue,
  height = 5,
  style,
}: ProgressBarProps): unknown {
  const clamped = Number.isFinite(valuePct) ? Math.min(100, Math.max(0, valuePct)) : 0
  return h(
    'div',
    {
      role: 'progressbar',
      'aria-label': ariaLabel,
      'aria-valuenow': Math.round(clamped),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      className: 'agy-acp-progress-track',
      style: { height: `${height}px`, ...style },
    },
    h('div', {
      className: 'agy-acp-progress-fill',
      style: {
        width: `${clamped.toFixed(1)}%`,
        backgroundColor: color,
      },
    }),
  )
})

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知'
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
