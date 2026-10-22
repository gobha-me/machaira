import { defineStore } from 'pinia'

export type ScreenId = 'read' | 'plan' | 'study' | 'search' | 'library' | 'journal' | 'settings'

export const SCREENS: { id: ScreenId; label: string }[] = [
  { id: 'read', label: 'Read' },
  { id: 'plan', label: 'Plan' },
  { id: 'study', label: 'Study' },
  { id: 'search', label: 'Search' },
  { id: 'library', label: 'Library' },
  { id: 'journal', label: 'Journal' },
  { id: 'settings', label: 'Settings' }
]

export const useUi = defineStore('ui', {
  state: () => ({
    screen: 'read' as ScreenId,
    settingsSection: null as 'semantic-search' | null
  }),
  actions: {
    openSemanticSettings(): void {
      this.settingsSection = 'semantic-search'
      this.screen = 'settings'
    },
    go(screen: ScreenId): void {
      this.screen = screen
    }
  }
})
