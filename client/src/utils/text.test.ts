import { describe, expect, it } from 'vitest'
import { parseVerseMarkup } from '../../../server/src/text'
import { spacingCases } from '../../../server/test/fixtures/verse-markup'
import type { VerseSegment } from '../services/api'
import { segLead } from './text'

const render = (segments: VerseSegment[]) => segments.map((segment, i) =>
  segment.kind === 'note' ? '' : segLead(segments, i) + segment.text
).join('')

describe('verse segment spacing', () => {
  it.each(spacingCases)('renders OSIS consistently: $name', ({ markup, expected }) => {
    expect(render(parseVerseMarkup(markup).segments)).toBe(expected)
  })

  it.each([
    ['[', 'the', ']', '[the]'],
    ['“', 'light', '”', '“light”'],
    ['(“[', 'light', ']”),', '(“[light]”),'],
    ['«', 'light', '»', '«light»'],
    ['{', 'light', '}', '{light}'],
    ['In the beginning was the ', 'Word', ', and the Word was God.', 'In the beginning was the Word, and the Word was God.']
  ])('checks both visible neighbours in %s / %s / %s', (open, word, close, expected) => {
    const segments: VerseSegment[] = [
      { kind: 'note', label: 'a', text: 'Leading note' },
      { kind: 'text', text: open },
      { kind: 'note', label: 'b', text: 'Note after opener' },
      { kind: 'text', text: '' },
      { kind: 'word', text: word, strongs: ['H216'] },
      { kind: 'note', label: 'c', text: 'Note before closer' },
      { kind: 'text', text: close }
    ]
    expect(render(segments)).toBe(expected)
  })

  it('handles absent segments and note-only input without adding spaces', () => {
    expect(segLead([], 0)).toBe('')
    expect(segLead([], -1)).toBe('')
    expect(render([{ kind: 'note', label: 'a', text: 'No prose' }])).toBe('')
  })
})
