import type { AcpConfigOption, SessionNewResult } from '../acp/protocol.ts'
import type { AcpModelOption } from '../common/types.ts'

export function selectOption(options: AcpConfigOption[] | undefined, key: string) {
  return options?.find(o => o.type === 'select' && (o.id === key || o.category === key))
}

export function values(option?: AcpConfigOption) {
  return option?.options?.flatMap(entry => 'value' in entry ? [entry] : entry.options) ?? []
}

type Route = { kind: 'config'; value: string; effort?: string } | { kind: 'legacy'; value: string }

export function modelCatalog(setup: Pick<SessionNewResult, 'configOptions' | 'models'>) {
  const model = selectOption(setup.configOptions, 'model')
  const entries = values(model)
  const currentEfforts = values(selectOption(setup.configOptions, 'thought_level')).map(o => o.value)
  const routes = new Map<string, Route>()
  const catalog = new Map<string, AcpModelOption>()
  const names = new Set<string>()
  function add(id: string, label: string, route: Route, efforts: string[] = []) {
    if (!id.trim() || routes.has(id)) return
    const name = label.trim() || id
    catalog.set(id, { value: id, name: names.has(name) ? `${name} (${id})` : name, efforts: [...efforts] })
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
      add(modelId, name, { kind: 'config', value: base.value, effort })
    } else {
      add(modelId, name, { kind: 'legacy', value: modelId })
    }
  }
  return { models: [...catalog.values()], routes }
}
