// Re-space text around inline note markers: a marker attaches to the preceding word, and
// the next text segment gets a leading space — unless it opens with closing punctuation
// (e.g. a trailing quote), which should hug the marker with no gap.
const CLOSE_PUNCT = /^[\s,.;:!?)\]}”’»…]/

export function segLead(text: string, i: number): string {
  return i > 0 && !CLOSE_PUNCT.test(text) ? ' ' : ''
}
