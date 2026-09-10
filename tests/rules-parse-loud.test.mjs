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

/**
 * The parse-error arm of one plane's `if (declared.errors.length > 0) { … }
 * else { … }` statement.
 *
 * A counted window (`slice(idx - 80, idx + 160)`) only reaches the arm while
 * nothing grows around it — a single inserted comment line between the guard
 * and the report pushes the anchor out of the window and reddens the test for
 * a reason unrelated to the wiring. The arm is delimited structurally instead:
 * anchor on the reporter call, walk back to its guard, brace-balance the arm,
 * and require the else arm that follows. Every marker is guarded, so a rename
 * fails loudly instead of slicing an empty region.
 *
 * The arm carries no braces of its own (the caller's assertions below prove the
 * extracted extent), so brace counting is safe here.
 */
function parseErrorArm(host, plane) {
  const callAt = host.indexOf(`reportRulesParseErrors('${plane}', declared.errors)`)
  assert.notEqual(callAt, -1, `the ${plane} plane references the shared reporter`)
  const ifAt = host.lastIndexOf('if (declared.errors.length > 0) {', callAt)
  assert.notEqual(ifAt, -1, `the ${plane} plane arms the reporter on parse errors`)
  const open = host.indexOf('{', ifAt)
  let depth = 0
  let close = -1
  for (let i = open; i < host.length; i++) {
    if (host[i] === '{') depth++
    else if (host[i] === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  assert.notEqual(close, -1, `the ${plane} parse-error arm is brace-balanced`)
  assert.match(host.slice(close), /^\}\s*else\s*\{/, `the ${plane} keeps the enforcement arm as the healthy path`)
  const arm = host.slice(open + 1, close)
  assert.ok(arm.includes(`reportRulesParseErrors('${plane}', declared.errors)`), `the ${plane} report sits inside the parse-error arm, not the healthy path`)
  return arm
}

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
  const preArm = parseErrorArm(host, 'pre-execute')
  assert.match(preArm, /reportRulesParseErrors\('pre-execute', declared\.errors\)/, 'pre-execute arms the reporter on parse errors')
  const ansArm = parseErrorArm(host, 'answerer')
  assert.match(ansArm, /reportRulesParseErrors\('answerer', declared\.errors\)/, 'the answerer arms the reporter on parse errors')
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
