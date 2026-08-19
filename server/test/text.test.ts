import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVerseMarkup, stripMarkup } from '../src/text.ts'
import { parseDisplayTargets, parseOsisTargets } from '../src/scripture-reference.ts'

describe('SWORD verse markup', () => {
  it('separates cross-references from translator footnotes and verse text', () => {
    const parsed = parseVerseMarkup(
      'He said <div class="sword-markup sword-note">Translator note.</div> this ' +
        '<div class="sword-markup sword-note" type="crossReference">Isaiah 40:3</div> clearly.'
    )

    assert.equal(parsed.text, 'He said this clearly.')
    assert.deepEqual(parsed.notes, [{ label: 'a', text: 'Translator note.' }])
    assert.deepEqual(parsed.crossReferences, ['Isaiah 40:3'])
    assert.deepEqual(parsed.crossReferenceTargets, [{
      book: 'Isa', chapter: 40, verseStart: 3, verseEnd: 3
    }])
    assert.equal(parsed.segments.filter((segment) => segment.kind === 'note').length, 1)
  })

  it('recognizes raw OSIS cross-reference notes and cleans their inline markup', () => {
    const parsed = parseVerseMarkup(
      "Text <note n='x' type='crossReference'><reference>Psalm 91:11-12 &amp; 13</reference></note> end."
    )

    assert.equal(parsed.text, 'Text end.')
    assert.deepEqual(parsed.notes, [])
    assert.deepEqual(parsed.crossReferences, ['Psalm 91:11-12 & 13'])
    assert.deepEqual(parsed.crossReferenceTargets, [{
      book: 'Ps', chapter: 91, verseStart: 11, verseEnd: 12
    }])
  })

  it('keeps cross-reference notes out of plain-text consumers', () => {
    assert.equal(
      stripMarkup(
        'Text <div class="sword-markup sword-note" type="crossReference">Isaiah 7:14</div> end.'
      ),
      'Text end.'
    )
  })

  it('prefers structured OSIS targets and preserves same-chapter ranges', () => {
    const parsed = parseVerseMarkup(
      'Text <note type="crossReference"><reference osisRef="Isa.40.3-Isa.40.5">' +
      'the prophet</reference></note> end.'
    )
    assert.deepEqual(parsed.crossReferenceTargets, [{
      book: 'Isa', chapter: 40, verseStart: 3, verseEnd: 5
    }])
  })
})

describe('Scripture reference targets', () => {
  it('parses OSIS lists and rejects cross-chapter ranges', () => {
    assert.deepEqual(parseOsisTargets('Isa.40.3 Ps.91.11-Ps.91.12'), [
      { book: 'Isa', chapter: 40, verseStart: 3, verseEnd: 3 },
      { book: 'Ps', chapter: 91, verseStart: 11, verseEnd: 12 }
    ])
    assert.deepEqual(parseOsisTargets('John.3.16-John.4.2'), [])
  })

  it('only resolves explicit, unambiguous display references', () => {
    assert.deepEqual(parseDisplayTargets('See Isaiah 40:3-5; Psalm 91:11 & 13'), [
      { book: 'Isa', chapter: 40, verseStart: 3, verseEnd: 5 },
      { book: 'Ps', chapter: 91, verseStart: 11, verseEnd: 11 }
    ])
    assert.deepEqual(parseDisplayTargets('vv. 4-8 & 13'), [])
  })
})
