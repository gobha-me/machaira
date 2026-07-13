// Design tokens transcribed from the Sword.dc.html prototype (applyVars()).

export type ThemeId = 'paper' | 'ink'

export interface Palette {
  paper: string
  card: string
  ink: string
  muted: string
  line: string
  soft: string
  gold: string
}

export const PALETTES: Record<ThemeId, Palette> = {
  paper: {
    paper: '#F6F2EA',
    card: '#FDFBF6',
    ink: '#231D14',
    muted: '#71675A',
    line: '#E5DDCE',
    soft: '#EFE8DB',
    gold: '#A8842C'
  },
  ink: {
    paper: '#171310',
    card: '#201B16',
    ink: '#EAE2D6',
    muted: '#9A8F81',
    line: '#2F2820',
    soft: '#241E17',
    gold: '#C9A75A'
  }
}

// Accent swatches offered in Settings (prototype order).
export const ACCENTS = ['#8A3B34', '#3B5280', '#3E6B4F', '#7A5A2E'] as const

// The prototype's dark-theme default accent when the user hasn't picked one.
export const DEFAULT_ACCENT_DARK = '#C77E6C'
export const DEFAULT_ACCENT_LIGHT = '#8A3B34'

export const TEXT_SCALE_MIN = 0.9
export const TEXT_SCALE_MAX = 1.4
export const TEXT_SCALE_STEP = 0.05

// Foreground used on accent-filled buttons in the prototype.
export const ON_ACCENT = '#FBF7EF'

/** Apply the palette + accent + text scale as CSS custom properties on an element. */
export function applyVars(
  el: HTMLElement,
  opts: { theme: ThemeId; accent: string; textScale: number }
): void {
  const p = PALETTES[opts.theme]
  el.style.setProperty('--paper', p.paper)
  el.style.setProperty('--card', p.card)
  el.style.setProperty('--ink', p.ink)
  el.style.setProperty('--muted', p.muted)
  el.style.setProperty('--line', p.line)
  el.style.setProperty('--soft', p.soft)
  el.style.setProperty('--gold', p.gold)
  el.style.setProperty('--accent', opts.accent)
  el.style.setProperty('--on-accent', ON_ACCENT)
  el.style.setProperty('--vs', String(opts.textScale))
}
