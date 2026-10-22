export interface SelectedText {
  text: string
  verseStart: number
  verseEnd: number
  words: { text: string; key: string }[]
}

// Read only Scripture prose from a native range. Verse numbers and footnote markers
// remain copyable, but must never become search terms or lexicon matches.
export function selectedScripture(root: HTMLElement, selection: Selection | null): SelectedText | null {
  if (!root.isConnected || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const parts: string[] = []
  const verses: number[] = []
  const words = new Map<string, string>()
  for (const prose of root.querySelectorAll<HTMLElement>('[data-selection-text]')) {
    const verse = Number(prose.closest<HTMLElement>('[data-verse]')?.dataset.verse)
    if (!Number.isSafeInteger(verse) || verse < 1) continue
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT)
    const fragments: string[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-selection-ignore]') || !range.intersectsNode(node)) continue
      const text = (node.textContent ?? '').slice(
        node === range.startContainer ? range.startOffset : 0,
        node === range.endContainer ? range.endOffset : undefined
      )
      fragments.push(text)
      if (!text.trim()) continue
      const tagged = node.parentElement?.closest<HTMLElement>('[data-strongs]')
      for (const key of tagged?.dataset.strongs?.split(/\s+/) ?? []) {
        if (/^[GH]\d+$/.test(key)) words.set(key, tagged?.textContent?.trim() ?? text)
      }
    }
    const text = fragments.join('').trim()
    if (text) { parts.push(text); verses.push(verse) }
  }
  if (!parts.length) return null
  return {
    text: parts.join(' ').replace(/\s+/g, ' '),
    verseStart: Math.min(...verses),
    verseEnd: Math.max(...verses),
    words: [...words].map(([key, text]) => ({ key, text }))
  }
}

export function hasNativeTextSelection(target: EventTarget | null): boolean {
  const selection = window.getSelection()
  return target instanceof Node && !!selection && !selection.isCollapsed
    && !!selection.toString().trim()
    && selection.rangeCount === 1 && selection.getRangeAt(0).intersectsNode(target)
}
