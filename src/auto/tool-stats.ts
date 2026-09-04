/**
 * dsh-auto-approval-llm · recent-tool statistics for the exact-list chips.
 *
 * Aggregates approval-history records into per-outcome candidate lists that
 * the settings card renders as clickable chips (allow / deny / human-only).
 * Pure and dependency-free so the grouping contract is unit-testable without
 * a running harness; the host route feeds it with the in-memory history
 * window (loaded from history.jsonl at boot).
 */

export interface ToolStatEntry {
  /** Real registered tool name (e.g. `bash`, `mcp__inkstone__create_note`). */
  name: string
  /** Number of records matching this outcome bucket. */
  count: number
}

export type ToolStatsTab = 'allow' | 'deny' | 'human'

export interface ToolStats {
  allow: ToolStatEntry[]
  deny: ToolStatEntry[]
  human: ToolStatEntry[]
  /** Tool names a human explicitly denied (source `human-deny`), distinct. */
  humanDenied: string[]
}

export interface ToolStatsRecord {
  toolName?: string
  outcome?: string
  source?: string
}

/**
 * Sources that represent an actual adjudication of the call — by a human, the
 * LLM classifier, or the timeout rule. Audit-only trails that fire when a call
 * NEVER went through approval (static-allow / allowlist-allow for statically
 * trusted tools, hard-deny / denyList-deny / policy-deny / category-deny /
 * rule-deny for statically refused ones) are NOT adjudications: the operator
 * never decided anything about that call, so it is not "frequently allowed /
 * denied" evidence for the chips.
 */
const ADJUDICATED_SOURCES = new Set([
  'human-allow', 'human-deny',
  'classifier-allow', 'classifier-deny',
  'timeout-allow', 'timeout-deny',
  'category-allow',
  'llm-allow', 'llm-deny',
])

/** Whether a history record belongs to the given chips outcome bucket. */
export function recordInBucket(record: ToolStatsRecord, tab: ToolStatsTab): boolean {
  const outcome = record.outcome ?? ''
  const source = record.source ?? ''
  if (!ADJUDICATED_SOURCES.has(source)) return false
  if (tab === 'allow') return outcome === 'allowed-once'
  if (tab === 'deny') return outcome === 'rejected'
  // Human bucket: the operator actually decided this call (human-allow /
  // human-deny). Auto-settled adjudications are not "went to a human".
  return source === 'human-allow' || source === 'human-deny'
}

function tally(records: ToolStatsRecord[], tab: ToolStatsTab): ToolStatEntry[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    const name = typeof record.toolName === 'string' ? record.toolName : ''
    if (name === '') continue
    if (!recordInBucket(record, tab)) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Aggregate records into the three chips buckets, each sorted most-frequent
 * first. A record lands in exactly one bucket (allow/deny/human are mutually
 * exclusive outcome views of the same call).
 */
export function aggregateToolStats(records: ToolStatsRecord[]): ToolStats {
  const humanDeniedSet = new Set<string>()
  for (const record of records) {
    if (record.outcome === 'rejected' && record.source === 'human-deny' && typeof record.toolName === 'string') {
      humanDeniedSet.add(record.toolName)
    }
  }
  return {
    allow: tally(records, 'allow'),
    deny: tally(records, 'deny'),
    human: tally(records, 'human'),
    humanDenied: [...humanDeniedSet].sort(),
  }
}
