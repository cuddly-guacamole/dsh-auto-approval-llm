/**
 * dsh-auto-approval-llm · panel text the client marker decisions may read.
 *
 * The approval panel carries the host's machine markers (`BREAKER_MARKER`,
 * `AWAITING_MARKER`), and the client arms its anti-hijack guard and renders the
 * status-less copy from them. The edit-diff preview is rendered INTO the same
 * panel element and its rows are file content, so they must never contribute:
 * a preview line spelling the breaker marker would otherwise disable the
 * human's Reject / Allow buttons on an ordinary ask. The exclusion has to hold
 * on every scan, not only on the one that rendered the preview — the rows stay
 * in the panel text after the raw block is hidden.
 */
export interface MarkerTextNode {
  text: string
  /** Whether the node lives inside the rendered `[data-dsa-edit-diff]` block. */
  inPreview: boolean
}

/** Concatenated panel text with every rendered-preview node excluded. */
export function markerTextOutsidePreview(nodes: readonly MarkerTextNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (!node.inPreview) out += node.text
  }
  return out
}
