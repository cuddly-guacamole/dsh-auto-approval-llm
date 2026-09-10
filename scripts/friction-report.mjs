#!/usr/bin/env node
/**
 * dsh-auto-approval-llm · friction report (read-only).
 *
 * The pipeline keeps two durable traces that together answer the questions
 * deciding whether unattended Auto sessions actually work: `audit.jsonl`
 * (every decision, append-only, byte-bounded) and `llm-latency.jsonl` (one
 * sample per review attempt). This reporter reads those two files and nothing
 * else — it writes no state, never rotates, and never touches approval state.
 *
 * Why a report instead of a new event family: the "model denied, human then
 * allowed" shape that would mark a mis-denial has not been observed here, so a
 * new event family would carry no information about it, while the inputs this
 * report prints already exist. Friction that no trace can carry (a mis-denial
 * the user notices later) belongs in the manual log beside this report's doc.
 *
 * The unattended-window criterion is deliberately hard to satisfy:
 *   FAIL         recorded friction inside the window (overturn or revocation)
 *   INSUFFICIENT fewer sessions recorded than the window requires
 *   VACUOUS      no human answer carried a directional LLM verdict, so nothing
 *                could have been overturned — a zero here would be empty
 *   PASS         window full, falsifiable, and clean
 * The verdict and its exit code are computed once, so the text and --json
 * outputs can never disagree: PASS 0, FAIL 1, VACUOUS 2, INSUFFICIENT 3, with
 * the usage-error code 2 reserved for argument failures (the message says
 * which).
 *
 * "human answered" counts a panel answer that did not come from the host
 * countdown: the client's own grace fallback can settle a panel as human-*, so
 * treat the label as panel-provenance rather than as proof of a person typing.
 *
 * Usage:
 *   node scripts/friction-report.mjs [--file <audit.jsonl>]
 *     [--latency <llm-latency.jsonl>] [--since YYYY-MM-DD] [--window N] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The plugin's runtime files live in `runtime/`; the pre-move root file is read
 * for one upgrade window. Prefer whichever exists, and report the canonical path
 * when neither does — a read-only report must not depend on the plugin's build
 * output, so the rule is repeated here rather than imported.
 */
function runtimeOrDefault(name) {
  const root = join(HERE, '..')
  const runtime = join(root, 'runtime', name)
  if (existsSync(runtime)) return runtime
  const legacy = join(root, name)
  if (existsSync(legacy)) return legacy
  return runtime
}

const DEFAULT_AUDIT = runtimeOrDefault('audit.jsonl')
const DEFAULT_LATENCY = runtimeOrDefault('llm-latency.jsonl')

/** Mirrors src/auto/audit.ts MAX_AUDIT_BYTES — the only rotation trigger. */
export const AUDIT_BYTE_LIMIT = 5 * 1024 * 1024

/**
 * Mirrors src/auto/audit.ts MAX_AUDIT_LINES — the most lines a rotation can
 * keep; a byte overrun trims the tail further, so the retained line count is
 * an upper bound, not a promise.
 */
export const AUDIT_LINE_LIMIT = 5_000

/** Warn once the audit is this far into its byte-rotation budget. */
export const ROTATION_WARN_RATIO = 0.8

/** Sources that mean an approval panel was shown to a human (or answered for them). */
export const PANEL_SOURCES = new Set([
  'human-allow',
  'human-deny',
  'timeout-allow',
  'timeout-deny',
  'llm-allow',
  'llm-deny',
  'llm-failed',
])

/** Countdown-settled sources: nobody answered inside the countdown. */
export const TIMEOUT_SOURCES = new Set(['timeout-allow', 'timeout-deny'])

/** Sources where a human answered in person. */
export const HUMAN_SOURCES = new Set(['human-allow', 'human-deny'])

/**
 * Verdicts that point somewhere. Only these can be overturned: an ESCALATE
 * means the reviewer declined to decide, and a classifier verdict never had a
 * human answer to compare against.
 */
