#!/usr/bin/env node
/**
 * dsh-auto-approval-llm · approval audit query (B2).
 *
 * Reads the append-only audit.jsonl and prints the decisions that were taken
 * by the auto-approval pipeline. Clearing history in the settings UI only
 * removes the bounded search window; the audit keeps every decision plus a
 * `{"type":"clear"}` tombstone.
 *
 * The audit also carries non-decision observation records. They are rendered
 * by their own type with their real payload fields: printing them through the
 * decision template produced `[decision] <time> ? -> undefined (undefined)`,
 * which hid the event that actually happened.
 *
 * Usage:
 *   node scripts/audit-query.mjs [--last N] [--tool name] [--session id]
 *     [--source human-allow|llm-deny|timeout-deny|... ] [--since 2026-08-18]
 *     [--file <path>] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Observation payload fields, in a stable order. Derived from the emitters in
 * src/index.ts (result-redacted / mask-failed / rules-parse-error /
 * learning-tamper / learning-revoked / learning-cap-reached /
 * runtime-state-read / rules-context-missing / permission-change).
 */
export const OBSERVATION_FIELDS = [
  'callId',
  'sessionId',
  'toolName',
  'plane',
  'count',
  'errors',
  'files',
  'agentKind',
  'workspaceRoot',
  'key',
  'allows',
  'seen',
  'expected',
  'scope',
  'to',
  'actor',
  'recentRejectedIds',
  'phase',
  'paths',
]

/** Long observation values are trimmed so one line stays one screen row. */
export const MAX_FIELD_CHARS = 120

export const USAGE_EXIT_CODE = 2

function iso(at) {
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : '?'
}

function renderField(value) {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text
}

/** One audit record → one printable line, by record type. */
export function formatAuditLine(record) {
  const at = iso(record?.at)
  if (record?.type === 'clear') return `[clear] ${at} cleared=${record.cleared}`
  if (record?.type === 'decision') {
    const base = `[decision] ${at} ${record.toolName ?? '?'} -> ${record.outcome} (${record.source})`
    return base + (record.llmReason ? ` — ${record.llmReason}` : '') + (record.breaker ? ' [breaker]' : '')
  }
  const label = typeof record?.type === 'string' && record.type !== '' ? record.type : 'unknown'
  const fields = OBSERVATION_FIELDS.filter((key) => record[key] !== undefined && record[key] !== null).map(
    (key) => `${key}=${renderField(record[key])}`,
  )
  return `[${label}] ${at}${fields.length > 0 ? ` ${fields.join(' ')}` : ''}`
}

/** Argument parsing returns a result instead of throwing, so it is testable. */
export function parseArgs(argv) {
  const out = { last: Infinity, tool: null, session: null, source: null, since: null, json: false, file: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    const take = () => {
      if (value === undefined) return { error: `${arg} requires a value` }
      i += 1
      return { value }
    }
    if (arg === '--last' || arg === '--tool' || arg === '--session' || arg === '--source' || arg === '--since' || arg === '--file') {
      const taken = take()
      if (taken.error) return { ok: false, error: taken.error }
      if (arg === '--tool') out.tool = taken.value
      else if (arg === '--session') out.session = taken.value
      else if (arg === '--source') out.source = taken.value
      else if (arg === '--file') out.file = taken.value
      else if (arg === '--since') {
        const at = Date.parse(taken.value)
        if (!Number.isFinite(at)) return { ok: false, error: `--since expects a date, got "${taken.value}"` }
        out.since = at
      } else {
        const n = Number(taken.value)
        if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `--last expects a positive integer, got "${taken.value}"` }
        out.last = n
      }
    } else if (arg === '--json') out.json = true
    else return { ok: false, error: `unknown arg: ${arg}` }
  }
  return { ok: true, options: out }
}

/**
 * The plugin's runtime files live in `runtime/`; the pre-move root file is read
 * for one upgrade window. Prefer whichever exists, and report the canonical
 * path when neither does — a read-only diagnostic must not depend on the
 * plugin's build output, so the rule is repeated here rather than imported.
 */
function runtimeOrDefault(name) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const runtime = join(root, 'runtime', name)
  if (existsSync(runtime)) return runtime
  const legacy = join(root, name)
  if (existsSync(legacy)) return legacy
  return runtime
}

export function main(argv) {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    return USAGE_EXIT_CODE
  }
  const opts = parsed.options
  const file = opts.file ?? runtimeOrDefault('audit.jsonl')

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    console.error(`cannot read audit file: ${file}`)
    return 1
  }
  const records = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }

  const matched = records.filter((r) => {
    if (opts.tool && r.toolName !== opts.tool) return false
    if (opts.session && r.sessionId !== opts.session) return false
    if (opts.source && r.source !== opts.source) return false
    if (opts.since !== null && (r.at ?? 0) < opts.since) return false
    return true
  })
  const tail = matched.slice(-opts.last)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(tail, null, 2)}\n`)
    return 0
  }
  for (const r of tail) console.log(formatAuditLine(r))
  console.log(
    `\n${tail.length}/${records.length} audit records` +
      (badLines > 0 ? ` (${badLines} unparseable line(s) skipped)` : ''),
  )
  return 0
}

// process.exitCode (not process.exit) so a piped stdout is never truncated.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
