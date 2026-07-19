import { defineStore } from 'pinia'
import {
  DEFAULT_ACCENT_DARK,
  DEFAULT_ACCENT_LIGHT,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  type ThemeId
} from '../theme'

const KEY = 'sword.settings.v1'

interface SettingsState {
  theme: ThemeId
  accent: string
  textScale: number
  extraSpacing: boolean
  followAlong: boolean
  drawApocrypha: boolean
  alwaysCite: boolean
  showFootnotes: boolean
  showStrongs: boolean
  defaultModuleName: string | null
  compareModuleNames: string[] | null
  commentaryModuleName: string | null
}

function load(): Partial<SettingsState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export const useSettings = defineStore('settings', {
  state: (): SettingsState => ({
    theme: 'paper',
    accent: DEFAULT_ACCENT_LIGHT,
    textScale: 1,
    extraSpacing: false,
    followAlong: true,
    drawApocrypha: true,
    alwaysCite: true,
    showFootnotes: true,
    showStrongs: false,
    defaultModuleName: null,
    compareModuleNames: null,
    commentaryModuleName: null,
    ...load()
  }),
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
    persist() {
      localStorage.setItem(KEY, JSON.stringify(this.$state))
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
    ) {
      this[key] = !this[key]
      this.persist()
    }
  }
})
