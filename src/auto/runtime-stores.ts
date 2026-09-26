/**
 * dsh-auto-approval-llm · boot-time loading of the persisted runtime stores.
 *
 * `loadRuntimeStores` runs inside `apply()`, immediately after
 * `setRuntimeStateDir()`; the ordering rationale is documented on the function
 * below, which is the call the entry makes.
 */
import { approvalHistory, learningStore, llmLatency, setLearningStore } from './approval-state.js'
import { appendAuditLine } from './audit.js'
import { loadHistory } from './approval-history.js'
import { loadLatencySamples } from './latency.js'
import { loadLearning, sameLearningFingerprint, learningFileFingerprint, type LearningFileFingerprint } from './learning.js'
import { LEARNING_FILENAME, resolveRuntimeReadPath, writeRuntimeAtomic } from './runtime-paths.js'

// History is loaded inside apply(), once the state directory is known — see the
// note on `loadRuntimeStores()` below.

// ── LLM review latency telemetry ──────────────────────────────────────────
// Independent of approval history: history records adjudicated facts, latency
// records how long each reviewer call actually took. Every attempt is sampled
// (including aborted ones and late responses that lost the countdown race),
// so the recent-100 min/avg/max cannot suffer survivor bias. Persisted in
// llm-latency.jsonl (same append+rotate pattern as history.jsonl); clear
// history intentionally leaves it alone — telemetry is not an approval record.

// ── confirmation-learning store ───────────────────────────────────────────
// Loaded once per process like history/latency; every mutation happens under
// the per-signature keyed mutex with a synchronous persist, so the on-disk
// snapshot can trail by at most one finished critical section. Corrupt or
// poisoned files degrade to an empty store = everything stays with a human.
// The LOAD prefers the canonical state path and falls back to the legacy
// package-root file, so an install upgrading keeps the entries it already
// earned; the persister then writes the merged store to the canonical path.

// Out-of-process tamper tripwire. The store is overwritten wholesale on the
// next persist, so a runtime divergence between the in-memory copy and the
// file would otherwise vanish without a trace. Decisions never read the
// on-disk file after boot and validation still rejects poisoned entries on
// the next load — this is observational only: one audit line + one warning
// per divergence, never a decision change.
let learningDiskFingerprint: LearningFileFingerprint | undefined

/**
 * Load the persisted stores from the NOW-KNOWN state directory, and remember the
 * learning file's fingerprint.
 *
 * This runs inside `apply()` rather than at module load, and that ordering is the
 * whole point: the state directory depends on `config.dshHome`, which is only
 * available once the plugin context exists. Loading at module load resolved the
 * directory from the environment alone, so a deployment whose `config.dshHome`
 * differs from the `DSH_HOME` environment variable used to READ from one
 * directory and WRITE to another — the store the operator inspects would never
 * be the store the plugin appended to, and the fingerprint would be taken from
 * the wrong file. `setRuntimeStateDir()` runs immediately before this call.
 */
export function loadRuntimeStores(): void {
  approvalHistory.length = 0
  loadHistory()
  llmLatency.length = 0
  llmLatency.push(...loadLatencySamples())
  setLearningStore(loadLearning(resolveRuntimeReadPath(LEARNING_FILENAME)))
  learningDiskFingerprint = learningFileFingerprint(resolveRuntimeReadPath(LEARNING_FILENAME))
}

export const persistLearningGuarded = (): boolean => {
  const current = learningFileFingerprint(resolveRuntimeReadPath(LEARNING_FILENAME))
  if (!sameLearningFingerprint(current, learningDiskFingerprint)) {
    console.warn('[dsh-auto-approval-llm] learning.json changed outside the plugin process; the in-memory store overwrites it on this persist (audit trail: learning-tamper).')
    appendAuditLine(JSON.stringify({ type: 'learning-tamper', at: Date.now(), seen: current ?? null, expected: learningDiskFingerprint ?? null }))
  }
  // One atomic tmp+rename location, no relocation: a false return means the file
  // still holds the previous content, so the in-memory store is ahead of the
  // disk and the change is lost on restart. Report that instead of pretending.
  const written = writeRuntimeAtomic(LEARNING_FILENAME, JSON.stringify(learningStore), '.tmp')
  learningDiskFingerprint = learningFileFingerprint(resolveRuntimeReadPath(LEARNING_FILENAME))
  if (!written) {
    console.warn('[dsh-auto-approval-llm] learning.json could not be written; the in-memory store is ahead of the file and this change is lost on restart.')
  }
  return written
}
