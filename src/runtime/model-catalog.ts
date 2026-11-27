import type { AcpConfigOption, SessionNewResult } from '../acp/protocol.ts'
import { sortedEfforts } from '../common/effort.ts'
import type { AcpModelOption } from '../common/types.ts'

export function selectOption(options: AcpConfigOption[] | undefined, key: string) {
  return options?.find(o => o.type === 'select' && (o.id === key || o.category === key))
}

export function values(option?: AcpConfigOption) {
  return option?.options?.flatMap(entry => 'value' in entry ? [entry] : entry.options) ?? []
}

type Route = { kind: 'config'; value: string; effort?: string } | { kind: 'legacy'; value: string }

export interface ModelCatalog {
  models: AcpModelOption[]
  routes: ReadonlyMap<string, Route>
}

interface CatalogSnapshot extends ModelCatalog {
  complete: boolean
  currentModel: string | undefined
  hasThoughtLevels: boolean
}

export function modelCatalog(setup: Pick<SessionNewResult, 'configOptions' | 'models'>): CatalogSnapshot {
  const model = selectOption(setup.configOptions, 'model')
  const entries = values(model)
  const thought = selectOption(setup.configOptions, 'thought_level')
  const currentEfforts = sortedEfforts(values(thought).map(o => o.value))
  const routes = new Map<string, Route>()
  const catalog = new Map<string, AcpModelOption>()
  const names = new Set<string>()
  function add(id: string, label: string, route: Route, efforts: string[] = []) {
    if (!id.trim() || routes.has(id)) return
    const name = label.trim() || id
    catalog.set(id, { value: id, name: names.has(name) ? `${name} (${id})` : name, efforts: [...efforts],
      ...(route.kind === 'config' && route.effort ? { variantOf: route.value } : {}),
    })
    names.add(name)
    routes.set(id, route)
  }
  for (const { value, name } of entries) {
    add(value, name, { kind: 'config', value }, value === model?.currentValue ? currentEfforts : [])
  }
  for (const { modelId, name } of setup.models?.availableModels ?? []) {
    if (routes.has(modelId)) continue
    // Only interpret a suffix when the agent also advertised the exact base selector.
    const match = /^(.*)-(low|medium|high|xhigh|max)$/.exec(modelId)
    const base = match && catalog.get(match[1]!)
    if (match && base && entries.some(e => e.value === base.value)) {
      const effort = match[2]!
      if (!base.efforts.includes(effort)) base.efforts.push(effort)
      add(modelId, name, { kind: 'config', value: base.value, effort }, [effort])
    } else {
      add(modelId, name, { kind: 'legacy', value: modelId })
    }
  }
  for (const m of catalog.values()) {
    m.efforts = sortedEfforts(m.efforts)
    if (m.value === model?.currentValue && thought && m.efforts.includes(thought.currentValue)) m.nativeEffort = thought.currentValue
  }
  return {
    models: [...catalog.values()],
    routes,
    complete: Boolean(setup.models?.availableModels?.length),
    currentModel: model?.currentValue,
    hasThoughtLevels: currentEfforts.length > 0,
  }
}

/** Only a full snapshot can remove models or replace known routes. */
export function mergeModelCatalog(previous: ModelCatalog, next: CatalogSnapshot): ModelCatalog {
  const nextModels = new Map(next.models.map(m => [m.value, m]))
  const oldModels = new Map(previous.models.map(m => [m.value, m]))
  const newModels = next.complete ? [] : next.models.filter(m => !oldModels.has(m.value))
  const routes = next.complete ? next.routes : new Map([...previous.routes, ...newModels.map(m => [m.value, next.routes.get(m.value)!] as const)])
  const models = (next.complete ? next.models : previous.models).map(model => {
    if (next.complete) {
      const old = oldModels.get(model.value)
      if (model.value !== next.currentModel && !model.variantOf && routes.get(model.value)?.kind === 'config' &&
          previous.routes.get(model.value)?.kind === 'config' && old?.efforts.length && !old.variantOf) {
        const efforts = model.efforts.length ? model.efforts : old.efforts
        if (old.nativeEffort && efforts.includes(old.nativeEffort)) {
          return { ...model, efforts, nativeEffort: old.nativeEffort }
        }
        return { ...model, efforts }
      }
      return model
    }
    const observed = nextModels.get(model.value)
    if (!observed) return model
    const route = routes.get(model.value)
    if (model.value !== next.currentModel || !next.hasThoughtLevels || route?.kind !== 'config' || route.effort) {
      return { ...model, name: observed.name }
    }
    // New thought levels describe the selected base only. Keep any independently advertised fixed levels.
    const fixedEfforts = [...routes.values()].flatMap(r => r.kind === 'config' && r.value === model.value && r.effort ? [r.effort] : [])
    return { ...observed, efforts: sortedEfforts([...observed.efforts, ...fixedEfforts]) }
  })
  return { models: [...models, ...newModels], routes }
}
