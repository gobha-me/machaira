import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVerseMarkup, stripMarkup } from '../src/text.ts'

// ASV John 1:1; marker-like metadata must never erase the reading text.
const VERSE = 'In the beginning was the Word, and the Word was with God, and the Word was God.'
const NOTE = 'Or, the Word was divine.'
const REFERENCE = 'Isaiah 40:3'
const TARGET = { book: 'Isa', chapter: 40, verseStart: 3, verseEnd: 3 }

function assertPlain(markup: string, text = VERSE): void {
  assert.deepEqual(parseVerseMarkup(markup), {
    text, notes: [], segments: [{ kind: 'text', text }],
    crossReferences: [], crossReferenceTargets: []
  })
  assert.equal(stripMarkup(markup), text)
}

const ordinaryAttributes = [
  ['note marker in title', 'title="sword-note"'],
  ['heading marker in title', "title='sword-section-title'"],
  ['data-class note', 'data-class="sword-note"'],
  ['data-class heading', "data-class='sword-section-title'"],
  ['prefixed note class', 'class="not-sword-note"'],
  ['suffixed note class', "class='sword-note-extra'"],
  ['prefixed heading class', 'class="not-sword-section-title"'],
  ['suffixed heading class', "class='sword-section-title-extra'"],
  ['punctuation is not a class delimiter', 'class="sword-note,sword-section-title"'],
  ['unquoted title', 'title=sword-note'],
  ['unrelated classes around a partial token', 'class="paragraph sword-note-extra current"'],
  ['fake single-quoted class inside title', 'data-before="a" title="class=\'sword-note\'" data-after="b"'],
  ['fake double-quoted class inside title', 'data-before=\'a\' title=\'class="sword-section-title"\' data-after=\'b\''],
  ['real class following quoted fake class', 'title="class=\'sword-note\'" class="paragraph"'],
  ['real class preceding quoted fake class', 'class=\'paragraph\' title=\'class="sword-section-title"\''],
  ['fake class and type together', 'title="class=\'sword-note\' type=\'crossReference\'"']
] as const