export const DIRECTIONAL_VERDICTS = new Set(['ALLOW', 'DENY'])

export const VERDICT_EXIT_CODES = { PASS: 0, FAIL: 1, VACUOUS: 2, INSUFFICIENT: 3 }
export const USAGE_EXIT_CODE = 2

/** Read a JSONL file. A missing file is reported, not thrown. */
export function readJsonl(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, bytes: 0, records: [], badLines: 0 }
  }
  const records = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { ok: true, bytes: Buffer.byteLength(text), records, badLines }
}

export function isDecision(record) {
  return record?.type === 'decision'
}

function tally(items, keyOf) {
  const counts = new Map()
  for (const item of items) {
    const key = keyOf(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function sortedEntries(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

function spanOf(items, key) {
  let min = null
  let max = null
  for (const item of items) {
    const value = item?.[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (min === null || value < min) min = value
    if (max === null || value > max) max = value
  }
  return { first: min, last: max }
}

/** A human answer carrying a verdict that could have been overturned. */
export function isOverturnEligible(record) {
  return HUMAN_SOURCES.has(record?.source) && DIRECTIONAL_VERDICTS.has(record?.llmDecision)
}

/**
 * A human overturn: a person answered the panel in the opposite direction of
 * the directional LLM verdict that was in hand.
 */
export function isOverturn(record) {
  if (!isOverturnEligible(record)) return false
  return record.source === 'human-allow' ? record.llmDecision === 'DENY' : record.llmDecision === 'ALLOW'
}

export function summarizeDecisions(records, bytes = 0) {
  const decisions = records.filter(isDecision)
  const rejected = decisions.filter((d) => d.outcome === 'rejected')
  const span = spanOf(decisions, 'at')
  return {
    lines: records.length,
    bytes,
    total: decisions.length,
    sessions: new Set(decisions.map((d) => d.sessionId).filter(Boolean)).size,
    firstAt: span.first,
    lastAt: span.last,
    bySource: sortedEntries(tally(decisions, (d) => d.source ?? 'unknown')),
    byOutcome: sortedEntries(tally(decisions, (d) => d.outcome ?? 'unknown')),
    panelMediated: decisions.filter((d) => PANEL_SOURCES.has(d.source)).length,
    humanAnswered: decisions.filter((d) => HUMAN_SOURCES.has(d.source)).length,
    timeouts: decisions.filter((d) => TIMEOUT_SOURCES.has(d.source)).length,
    rejections: rejected.length,
    rejectionsBySource: sortedEntries(tally(rejected, (d) => d.source ?? 'unknown')),
    rotationBytes: bytes / AUDIT_BYTE_LIMIT,
  }
}

/** Cross-tab of human answers against the LLM verdict that was in hand. */
export function overturnTable(records) {
  const decisions = records.filter(isDecision)
  return [...HUMAN_SOURCES].sort().map((source) => {
    const answered = decisions.filter((d) => d.source === source)
    const withVerdict = answered.filter((d) => typeof d.llmDecision === 'string')
    return {
      source,
      answered: answered.length,
      withVerdict: withVerdict.length,
      verdicts: sortedEntries(tally(withVerdict, (d) => d.llmDecision)),
      overturnEligible: withVerdict.filter(isOverturnEligible).length,
      overturns: withVerdict.filter(isOverturn).length,
    }
  })
}

/**
 * Retry attempt failure codes carried by decision records, most frequent
 * first. This is the review lanes' own account of why they did not settle:
 * EMPTY_RESPONSE and TIMEOUT dominate an unhealthy or budget-starved lane,
 * while NO_ADAPTER / RATE_LIMIT / TRANSPORT point at routing or provider
 * trouble rather than at the countdown budget.
 */
export function attemptFailureCodes(records) {
  const codes = new Map()
  let decisionsWithAttempts = 0
  for (const record of records.filter(isDecision)) {
    const attempts = Array.isArray(record.attempts) ? record.attempts : []
    if (attempts.length === 0) continue
    decisionsWithAttempts += 1
    for (const attempt of attempts) {
      const code = typeof attempt?.code === 'string' && attempt.code !== '' ? attempt.code : 'UNKNOWN'
      codes.set(code, (codes.get(code) ?? 0) + 1)
    }
  }
  return { decisionsWithAttempts, codes: sortedEntries(codes) }
}

/**
 * Review-lane outcome per channel. Samples without a boolean `settled` are
 * counted once at the top level instead of being dropped silently, so a biased
 * subset cannot masquerade as the whole lane.
 */
export function settlementByChannel(latency) {
  const channels = new Map()
  let samplesWithoutSettled = 0
  for (const sample of latency) {
    if (typeof sample?.settled !== 'boolean') {
      samplesWithoutSettled += 1
      continue
    }
    const key = sample.channel ?? 'unknown'
    const bucket = channels.get(key) ?? { channel: key, settled: 0, unsettled: 0 }
    if (sample.settled) bucket.settled += 1
    else bucket.unsettled += 1
    channels.set(key, bucket)
  }
  const lanes = [...channels.values()].map((bucket) => {
    const total = bucket.settled + bucket.unsettled
    return { ...bucket, total, settledRate: total === 0 ? null : bucket.settled / total }
  })
  return { lanes: lanes.sort((a, b) => b.total - a.total), samplesWithoutSettled }
}

/**
 * The `window` sessions with the most recent activity, newest first. Ordering
 * by last activity (not first appearance) is what keeps a long-running session
 * inside the window and a finished one out of it.
 */
export function rollingSessions(records, window = 20) {
  const decisions = records.filter(isDecision)
  const lastAt = new Map()
  for (const decision of decisions) {
    const id = decision.sessionId
    if (!id) continue
    const at = typeof decision.at === 'number' && Number.isFinite(decision.at) ? decision.at : 0
    lastAt.set(id, Math.max(lastAt.get(id) ?? Number.NEGATIVE_INFINITY, at))
  }
  const ordered = [...lastAt.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([id]) => id)
  const sessionIds = ordered.slice(0, window)
  const kept = new Set(sessionIds)
  const keptDecisions = decisions.filter((d) => kept.has(d.sessionId))
  const span = spanOf(keptDecisions, 'at')
  return {
    requested: window,
    available: lastAt.size,
    complete: lastAt.size >= window,
    sessionIds,
    decisions: keptDecisions,
    startedAt: span.first,
  }
}

/**
 * Evaluate the unattended-Auto criterion over the rolling window. The verdict
 * is the single source of truth for the exit code, so the text and --json
 * renderings cannot disagree. Precedence: recorded friction wins over missing
 * data, which wins over an unfalsifiable window.
 */
export function evaluateCriterion(records, { window = 20 } = {}) {
  const roll = rollingSessions(records, window)
  const overturns = roll.decisions.filter(isOverturn)
  const eligible = roll.decisions.filter(isOverturnEligible)
  const humanAnswered = roll.decisions.filter((d) => HUMAN_SOURCES.has(d.source))
  const highAdvisory = roll.decisions.filter((d) => d.llmRisk === 'HIGH' && typeof d.llmDecision === 'string')
  // Revocation records carry no sessionId (the settings card revokes without
  // session context), so they are windowed by time instead.
  const revocations = records.filter(
    (r) => r?.type === 'learning-revoked' && (roll.startedAt === null || (r.at ?? 0) >= roll.startedAt),
  )
  const failed = overturns.length > 0 || revocations.length > 0
  const verdict = failed
    ? 'FAIL'
    : !roll.complete
      ? 'INSUFFICIENT'
      : eligible.length === 0
        ? 'VACUOUS'
        : 'PASS'
  return {
    window: roll.requested,
    sessionsAvailable: roll.available,
    windowComplete: roll.complete,
    sessionIds: roll.sessionIds,
    decisionCount: roll.decisions.length,
    humanAnswered: humanAnswered.length,
    overturnEligible: eligible.length,
    humanOverturns: overturns.length,
    highAdvisoryDecisions: highAdvisory.length,
    learningRevocations: revocations.length,
    windowStartedAt: roll.startedAt,
    verdict,
    exitCode: VERDICT_EXIT_CODES[verdict],
  }
}

function pct(part, whole) {
  if (!whole) return '0.0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}

function iso(at) {
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : '?'
}

const VERDICT_EXPLANATION = {
  PASS: 'PASS - window full, falsifiable and clean',
  FAIL: 'FAIL - friction recorded inside the window',
  VACUOUS: 'VACUOUS - no human answer carried an ALLOW/DENY verdict, so nothing could be overturned',
  INSUFFICIENT: 'INSUFFICIENT - fewer sessions recorded than the window requires',
}

export function renderReport({ decisions, latency, criterion, overturns, attempts, since, badLines }) {
  const out = []
  out.push('=== friction report (audit.jsonl) ===')
  out.push(
    `range ${iso(decisions.firstAt)} .. ${iso(decisions.lastAt)}${since ? '  (--since filter applied)' : ''}`,
  )
  out.push(
    `lines ${decisions.lines}  decisions ${decisions.total}  sessions ${decisions.sessions}` +
      `  ${(decisions.bytes / 1024 / 1024).toFixed(2)} MiB of ${AUDIT_BYTE_LIMIT / 1024 / 1024} MiB`,
  )
  if (badLines > 0) out.push(`[!] ${badLines} unparseable line(s) skipped`)
  if (decisions.rotationBytes >= ROTATION_WARN_RATIO) {
    out.push(
      `[!] audit is at ${(decisions.rotationBytes * 100).toFixed(0)}% of the byte-rotation trigger;` +
        ` once it rotates it keeps at most the newest ${AUDIT_LINE_LIMIT} lines, fewer if they are long`,
    )
  }
  if (decisions.total === 0) {
    out.push('no decision records found (missing --file? audit disabled?)')
  } else {
    out.push('')
    out.push('decisions by source')
    for (const [source, count] of decisions.bySource) {
      out.push(`  ${source.padEnd(18)} ${String(count).padStart(6)}  ${pct(count, decisions.total)}`)
    }
    out.push('')
    out.push(
      `panel-mediated ${decisions.panelMediated} (${pct(decisions.panelMediated, decisions.total)})` +
        `   human answered ${decisions.humanAnswered}` +
        `   countdown-settled ${decisions.timeouts} (${pct(decisions.timeouts, decisions.total)})` +
        `   rejected ${decisions.rejections} (${pct(decisions.rejections, decisions.total)})`,
    )
    out.push('  panel-mediated counts every ask that reached a panel, including LLM takeovers')
    out.push('  rejected by: ' + decisions.rejectionsBySource.map(([s, n]) => `${s} ${n}`).join(', '))
    out.push('')
    out.push('human answer vs LLM verdict in hand (overturn table)')
    for (const row of overturns) {
      out.push(
        `  ${row.source.padEnd(12)} answered ${String(row.answered).padStart(4)}  carrying a verdict ${row.withVerdict}`,
      )
      out.push(
        `  ${''.padEnd(12)} verdicts ${row.verdicts.map(([v, n]) => `${v} ${n}`).join(' / ') || '-'}` +
          `   overturnable ${row.overturnEligible}   overturns ${row.overturns}`,
      )
    }
    out.push('  only ALLOW/DENY can be overturned: ESCALATE is the reviewer declining to decide,')
    out.push('  and a classifier verdict never had a human answer to compare against')
    out.push('')
    out.push('review lane settlement (llm-latency.jsonl)')
    if (latency.lanes.length === 0) out.push('  no latency samples found')
    for (const lane of latency.lanes) {
      out.push(
        `  ${lane.channel.padEnd(12)} settled ${String(lane.settled).padStart(4)} / ${String(lane.total).padStart(4)}` +
          `  (${pct(lane.settled, lane.total)})  unsettled ${lane.unsettled}`,
      )
    }
    if (latency.samplesWithoutSettled > 0) {
      out.push(`  ${latency.samplesWithoutSettled} sample(s) without a settled flag were excluded`)
    }
    out.push('')
    out.push('review attempt failures (decision.attempts)')
    if (attempts.decisionsWithAttempts === 0) out.push('  no failed attempt recorded')
    else {
      out.push(`  decisions carrying a failed attempt ${attempts.decisionsWithAttempts}`)
      for (const [code, count] of attempts.codes) out.push(`  ${code.padEnd(22)}${String(count).padStart(6)}`)
    }
    out.push('')
  }
  out.push(`criterion window (last ${criterion.window} sessions by last activity)`)
  out.push(
    `  sessions available ${criterion.sessionsAvailable}` +
      (criterion.windowComplete ? '' : '  [!] fewer sessions recorded than the window size'),
  )
  out.push(
    `  decisions ${criterion.decisionCount}  human answered ${criterion.humanAnswered}` +
      `  overturnable ${criterion.overturnEligible}  overturns ${criterion.humanOverturns}` +
      `  revocations ${criterion.learningRevocations}  HIGH-advisory ${criterion.highAdvisoryDecisions}`,
  )
  out.push(`  verdict: ${VERDICT_EXPLANATION[criterion.verdict]}`)
  out.push(`  exit code ${criterion.exitCode}`)
  return { text: out.join('\n'), exitCode: criterion.exitCode }
}

/** Argument parsing returns a result instead of throwing, so it is testable. */
export function parseArgs(argv) {
  const out = { file: DEFAULT_AUDIT, latency: DEFAULT_LATENCY, since: null, window: 20, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    const take = () => {
      if (value === undefined) return { error: `${arg} requires a value` }
      i += 1
      return { value }
    }
    if (arg === '--file' || arg === '--latency' || arg === '--since' || arg === '--window') {
      const taken = take()
      if (taken.error) return { ok: false, error: taken.error }
      if (arg === '--file') out.file = taken.value
      else if (arg === '--latency') out.latency = taken.value
      else if (arg === '--since') {
        const at = Date.parse(taken.value)
        if (!Number.isFinite(at)) return { ok: false, error: `--since expects a date, got "${taken.value}"` }
        out.since = at
      } else {
        const n = Number(taken.value)
        if (!Number.isInteger(n) || n <= 0) {
          return { ok: false, error: `--window expects a positive integer, got "${taken.value}"` }
        }
        out.window = n
      }
    } else if (arg === '--json') out.json = true
    else return { ok: false, error: `unknown arg: ${arg}` }
  }
  return { ok: true, options: out }
}

export function main(argv) {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    return USAGE_EXIT_CODE
  }
  const opts = parsed.options
  const audit = readJsonl(opts.file)
  const records = opts.since === null ? audit.records : audit.records.filter((r) => (r?.at ?? 0) >= opts.since)
  const latency = readJsonl(opts.latency)
  const decisions = summarizeDecisions(records, audit.bytes)
  const overturns = overturnTable(records)
  const attempts = attemptFailureCodes(records)
  const criterion = evaluateCriterion(records, { window: opts.window })
  const lanes = settlementByChannel(latency.records)
  if (opts.json) {
    console.log(JSON.stringify({ decisions, overturns, attempts, latency: lanes, criterion }, null, 2))
    return criterion.exitCode
  }
  const { text, exitCode } = renderReport({
    decisions,
    latency: lanes,
    criterion,
    overturns,
    attempts,
    since: opts.since !== null,
    badLines: audit.badLines,
  })
  console.log(text)
  return exitCode
}

// process.exitCode (not process.exit) so a piped stdout is never truncated.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
