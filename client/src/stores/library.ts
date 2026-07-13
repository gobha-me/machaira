import { defineStore } from 'pinia'
import { api, type ModuleInfo } from '../services/api'

// Preferred modules surfaced first in the Library (matches the prototype's set).
// Names are resolved case-insensitively against what the repos actually offer;
// anything missing simply doesn't render — no fabricated rows.
const FEATURED_BIBLES = ['WEB', 'KJVA', 'KJV', 'ASV', 'YLT', 'Brenton', 'LXX']
const FEATURED_DICTS = ['StrongsGreek', 'StrongsHebrew']

// SWORD tags modules with ISO language codes ('en', 'grc', 'hbo'). Humanize them for
// the filter and to make free-text search on a language name ("greek") work.
const displayNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'language' })
    : null

function langLabel(code: string): string {
  if (!code) return 'Unknown'
  try {
    return displayNames?.of(code) ?? code
  } catch {
    return code
  }
}

interface LibraryState {
  bibles: ModuleInfo[]
  dicts: ModuleInfo[]
  installedNames: Set<string>
  progress: Record<string, number>
  installing: Set<string>
  loaded: boolean
  loading: boolean
  error: string | null
  query: string
  language: string
}

export interface LanguageOption {
  code: string
  label: string
  count: number
}

function matchesQuery(m: ModuleInfo, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = `${m.name} ${m.abbreviation ?? ''} ${m.description} ${m.language} ${langLabel(m.language)}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

function order(mods: ModuleInfo[], featured: string[]): ModuleInfo[] {
  const rank = new Map(featured.map((n, i) => [n.toLowerCase(), i]))
  return [...mods].sort((a, b) => {
    const ra = rank.has(a.name.toLowerCase()) ? rank.get(a.name.toLowerCase())! : Infinity
    const rb = rank.has(b.name.toLowerCase()) ? rank.get(b.name.toLowerCase())! : Infinity
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name)
  })
}

export const useLibrary = defineStore('library', {
  state: (): LibraryState => ({
    bibles: [],
    dicts: [],
    installedNames: new Set(),
    progress: {},
    installing: new Set(),
    loaded: false,
    loading: false,
    error: null,
    query: '',
    language: ''
  }),
  getters: {
    filterActive(state): boolean {
      return state.query.trim() !== '' || state.language !== ''
    },
    // Languages present across all catalog modules, most-common first, for the filter.
    languages(state): LanguageOption[] {
      const counts = new Map<string, number>()
      for (const m of [...state.bibles, ...state.dicts]) {
        counts.set(m.language, (counts.get(m.language) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([code, count]) => ({ code, label: langLabel(code), count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    },
    filteredBibles(state): ModuleInfo[] {
      return order(
        state.bibles.filter(
          (m) => (!state.language || m.language === state.language) && matchesQuery(m, state.query)
        ),
        FEATURED_BIBLES
      )
    },
    filteredDicts(state): ModuleInfo[] {
      return order(
        state.dicts.filter(
          (m) => (!state.language || m.language === state.language) && matchesQuery(m, state.query)
        ),
        FEATURED_DICTS
      )
    },
    featuredBibles(state): ModuleInfo[] {
      const set = new Set(FEATURED_BIBLES.map((n) => n.toLowerCase()))
      return order(
        state.bibles.filter((m) => set.has(m.name.toLowerCase())),
        FEATURED_BIBLES
      )
    },
    otherBibles(state): ModuleInfo[] {
      const set = new Set(FEATURED_BIBLES.map((n) => n.toLowerCase()))
      return order(
        state.bibles.filter((m) => !set.has(m.name.toLowerCase())),
        []
      )
    },
    lexicons(state): ModuleInfo[] {
      return order(state.dicts, FEATURED_DICTS)
    },
    installedBibles(state): ModuleInfo[] {
      return state.bibles.filter((m) => state.installedNames.has(m.name))
    },
    installedCount(state): number {
      return state.installedNames.size
    },
    resultCount(): number {
      return this.filteredBibles.length + this.filteredDicts.length
    }
  },
  actions: {
    isInstalled(name: string): boolean {
      return this.installedNames.has(name)
    },
    clearFilter(): void {
      this.query = ''
      this.language = ''
    },
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return
      this.loading = true
      this.error = null
      try {
        const [bibles, dicts, installed] = await Promise.all([
          api.sources('BIBLE'),
          api.sources('DICT'),
          api.installed()
        ])
        this.bibles = bibles
        this.dicts = dicts
        this.installedNames = new Set(installed.map((m) => m.name))
        this.loaded = true
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.loading = false
      }
    },
    async refreshInstalled(): Promise<void> {
      const installed = await api.installed()
      this.installedNames = new Set(installed.map((m) => m.name))
    },
    async install(name: string): Promise<void> {
      if (this.installing.has(name)) return
      this.installing.add(name)
      this.progress = { ...this.progress, [name]: 0 }
      try {
        await api.install(name, (pct) => {
          this.progress = { ...this.progress, [name]: pct }
        })
        this.installedNames = new Set([...this.installedNames, name])
      } catch (e) {
        this.error = `Install failed for ${name}: ${(e as Error).message}`
      } finally {
        this.installing.delete(name)
        const { [name]: _drop, ...rest } = this.progress
        this.progress = rest
      }
    },
    async uninstall(name: string): Promise<void> {
      await api.uninstall(name)
      const next = new Set(this.installedNames)
      next.delete(name)
      this.installedNames = next
    }
  }
})
