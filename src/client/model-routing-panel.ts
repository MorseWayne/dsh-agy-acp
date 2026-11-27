// @ts-expect-error runtime React is supplied by the DSH web host
import React from 'react'
import {
  AUTO_ACCOUNT_ID, MODEL_FAMILY_ORDER, MODEL_FAMILY_META, MAX_MODEL_ROUTE_OVERRIDES,
  classifyModelFamily, compactModelAccountRouting, equalModelAccountRouting, validateModelAccountRoutingInput,
} from '../common/account-routing.ts'
import type {
  AccountHealthSnapshot, AccountRouteFallback, AccountRouteRule, AcpModelOption, ModelAccountRoutingConfig, StatusSnapshot,
} from '../common/types.ts'
import { saveModelAccountRouting } from './panel-actions.ts'
import { theme } from './theme.ts'
import { SegmentedControl } from './ui-primitives.ts'

const h = React.createElement
const btn = 'agy-acp-btn agy-acp-btn--sm'
const policies = [
  { value: 'auto', label: '自动借备用号', accent: true, title: '首选号限流或额度耗尽时自动借用其他可用账号' },
  { value: 'strict', label: '严格锁单号', title: '仅限此账号，额度耗尽直接提示，绝不串号' },
] as const

export interface ModelRoutingPanelProps {
  accounts: AccountHealthSnapshot[]
  models: AcpModelOption[]
  preferredAccountId?: string | null
  routing?: ModelAccountRoutingConfig
  refreshingModels?: boolean
  onRefreshModels?: () => void
  applyStatus: (next: StatusSnapshot) => void
}

interface AddForm {
  manual: boolean
  model: string
  rule?: AccountRouteRule
  error: string
}
interface EditorState {
  latestServer: ModelAccountRoutingConfig
  baseline: ModelAccountRoutingConfig
  draft: ModelAccountRoutingConfig
  form: AddForm
  saving: boolean
  feedback: string
}
const emptyForm: AddForm = { manual: false, model: '', error: '' }
export function initialRoutingEditor(routing?: ModelAccountRoutingConfig): EditorState {
  const baseline = compactModelAccountRouting(routing) ?? {}
  return { latestServer: baseline, baseline, draft: baseline, form: emptyForm, saving: false, feedback: '' }
}
type Action =
  | { type: 'sync' | 'saved'; routing?: ModelAccountRoutingConfig }
  | { type: 'discard' }
  | { type: 'draft'; draft: ModelAccountRoutingConfig }
  | { type: 'form'; patch: Partial<AddForm> }
  | { type: 'saving' }
  | { type: 'failed'; message: string }

export function reduceRoutingEditor(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'sync': {
      // Keep the newest server value for discard, but don't rebase an edited draft underneath its owner.
      if (equalModelAccountRouting(action.routing, state.latestServer)) return state
      const latestServer = action.routing ?? {}
      if (state.saving || !equalModelAccountRouting(state.draft, state.baseline)) return { ...state, latestServer }
      return { ...state, latestServer, baseline: latestServer, draft: latestServer, feedback: '' }
    }
    case 'discard': return initialRoutingEditor(state.latestServer)
    case 'saved': return { ...initialRoutingEditor(action.routing), feedback: '分配规则已保存。' }
    case 'failed': return { ...state, saving: false, feedback: `保存失败：${action.message}` }
    case 'saving': return { ...state, saving: true, feedback: '' }
    case 'draft': {
      const reverted = equalModelAccountRouting(action.draft, state.baseline)
      return { ...state, baseline: reverted ? state.latestServer : state.baseline,
        draft: reverted ? state.latestServer : action.draft, feedback: '', form: { ...state.form, error: '' } }
    }
    case 'form': return { ...state, form: { ...state.form, error: '', ...action.patch } }
  }
}

