export interface DiscoveryChoice {
  id: string
  name: string
  meta?: string
  compatibility: 'confirmed' | 'unknown'
}

export function filterDiscoveryChoices(
  options: DiscoveryChoice[],
  query: string,
  limit = 100
): DiscoveryChoice[] {
  const normalized = query.trim().toLocaleLowerCase()
  const matches = normalized
    ? options.filter((choice) => [choice.id, choice.name, choice.meta ?? '']
      .some((value) => value.toLocaleLowerCase().includes(normalized)))
    : options
  return [...matches]
    .sort((left, right) => {
      if (left.compatibility !== right.compatibility) return left.compatibility === 'confirmed' ? -1 : 1
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    })
    .slice(0, limit)
}

export function isStaleDiscoveryChoice(
  options: DiscoveryChoice[],
  value: string,
  loaded: boolean
): boolean {
  return loaded && !!value.trim() && !options.some((choice) => choice.id === value.trim())
}
