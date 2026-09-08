/**
 * dsh-auto-approval-llm · rulesText parse errors are loud in BOTH planes.
 *
 * rulesText is parsed in two host evaluation planes — the pre-execute plane
 * and the answerer plane — and a block with parse errors disables the whole
 * declared-rules segment in each (documented semantics, untouched). The
 * pre-execute plane used to skip that in silence while the answerer only
 * console.error'd, so a deny rule dropped by a hand-edited block could fail
 * open with no consistent signal to search for. These contracts pin the
 * shared reporter: both planes call the same symbol, its output carries the
 * error lines and is de-duplicated/bounded, and its pure core cannot disturb
 * any decision path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRulesText, RULES_PARSE_REPORT_CAP, summarizeRulesParseErrors } from '../lib/auto/rules.js'

// ── pure report core (src/auto/rules.ts) ─────────────────────────────────

test('summarize: keeps every error in order with its line number and message', () => {
  const errors = [
    { line: 3, message: '未知策略 "denny"' },
    { line: 7, message: '正则为空' },
  ]
  const out = summarizeRulesParseErrors(errors)
  assert.deepEqual(out.entries, errors)
  assert.equal(out.more, 0)
})

test('summarize: output is bounded at the cap, overflow counted separately', () => {
  const errors = Array.from({ length: 30 }, (_, i) => ({ line: i + 1, message: `err ${i}` }))
  const out = summarizeRulesParseErrors(errors)
  assert.equal(out.entries.length, RULES_PARSE_REPORT_CAP)
  assert.equal(RULES_PARSE_REPORT_CAP, 8)
  assert.equal(out.more, errors.length - RULES_PARSE_REPORT_CAP)
  assert.deepEqual(out.entries[0], errors[0], 'the first errors keep their order')
  const roomy = summarizeRulesParseErrors(errors, 100)
  assert.equal(roomy.entries.length, errors.length)
  assert.equal(roomy.more, 0)
})

test('summarize: duplicate (line, message) pairs collapse without inflating counts', () => {
  const unique = Array.from({ length: 20 }, (_, i) => ({ line: i + 1, message: `m${i}` }))
  const errors = [...unique, ...Array.from({ length: 10 }, () => unique[0])]
  const out = summarizeRulesParseErrors(errors)
  assert.deepEqual(out.entries, unique.slice(0, RULES_PARSE_REPORT_CAP))
  assert.equal(out.more, unique.length - RULES_PARSE_REPORT_CAP, 'duplicates never count as hidden errors')
})

test('summarize: real parseRulesText errors pass through with their lines', () => {
  const text = [
    'Tool(bash) | deny | arguments',
    'line with no policy separator',
    'Tool((a+)+) | deny',
  ].join('\n')
  const { errors } = parseRulesText(text)
  assert.ok(errors.length >= 2)
  const out = summarizeRulesParseErrors(errors)
  assert.deepEqual(out.entries, errors)
  for (const e of out.entries) {
    assert.ok(Number.isInteger(e.line) && e.line >= 1, 'every report entry names its rule line')
    assert.ok(e.message.length > 0, 'every report entry carries a message')
  }
})

// ── host wiring anchors (src/index.ts) ───────────────────────────────────

test('host: pre-execute and answerer planes call the same shared reporter', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const pre = host.indexOf("reportRulesParseErrors('pre-execute', declared.errors)")
  const ans = host.indexOf("reportRulesParseErrors('answerer', declared.errors)")
  assert.ok(pre !== -1, 'the pre-execute plane references the shared reporter')
  assert.ok(ans !== -1, 'the answerer plane references the shared reporter')
  assert.ok(pre < ans, 'the pre-execute plane is wired before the answerer plane')
  assert.match(host, /function reportRulesParseErrors\(plane: 'pre-execute' \| 'answerer'/, 'one reporter function serves both planes')
})

test('host: the old silent skip and ad-hoc console.error are gone from both planes', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(!host.includes("console.error('[dsh-auto-approval-llm] rulesText 解析错误"), 'no plane keeps the ad-hoc parse-error console.error')
  const preBlock = host.slice(host.indexOf("reportRulesParseErrors('pre-execute', declared.errors)") - 80, host.indexOf("reportRulesParseErrors('pre-execute', declared.errors)") + 160)
  assert.match(preBlock, /if \(declared\.errors\.length > 0\) \{/, 'pre-execute arms the reporter on parse errors')
  assert.match(preBlock, /\} else \{/, 'pre-execute keeps the enforcement arm as the healthy path')
  const ansBlock = host.slice(host.indexOf("reportRulesParseErrors('answerer', declared.errors)") - 80, host.indexOf("reportRulesParseErrors('answerer', declared.errors)") + 160)
  assert.match(ansBlock, /if \(declared\.errors\.length > 0\) \{/, 'the answerer arms the reporter on parse errors')
})

test('host: repeated identical reports are suppressed per plane (content-keyed, bounded)', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /const rulesParseReported = new Map<string, string>\(\)/, 'per-plane last-reported state exists')
  assert.ok(host.includes('rulesParseReported.get(plane) === signature'), 'an identical signature is not re-reported')
  assert.ok(host.includes('rulesParseReported.set(plane, signature)'), 'a changed signature re-arms the reporter')
  assert.ok(host.includes("signature = `${plane}:${entries.map((e) => `${e.line}:${e.message}`).join('|')}`"), 'the suppression key embeds the plane and the error tuples')
})

test('host: the reporter is self-contained and never disturbs a decision path', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const fn = host.slice(host.indexOf('function reportRulesParseErrors('), host.indexOf('function loadHistory('))
  assert.match(fn, /try \{/, 'the reporter body runs under try')
  assert.match(fn, /\} catch \{/, 'the reporter swallows its own failures')
  assert.ok(fn.includes("type: 'rules-parse-error'"), 'the audit event uses a dedicated type')
  assert.ok(!fn.includes("type: 'decision'"), 'the audit event is not a decision record (no verdict-count pollution)')
})