function ruleControls(
  accounts: AccountHealthSnapshot[], label: string, rule: AccountRouteRule | undefined,
  onChange: (rule: AccountRouteRule | undefined) => void, globalSummary?: string,
): unknown {
  const id = rule?.accountId ?? ''
  const specific = Boolean(id && id !== AUTO_ACCOUNT_ID)
  const selected = accounts.find(a => a.id === id)
  const unavailable = specific && !selected?.enabled
  const strict = rule?.fallback === 'strict'
  return h('div', { className: 'agy-acp-route-controls' },
    h('select', {
      className: 'agy-acp-select agy-acp-select--sm', 'aria-label': `${label}首选账号`, value: id,
      onChange: ({ target: { value } }: { target: { value: string } }) => onChange(!value ? undefined :
        { accountId: value, ...(value !== AUTO_ACCOUNT_ID && strict ? { fallback: 'strict' } : {}) }),
    },
    globalSummary ? h('option', { value: '' }, `跟随全局默认（${globalSummary}）`) : null,
    h('option', { value: AUTO_ACCOUNT_ID }, '自动按余量轮换（忽略全局主力）'),
    ...accounts.map(a => h('option', { key: a.id, value: a.id }, `${a.label || a.id}${a.enabled ? '' : '（已停用）'}`)),
    specific && !selected ? h('option', { value: id }, `${id}（账号已移除）`) : null),
    specific ? h(SegmentedControl, {
      ariaLabel: `${label}共享策略`, options: policies, value: rule?.fallback ?? 'auto',
      onChange: (fallback: AccountRouteFallback) => onChange({ accountId: id, fallback }),
    }) : null,
    unavailable ? h('span', { className: 'agy-acp-caption agy-acp-route-warning', style: strict ? { color: theme.stateWarn } : undefined },
      `首选账号${selected ? '已停用' : '已移除'}。${strict ? '严格锁定时可能无法发起请求，请更换账号。' : '将尝试借用其他可用账号。'}`) : null,
  )
}

function replaceRule(draft: ModelAccountRoutingConfig, group: 'families' | 'models', key: string, rule?: AccountRouteRule): ModelAccountRoutingConfig {
  const rules: Record<string, AccountRouteRule> = { ...draft[group], ...(rule ? { [key]: rule } : {}) }
  if (!rule) delete rules[key]
  const next = { ...draft, [group]: rules }
  if (!Object.keys(rules).length) delete next[group]
  return next
}

