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

export interface ParsedVerse {
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
}

// Sentinel wraps a note index in the working string; U+E000 is private-use and never
// appears in scripture text, so it survives tag-stripping and can't collide.
const SENT = ''

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

  let s = raw.replace(NOTE_DIV, (_m, inner: string) => take(inner))
  s = s.replace(TITLE_DIV, ' ')
  s = s.replace(GBF_NOTE, (_m, inner: string) => take(inner))
  s = tighten(decodeEntities(s.replace(TAG, ' ')).replace(/\s+/g, ' ')).trim()

  const notes: VerseNote[] = noteTexts.map((text, i) => ({ label: noteLabel(i), text }))
  const segments: VerseSegment[] = []
  let text = ''
  const parts = s.split(new RegExp(`${SENT}(\\d+)${SENT}`))
  for (let k = 0; k < parts.length; k++) {
    if (k % 2 === 0) {
      const t = tighten(parts[k].replace(/\s+/g, ' ')).trim()
      if (t) {
        segments.push({ kind: 'text', text: t })
        text += (text ? ' ' : '') + t
      }
    } else {
      const note = notes[Number(parts[k])]
      if (note) segments.push({ kind: 'note', label: note.label, text: note.text })
    }
  }

  return { text: tighten(text).trim(), notes, segments }
}
