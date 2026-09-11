/**
 * dsh-auto-approval-llm · audit query line rendering.
 *
 * Fix: every non-decision record went through the decision template, so an
 * observation event printed as `[decision] <time> ? -> undefined (undefined)`
 * — the reader could not tell which event happened, and the payload that made
 * the event worth recording (the files that were read, how many rule errors
 * there were) never reached the screen. Each type now renders as itself with
 * the fields its emitter actually writes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_FIELD_CHARS, USAGE_EXIT_CODE, formatAuditLine, main, parseArgs } from '../scripts/audit-query.mjs'

const at = Date.UTC(2026, 8, 10, 12, 0, 0)
const stamp = '2026-09-10T12:00:00.000Z'

test('formatAuditLine: decision lines keep their exact shape', () => {
  assert.equal(
    formatAuditLine({ type: 'decision', at, toolName: 'bash', outcome: 'allowed-once', source: 'static-allow' }),
    `[decision] ${stamp} bash -> allowed-once (static-allow)`,
  )
  assert.equal(
    formatAuditLine({
      type: 'decision',
      at,
      toolName: 'bash',
      outcome: 'rejected',
      source: 'llm-deny',
      llmReason: 'looks destructive',
      breaker: true,
    }),
    `[decision] ${stamp} bash -> rejected (llm-deny) — looks destructive [breaker]`,
  )
})

test('formatAuditLine: the clear tombstone is unchanged', () => {
  assert.equal(formatAuditLine({ type: 'clear', at, cleared: 12 }), `[clear] ${stamp} cleared=12`)
})

test('formatAuditLine: observation events carry the payload their emitter writes', () => {
  const stateRead = formatAuditLine({
    type: 'runtime-state-read',
    at,
    callId: 'abc',
    sessionId: 'session-1',
    toolName: 'read',
    files: ['audit.jsonl', 'learning.json'],
  })
  assert.match(stateRead, /^\[runtime-state-read\] 2026-09-10T12:00:00\.000Z /)
  assert.ok(stateRead.includes('callId=abc'))
  assert.ok(stateRead.includes('sessionId=session-1'))
  assert.ok(stateRead.includes('files=["audit.jsonl","learning.json"]'))
  assert.ok(!stateRead.includes('undefined'))

  const rules = formatAuditLine({
    type: 'rules-parse-error',
    at,
    plane: 'answerer',
    count: 2,
    errors: [{ line: 3 }, { line: 7 }],
  })
  assert.ok(rules.includes('plane=answerer'))
  assert.ok(rules.includes('count=2'))
  assert.ok(rules.includes('errors=[{"line":3},{"line":7}]'))

  const trustedIntents = formatAuditLine({
    type: 'trusted-intents',
    at,
    sessionId: 'session-1',
    count: 3,
    origins: { 'user-message': 2, 'question-answer': 1 },
  })
  assert.ok(trustedIntents.startsWith('[trusted-intents] '))
  assert.ok(trustedIntents.includes('count=3'))
  assert.ok(trustedIntents.includes('question-answer'))

  const revoked = formatAuditLine({ type: 'learning-revoked', at, key: 'deadbeef' })
  assert.ok(revoked.startsWith('[learning-revoked] '))
  assert.ok(revoked.includes('key=deadbeef'))

  const cap = formatAuditLine({ type: 'learning-cap-reached', at, sessionId: 'session-1', allows: 50 })
  assert.ok(cap.includes('allows=50'))

  const contextMissing = formatAuditLine({
    type: 'rules-context-missing',
    at,
    toolName: 'bash',
    agentKind: null,
    workspaceRoot: 'C:/ws',
  })
  assert.ok(contextMissing.includes('workspaceRoot=C:/ws'))
  assert.ok(!contextMissing.includes('agentKind'))
})

test('formatAuditLine: unknown or missing types still produce a labelled line', () => {
  assert.match(formatAuditLine({ type: 'brand-new-event', at }), /^\[brand-new-event\] /)
  assert.match(formatAuditLine({ at }), /^\[unknown\] /)
  assert.match(formatAuditLine({ type: '', at }), /^\[unknown\] /)
})

test('formatAuditLine: a missing or non-numeric timestamp degrades instead of crashing', () => {
  assert.equal(formatAuditLine({ type: 'clear', cleared: 1 }), '[clear] ? cleared=1')
  assert.equal(formatAuditLine({ type: 'result-redacted', at: 'nope', callId: 'x' }), '[result-redacted] ? callId=x')
  assert.equal(formatAuditLine({ type: 'result-redacted', at: Number.NaN }), '[result-redacted] ?')
})

test('formatAuditLine: long observation values are trimmed to one row', () => {
  const line = formatAuditLine({ type: 'rules-parse-error', at, errors: 'x'.repeat(500) })
  const errors = line.slice(line.indexOf('errors='))
  assert.ok(errors.endsWith('…'))
  assert.ok(errors.length <= `errors=${'x'.repeat(MAX_FIELD_CHARS)}…`.length)
})

test('parseArgs: invalid values are rejected instead of silently ignored', () => {
  assert.equal(parseArgs(['--since', 'not-a-date']).ok, false)
  assert.equal(parseArgs(['--last', '0']).ok, false)
  assert.equal(parseArgs(['--last', 'abc']).ok, false)
  assert.equal(parseArgs(['--file']).ok, false)
  assert.equal(parseArgs(['--nope']).ok, false)

  const ok = parseArgs(['--last', '5', '--source', 'timeout-allow', '--json'])
  assert.equal(ok.ok, true)
  assert.equal(ok.options.last, 5)
  assert.equal(ok.options.source, 'timeout-allow')
  assert.equal(ok.options.json, true)
  assert.equal(parseArgs([]).options.last, Infinity)
})

test('main: usage errors exit 2 and an unreadable file exits 1', () => {
  assert.equal(main(['--last', 'abc']), USAGE_EXIT_CODE)
  assert.equal(main(['--file', 'C:/definitely/not/here/audit.jsonl']), 1)
})

test('formatAuditLine: learning-tamper fingerprints survive the whitelist', () => {
  const line = formatAuditLine({
    type: 'learning-tamper',
    at,
    seen: { mtime: 1, hash: 'ab' },
    expected: null,
  })
  assert.ok(line.includes('seen={"mtime":1,"hash":"ab"}'))
  assert.ok(!line.includes('expected'))
})

test('formatAuditLine: permission-change records render their payload', () => {
  const line = formatAuditLine({
    type: 'permission-change',
    at,
    sessionId: 'session-1',
    scope: 'policy',
    to: 'never',
    actor: 'user',
    recentRejectedIds: ['h1', 'h2'],
  })
  assert.ok(line.startsWith('[permission-change] '))
  assert.ok(line.includes('scope=policy'))
  assert.ok(line.includes('to=never'))
  assert.ok(line.includes('actor=user'))
  assert.ok(line.includes('recentRejectedIds=["h1","h2"]'))
})

test('main: a readable file with no parseable records reports the skipped lines', () => {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  let code
  try {
    code = main(['--file', 'scripts/audit-query.mjs'])
  } finally {
    console.log = original
  }
  const output = lines.join('\n')
  assert.equal(code, 0)
  assert.match(output, /unparseable line\(s\) skipped/)
  assert.match(output, /0\/0 audit records/)
})
