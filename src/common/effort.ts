import type { AcpModelOption } from './types.ts'

const labels: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }

export function sortedEfforts(ids: readonly string[]): string[] {
  const unique = new Set(ids.filter(id => id.trim() !== ''))
  return [...Object.keys(labels).filter(id => unique.delete(id)), ...unique]
}

export function effortLabel(id: string): string {
  return Object.hasOwn(labels, id) ? labels[id]! : id
}

/** Never inherit the last turn's override when the user goes back to Default. */
export function defaultEffort(model: AcpModelOption | undefined, configured: string): string | undefined {
  if (!model) return undefined
  return [configured, model.nativeEffort, 'high', 'medium', 'low', ...model.efforts].find(
    (id): id is string => Boolean(id && model.efforts.includes(id)),
  )
}
