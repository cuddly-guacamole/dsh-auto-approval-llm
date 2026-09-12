/**
 * A declared allow rule (`Tool(bash) | allow`) matches on the TOOL name, so it
 * is a name-based channel exactly like the allowlist — and the user decision
 * behind the hard lock is that NO name-based channel pre-authorizes delete/disk
 * in either plane, with the credential-read floor riding the same predicate.
 * The rule-allow branch returned before the category layer was consulted, so a
 * `bash rm …` that the allowlist path routes into the locked hard-reject
 * countdown settled as allowed-once when an allow rule matched instead.
 *
 * Pins both planes and the order (the gate must precede the allow settle).
 * Run: node --test tests/audit-rule-allow-locked-gate.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const GATE = 'const ruleLock = nameChannelLockRefusal({'

test('all four name-based channel sites consult the shared locked predicate', () => {
  const sites = src.match(/nameChannelLockRefusal\(\{/g) ?? []
  assert.equal(sites.length, 4, 'pre-execute rules + answerer rules + allowlist mirror + static-allow')
})

test('pre-execute: the rule-allow branch is gated before it records the allow', () => {
  const gate = src.indexOf(GATE)
  assert.ok(gate > 0, 'the pre-execute rule-allow branch must ask the locked predicate')
  const settle = src.indexOf("source: 'rule-allow'", gate)
  assert.ok(settle > gate, 'the gate must precede the pre-execute rule-allow settle')
  const window = src.slice(gate, settle)
  assert.match(window, /const ruleLock = nameChannelLockRefusal\(\{\s*\n\s*category,/, 'reads the category derived for this ask')
  assert.match(window, /credentialRead: assessment\?\.credentialRead === true/, 'carries the credential-read floor')
  assert.match(window, /return \{ kind: 'ask', reason: `\[dsh-auto-approval-llm\] \$\{ruleLock\}/, 'the refusal hands the call to the answerer')
})

test('answerer: the rule-allow branch falls to the locked countdown, not to allow', () => {
  const preSettle = src.indexOf("source: 'rule-allow'")
  const gate = src.indexOf(GATE, preSettle)
  assert.ok(gate > 0, 'the answerer rule-allow branch must ask the locked predicate')
  const settle = src.indexOf("source: 'rule-allow'", gate)
  assert.ok(settle > gate, 'the gate must precede the answerer rule-allow settle')
  const window = src.slice(gate, settle)
  assert.match(window, /const lockedStatus: ReviewStatus = \{/, 'the refusal reuses the locked status shape')
  assert.match(window, /action: 'reject'/, 'the locked countdown is pinned to reject')
  assert.match(window, /return askHuman\(req, undefined, next, false, lockedStatus\)/, 'the refusal routes to the locked ask')
  assert.match(window, /credentialRead: classified\.assessment\?\.credentialRead === true/, 'carries the credential-read floor')
})

test('the answerer computes the category layer before it evaluates the declared rules', () => {
  const toolNameAt = src.indexOf('const toolName = req.toolName')
  const classifiedAt = src.indexOf('const classified = classifyStaticRisk(req, args)', toolNameAt)
  const rulesAt = src.indexOf("if (config.rulesText.trim() !== '')", classifiedAt)
  assert.ok(toolNameAt > 0 && classifiedAt > toolNameAt && rulesAt > classifiedAt, 'classified must come before the rules block')
  assert.equal(src.indexOf('const classified = classifyStaticRisk(req, args)', classifiedAt + 1), -1,
    'one computation per ask (the later duplicate must be gone)')
  assert.match(src.slice(classifiedAt, classifiedAt + 120), /classifyStaticRisk\(req, args\)/)
})
