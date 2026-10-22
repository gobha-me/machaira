import { defineStore } from 'pinia'
import { parseUserPreferences, parsePreferences, type ReaderPreferences, type UserPreferences } from '@machaira/scripture'
import { api } from '../services/api'
import { AccountCache } from '../services/accountCache'
import {
  DEFAULT_ACCENT_DARK,
  DEFAULT_ACCENT_LIGHT,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  type ThemeId
} from '../theme'

const KEY = 'sword.settings.v1'

const settingsKey = (userId: string) => `${KEY}:${encodeURIComponent(userId)}`
const syncs = new WeakMap<object, AccountCache<UserPreferences>>()

function defaults(): ReaderPreferences {
  return {
    theme: 'paper',
    accent: DEFAULT_ACCENT_LIGHT,
    textScale: 1,
    extraSpacing: false,
    followAlong: true,
    drawApocrypha: true,
    alwaysCite: true,
    showFootnotes: true,
    showStrongs: false,
    studyPartnerOpen: false,
    defaultModuleName: null,
    compareModuleNames: null,
    commentaryModuleName: null
  }
}

export const useSettings = defineStore('settings', {
  state: defaults,
  getters: {
    // The effective accent (prototype falls back to a warmer accent in dark mode).
    effectiveAccent(state): string {
      if (state.accent) return state.accent
      return state.theme === 'ink' ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT
    },
    textScalePct(state): string {
      return `${Math.round(state.textScale * 100)}%`
    }
  },
  actions: {
    activateUser(userId: string | null) {
      syncs.get(this)?.activate(null)
      this.$reset()
      if (!userId) return
      try {
        const legacy = localStorage.getItem(KEY)
        if (legacy !== null) {
          if (localStorage.getItem(settingsKey(userId)) === null) {
            const preferences = parsePreferences(JSON.parse(legacy))
            if (preferences) localStorage.setItem(settingsKey(userId), JSON.stringify({ preferences, updated_at: 0 }))
          }
          // Consume the global value only once, even if this account already has server prefs.
          localStorage.removeItem(KEY)
        }
      } catch {
        // Migration and cache access are best effort when storage is corrupt or unavailable.
      }
      const sync = new AccountCache<UserPreferences>({
        key: settingsKey,
        parse: parseUserPreferences,
        get: () => api.preferences(),
        put: (value) => api.savePreferences(value),
        apply: (value) => this.$patch({ ...defaults(), ...value.preferences })
      })
      syncs.set(this, sync)
      sync.activate(userId)
    },
    async restore(): Promise<void> {
      await syncs.get(this)?.restore()
    },
    persist() {
      syncs.get(this)?.update({ preferences: { ...this.$state } })
    },
    setTheme(theme: ThemeId) {
      this.theme = theme
      this.persist()
    },
    setAccent(accent: string) {
      this.accent = accent
      this.persist()
    },
    setDefaultModule(name: string | null) {
      this.defaultModuleName = name
      this.persist()
    },
    setCompareModules(names: string[]) {
      this.compareModuleNames = names
      this.persist()
    },
    setCommentaryModule(name: string | null) {
      this.commentaryModuleName = name
      this.persist()
    },
    bumpTextScale(delta: number) {
      const next = Math.min(
        TEXT_SCALE_MAX,
        Math.max(TEXT_SCALE_MIN, Math.round((this.textScale + delta) / TEXT_SCALE_STEP) * TEXT_SCALE_STEP)
      )
      this.textScale = Math.round(next * 100) / 100
      this.persist()
    },
    toggle(
      key:
        | 'extraSpacing'
        | 'followAlong'
        | 'drawApocrypha'
        | 'alwaysCite'
        | 'showFootnotes'
        | 'showStrongs'
        | 'studyPartnerOpen'
    ) {
      this[key] = !this[key]
      this.persist()
    }
  }
})
