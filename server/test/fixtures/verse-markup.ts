// OSIS-shaped excerpts/variants exercise the markup boundaries without installing modules.
export const spacingCases = [
  {
    name: 'LSV transChange inside literal added-word brackets',
    markup: 'and [<transChange type="added">the</transChange>] earth',
    expected: 'and [the] earth'
  },
  {
    name: 'LSV nested quotes and punctuation touching tags',
    markup: 'And God says, “<q level="1">Let <q level="2">‘light’</q> be</q>”; and light is.',
    expected: 'And God says, “Let ‘light’ be”; and light is.'
  },
  {
    name: 'Strong’s words at both quote boundaries',
    markup: '“<q who="God"><w lemma="strong:H216">Let light be</w></q>”.',
    expected: '“Let light be”.'
  },
  {
    name: 'adjacent Strong’s tags retain word boundaries',
    markup: '“<q><w lemma="strong:H216">light</w><w lemma="strong:H1961">is</w></q>”',
    expected: '“light is”'
  },
  {
    name: 'nested brackets and quotes around tagged added words',
    markup: '(<q>“[<transChange type="added"><w lemma="strong:H776">the earth</w></transChange>]”</q>),',
    expected: '(“[the earth]”),'
  },
  {
    name: 'note at an opening bracket does not add prose spacing',
    markup: '[<div class="sword-markup sword-note">An added word.</div><w lemma="strong:H776">the earth</w>]',
    expected: '[the earth]'
  },
  {
    name: 'invalid Strong’s lemma falls back to text without joining words',
    markup: '“<q><w lemma="strong:invalid">Let</w><w>light</w> be</q>”',
    expected: '“Let light be”'
  },
  {
    name: 'empty tagged words and empty formatting at quote edges',
    markup: '“<q><w lemma="strong:H216"></w><transChange type="added"> </transChange>light</q>”',
    expected: '“light”'
  },
  {
    name: 'unclosed quote markup preserves text without inventing punctuation',
    markup: '“<q level="1"><w lemma="strong:H216">light</w>',
    expected: '“light'
  },
  {
    name: 'empty input',
    markup: '',
    expected: ''
  },
  {
    name: 'KJV Genesis 1:2 added words regression',
    markup: 'And the earth was without form, and void; and darkness <transChange type="added">was</transChange> upon the face of the deep.',
    expected: 'And the earth was without form, and void; and darkness was upon the face of the deep.'
  },
  {
    name: 'KJV John 1:1 Strong’s regression',
    markup: 'In the beginning was the <w lemma="strong:G3056">Word</w>, and the <w lemma="strong:G3056">Word</w> was with <w lemma="strong:G2316">God</w>, and the Word was God.',
    expected: 'In the beginning was the Word, and the Word was with God, and the Word was God.'
  },
  {
    name: 'Geneva John 1:1 regression',
    markup: 'In the beginning was that <w>Word</w>, and that Word was with God, and that Word was God.',
    expected: 'In the beginning was that Word, and that Word was with God, and that Word was God.'
  }
]
