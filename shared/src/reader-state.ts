/** Account-synced reader data. Timestamps are client Unix milliseconds; ties keep stored state. */
export interface ReadingCursor {
  moduleName: string
  book: string
  chapter: number
  updated_at: number
}

export interface ReaderPreferences {
  theme: 'paper' | 'ink'
  accent: string
  textScale: number
  extraSpacing: boolean
  followAlong: boolean
  drawApocrypha: boolean
  alwaysCite: boolean
  showFootnotes: boolean
  showStrongs: boolean
  studyPartnerOpen: boolean
  defaultModuleName: string | null
  compareModuleNames: string[] | null
  commentaryModuleName: string | null
}

export interface UserPreferences {
  preferences: Partial<ReaderPreferences>
  updated_at: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function validModuleName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
}

export function parseReadingCursor(value: unknown): ReadingCursor | null {
  if (!record(value) || Object.keys(value).some((key) => !['moduleName', 'book', 'chapter', 'updated_at'].includes(key))) return null
  if (!validModuleName(value.moduleName) || typeof value.book !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value.book) ||
      typeof value.chapter !== 'number' || !Number.isSafeInteger(value.chapter) || value.chapter < 1 ||
      !timestamp(value.updated_at)) return null
  return { moduleName: value.moduleName, book: value.book, chapter: value.chapter, updated_at: value.updated_at }
}

/** Unknown preference keys are deliberately dropped; known keys must have valid values. */
export function parsePreferences(value: unknown): Partial<ReaderPreferences> | null {
  if (!record(value)) return null
  const result: Record<string, unknown> = {}
  const validators: Record<keyof ReaderPreferences, (input: unknown) => boolean> = {
    theme: (input) => input === 'paper' || input === 'ink',
    accent: (input) => typeof input === 'string' && (input === '' || /^#[0-9a-fA-F]{6}$/.test(input)),
    textScale: (input) => typeof input === 'number' && Number.isFinite(input) && input >= 0.9 && input <= 1.4,
    extraSpacing: (input) => typeof input === 'boolean',
    followAlong: (input) => typeof input === 'boolean',
    drawApocrypha: (input) => typeof input === 'boolean',
    alwaysCite: (input) => typeof input === 'boolean',
    showFootnotes: (input) => typeof input === 'boolean',
    showStrongs: (input) => typeof input === 'boolean',
    studyPartnerOpen: (input) => typeof input === 'boolean',
    defaultModuleName: (input) => input === null || validModuleName(input),
    compareModuleNames: (input) => input === null || (Array.isArray(input) && input.length <= 128 && input.every(validModuleName)),
    commentaryModuleName: (input) => input === null || validModuleName(input)
  }
  for (const [key, validate] of Object.entries(validators)) {
    if (!Object.hasOwn(value, key)) continue
    if (!validate(value[key])) return null
    result[key] = value[key]
  }
  return result
}

export function parseUserPreferences(value: unknown): UserPreferences | null {
  if (!record(value) || Object.keys(value).some((key) => !['preferences', 'updated_at'].includes(key)) ||
      !timestamp(value.updated_at)) return null
  const preferences = parsePreferences(value.preferences)
  return preferences ? { preferences, updated_at: value.updated_at } : null
}
