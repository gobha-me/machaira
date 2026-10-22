// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectedScripture } from './textSelection'

let root: HTMLElement
function select(start: Node, startOffset: number, end = start, endOffset = start.textContent!.length) {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  return selectedScripture(root, window.getSelection())
}
beforeEach(() => {
  root = document.createElement('div')
  root.innerHTML = `<span data-verse="1"><button>1</button><span data-selection-text>In the beginning was the <span data-strongs="G3056 invalid G3056">Word</span><sup data-selection-ignore>a</sup>   </span></span>
    <span data-verse="2"><button>2</button><span data-selection-text>The same was in the beginning with <span data-strongs="G2316">God</span>.</span></span>`
  document.body.append(root)
})
afterEach(() => { window.getSelection()!.removeAllRanges(); document.body.innerHTML = '' })

describe('native Scripture range extraction', () => {
  it('keeps partial endpoints across verses, excluding numbers, markers, and duplicate/invalid tags', () => {
    const prose = root.querySelectorAll('[data-selection-text]')
    const result = select(prose[0].firstChild!, 7, prose[1].firstChild!, 8)
    expect(result).toEqual({
      text: 'beginning was the Word The same', verseStart: 1, verseEnd: 2,
      words: [{ key: 'G3056', text: 'Word' }]
    })
  })

  it('does not infer Strong’s from a matching word outside the selected range', () => {
    const prose = root.querySelectorAll('[data-selection-text]')
    expect(select(prose[1].firstChild!, 4, prose[1].firstChild!, 8)?.words).toEqual([])
  })

  it('handles reversed native anchor/focus as the same ordered range', () => {
    const prose = root.querySelectorAll('[data-selection-text]')
    const selection = window.getSelection()!
    selection.setBaseAndExtent(prose[1].firstChild!, 8, prose[0].firstChild!, 7)
    expect(selectedScripture(root, selection)?.text).toBe('beginning was the Word The same')
  })

  it('rejects collapsed, whitespace-only, marker-only, missing, and detached selections', () => {
    const prose = root.querySelector('[data-selection-text]')!
    expect(select(prose.firstChild!, 0, prose.firstChild!, 0)).toBeNull()
    expect(select(prose.lastChild!, 0)).toBeNull()
    expect(select(root.querySelector('sup')!.firstChild!, 0)).toBeNull()
    expect(selectedScripture(root, null)).toBeNull()
    select(prose.firstChild!, 0)
    root.remove()
    expect(selectedScripture(root, window.getSelection())).toBeNull()
  })

  it('rejects a selection that starts or ends outside the reading surface', () => {
    const outside = document.createTextNode('Outside')
    document.body.append(outside)
    expect(select(root.querySelector('[data-selection-text]')!.firstChild!, 0, outside, 7)).toBeNull()
  })
})