describe('rendered SWORD class and type attribute boundaries', () => {
  for (const [name, attributes] of ordinaryAttributes) {
    it(`retains ordinary verse prose: ${name}`, () => {
      assertPlain(`<div ${attributes}>${VERSE}</div>`)
    })
  }

  for (const [name, attributes] of [
    ['data-type before class', 'data-type="crossReference" class="sword-note"'],
    ['data-type after class', "class='sword-note' data-type='crossReference'"],
    ['fake single-quoted type inside title', 'title="type=\'crossReference\'" class="sword-markup sword-note"'],
    ['fake double-quoted type inside title', 'class=\'sword-markup sword-note\' title=\'type="crossReference"\'']
  ] as const) {
    it(`keeps a translator note when only metadata names a cross-reference: ${name}`, () => {
      const markup = `${VERSE}<div ${attributes}>${REFERENCE}</div>`
      assert.deepEqual(parseVerseMarkup(markup), {
        text: VERSE,
        notes: [{ label: 'a', text: REFERENCE }],
        segments: [{ kind: 'text', text: VERSE }, { kind: 'note', label: 'a', text: REFERENCE }],
        crossReferences: [], crossReferenceTargets: []
      })
      assert.equal(stripMarkup(markup), VERSE)
    })
  }

  // Each native-compatibility case also carries a deceptive ordinary wrapper.
  // Main must fail on the lost prose while the expected annotation stays exact.
  for (const [name, attributes] of [
    ['double quotes', 'class="sword-markup sword-note"'],
    ['single quotes and token order', "class='sword-note sword-markup'"],
    ['tabs and newlines between classes', 'data-before="a" class="first\tsword-note\nlast" data-after="b"'],
    ['case and spaces around equals', 'CLASS = "SWORD-MARKUP SWORD-NOTE"'],
    ['unquoted single class', 'class=sword-note']
  ] as const) {
    it(`extracts the genuine translator note beside deceptive metadata: ${name}`, () => {
      const markup = `<div title="sword-note">${VERSE}</div><div ${attributes}>${NOTE}</div>`
      assert.deepEqual(parseVerseMarkup(markup), {
        text: VERSE,
        notes: [{ label: 'a', text: NOTE }],
        segments: [{ kind: 'text', text: VERSE }, { kind: 'note', label: 'a', text: NOTE }],
        crossReferences: [], crossReferenceTargets: []
      })
      assert.equal(stripMarkup(markup), VERSE)
    })
  }

  for (const [name, attributes] of [
    ['native chapter heading', 'class="sword-markup sword-section-title"'],
    ['single quotes and token order', "class='sword-section-title sword-markup'"],
    ['whitespace and case', 'CLASS = "first\tSWORD-SECTION-TITLE\nlast"'],
    ['unquoted single class', 'class=sword-section-title']
  ] as const) {
    it(`removes only the genuine chapter heading: ${name}`, () => {
      assertPlain(
        `<div data-class="sword-section-title">${VERSE}</div>` +
        `<div ${attributes}>The Word Became Flesh</div>`
      )
    })
  }

  for (const [name, attributes] of [
    ['type before class', 'type="crossReference" class="sword-markup sword-note"'],
    ['type after class and single quotes', "class='sword-note sword-markup' type='crossReference'"],
    ['case and class whitespace', 'TYPE = "CROSSREFERENCE" CLASS = "first\tsword-note\nlast"'],
    ['unquoted attributes', 'class=sword-note type=crossReference'],
    ['actual type beside misleading data-type', 'data-type="translatorNote" class="sword-note" type="crossReference"']
  ] as const) {
    it(`extracts only the genuine cross-reference beside deceptive metadata: ${name}`, () => {
      const markup = `<div class="not-sword-note">${VERSE}</div><div ${attributes}>${REFERENCE}</div>`
      assert.deepEqual(parseVerseMarkup(markup), {
        text: VERSE, notes: [], segments: [{ kind: 'text', text: VERSE }],
        crossReferences: [REFERENCE], crossReferenceTargets: [TARGET]
      })
      assert.equal(stripMarkup(markup), VERSE)
    })
  }

  it('keeps nested ordinary prose and punctuation while separating real note and structured reference', () => {
    const markup = '<div class="paragraph" title="sword-note">The Word' +
      `<div class="sword-note">${NOTE}</div> was God.</div>` +
      '<div class="sword-section-title">The Word Became Flesh</div>' +
      '<div type="crossReference" class="sword-note">' +
      '<reference osisRef="Isa.40.3-Isa.40.5">the prophet</reference></div>'
    assert.deepEqual(parseVerseMarkup(markup), {
      text: 'The Word was God.',
      notes: [{ label: 'a', text: NOTE }],
      segments: [
        { kind: 'text', text: 'The Word' },
        { kind: 'note', label: 'a', text: NOTE },
        { kind: 'text', text: 'was God.' }
      ],
      crossReferences: ['the prophet'],
      crossReferenceTargets: [{ book: 'Isa', chapter: 40, verseStart: 3, verseEnd: 5 }]
    })
    assert.equal(stripMarkup(markup), 'The Word was God.')
  })

  it('does not retain matcher state, labels or targets across alternating calls', () => {
    for (let round = 0; round < 3; round++) {
      const markup = `<div class="sword-note">${NOTE}</div>` +
        `<div title="sword-section-title">${VERSE}</div>` +
        `<div class="sword-note" type="crossReference">${REFERENCE}</div>`
      assert.deepEqual(parseVerseMarkup(markup), {
        text: VERSE,
        notes: [{ label: 'a', text: NOTE }],
        segments: [{ kind: 'note', label: 'a', text: NOTE }, { kind: 'text', text: VERSE }],
        crossReferences: [REFERENCE], crossReferenceTargets: [TARGET]
      })
      assert.equal(stripMarkup(markup), VERSE)
      assertPlain(`<div title="class='sword-note'">${VERSE}</div>`)
    }
  })
})
