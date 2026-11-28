import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseCommentaryMarkup, parseVerseMarkup } from '../src/text.js'

const geneva = readFileSync(new URL('./fixtures/geneva/john1-1.thml', import.meta.url), 'utf8')

describe('Geneva commentary note markers', () => {
  it('removes real John 1:1 reference and note-body labels without removing the commentary', () => {
    const parsed = parseCommentaryMarkup(geneva, 'Geneva')
    assert.ok(parsed.text.startsWith('In the beginning was the Word, and the Word was with God, and the Word was God.'))
    assert.ok(parsed.text.includes('The Son of God is of one and the selfsame eternity'))
    assert.ok(parsed.text.includes('Had his being.'))
    assert.ok(parsed.text.includes('is the predicate of the sentence.'))
    assert.doesNotMatch(parsed.text, /\{[a-z0-9]+\}|\([a-z0-9]+\)/i)
    assert.equal(parsed.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join(' '), parsed.text)
  })

  it('recognizes the module name case insensitively without changing other modules or Bible text', () => {
    assert.doesNotMatch(parseCommentaryMarkup(geneva, 'geneva').text, /\{[a-z0-9]+\}/i)
    assert.match(parseCommentaryMarkup(geneva, 'AnotherCommentary').text, /\{1\}/)
    assert.match(parseVerseMarkup(geneva).text, /\{1\}/)
  })

  it('preserves unbalanced braces, literal prose braces, and unreferenced parentheses', () => {
    for (const text of ['A literal {word} in prose.', 'A literal {a} in prose.', 'An unbalanced {a or 1} marker.', 'An unfinished {1', 'A parenthetical (a) aside.']) {
      assert.equal(parseCommentaryMarkup(text, 'Geneva').text, text)
    }
    const parsed = parseCommentaryMarkup('Word {a}.<br /> (a) Explain literal {x}, {a + b}, and {1 here. Keep (2) as prose.', 'Geneva')
    assert.equal(parsed.text, 'Word. Explain literal {x}, {a + b}, and {1 here. Keep (2) as prose.')
  })

  it('only removes paired labels at the quote and note boundary', () => {
    const raw = '{1} A {a} word {b}.<br/> (1) First explanation. (a) Another explanation. Unrelated {b} and (c) stay.'
    assert.equal(parseCommentaryMarkup(raw, 'Geneva').text, 'A word {b}. First explanation. Another explanation. Unrelated {b} and (c) stay.')
    assert.equal(parseCommentaryMarkup('Word {a}.<br /> No matching note body.', 'Geneva').text, 'Word {a}. No matching note body.')
  })

  it('preserves literal labels before and after real explanations in John 1:1', () => {
    const raw = geneva.replace(
      'with the Father. (a) From the beginning',
      'with the Father. The notation (a) is literal. (1) is also a literal label. (a) From the beginning'
    )
    const { text } = parseCommentaryMarkup(raw, 'Geneva')

    assert.match(text, /with the Father\. The notation \(a\) is literal\. \(1\) is also a literal label\. From the beginning/)
    assert.doesNotMatch(text, /\{[1a-e]\}/)
  })

  it('preserves a brace reference when its only apparent match occurs inside an explanation', () => {
    const raw = 'The {a} Word was {b} spoken.<br /> (b) The notation (a) is used here as prose.'

    assert.equal(parseCommentaryMarkup(raw, 'Geneva').text, 'The {a} Word was spoken. The notation (a) is used here as prose.')
  })

  it('removes valid pairs alongside nested or unbalanced brace text', () => {
    for (const literal of ['{{a}}', '{{a}', '{a}}', '}{a}', '{a', 'a}']) {
      const raw = `The Word was {b} spoken, with ${literal}.<br /> (b) A real note. (a) A literal label.`
      assert.equal(
        parseCommentaryMarkup(raw, 'Geneva').text,
        `The Word was spoken, with ${literal}. A real note. (a) A literal label.`,
        literal
      )
    }
  })

  it('recognizes numeric and letter labels separated by breaks and nonbreaking spaces', () => {
    for (const space of ['\u00a0', '&nbsp;', '&#160;', '&#xA0;']) {
      const raw = `The {12} Word was {b} spoken.<br />${space}(12)${space}First explanation.` +
        `<BR/>${space}(b)${space}Second explanation.`
      assert.equal(parseCommentaryMarkup(raw, 'Geneva').text, 'The Word was spoken. First explanation. Second explanation.', space)
    }
  })

  it('preserves a structured note and its segment when a break appears inside the note', () => {
    const raw = 'The Word was <div class="sword-markup sword-note">Keep (b) in this footnote.<br />' +
      'Second footnote sentence.</div>{b} spoken.<br /> (b) The genuine explanation.'
    const { text, notes, segments } = parseCommentaryMarkup(raw, 'Geneva')
    const footnote = { label: 'a', text: 'Keep (b) in this footnote. Second footnote sentence.' }

    assert.equal(text, 'The Word was spoken. The genuine explanation.')
    assert.deepEqual(notes, [footnote])
    assert.deepEqual(segments, [
      { kind: 'text', text: 'The Word was' },
      { kind: 'note', ...footnote },
      { kind: 'text', text: 'spoken. The genuine explanation.' }
    ])
  })

  it('removes explanation labels after a sentence ending with an encoded closing quote', () => {
    const raw = 'The {a} Word was {b} spoken.<br /> (a) He said &quot;Follow the Word.&quot; (b) Another explanation.'

    assert.equal(
      parseCommentaryMarkup(raw, 'Geneva').text,
      'The Word was spoken. He said "Follow the Word." Another explanation.'
    )
  })
})
