/**
 * dsh-auto-approval-llm · LLM review latency ring buffer (B+ design).
 *
 * Approval decision history (`history.jsonl`) is an audit of adjudicated
 * facts; LLM response latency is performance telemetry with a different
 * window, lifecycle and consumers. They must not share a record: an
 * aborted call (countdown timeout) or a late response that lost the race
 * has no history record to attach to, and back-writing one would fabricate
 * an adjudication. So latency lives in its own bounded JSONL file plus an
 * in-memory window, mirroring the history persistence pattern (append-only
 * + size rotation, corrupt lines skipped on load).
 *
 * Sample semantics (settled vs aborted):
 * - settled: the reviewer produced a real response (ALLOW/DENY/ESCALATE
 *   with parsed text). Wall-clock duration is a true response time.
 * - aborted: timeout abort, network failure, parse failure, or no route.
 *   The duration is a wait ceiling, not a response time — mixing it into
 *   min/avg/max would bias every value (right-truncated samples inflate
 *   the average), so it is counted separately and never aggregated into
 *   the latency statistics.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LatencySample {
  at: number
  tookMs: number
  settled: boolean
  /** Total attempts (1 = single call); present once retries are in play. */
  attempts?: number
}

export interface LatencySummary {
  /** Settled samples inside the window (the "recent N" the UI reports). */
  count: number
  /** Min/avg/max over settled samples only; null when count === 0. */
  minMs: number | null
  avgMs: number | null
  maxMs: number | null
  /** Aborted attempts inside the same window (timed out / failed). */
  abortedCount: number
  /** `at` of the oldest sample in the window; null when empty. */
  windowStartAt: number | null
}

export const MAX_LATENCY_SAMPLES = 200
export const LATENCY_SUMMARY_WINDOW = 100

// Compiled to lib/auto/latency.js, so two levels up is the plugin root
// (the same directory that holds history.jsonl and audit.jsonl).
const LATENCY_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'llm-latency.jsonl')

/**
 * Aggregate the trailing `window` samples (by array order, which callers keep
 * chronological). Only settled samples contribute to min/avg/max — aborted
 * attempts are counted separately so a burst of timeouts cannot masquerade as
 * healthy response times.
 */
export function summarizeLatency(samples: readonly LatencySample[], window = LATENCY_SUMMARY_WINDOW): LatencySummary {
  const windowed = samples.slice(-window)
  const settledMs: number[] = []
  let abortedCount = 0
  for (const sample of windowed) {
    if (sample.settled) settledMs.push(sample.tookMs)
    else abortedCount += 1
  }
  const count = settledMs.length
  const minMs = count > 0 ? Math.min(...settledMs) : null
  const maxMs = count > 0 ? Math.max(...settledMs) : null
  const avgMs = count > 0 ? Math.round(settledMs.reduce((sum, ms) => sum + ms, 0) / count) : null
  return {
    count,
    minMs,
    avgMs,
    maxMs,
    abortedCount,
    windowStartAt: windowed.length > 0 ? windowed[0].at : null,
  }
}

export function loadLatencySamples(): LatencySample[] {
  const samples: LatencySample[] = []
  try {
    if (!existsSync(LATENCY_FILE)) return samples
    const lines = readFileSync(LATENCY_FILE, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Partial<LatencySample>
        if (parsed && typeof parsed.at === 'number' && typeof parsed.tookMs === 'number' && typeof parsed.settled === 'boolean') {
          samples.push({ at: parsed.at, tookMs: parsed.tookMs, settled: parsed.settled })
        }
      } catch {
        // Corrupt or partial lines are non-fatal; keep the readable tail.
      }
    }
    if (samples.length > MAX_LATENCY_SAMPLES) samples.splice(0, samples.length - MAX_LATENCY_SAMPLES)
  } catch {
    // Best-effort load; latency telemetry never affects an approval outcome.
  }
  return samples
}

export function pushLatencySample(samples: LatencySample[], sample: LatencySample): void {
  samples.push(sample)
  if (samples.length > MAX_LATENCY_SAMPLES) samples.shift()
  try {
    appendFileSync(LATENCY_FILE, `${JSON.stringify(sample)}\n`)
    if (statSync(LATENCY_FILE).size > 1_048_576) {
      writeFileSync(LATENCY_FILE, `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`)
    }
  } catch {
    // Persistence is best-effort; the in-memory window still serves the UI.
  }
}