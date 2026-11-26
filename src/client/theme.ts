// DSH Web official design tokens (`--dsw-alias-*`) with light/dark-safe fallbacks.
// Never hardcodes dark-only hex surfaces such as `#18181b`.

export const theme = {
  borderSubtle: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.12))',
  borderPrimary: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22))',
  borderStrong: '1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.32))',
  surfaceBase: 'var(--dsw-alias-bg-base, Canvas)',
  surfaceElevated: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas))',
  surfaceLayer2: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.06)))',
  surfaceCard: 'var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.05))',
  surfaceTile: 'var(--dsw-alias-card-tile-fill, rgba(127, 127, 127, 0.06))',
  surfaceHover: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08))',
  surfaceActive: 'var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.14))',
  surfaceInput: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-base, transparent))',
  surfaceMask: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.38))',
  textPrimary: 'var(--dsw-alias-label-primary, CanvasText)',
  textSecondary: 'var(--dsw-alias-label-secondary, inherit)',
  textTertiary: 'var(--dsw-alias-label-tertiary, inherit)',
  // Note: `--dsw-alias-button-primary-fill` is dark in light mode and light in dark mode;
  // `--dsw-alias-label-primary-foreground` flips accordingly so primary buttons never become white-on-white.
  textOnPrimary: 'var(--dsw-alias-label-primary-foreground, var(--dsw-alias-label-on-color, #ffffff))',
  brandPrimary: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2937))',
  brandPrimaryHover: 'var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #374151))',
  accentBlue: 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #3b82f6))',
  accentBlueSoft: 'var(--dsw-alias-state-business-tertiary, rgba(59, 130, 246, 0.14))',
  stateSuccess: 'var(--dsw-alias-state-success-primary, #22c55e)',
  stateSuccessSoft: 'var(--dsw-alias-state-success-tertiary, rgba(34, 197, 94, 0.14))',
  stateWarn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  stateWarnSoft: 'var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.14))',
  stateError: 'var(--dsw-alias-state-error-primary, #ef4444)',
  stateErrorSoft: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(239, 68, 68, 0.12))',
  stateIdle: 'var(--dsw-alias-state-idle-primary, #94a3b8)',
} as const

export const styles = {
  panelNav: { display: 'flex', flexWrap: 'wrap' as const, gap: '6px', marginBottom: '12px' },
  sectionHeading: { margin: '0 0 6px', fontSize: '14px', fontWeight: 600 },
  card: {
    borderRadius: '12px',
    border: theme.borderPrimary,
    padding: '14px 16px',
    marginBottom: '14px',
    backgroundColor: theme.surfaceCard,
  },
  tile: {
    padding: '10px 12px',
    borderRadius: '10px',
    backgroundColor: theme.surfaceTile,
    border: theme.borderPrimary,
    marginBottom: '8px',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '7px 10px',
    borderRadius: '8px',
    border: theme.borderStrong,
    backgroundColor: theme.surfaceInput,
    color: theme.textPrimary,
    fontSize: '13px',
  },
  secondaryText: {
    fontSize: '12px',
    color: theme.textSecondary,
  },
  ghostButton: {
    padding: '5px 11px',
    borderRadius: '8px',
    border: theme.borderPrimary,
    background: 'transparent',
    color: theme.textPrimary,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  },
  primaryButton: {
    padding: '6px 14px',
    borderRadius: '8px',
    border: 'none',
    backgroundColor: theme.brandPrimary,
    color: theme.textOnPrimary,
    fontWeight: 500,
    cursor: 'pointer',
    fontSize: '13px',
  },
  dangerButton: {
    padding: '5px 10px',
    borderRadius: '8px',
    border: `1px solid ${theme.stateError}`,
    background: 'transparent',
    color: theme.stateError,
    cursor: 'pointer',
    fontSize: '12px',
  },
  modalOverlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 10000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'clamp(8px, 3vw, 24px)',
    backgroundColor: theme.surfaceMask,
  },
  modalDialog: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    width: 'min(820px, 100%)',
    boxSizing: 'border-box' as const,
    minWidth: 0,
    maxHeight: '88vh',
    overflow: 'hidden' as const,
    borderRadius: '16px',
    border: theme.borderStrong,
    backgroundColor: theme.surfaceElevated,
    color: theme.textPrimary,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.28)',
  },
} as const

const STYLE_ELEMENT_ID = 'dsh-agy-acp-scoped-styles'

