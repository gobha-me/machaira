import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVerseMarkup, stripMarkup } from '../src/text.ts'

describe('SWORD verse markup', () => {
  it('separates cross-references from translator footnotes and verse text', () => {
    const parsed = parseVerseMarkup(
      'He said <div class="sword-markup sword-note">Translator note.</div> this ' +
        '<div class="sword-markup sword-note" type="crossReference">Isaiah 40:3</div> clearly.'
    )

    assert.equal(parsed.text, 'He said this clearly.')
    assert.deepEqual(parsed.notes, [{ label: 'a', text: 'Translator note.' }])
    assert.deepEqual(parsed.crossReferences, ['Isaiah 40:3'])
    assert.equal(parsed.segments.filter((segment) => segment.kind === 'note').length, 1)
  })

  it('recognizes raw OSIS cross-reference notes and cleans their inline markup', () => {
    const parsed = parseVerseMarkup(
      "Text <note n='x' type='crossReference'><reference>Psalm 91:11-12 &amp; 13</reference></note> end."
    )

    assert.equal(parsed.text, 'Text end.')
    assert.deepEqual(parsed.notes, [])
    assert.deepEqual(parsed.crossReferences, ['Psalm 91:11-12 & 13'])
  })

  it('keeps cross-reference notes out of plain-text consumers', () => {
    assert.equal(
      stripMarkup(
        'Text <div class="sword-markup sword-note" type="crossReference">Isaiah 7:14</div> end.'
      ),
      'Text end.'
    )
  })
})
