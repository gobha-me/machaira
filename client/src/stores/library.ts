import { defineStore } from 'pinia'
import { api, type ModuleInfo, type RepositoryDiagnostic } from '../services/api'

export type LibraryCategory = 'all' | 'installed' | 'scripture' | 'deuterocanon' | 'ancient-writings' | 'commentary' | 'lexicon'

const displayNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
  ? new Intl.DisplayNames(['en'], { type: 'language' })
  : null

function languageLabel(code: string): string {
  if (!code) return 'Unknown'
  try { return displayNames?.of(code) ?? code } catch { return code }
}

function uniqueInstalled(modules: ModuleInfo[]): ModuleInfo[] {
  const seen = new Set<string>()
  return modules.filter((module) => module.installed && !seen.has(module.name) && Boolean(seen.add(module.name)))
}

function categoryMatches(module: ModuleInfo, category: LibraryCategory): boolean {
  if (category === 'all') return true
  if (category === 'installed') return module.installed
  if (category === 'scripture') return module.kind === 'scripture'
  if (category === 'deuterocanon') return module.collection === 'deuterocanon'
  if (category === 'ancient-writings') return module.collection === 'ancient-writings'
  return module.kind === category
}

export function catalogSearchText(module: ModuleInfo): string {
  return [module.name, module.description, module.abbreviation, module.language,
    languageLabel(module.language), module.repository, module.distributionLicense, module.tradition,
    module.collection, module.coverageSummary,
    module.collection === 'deuterocanon' ? 'apocrypha deuterocanon' : '',
    ...module.coverage].filter(Boolean).join(' ').toLocaleLowerCase()
}

export const useLibrary = defineStore('library', {
  state: () => ({
    generation: 0,
    modules: [] as ModuleInfo[],
    diagnostics: [] as RepositoryDiagnostic[],
    usedCachedCatalog: false,
    refreshedAt: null as number | null,
    preferences: {} as Record<string, boolean>,
    progress: {} as Record<string, number>,
    installing: new Set<string>(),
    loaded: false,
    loading: false,
    importing: false,
    error: null as string | null,
    query: '',
    language: '',
    category: 'all' as LibraryCategory
  }),
  getters: {
    installedModules(state): ModuleInfo[] { return uniqueInstalled(state.modules) },
    installedBibles(): ModuleInfo[] { return this.installedModules.filter((module) => module.kind === 'scripture') },
    installedGeneralBooks(): ModuleInfo[] { return this.installedModules.filter((module) => module.kind === 'general-book') },
    installedDicts(): ModuleInfo[] { return this.installedModules.filter((module) => module.kind === 'lexicon') },
    installedCommentaries(): ModuleInfo[] { return this.installedModules.filter((module) => module.kind === 'commentary') },
    installedCount(): number { return this.installedModules.length },
    languages(state): Array<{ code: string; label: string; count: number }> {
      const counts = new Map<string, number>()
      for (const module of state.modules) counts.set(module.language, (counts.get(module.language) ?? 0) + 1)
      return [...counts].map(([code, count]) => ({ code, label: languageLabel(code), count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    },
    filteredModules(state): ModuleInfo[] {
      const terms = state.query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
      return state.modules.filter((module) => {
        if (!categoryMatches(module, state.category) || (state.language && module.language !== state.language)) return false
        const haystack = catalogSearchText(module)
        return terms.every((term) => haystack.includes(term))
      }).sort((left, right) => Number(right.installed) - Number(left.installed)
        || Number(right.collection === 'deuterocanon') - Number(left.collection === 'deuterocanon')
        || left.description.localeCompare(right.description))
    },
    repositoryProblems(state): RepositoryDiagnostic[] {
      return state.diagnostics.filter((repo) => repo.status === 'failed')
    }
  },
  actions: {
    isInstalled(name: string): boolean { return this.modules.some((module) => module.name === name && module.installed) },
    async load(force = false, refreshRepositories = force): Promise<void> {
      if (this.loaded && !force) return
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        const [catalog, preferences] = await Promise.all([api.catalog(refreshRepositories), api.corpusPreferences()])
        if (generation !== this.generation) return
        this.modules = catalog.modules
        this.diagnostics = catalog.diagnostics.repositories
        this.usedCachedCatalog = catalog.diagnostics.usedCachedCatalog
        this.refreshedAt = catalog.diagnostics.refreshedAt
        this.preferences = preferences
        this.loaded = true
      } catch (error) {
        if (generation !== this.generation) return
        this.error = (error as Error).message
      } finally {
        if (generation === this.generation) this.loading = false
      }
    },
    async refreshInstalled(): Promise<void> { await this.load(true, false) },
    async install(module: ModuleInfo): Promise<void> {
      if (!module.repository || this.installing.has(module.id)) return
      const generation = this.generation
      this.installing.add(module.id)
      this.progress = { ...this.progress, [module.id]: 0 }
      try {
        await api.install(module.repository, module.name, (pct) => {
          if (generation === this.generation) this.progress = { ...this.progress, [module.id]: pct }
        })
        if (generation !== this.generation) return
        await this.load(true, false)
      } catch (error) {
        if (generation !== this.generation) return
        this.error = `Install failed for ${module.name}: ${(error as Error).message}`
      } finally {
        if (generation === this.generation) {
          this.installing.delete(module.id)
          const { [module.id]: _removed, ...rest } = this.progress
          this.progress = rest
        }
      }
    },
    async uninstall(name: string): Promise<void> {
      const generation = this.generation
      await api.uninstall(name)
      if (generation !== this.generation) return
      await this.load(true, false)
    },
    async importSword(file: File): Promise<string[]> {
      const generation = this.generation
      this.importing = true
      this.error = null
      try {
        const modules = await api.importSword(file)
        if (generation !== this.generation) return []
        await this.load(true, false)
        if (generation !== this.generation) return []
        return modules
      } catch (error) {
        if (generation !== this.generation) return []
        this.error = (error as Error).message
        throw error
      } finally { if (generation === this.generation) this.importing = false }
    },
    async setAiEnabled(module: ModuleInfo, enabled: boolean): Promise<void> {
      const generation = this.generation
      await api.setCorpusPreference(module.name, enabled)
      if (generation !== this.generation) return
      this.preferences = { ...this.preferences, [module.name]: enabled }
    },
    resetPersonalData(): void {
      this.generation += 1
      this.preferences = {}
      this.progress = {}
      this.installing.clear()
      this.loading = false
      this.importing = false
      this.error = null
      // The shared module catalog remains reusable, but preferences need a fresh load.
      this.loaded = false
    }
  }
})