const SCOPED_CSS = `
.agy-acp-root {
  max-width: 820px;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.agy-acp-root *, .agy-acp-root *::before, .agy-acp-root *::after {
  box-sizing: border-box;
}
.agy-acp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.agy-acp-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary, CanvasText);
}
.agy-acp-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.agy-acp-muted {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.agy-acp-caption {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit));
}
.agy-acp-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.06));
  color: var(--dsw-alias-label-primary, CanvasText);
  white-space: nowrap;
}
.agy-acp-pill--sm {
  padding: 1px 8px;
  font-size: 11px;
}
.agy-acp-pill--success {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 35%, transparent);
  background: var(--dsw-alias-state-success-tertiary, rgba(34, 197, 94, 0.12));
  color: var(--dsw-alias-state-success-primary, #22c55e);
}
.agy-acp-pill--warn {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 40%, transparent);
  background: var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.14));
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, #f59e0b));
}
.agy-acp-pill--error {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 40%, transparent);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239, 68, 68, 0.12));
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-acp-pill--info {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 35%, transparent);
  background: var(--dsw-alias-state-business-tertiary, rgba(59, 130, 246, 0.14));
  color: var(--dsw-alias-state-business-primary, #3b82f6);
}
.agy-acp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

/* Segmented navigation tabs */
.agy-acp-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px;
  margin-bottom: 14px;
  border-radius: 10px;
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18));
  max-width: 100%;
}
.agy-acp-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.agy-acp-tab:hover {
  color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
}
.agy-acp-tab[aria-pressed='true'] {
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-2, Canvas));
  color: var(--dsw-alias-label-primary, CanvasText);
  border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.agy-acp-tab:focus-visible,
.agy-acp-btn:focus-visible,
.agy-acp-seg-btn:focus-visible,
.agy-acp-input:focus-visible,
.agy-acp-select:focus-visible,
.agy-acp-collapse-trigger:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6);
  outline-offset: 1px;
}

/* Surfaces & cards */
.agy-acp-card {
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.05));
  padding: 16px;
  margin-bottom: 14px;
}
.agy-acp-card--flush {
  padding: 0;
  overflow: hidden;
}
.agy-acp-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.agy-acp-section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, CanvasText);
}
.agy-acp-divider {
  border: 0;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  margin: 14px 0;
}

/* KPI Metrics Grid */
.agy-acp-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 112px), 1fr));
  gap: 8px;
}
.agy-acp-kpi-tile {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-card-tile-fill, rgba(127, 127, 127, 0.06));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  min-width: 0;
}
.agy-acp-kpi-label {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, inherit);
  margin-bottom: 4px;
}
.agy-acp-kpi-value {
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, CanvasText);
  line-height: 1.2;
}

/* Buttons */
.agy-acp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  background: transparent;
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
  white-space: nowrap;
}
.agy-acp-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.34));
}
.agy-acp-btn:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.14));
}
.agy-acp-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}
.agy-acp-btn--sm {
  padding: 4px 9px;
  font-size: 12px;
  border-radius: 7px;
}
.agy-acp-btn--primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2937));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-label-on-color, #ffffff));
  border-color: transparent;
}
.agy-acp-btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, #374151));
  border-color: transparent;
}
.agy-acp-btn--danger {
  color: var(--dsw-alias-state-error-primary, #ef4444);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 45%, transparent);
}
.agy-acp-btn--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239, 68, 68, 0.1));
  border-color: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-acp-btn--danger-solid {
  background: var(--dsw-alias-state-error-primary, #ef4444);
  color: var(--dsw-alias-label-on-color, #ffffff);
  border-color: transparent;
}
.agy-acp-btn--danger-solid:hover:not(:disabled) {
  opacity: 0.9;
  background: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-acp-btn--link {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--dsw-alias-link, var(--dsw-alias-state-business-primary, #3b82f6));
  font-size: 11.5px;
  font-weight: 500;
}
.agy-acp-btn--link:hover:not(:disabled) {
  background: transparent;
  text-decoration: underline;
}

/* Form controls */
.agy-acp-fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.agy-acp-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 12px;
}
.agy-acp-grid-3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 195px), 1fr));
  gap: 10px;
}
.agy-acp-field-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, inherit);
}
.agy-acp-input,
.agy-acp-select {
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.3));
  background-color: var(--dsw-specific-input-major, var(--dsw-alias-bg-base, transparent));
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
  font-size: 13px;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.agy-acp-input:hover:not(:disabled),
.agy-acp-select:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.45));
}
.agy-acp-input:disabled,
.agy-acp-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.agy-acp-input--sm,
.agy-acp-select--sm {
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 7px;
}

/* Toggle Switch */
.agy-acp-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 13px;
  border-radius: 10px;
  background: var(--dsw-alias-card-tile-fill, rgba(127, 127, 127, 0.05));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.agy-acp-switch-row:hover {
  border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
}
.agy-acp-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 38px;
  height: 22px;
  flex: none;
}
.agy-acp-switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
}
.agy-acp-switch-track {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.35));
  transition: background-color 150ms ease;
}
.agy-acp-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
  transition: transform 150ms ease;
}
.agy-acp-switch input:checked + .agy-acp-switch-track {
  background: var(--dsw-alias-state-business-primary, #3b82f6);
}
.agy-acp-switch input:checked + .agy-acp-switch-track .agy-acp-switch-thumb {
  transform: translateX(16px);
}
.agy-acp-switch input:focus-visible + .agy-acp-switch-track {
  outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6);
  outline-offset: 2px;
}

/* Inline Segmented Control (MCP Policy Modes) */
.agy-acp-seg {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.1)));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  flex: none;
}
.agy-acp-seg-btn {
  padding: 3px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
.agy-acp-seg-btn:hover:not(:disabled):not([aria-checked='true']) {
  color: var(--dsw-alias-label-primary, CanvasText);
}
.agy-acp-seg-btn[aria-checked='true'] {
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-base, Canvas));
  color: var(--dsw-alias-label-primary, CanvasText);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}
.agy-acp-seg-btn--accent[aria-checked='true'] {
  background: var(--dsw-alias-state-business-primary, #3b82f6);
  color: var(--dsw-alias-label-on-color, #ffffff);
}
.agy-acp-seg-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Flat list rows (avoiding multi-nested boxes) */
.agy-acp-list {
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
  background: var(--dsw-alias-card-tile-fill, rgba(127, 127, 127, 0.04));
  overflow: hidden;
}
.agy-acp-list-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 9px 12px;
}
.agy-acp-list-row + .agy-acp-list-row {
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
}

/* Preset chip bar */
.agy-acp-preset-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.agy-acp-preset-chip {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 120ms ease;
}
.agy-acp-preset-chip:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary, CanvasText);
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.38));
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
}
.agy-acp-preset-chip[aria-pressed='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 55%, transparent);
  background: var(--dsw-alias-state-business-tertiary, rgba(59, 130, 246, 0.14));
  color: var(--dsw-alias-state-business-primary, #3b82f6);
}

/* Progress bar */
.agy-acp-progress-track {
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18));
  overflow: hidden;
}
.agy-acp-progress-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 180ms ease;
}

/* Notices & banners */
.agy-acp-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 13px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.06));
  margin-bottom: 12px;
  font-size: 12.5px;
}
.agy-acp-notice--warn {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 42%, transparent);
  background: var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.1));
}
.agy-acp-notice--error {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 45%, transparent);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239, 68, 68, 0.1));
}

/* Collapsible sections */
.agy-acp-collapsible {
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  background: var(--dsw-alias-card-tile-fill, rgba(127, 127, 127, 0.04));
  overflow: hidden;
}
.agy-acp-collapsible > summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, CanvasText);
  user-select: none;
}
.agy-acp-collapsible > summary::-webkit-details-marker {
  display: none;
}
.agy-acp-collapsible > summary:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.06));
}
.agy-acp-collapsible-body {
  padding: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
}
.agy-acp-collapse-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.agy-acp-collapse-trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.06));
}

/* Sticky save action bar */
.agy-acp-sticky-bar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 11px 14px;
  margin-top: 14px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, Canvas));
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.08);
}

/* Account card & quota grid */
.agy-acp-account-card {
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  background: var(--dsw-alias-card-tile-fill, rgba(127, 127, 127, 0.04));
  padding: 13px 14px;
  margin-bottom: 10px;
  overflow-wrap: anywhere;
}
.agy-acp-account-card:last-child {
  margin-bottom: 0;
}
.agy-acp-quota-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
  gap: 8px;
  margin-top: 8px;
}
.agy-acp-quota-card {
  padding: 9px 11px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.04));
}

/* Modal shell */
.agy-acp-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18));
  flex: none;
}
.agy-acp-modal-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 18px 18px;
  min-height: 0;
}
.agy-acp-modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22));
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  font-size: 17px;
  line-height: 1;
  flex: none;
}
.agy-acp-modal-close:hover {
  color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1));
}
.agy-acp-header-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.agy-acp-header-badge:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.36));
}

/* Conversation panel mirrored tool rows (matches DSH ToolRow geometry & tokens) */
.agy-tool-root {
  display: flex;
  flex-direction: column;
}
.agy-tool-leading {
  flex-shrink: 0;
}
.agy-tool-title {
  font-weight: 400;
}
.agy-tool-sep {
  flex: none;
  width: 2px;
  height: 2px;
  border-radius: 1px;
  margin: 0 8px;
  background: var(--dsw-alias-label-caption, rgba(127, 127, 127, 0.6));
}
.agy-tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.agy-tool-summary--error {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-tool-summary--stopped {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, #f59e0b));
}
.agy-tool-summary-suffix {
  flex: none;
  margin-left: 4px;
  white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.agy-tool-diff-stat {
  margin-left: 10px;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 2px);
  transform: translateY(0.5px);
}
.agy-tool-row[aria-expanded='true'] .agy-tool-diff-added {
  color: var(--dsw-alias-state-success-primary, #22c55e);
}
.agy-tool-row[aria-expanded='true'] .agy-tool-diff-removed {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
@media (hover: hover) {
  .agy-tool-row:hover .agy-tool-diff-added {
    color: var(--dsw-alias-state-success-primary, #22c55e);
  }
  .agy-tool-row:hover .agy-tool-diff-removed {
    color: var(--dsw-alias-state-error-primary, #ef4444);
  }
}
.agy-tool-file-link {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: inherit;
  text-decoration: underline dotted;
  text-decoration-color: currentColor;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  cursor: pointer;
}
.agy-tool-exit-badge {
  flex: none;
  margin-left: 8px;
}
.agy-tool-exit-badge--fallback {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--dsw-alias-card-fill, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-secondary, inherit);
}
.agy-tool-exit-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary, #ef4444);
  margin-right: 4px;
}
.agy-tool-body-wrap {
  display: flex;
  flex-direction: column;
}
.agy-tool-card-body {
  margin: 4px 0 4px 4px;
}
.agy-tool-terminal-body {
  margin: 4px 0 4px 4px;
  --dsl-terminal-font: var(--dsw-font-markdown-code-block-small, 12px/18px monospace);
  --dsl-terminal-line-height: 18px;
  --dsl-terminal-output-max-height: 224px;
  --dsl-terminal-command-whitespace: pre-wrap;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
}
.agy-tool-io-card {
  display: flex;
  flex-direction: column;
  margin: 4px 0 4px 4px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, 0.06));
  font: var(--dsw-font-markdown-code-block-small, 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace);
}
.agy-tool-io-section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  align-items: baseline;
  padding: 12px 16px;
  max-height: 180px;
  overflow-y: auto;
}
.agy-tool-io-label {
  position: sticky;
  top: 0;
  align-self: start;
  color: var(--dsw-alias-label-caption, rgba(127, 127, 127, 0.7));
}
.agy-tool-io-divider {
  flex: none;
  height: 0.5px;
  background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18));
}
.agy-tool-io-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary, inherit);
}
.agy-tool-io-text[data-error] {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-tool-steps-card {
  margin: 4px 0 4px 4px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, 0.06));
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  overflow: hidden;
}
.agy-tool-steps-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 280px;
  overflow-y: auto;
}
.agy-tool-step-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 14px;
}
.agy-tool-step-item + .agy-tool-step-item {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
}
.agy-tool-step-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 18px;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.agy-tool-step-item[data-status='done'] .agy-tool-step-icon {
  color: var(--dsw-alias-state-success-primary, #22c55e);
}
.agy-tool-step-item[data-status='in_progress'] .agy-tool-step-icon {
  color: var(--dsw-alias-state-business-primary, #3b82f6);
}
.agy-tool-step-item[data-status='failed'] .agy-tool-step-icon {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-tool-step-box {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid var(--dsw-alias-label-tertiary, currentColor);
  box-sizing: border-box;
}
.agy-tool-step-title {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.agy-tool-step-item[data-status='skipped'] .agy-tool-step-title {
  text-decoration: line-through;
  color: var(--dsw-alias-label-tertiary, inherit);
}
.agy-tool-step-status {
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-label-caption, rgba(127, 127, 127, 0.7));
  white-space: nowrap;
}
.agy-tool-inspect-btn {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  margin: 4px 0 2px 4px;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.3));
  border-radius: 999px;
  background: var(--dsw-alias-bg-base, Canvas);
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 100ms ease;
}
.agy-tool-inspect-btn:focus-visible {
  opacity: 1;
}
@media (hover: hover) {
  .agy-tool-root:hover .agy-tool-inspect-btn {
    opacity: 1;
  }
  .agy-tool-inspect-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, 0.14));
    color: var(--dsw-alias-label-primary, CanvasText);
  }
}
@media (hover: none) {
  .agy-tool-inspect-btn {
    opacity: 1;
  }
}
.agy-tool-row--fallback {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  color: var(--dsw-alias-label-tertiary, inherit);
  cursor: pointer;
}
.agy-tool-fallback-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  font-size: 12px;
}
.agy-tool-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
`

export function ensureAgyAcpStyles(): void {
  if (typeof document === 'undefined' || !document.head) return
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ELEMENT_ID
    el.textContent = SCOPED_CSS
    document.head.appendChild(el)
  } else if (el.textContent !== SCOPED_CSS) {
    el.textContent = SCOPED_CSS
  }
}
