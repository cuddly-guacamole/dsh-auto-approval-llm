/**
 * dsh-auto-approval-llm · exact-list chips pure logic (client).
 *
 * Pure, dependency-free helpers that turn the host tool-stats response into
 * the clickable candidates rendered inside the「精确名单」card. Kept out of
 * index.ts so the grouping/ordering contract is unit-testable against the
 * compiled lib (mirrors approvals/shared.ts's discipline).
 */

export interface ToolStatsEntry {
  name: string
  count: number
}

export interface ToolStatsPayload {
  allow: ToolStatsEntry[]
  deny: ToolStatsEntry[]
  human: ToolStatsEntry[]
  humanDenied: string[]
}

/** One clickable candidate: an exact tool name or a trailing-* prefix. */
export interface ToolChip {
  /** Text that is appended to the list (exact name or `prefix*`). */
  value: string
  /** Whether this chip is a collapsed class (`mcp__inkstone__*`). */
  collapsed: boolean
  /** Aggregate frequency (exact count, or the class total when collapsed). */
  count?: number
  /** Tool names this collapsed chip would expand into (informational). */
  members?: string[]
}

/**
 * Whether a tool name starts with a `mcp__<vendor>__` style registered-tool
 * prefix that is safe to collapse into a single wildcard chip.
 */
export function toolPrefixOf(name: string): string | undefined {
  // Registered MCP tools are named `mcp__<server>__<tool>`; the server segment
  // is the collapse key.
  const m = /^mcp__([^_][^_]*)__/.exec(name)
  if (m) return `mcp__${m[1]}__`
  return undefined
}

/**
 * A collapsed prefix chip is only offered when NO member of that class was
 * ever denied by a human — collapsing a class whose member the operator once
 * explicitly refused would silently pre-authorize that exact tool again.
 */
export function canCollapse(prefix: string, humanDenied: string[]): boolean {
  return !humanDenied.some((name) => name.startsWith(prefix))
}

/** A class with at least this many members collapses into one wildcard chip. */
export const COLLAPSE_MIN = 2

/**
 * Build the ordered candidate chip list for one tab.
 *
 * Ordering: chips sorted by frequency (desc), then name. A registered-tool
 * class (`mcp__<server>__…`) with ≥ COLLAPSE_MIN members and no human-denied
 * member collapses into a SINGLE wildcard chip (`mcp__<server>__*`) — the
 * collapsed chip replaces its member chips instead of trailing them, so a
 * busy MCP server never floods the visible row. Exact chips already covered
 * by a listed wildcard are omitted (redundant); a collapsed chip is omitted
 * when the list already contains that wildcard (the class is fully covered).
 * Counts drive ordering only — the chip click fills the list text, the list
 * stays the source of truth until 保存.
 */
export function buildToolChips(
  stats: ToolStatsEntry[],
  humanDenied: string[],
  listEntries: string[],
): ToolChip[] {
  const listSet = new Set(listEntries)
  // A class-level wildcard already in the list covers every member — omit the
  // whole class from the candidates (adding members back would be redundant).
  const wildcardedPrefixes = new Set<string>()
  for (const entry of listEntries) {
    if (entry.endsWith('*') && entry.indexOf('*') === entry.length - 1 && entry.length > 1) {
      wildcardedPrefixes.add(entry.slice(0, -1))
    }
  }
  const coveredByWildcard = (name: string) =>
    [...wildcardedPrefixes].some((prefix) => name.startsWith(prefix))

  // Split plain tools from registered-tool classes.
  const plain: ToolStatsEntry[] = []
  const classes = new Map<string, ToolStatsEntry[]>()
  for (const entry of stats) {
    const prefix = toolPrefixOf(entry.name)
    if (prefix === undefined) plain.push(entry)
    else {
      const members = classes.get(prefix) ?? []
      members.push(entry)
      classes.set(prefix, members)
    }
  }

  const chips: ToolChip[] = []
  for (const entry of plain) {
    if (listSet.has(entry.name) || coveredByWildcard(entry.name)) continue
    chips.push({ value: entry.name, collapsed: false, count: entry.count })
  }
  for (const [prefix, members] of classes) {
    if (listSet.has(`${prefix}*`)) continue
    // Any member already listed means the operator is pinning members exactly —
    // hide the whole class (a collapse chip would delete the pinned member on
    // click, and sibling members are one click away after the list is saved).
    if (members.some((m) => listSet.has(m.name))) continue
    const total = members.reduce((sum, m) => sum + m.count, 0)
    if (members.length >= COLLAPSE_MIN && canCollapse(prefix, humanDenied)) {
      // Collapsed chip REPLACES the member chips (visual space), but clicking
      // it still replaces any already-listed members via applyChipToList.
      chips.push({ value: `${prefix}*`, collapsed: true, members: members.map((m) => m.name), count: total })
      continue
    }
    for (const member of members) {
      chips.push({ value: member.name, collapsed: false, count: member.count })
    }
  }
  return chips.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
}

/**
 * Apply one chip click to the edited list TEXT (the textarea draft).
 *
 * - Exact-tool chip: appends the name on a new line unless the class already
 *   has a trailing-`*` wildcard covering it (redundant).
 * - Collapsed `prefix*` chip: when the current list contains member tools of
 *   that prefix, they are REMOVED first (the wildcard now covers them) and the
 *   `prefix*` line is added. Pure: returns the next textarea content.
 */
export function applyChipToList(listText: string, chip: ToolChip): string {
  const current = listText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const set = new Set(current)
  if (!chip.collapsed) {
    // Exact name: if a wildcard already covers it, adding the name is
    // redundant — no-op keeps the list minimal.
    const covered = [...set].some((e) => e.endsWith('*') && e.length > 1 && chip.value.startsWith(e.slice(0, -1)))
    if (set.has(chip.value) || covered) return listText
    return [...current, chip.value].join('\n') + '\n'
  }
  // Collapsed class: drop members of this prefix first, then add the wildcard.
  const prefix = chip.value.slice(0, -1)
  const kept = current.filter((line) => !(line.startsWith(prefix) && line !== chip.value))
  if (kept.includes(chip.value)) return kept.join('\n') + (kept.length ? '\n' : '')
  return [...kept, chip.value].join('\n') + '\n'
}
