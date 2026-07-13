// SWORD verse content can carry inline markup and doubled whitespace. Two consumers:
//   • stripMarkup()      — plain text for search/compare (drops notes entirely).
//   • parseVerseMarkup() — reading view: pulls footnotes out into structured notes
//     and returns the verse split into text/note segments for inline markers.
//
// With markup enabled, node-sword-interface renders footnotes as
// `<div class="sword-markup sword-note">…</div>`, headings as `sword-section-title`,
// Strong's words as `<w>`, etc. A few modules also carry GBF `/f … /f*` note markers.

const TAG = /<[^>]*>/g
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

function decodeEntities(input: string): string {
  return input.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? ' ')
}

// Stripping tags leaves spaces before punctuation (e.g. `</w> ,`). Tighten those and
// spaces after opening brackets/quotes. Never joins two word characters, so it can't
// glue words the way SWORD's own strip filter does.
function tighten(input: string): string {
  return input.replace(/\s+([,.;:!?)\]”’])/g, '$1').replace(/([(\[“‘])\s+/g, '$1')
}

function stripInline(input: string): string {
  return tighten(decodeEntities(input.replace(TAG, ' ')).replace(/\s+/g, ' ')).trim()
}

// Rendered footnote/heading blocks (div form), legacy OSIS note forms, and GBF markers.
const NOTE_DIV = /<div\b[^>]*\bsword-note\b[^>]*>([\s\S]*?)<\/div>/gi
const TITLE_DIV = /<div\b[^>]*\bsword-section-title\b[^>]*>[\s\S]*?<\/div>/gi
const GBF_NOTE = /\/f\b\s*\+?\s*([\s\S]*?)\/f\*/gi
const OSIS_NOTE_BLOCKS = /<(note|rf|scripRef|milestone)\b[^>]*>[\s\S]*?<\/\1>/gi

export function stripMarkup(input: string): string {
  return tighten(
    decodeEntities(
      input
        .replace(NOTE_DIV, ' ')
        .replace(TITLE_DIV, ' ')
        .replace(GBF_NOTE, ' ')
        .replace(OSIS_NOTE_BLOCKS, ' ')
        .replace(TAG, ' ')
    ).replace(/\s+/g, ' ')
  ).trim()
}

export interface VerseNote {
  label: string
  text: string
}

export type VerseSegment =
  | { kind: 'text'; text: string }
  | { kind: 'note'; label: string; text: string }
  | { kind: 'word'; text: string; strongs: string[] }

export interface ParsedVerse {
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
}

// Sentinels wrap a note (U+E000) or Strong's-tagged word (U+E001) index in the working
// string; both are private-use and never appear in scripture text, so they survive
// tag-stripping and can't collide.
const SENT = String.fromCharCode(0xe000)
const WSENT = String.fromCharCode(0xe001)
const NOTE_TOKEN = new RegExp(`^${SENT}(\\d+)${SENT}$`)
const WORD_TOKEN = new RegExp(`^${WSENT}(\\d+)${WSENT}$`)

// `<w>` carries per-word Strong's keys as `lemma="strong:G3056"` (a lemma may list
// several space-separated tokens). Only tagged modules (e.g. KJVA) emit these.
const W_TAG = /<w\b([^>]*)>([\s\S]*?)<\/w>/gi
const LEMMA = /strong:([GH]\d+)/gi

function parseLemma(attrs: string): string[] {
  const out: string[] = []
  LEMMA.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LEMMA.exec(attrs)) !== null) out.push(m[1].toUpperCase())
  return out
}

function noteLabel(i: number): string {
  return String.fromCharCode(97 + (i % 26))
}

export function parseVerseMarkup(raw: string): ParsedVerse {
  const noteTexts: string[] = []
  const take = (inner: string): string => {
    const i = noteTexts.length
    noteTexts.push(stripInline(inner))
    return ` ${SENT}${i}${SENT} `
  }

  const wordTokens: { text: string; strongs: string[] }[] = []
  const takeWord = (attrs: string, inner: string): string => {
    const innerText = stripInline(inner)
    const strongs = parseLemma(attrs)
    // No Strong's key → let it fall through as ordinary (non-tappable) text.
    if (strongs.length === 0) return ` ${innerText} `
    const j = wordTokens.length
    wordTokens.push({ text: innerText, strongs })
    return `${WSENT}${j}${WSENT}`
  }

  let s = raw.replace(NOTE_DIV, (_m, inner: string) => take(inner))
  s = s.replace(TITLE_DIV, ' ')
  s = s.replace(GBF_NOTE, (_m, inner: string) => take(inner))
  s = s.replace(W_TAG, (_m, attrs: string, inner: string) => takeWord(attrs, inner))
  s = tighten(decodeEntities(s.replace(TAG, ' ')).replace(/\s+/g, ' ')).trim()

  const notes: VerseNote[] = noteTexts.map((text, i) => ({ label: noteLabel(i), text }))
  const segments: VerseSegment[] = []
  let text = ''
  const append = (t: string): string => (text ? `${text} ${t}` : t)
  const parts = s.split(new RegExp(`(${SENT}\\d+${SENT}|${WSENT}\\d+${WSENT})`))
  for (const part of parts) {
    const wm = part.match(WORD_TOKEN)
    if (wm) {
      const w = wordTokens[Number(wm[1])]
      if (w && w.text) {
        segments.push({ kind: 'word', text: w.text, strongs: w.strongs })
        text = append(w.text)
      }
      continue
    }
    const nm = part.match(NOTE_TOKEN)
    if (nm) {
      const note = notes[Number(nm[1])]
      if (note) segments.push({ kind: 'note', label: note.label, text: note.text })
      continue
    }
    const t = tighten(part.replace(/\s+/g, ' ')).trim()
    if (t) {
      segments.push({ kind: 'text', text: t })
      text = append(t)
    }
  }

  return { text: tighten(text).trim(), notes, segments }
}
