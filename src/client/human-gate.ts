/**
 * Derived "human hand" rate for the approval-records overlay.
 *
 * Single-source list shared with `scripts/friction-report.mjs` (`HUMAN_SOURCES`);
 * the equality is pinned by tests/client-human-gate.test.mjs — edit both or
 * neither. Keep this module dependency-free: the tests import it straight from
 * the compiled output and the client bundle must stay self-contained.
 */

/** Records whose verdict was settled by a person, not by a timer or an LLM. */
export const HUMAN_SOURCES: readonly string[] = ['human-allow', 'human-deny']

export interface HumanGateStats {
  /** Records in the visible window (the overlay shows the most recent 50). */
  total: number
  /** Records in that window whose source is one of HUMAN_SOURCES. */
  humanCount: number
  /** Rounded "one human hand in every N calls"; null while no human hand occurred. */
  everyNth: number | null
  /** No records in the window: any rate claim would be vacuous. */
  empty: boolean
}

export function humanGateStats(records: readonly unknown[]): HumanGateStats {
  const total = records.length
  let humanCount = 0
  for (const record of records) {
    // `includes` on the list, never a method on the record: history rows from
    // older formats may miss `source` or carry a non-string one.
    if (HUMAN_SOURCES.includes((record as { source?: unknown } | null)?.source as string)) humanCount += 1
  }
  return {
    total,
    humanCount,
    everyNth: humanCount > 0 ? Math.max(1, Math.round(total / humanCount)) : null,
    empty: total === 0,
  }
}
