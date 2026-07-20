// Typed client for the local SWORD backend (proxied at /api in dev).

export interface ModuleInfo {
  name: string
  type: string
  description: string
  language: string
  abbreviation?: string
  distributionLicense?: string
  repository?: string
  version?: string
  size?: number
  about?: string
  hasStrongs: boolean
  hasGreekStrongsKeys: boolean
  hasHebrewStrongsKeys: boolean
  hasFootnotes: boolean
  hasHeadings: boolean
  hasRedLetterWords: boolean
  hasCrossReferences: boolean
  locked: boolean
  installed: boolean
}

export interface BookEntry {
  code: string
  name: string
  section: 'ot' | 'nt' | 'apocrypha'
  chapters: number
}

export interface VerseNote {
  label: string
  text: string
}

export type VerseSegment =
  | { kind: 'text'; text: string }
  | { kind: 'note'; label: string; text: string }
  | { kind: 'word'; text: string; strongs: string[] }

export interface ChapterVerse {
  n: number
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
}

export interface ChapterPayload {
  module: string
  book: string
  bookName: string
  chapter: number
  verses: ChapterVerse[]
}

export interface CompareRow {
  module: string
  hasStrongs: boolean
  license: string
  verses: { n: number; text: string | null }[]
}

export interface StrongsPayload {
  key: string
  transcription: string
  phonetic: string
  definition: string
  references: unknown[]
}

export interface CommentaryEntry {
  n: number
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
}

export interface CommentaryPayload {
  module: string
  book: string
  bookName: string
  chapter: number
  locked: boolean
  entries: CommentaryEntry[]
}

export interface SearchHit {
  module: string
  book: string
  bookName: string
  chapter: number
  verse: number
  content: string
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as ApiErrorBody)
  return res.json() as Promise<T>
}

export interface ApiErrorBody {
  error?: string
  message?: string
}

export class ApiError extends Error {
  status: number
  body: ApiErrorBody
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error ?? `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

export const api = {
  async repositories(): Promise<string[]> {
    return (await getJson<{ repositories: string[] }>('/api/repositories')).repositories
  },

  async sources(type: 'BIBLE' | 'DICT' | 'COMMENTARY' = 'BIBLE'): Promise<ModuleInfo[]> {
    return (await getJson<{ modules: ModuleInfo[] }>(`/api/sources?type=${type}`)).modules
  },

  async installed(): Promise<ModuleInfo[]> {
    return (await getJson<{ modules: ModuleInfo[] }>('/api/sources/installed')).modules
  },

  async uninstall(module: string): Promise<void> {
    const res = await fetch(`/api/sources/${encodeURIComponent(module)}`, { method: 'DELETE' })
    if (!res.ok) throw new ApiError(res.status, {})
  },

  /** Install a module, streaming progress via SSE. Resolves when done. */
  install(module: string, onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      fetch(`/api/sources/${encodeURIComponent(module)}/install`, { method: 'POST' })
        .then((res) => {
          if (!res.body) return reject(new Error('no stream'))
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          const pump = (): Promise<void> =>
            reader.read().then(({ done, value }) => {
              if (done) return resolve()
              buffer += decoder.decode(value, { stream: true })
              const events = buffer.split('\n\n')
              buffer = events.pop() ?? ''
              for (const chunk of events) {
                const evLine = chunk.split('\n').find((l) => l.startsWith('event:'))
                const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))
                const ev = evLine?.slice(6).trim()
                const data = dataLine ? JSON.parse(dataLine.slice(5).trim()) : {}
                if (ev === 'progress') onProgress(data.pct)
                else if (ev === 'done') {
                  onProgress(100)
                  resolve()
                } else if (ev === 'error') reject(new Error(data.message))
              }
              return pump()
            })
          return pump()
        })
        .catch(reject)
    })
  },

  async books(module: string): Promise<BookEntry[]> {
    return (await getJson<{ books: BookEntry[] }>(`/api/modules/${encodeURIComponent(module)}/books`))
      .books
  },

  async chapter(module: string, book: string, chapter: number): Promise<ChapterPayload> {
    return getJson<ChapterPayload>(
      `/api/read/${encodeURIComponent(module)}/${encodeURIComponent(book)}/${chapter}`
    )
  },

  async compare(book: string, chapter: number, lo: number, hi: number, modules: string[]) {
    const verse = lo === hi ? `${lo}` : `${lo}-${hi}`
    return getJson<{ translations: CompareRow[]; bookName: string }>(
      `/api/compare/${encodeURIComponent(book)}/${chapter}/${verse}?modules=${modules.join(',')}`
    )
  },

  async strongs(key: string): Promise<StrongsPayload> {
    return getJson<StrongsPayload>(`/api/strongs/${encodeURIComponent(key)}`)
  },

  async commentary(module: string, book: string, chapter: number): Promise<CommentaryPayload> {
    return getJson<CommentaryPayload>(
      `/api/commentary/${encodeURIComponent(module)}/${encodeURIComponent(book)}/${chapter}`
    )
  },

  async search(q: string, modules: string[]): Promise<SearchHit[]> {
    const res = await getJson<{ results: SearchHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}&modules=${modules.join(',')}`
    )
    return res.results
  }
}
