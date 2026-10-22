/** Canonical OpenBible coordinates; translation resolution happens only when opening Read. */
export interface CrossReferenceMapScope { book?: string; chapter?: number }
export interface CrossReferenceMapNode {
  id: string
  book: string
  chapter: number | null
  verse: number | null
  label: string
}
export interface CrossReferenceMapEdge {
  source: string
  target: string
  count: number
  /** A real, deterministic representative of this aggregate, in canonical OSIS. */
  sample: { source: string; target: string }
}
export interface CrossReferenceMapPayload {
  nodes: CrossReferenceMapNode[]
  edges: CrossReferenceMapEdge[]
  totalLinks: number
  matchedLinks: number
}
export interface CrossReferenceMapSimilarity {
  state: string
  distances: Array<number | null>
}
