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
})