// The view edits only the local draft; the save button is the sole write to the server.
export function renderRoutingEditor(props: ModelRoutingPanelProps, state: EditorState, dispatch: (action: Action) => void): unknown {
  const { accounts, models, preferredAccountId, applyStatus, onRefreshModels, refreshingModels } = props
  const { baseline, draft, form, saving, feedback } = state
  const dirty = !equalModelAccountRouting(draft, baseline)
  const validation = validateModelAccountRoutingInput(draft)
  const preferred = accounts.find(a => a.id === preferredAccountId && a.enabled)
  const globalSummary = preferred ? `主力号：${preferred.label || preferred.id}` : '自动按余量轮换'
  const modelKeys = Object.keys(draft.models ?? {}).sort()
  const availableModels = models.filter(m => !Object.hasOwn(draft.models ?? {}, m.value.trim().toLowerCase()))
  const manual = form.manual || !models.length
  const modelInput = manual || availableModels.some(m => m.value === form.model) ? form.model : ''
  const newRule = form.rule ?? { accountId: accounts.find(a => a.enabled)?.id ?? AUTO_ACCOUNT_ID }
  const editForm = (patch: Partial<AddForm>) => dispatch({ type: 'form', patch })
  const changeRule = (group: 'families' | 'models', key: string, rule?: AccountRouteRule) =>
    dispatch({ type: 'draft', draft: replaceRule(draft, group, key, rule) })

  function addRule(): void {
    const key = modelInput.trim().toLowerCase()
    if (!key) return editForm({ error: '请先选择或输入模型 ID。' })
    if (Object.hasOwn(draft.models ?? {}, key)) return editForm({ error: '这个模型已有规则，请直接修改上方的分配。' })
    if (modelKeys.length >= MAX_MODEL_ROUTE_OVERRIDES) return editForm({ error: `最多可添加 ${MAX_MODEL_ROUTE_OVERRIDES} 条具体模型规则，请先移除一条。` })
    const next = replaceRule(draft, 'models', key, newRule)
    const checked = validateModelAccountRoutingInput(next)
    if (!checked.ok) return editForm({ error: `无法添加：${checked.error}` })
    dispatch({ type: 'draft', draft: checked.value })
    editForm({ model: '' })
  }
  async function save(): Promise<void> {
    if (saving || !dirty || !validation.ok || form.error) return
    dispatch({ type: 'saving' })
    const result = await saveModelAccountRouting(compactModelAccountRouting(draft) ?? {})
    if (!result.ok || !result.status) return dispatch({ type: 'failed', message: result.error || '未收到有效的保存结果，请重试。' })
    dispatch({ type: 'saved', routing: result.status.config?.modelAccountRouting })
    applyStatus(result.status)
  }
  return h('section', { className: 'agy-acp-card', 'aria-label': '模型账号分配（额度共享）' },
    h('h3', { className: 'agy-acp-section-title' }, '模型账号分配（额度共享）'),
    h('fieldset', { className: 'agy-acp-fieldset', disabled: saving },
      h('h4', null, '按模型大类分配'),
      h('p', { className: 'agy-acp-caption' }, '为每类模型选择首选账号。不设置时跟随全局默认；选择具体账号后，还能决定是否借用备用号。'),
      ...MODEL_FAMILY_ORDER.map(family => {
        const { label, description } = MODEL_FAMILY_META[family]
        return h('div', { key: `family:${family}`, className: 'agy-acp-route-row' },
          h('div', { className: 'agy-acp-route-label' }, h('strong', null, label), h('div', { className: 'agy-acp-caption' }, description)),
          ruleControls(accounts, label, draft.families?.[family], rule => changeRule('families', family, rule), globalSummary))
      }),
      h('h4', null, '具体模型覆盖（优先于上方大类）'),
      h('p', { className: 'agy-acp-caption' }, '同一大类下想把不同模型分给不同账号时（如 Neon 走账号 1、Carbon 走账号 2），可在此单独指定。'),
      ...modelKeys.map(key => {
        const model = models.find(m => m.value.trim().toLowerCase() === key)
        return h('div', { key: `model:${key}`, className: 'agy-acp-route-row' },
          h('div', { className: 'agy-acp-route-label' }, h('strong', null, model ? `${model.name} (${model.value})` : key), ' ',
            h('span', { className: 'agy-acp-pill agy-acp-pill--sm' }, `覆盖 ${MODEL_FAMILY_META[classifyModelFamily(key)].label}`)),
          ruleControls(accounts, key, draft.models?.[key], rule => changeRule('models', key, rule)),
          h('button', { className: btn, type: 'button', 'aria-label': `移除 ${key} 规则`, onClick: () => changeRule('models', key) }, '移除'))
      }),
      h('div', { className: 'agy-acp-route-add-bar' },
        manual ? h('input', { className: 'agy-acp-input agy-acp-input--sm', 'aria-label': '新增模型 ID',
          value: modelInput, placeholder: '输入模型 ID，例如 gemini-4-neon', onChange: (e: { target: { value: string } }) => editForm({ model: e.target.value, manual: true }) })
          : h('select', { className: 'agy-acp-select agy-acp-select--sm', 'aria-label': '新增具体模型', value: modelInput,
              onChange: (e: { target: { value: string } }) => editForm({ model: e.target.value }) },
            h('option', { value: '' }, availableModels.length ? '选择要添加的模型' : '目录中的模型均已添加'),
            ...availableModels.map(m => h('option', { key: m.value, value: m.value }, `${m.name} (${m.value})`))),
        models.length ? h('button', { className: btn, type: 'button', onClick: () => editForm({ manual: !manual, model: '' }) }, manual ? '返回下拉' : '手动输入')
          : onRefreshModels ? h('button', { className: btn, type: 'button', onClick: onRefreshModels, disabled: refreshingModels }, refreshingModels ? '刷新中…' : '刷新模型目录') : null,
        ruleControls(accounts, '新增规则', newRule, rule => editForm({ rule })),
        h('button', { className: btn, type: 'button', onClick: addRule }, '+ 添加规则')),
      form.error ? h('p', { role: 'alert', className: 'agy-acp-caption', style: { color: theme.stateError } }, form.error) : null,
    ),
    h('div', { className: 'agy-acp-sticky-bar' },
      h('span', { role: 'status', className: 'agy-acp-caption' }, !validation.ok ? validation.error : feedback || (dirty ? '有未保存的分配规则。' : '没有未保存的修改。')),
      h('div', { className: 'agy-acp-route-controls' },
        compactModelAccountRouting(draft) ? h('button', { type: 'button', className: btn, disabled: saving, onClick: () => dispatch({ type: 'draft', draft: {} }) }, '清空全部规则') : null,
        dirty ? h('button', { type: 'button', className: btn, disabled: saving, onClick: () => dispatch({ type: 'discard' }) }, '放弃修改') : null,
        h('button', { type: 'button', className: 'agy-acp-btn agy-acp-btn--primary', disabled: saving || !dirty || !validation.ok || Boolean(form.error), onClick: save }, saving ? '保存中…' : '保存分配规则'))),
  )
}

export const ModelRoutingPanel = React.memo(function ModelRoutingPanel(props: ModelRoutingPanelProps): unknown {
  const [state, dispatch] = React.useReducer(reduceRoutingEditor, props.routing, initialRoutingEditor)
  React.useEffect(() => {
    dispatch({ type: 'sync', routing: props.routing })
  }, [props.routing])
  return renderRoutingEditor(props, state, dispatch)
})
