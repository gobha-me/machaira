import type { VerseSegment } from '../services/api'

const CLOSE_PUNCT = /^[,.;:!?)\]}”’»…]/
const OPEN_PUNCT = /[(\[{“‘«]$/

// Notes have no prose width. Check both visible neighbours so splitting a quote or
// added-word bracket into text/word/note segments cannot reintroduce an inner gap.
export function segLead(segments: readonly VerseSegment[], i: number): string {
  const current = segments[i]
  if (!current || current.kind === 'note' || !current.text.trim()) return ''
  const text = current.text.trimStart()
  let previous = ''
  for (let j = i - 1; j >= 0; j--) {
    const segment = segments[j]
    if (segment && segment.kind !== 'note' && segment.text.trim()) {
      previous = segment.text
      break
    }
  }
  if (!previous || /\s$/.test(previous) || /^\s/.test(current.text)) return ''
  return CLOSE_PUNCT.test(text) || OPEN_PUNCT.test(previous.trimEnd()) ? '' : ' '
}
