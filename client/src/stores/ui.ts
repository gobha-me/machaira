import { defineStore } from 'pinia'
import { computed, inject, ref } from 'vue'
import { routerKey } from 'vue-router'

export type ScreenId = 'read' | 'plan' | 'study' | 'map' | 'search' | 'library' | 'journal' | 'settings'

export const SCREENS: { id: ScreenId; label: string }[] = [
  { id: 'read', label: 'Read' },
  { id: 'plan', label: 'Plan' },
  { id: 'study', label: 'Study' },
  { id: 'map', label: 'Map' },
  { id: 'search', label: 'Search' },
  { id: 'library', label: 'Library' },
  { id: 'journal', label: 'Journal' },
  { id: 'settings', label: 'Settings' }
]

export const useUi = defineStore('ui', () => {
  const router = inject(routerKey, null)
  const screen = computed<ScreenId>(() =>
    SCREENS.find((entry) => entry.id === router?.currentRoute.value.name)?.id ?? 'read'
  )
  const settingsSection = ref<'semantic-search' | null>(null)
  function go(next: ScreenId): void {
    if (router && next !== screen.value) void router.push({ name: next })
  }
  function openSemanticSettings(): void {
    settingsSection.value = 'semantic-search'
    go('settings')
  }
  function findRelated(phrase: string): void {
    const query = phrase.trim()
    if (router && query) void router.push({ name: 'search', query: { related: query } })
  }
  return { screen, settingsSection, go, openSemanticSettings, findRelated }
})
