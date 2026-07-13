import { defineStore } from 'pinia'

export type ScreenId = 'read' | 'study' | 'search' | 'library' | 'journal' | 'settings'

export const SCREENS: { id: ScreenId; label: string }[] = [
  { id: 'read', label: 'Read' },
  { id: 'study', label: 'Study' },
  { id: 'search', label: 'Search' },
  { id: 'library', label: 'Library' },
  { id: 'journal', label: 'Journal' },
  { id: 'settings', label: 'Settings' }
]

export const useUi = defineStore('ui', {
  state: () => ({
    screen: 'read' as ScreenId
  }),
  actions: {
    go(screen: ScreenId): void {
      this.screen = screen
    }
  }
})
