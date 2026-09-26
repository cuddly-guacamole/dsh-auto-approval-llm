/**
 * dsh-auto-approval-llm · bounded feedback maps and result-masking audit.
 *
 * The maps themselves live in `approval-state.ts`; this module owns the record,
 * sweep and audit functions that write them.
 */
import { decisionFeedback, timeoutFeedback } from './approval-state.js'
import { appendAuditLine } from './audit.js'

// ── timeout feedback ──────────────────────────────────────────────────────
// When the human countdown expires we still must return `'rejected'` (the
// approval vocabulary has no timeout outcome), but the agent should be able to
// tell a timeout apart from a deliberate user denial. Record a marker and let
// `tools/post-execute` inject it into the denied tool result.

export function recordTimeoutFeedback(callId: string | undefined, text: string): void {
  if (!callId) return
  timeoutFeedback.set(callId, { text, at: Date.now() })
}

export function recordDecisionFeedback(callId: string | undefined, text: string): void {
  if (!callId) return
  decisionFeedback.set(callId, { text, at: Date.now() })
}

// Result-masking audit (reuses audit.jsonl's type envelope; never
// records any masked material, only the event facts).
export function auditRedact(callId: string | undefined, toolName: string | undefined): void {
  appendAuditLine(JSON.stringify({ type: 'result-redacted', at: Date.now(), callId: callId ?? null, toolName: toolName ?? null }))
}

export function auditMaskFailed(callId: string | undefined, toolName: string | undefined): void {
  appendAuditLine(JSON.stringify({ type: 'mask-failed', at: Date.now(), callId: callId ?? null, toolName: toolName ?? null }))
}

// Bound both feedback maps so a stuck/broken approval chain can never grow
// them without limit. Expired entries (older than ttlMs) are dropped first;
// if still over maxEntries the oldest by `at` are evicted (FIFO).
export function sweepFeedback(
  map: Map<string, { at: number }>,
  opts: { ttlMs: number; maxEntries: number },
): void {
  const now = Date.now()
  for (const [key, entry] of map) {
    if (now - entry.at > opts.ttlMs) map.delete(key)
  }
  if (map.size > opts.maxEntries) {
    const overflow = map.size - opts.maxEntries
    const oldest = [...map.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, overflow)
    for (const [key] of oldest) map.delete(key)
  }
}
