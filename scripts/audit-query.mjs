#!/usr/bin/env node
/**
 * dsh-auto-approval-llm · approval audit query (B2).
 *
 * Reads the append-only audit.jsonl and prints the decisions that were taken
 * by the auto-approval pipeline. Clearing history in the settings UI only
 * removes the bounded search window; the audit keeps every decision plus a
 * `{"type":"clear"}` tombstone.
 *
 * Usage:
 *   node scripts/audit-query.mjs [--last N] [--tool name] [--session id]
 *     [--source human-allow|llm-deny|timeout-deny|... ] [--since 2026-08-18]
 *     [--file <path>] [--json]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const out = { last: Infinity, tool: null, session: null, source: null, since: null, json: false, file: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--last') out.last = Number(next())
    else if (a === '--tool') out.tool = next()
    else if (a === '--session') out.session = next()
    else if (a === '--source') out.source = next()
    else if (a === '--since') out.since = Date.parse(next())
    else if (a === '--json') out.json = true
    else if (a === '--file') out.file = next()
    else { console.error(`unknown arg: ${a}`); process.exit(2) }
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
const file = opts.file ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'audit.jsonl')

let records = []
try {
  records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
} catch {
  console.error(`cannot read audit file: ${file}`)
  process.exit(1)
}

const matched = records.filter((r) => {
  if (opts.tool && r.toolName !== opts.tool) return false
  if (opts.session && r.sessionId !== opts.session) return false
  if (opts.source && r.source !== opts.source) return false
  if (opts.since && r.at < opts.since) return false
  return true
})
const tail = matched.slice(-opts.last)

if (opts.json) {
  process.stdout.write(`${JSON.stringify(tail, null, 2)}\n`)
} else {
  for (const r of tail) {
    if (r.type === 'clear') {
      console.log(`[clear] ${new Date(r.at).toISOString()} cleared=${r.cleared}`)
      continue
    }
    const d = new Date(r.at).toISOString()
    const line = `[decision] ${d} ${r.toolName ?? '?'} -> ${r.outcome} (${r.source})`
    console.log(line + (r.llmReason ? ` — ${r.llmReason}` : '') + (r.breaker ? ' [breaker]' : ''))
  }
  console.log(`\n${tail.length}/${records.length} audit records`)
}
