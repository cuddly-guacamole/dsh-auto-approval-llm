/**
 * dsh-auto-approval-llm · adjudicated approval history.
 *
 * The array binding is shared by reference from `approval-state.ts` on purpose:
 * `loadRuntimeStores` and the history DELETE route both clear it with
 * `length = 0`, which only discards the records for every reader if they all
 * hold this very array.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { approvalHistory } from './approval-state.js'
import { appendAuditLine } from './audit.js'
import { sanitizeReviewReason } from './classifier.js'
import { atomicWriteFile } from './route-table.js'
import { HISTORY_FILENAME, appendRuntimeLine, resolveRuntimeReadPath, resolveRuntimeWritePath, runtimeFilePath } from './runtime-paths.js'
import type { RetryAttempt } from './retry.js'

// ── approval history ──────────────────────────────────────────────────────
export interface HistoryRecord {
  id: string
  at: number
  sessionId: string
  toolName: string
  outcome: string
  source: string
  llmDecision?: string
  llmRisk?: string
  llmReason?: string
  /** Free-text reason for decisions that are NOT LLM-adjudicated (e.g. the
   * pre-execute hard fuse) — same sanitization path as `llmReason`. */
  reason?: string
  /** Wall-clock milliseconds the LLM took to produce this decision: the
   * fast-decision lane measures the classify call; a deep-review takeover
   * measures from the approval request to the LLM's claim resolution. Only
   * present on LLM-adjudicated records. */
  llmTookMs?: number
  /** Per-attempt failure trail when the review was retried (1-based `n`). */
  attempts?: RetryAttempt[]
  breaker?: boolean
  breakerReasons?: string[]
  /** Category-layer decisions carry their label/decision/mode for the audit. */
  category?: string
  categoryDecision?: string
  mode?: string
  /**
   * Set when a static allow came from the session-artifact delete exemption.
   * Without it that exemption is invisible: on a multi-segment line the merge
   * replaces the segment reason with the generic "every command …" text, so the
   * allow cannot be told apart from a routine one.
   */
  sessionArtifactDeletion?: boolean
}

/**
 * Test-only redirect for history persistence.
 *
 * `history.jsonl` is a live runtime file: the running host appends decisions to
 * it and the /history DELETE branch truncates it. Before this override the only
 * history test could assert the GET response shape, so a DELETE that truncated
 * the live file — and tombstoned the live audit — was invisible to the suite.
 * Mirrors `setAuditFilePathForTests` in `src/auto/audit.ts`: nothing in
 * production sets it, so the default stays the runtime location and
 * `historyFilePath()` reports the effective path so a contract test can pin
 * that default without relying on the caller's cooperation.
 */
let historyFileOverride: string | undefined

/** Test-only: point history persistence at `path` (pass undefined to restore the default). */
export function setHistoryFilePathForTests(path: string | undefined): void {
  historyFileOverride = path
}

/** Where history is read from: the single canonical runtime path. */
function historyReadPath(): string {
  return historyFileOverride ?? resolveRuntimeReadPath(HISTORY_FILENAME)
}

/** Where history is written to: the same canonical path (a directory that cannot be created fails the write closed). */
export function historyWritePath(): string {
  return historyFileOverride ?? resolveRuntimeWritePath(HISTORY_FILENAME)
}

/** The history file this process is actually appending to. */
export function historyFilePath(): string {
  return historyFileOverride ?? runtimeFilePath(HISTORY_FILENAME)
}

// ── atomic JSONL rotation + tolerant history parse ─────────────────────────
// Rotations write a same-directory temp file and rename it over the target,
// so a crash between truncate and write can never leave a truncated last
// line (which would otherwise poison the next load). On failure the temp
// file is removed and the previous content stays untouched — fail-closed:
// prefer stale data over lost data. Mirrored inline by pushLatencySample in
// src/auto/latency.ts (kept local there to avoid a cross-module dependency).

/** Parse stored history JSONL tolerantly: a line that fails to parse is
 * skipped and counted, never allowed to abort loading the lines after it
 * (a crash mid-rotation can leave exactly one truncated line behind). */
export function parseHistoryLines(lines: string[]): { records: HistoryRecord[]; badCount: number } {
  const records: HistoryRecord[] = []
  let badCount = 0
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as HistoryRecord
      if (record && typeof record.id === 'string') records.push(record)
    } catch {
      badCount += 1
    }
  }
  return { records, badCount }
}

export function loadHistory(): void {
  try {
    if (!existsSync(historyReadPath())) return
    const lines = readFileSync(historyReadPath(), 'utf8').split('\n').filter(Boolean)
    const { records, badCount } = parseHistoryLines(lines)
    approvalHistory.push(...records)
    if (badCount > 0) {
      console.warn(`[dsh-auto-approval-llm] history.jsonl: skipped ${badCount} corrupt line(s); later records still loaded`)
    }
    if (approvalHistory.length > 200) approvalHistory.splice(0, approvalHistory.length - 200)
  } catch {
    // Corrupt or unreadable history is non-fatal.
  }
}

export function pushHistory(entry: Omit<HistoryRecord, 'id' | 'at'>): boolean {
  if (entry.llmReason !== undefined) {
    entry = { ...entry, llmReason: sanitizeReviewReason(entry.llmReason) }
  }
  if (entry.reason !== undefined) {
    entry = { ...entry, reason: sanitizeReviewReason(entry.reason) }
  }
  const record: HistoryRecord = {
    ...entry,
    id: `h${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
  }
  approvalHistory.push(record)
  if (approvalHistory.length > 200) approvalHistory.shift()
  try {
    const file = appendRuntimeLine(HISTORY_FILENAME, `${JSON.stringify(record)}\n`, historyFileOverride)
    // Rotate the on-disk log once it grows past 1 MB so it cannot grow without
    // bound (the in-memory window is already capped at 200 records). The append
    // returns the file the line landed in, and that returned path is the one to
    // rotate.
    if (file !== undefined && statSync(file).size > 1_048_576) {
      atomicWriteFile(file, `${approvalHistory.map((r) => JSON.stringify(r)).join('\n')}\n`)
    }
  } catch {
    // History persistence is best-effort.
  }
  // Durable append-only audit (B2): same decision, additionally persisted with
  // a type marker; clearing history leaves a tombstone here, never an erase.
  // The return value is the fail-closed commit gate (APPROVAL-07): allow
  // verdicts must take effect only when their audit record persisted. The
  // history.jsonl write above stays best-effort — the audit is the gate.
  return appendAuditLine(JSON.stringify({ type: 'decision', ...record }))
}
