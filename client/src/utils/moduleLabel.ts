import type { ModuleInfo } from '../services/api'

type ModuleLabelInfo = Pick<ModuleInfo, 'name' | 'description' | 'abbreviation'>

// These catalog IDs lack a useful short name in some SWORD repositories. Keep display
// aliases separate from the IDs used in API requests, saved preferences, and URLs.
const DISPLAY_ALIASES: Record<string, string> = {
  enggnv1599eb: 'Geneva 1599',
  Geneva1599: 'Geneva 1599',
  LSV: 'LSV'
}

export function moduleLabel(module: ModuleLabelInfo): string {
  return Object.hasOwn(DISPLAY_ALIASES, module.name) ? DISPLAY_ALIASES[module.name]!
    : module.abbreviation?.trim() || module.description?.trim() || module.name
}
