/**
 * dsh-auto-approval-llm · friction report contracts.
 *
 * The report exists because the pipeline cannot show a mis-denial: every DNS
 * direction verdict it has ever seen in front of a human was an ESCALATE, and
 * no human answer has yet overridden a DENY, so the "overturn" shape is
 * measured as absent rather than assumed absent. These contracts pin the
 * reading rules that keep the report honest — the overturn direction, who is
 * even overturnable, the vacuity guard, window ordering by last activity, and
 * one verdict/exit code shared by the text and --json paths — so a clean
 * verdict cannot be printed over an empty or partial window.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_BYTE_LIMIT,
  AUDIT_LINE_LIMIT,
  USAGE_EXIT_CODE,
  VERDICT_EXIT_CODES,
  evaluateCriterion,
  isOverturn,
  isOverturnEligible,
  main,
  overturnTable,
  parseArgs,
  readJsonl,
  renderReport,
  rollingSessions,
  settlementByChannel,
  summarizeDecisions,
} from '../scripts/friction-report.mjs'

/** Capture console.log so the CLI paths can be asserted without fixtures. */
function captureLogs(run) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    return { code: run(), output: lines.join('\n') }
  } finally {
    console.log = original
  }
}

const decision = (over = {}) => ({
  type: 'decision',
  sessionId: 's1',
  toolName: 'bash',
  outcome: 'allowed-once',
  source: 'static-allow',
  at: 1_000,
  ...over,
})

test('isOverturn: only a human answering against a directional LLM verdict counts', () => {
  assert.equal(isOverturn(decision({ source: 'human-allow', llmDecision: 'DENY' })), true)
  assert.equal(isOverturn(decision({ source: 'human-deny', llmDecision: 'ALLOW' })), true)
  // ESCALATE is the reviewer declining to decide: there is no direction to
  // overturn, so it is not even eligible.
  assert.equal(isOverturnEligible(decision({ source: 'human-allow', llmDecision: 'ESCALATE' })), false)
  assert.equal(isOverturn(decision({ source: 'human-allow', llmDecision: 'ESCALATE' })), false)
  // A classifier verdict never had a human answer to compare against.
  assert.equal(isOverturnEligible(decision({ source: 'classifier-allow', llmDecision: 'allow' })), false)
  assert.equal(isOverturn(decision({ source: 'classifier-allow', llmDecision: 'allow' })), false)
  // A countdown settlement is not a human answer at all.
  assert.equal(isOverturn(decision({ source: 'timeout-allow', llmDecision: 'DENY' })), false)
  assert.equal(isOverturn(decision({ source: 'human-allow' })), false)
})

test('summarizeDecisions: separates panel-mediated from human answered; ignores observation events', () => {
  const records = [
    decision({ source: 'static-allow' }),
    decision({ source: 'classifier-allow' }),
    decision({ source: 'human-allow' }),
    decision({ source: 'timeout-allow' }),
    decision({ source: 'llm-allow' }),
    decision({ source: 'timeout-deny', outcome: 'rejected' }),
    decision({ source: 'hard-deny', outcome: 'rejected' }),
    decision({ source: 'llm-failed', outcome: 'rejected', sessionId: 's2' }),
    { type: 'runtime-state-read', at: 1_000 },
  ]
  const summary = summarizeDecisions(records, 4_096)
  assert.equal(summary.total, 8)
  assert.equal(summary.sessions, 2)
  assert.equal(summary.panelMediated, 5)
  assert.equal(summary.humanAnswered, 1)
  assert.equal(summary.timeouts, 2)
  assert.equal(summary.rejections, 3)
  assert.equal(summary.bytes, 4_096)
  assert.ok(summary.rotationBytes > 0 && summary.rotationBytes < 1)
})

test('overturnTable: reports who is overturnable, not just who answered', () => {
  const rows = overturnTable([
    decision({ source: 'human-allow', llmDecision: 'ESCALATE' }),
    decision({ source: 'human-allow', llmDecision: 'ALLOW' }),
    decision({ source: 'human-allow', llmDecision: 'DENY' }),
    decision({ source: 'human-deny', llmDecision: 'ALLOW' }),
    decision({ source: 'human-deny' }),
  ])
  const allow = rows.find((r) => r.source === 'human-allow')
  const deny = rows.find((r) => r.source === 'human-deny')
  assert.equal(allow.answered, 3)
  assert.equal(allow.withVerdict, 3)
  assert.equal(allow.overturnEligible, 2)
  assert.equal(allow.overturns, 1)
  assert.equal(deny.answered, 2)
  assert.equal(deny.withVerdict, 1)
  assert.equal(deny.overturns, 1)
})

test('settlementByChannel: counts samples without a settled flag instead of dropping them', () => {
  const { lanes, samplesWithoutSettled } = settlementByChannel([
    { channel: 'reviewer', settled: false },
    { channel: 'reviewer', settled: false },
    { channel: 'reviewer', settled: true },
    { channel: 'classifier', settled: true },
    { channel: 'classifier', settled: false },
    { at: 1 },
  ])
  const reviewer = lanes.find((l) => l.channel === 'reviewer')
  assert.equal(reviewer.total, 3)
  assert.equal(reviewer.unsettled, 2)
  assert.equal(Number(reviewer.settledRate.toFixed(3)), 0.333)
  assert.equal(lanes.find((l) => l.channel === 'classifier').settledRate, 0.5)
  assert.equal(samplesWithoutSettled, 1)
})

test('rollingSessions: orders by last activity, so a long-running session stays in the window', () => {
  const records = [
    decision({ sessionId: 'long', at: 10_000 }),
    decision({ sessionId: 'b', at: 11_000 }),
    decision({ sessionId: 'c', at: 12_000 }),
    decision({ sessionId: 'long', at: 99_000 }),
  ]
  const roll = rollingSessions(records, 2)
  assert.deepEqual(roll.sessionIds, ['long', 'c'])
  assert.equal(roll.decisions.length, 3)
  assert.equal(roll.available, 3)
  assert.equal(roll.complete, true)
  assert.equal(roll.startedAt, 10_000)
  assert.equal(rollingSessions(records, 10).complete, false)
})

test('evaluateCriterion: a window whose answers carry no direction is VACUOUS, never PASS', () => {
  const classifierOnly = [
    decision({ sessionId: 'a', source: 'classifier-allow', llmDecision: 'allow', llmRisk: 'LOW' }),
    decision({ sessionId: 'b', source: 'classifier-allow', llmDecision: 'allow', llmRisk: 'LOW' }),
  ]
  const vacuous = evaluateCriterion(classifierOnly, { window: 2 })
  assert.equal(vacuous.overturnEligible, 0)
  assert.equal(vacuous.verdict, 'VACUOUS')
  assert.equal(vacuous.exitCode, VERDICT_EXIT_CODES.VACUOUS)

  const escalateOnly = [
    decision({ sessionId: 'a', source: 'human-allow', llmDecision: 'ESCALATE' }),
    decision({ sessionId: 'b', source: 'human-allow', llmDecision: 'ESCALATE' }),
  ]
  const escalate = evaluateCriterion(escalateOnly, { window: 2 })
  assert.equal(escalate.humanAnswered, 2)
  assert.equal(escalate.overturnEligible, 0)
  assert.equal(escalate.verdict, 'VACUOUS')
})

test('evaluateCriterion: a partial window is INSUFFICIENT even when it is falsifiable', () => {
  const one = [decision({ sessionId: 'a', source: 'human-allow', llmDecision: 'ALLOW' })]
  const result = evaluateCriterion(one, { window: 20 })
  assert.equal(result.windowComplete, false)
  assert.equal(result.overturnEligible, 1)
  assert.equal(result.verdict, 'INSUFFICIENT')
  assert.equal(result.exitCode, VERDICT_EXIT_CODES.INSUFFICIENT)
})

test('evaluateCriterion: a full, falsifiable, clean window passes', () => {
  const clean = [
    decision({ sessionId: 'a', source: 'human-allow', llmDecision: 'ALLOW' }),
    decision({ sessionId: 'b', source: 'human-allow', llmDecision: 'ALLOW' }),
  ]
  const result = evaluateCriterion(clean, { window: 2 })
  assert.equal(result.windowComplete, true)
  assert.equal(result.overturnEligible, 2)
  assert.equal(result.humanOverturns, 0)
  assert.equal(result.learningRevocations, 0)
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.exitCode, 0)
})

test('evaluateCriterion: an overturn inside the window fails it', () => {
  const overturned = [
    decision({ sessionId: 'a', source: 'human-allow', llmDecision: 'ALLOW' }),
    decision({ sessionId: 'b', source: 'human-allow', llmDecision: 'DENY' }),
  ]
  const result = evaluateCriterion(overturned, { window: 2 })
  assert.equal(result.humanOverturns, 1)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.exitCode, 1)
})

test('evaluateCriterion: revocations are windowed by time, not global', () => {
  const records = [
    decision({ sessionId: 'a', at: 10_000, source: 'human-allow', llmDecision: 'ALLOW' }),
    decision({ sessionId: 'b', at: 11_000, source: 'human-allow', llmDecision: 'ALLOW' }),
    { type: 'learning-revoked', at: 500, key: 'old' },
  ]
  const old = evaluateCriterion(records, { window: 2 })
  assert.equal(old.learningRevocations, 0)
  assert.equal(old.verdict, 'PASS')

  const withRevocation = evaluateCriterion([...records, { type: 'learning-revoked', at: 20_000, key: 'new' }], { window: 2 })
  assert.equal(withRevocation.learningRevocations, 1)
  assert.equal(withRevocation.verdict, 'FAIL')
})

test('readJsonl: a missing file is reported, unparseable lines are counted', () => {
  const missing = readJsonl('C:/definitely/not/here/audit.jsonl')
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.records, [])
})

test('parseArgs: invalid values are rejected instead of silently ignored', () => {
  assert.equal(parseArgs(['--window', '0']).ok, false)
  assert.equal(parseArgs(['--window', '1.5']).ok, false)
  assert.equal(parseArgs(['--window', 'abc']).ok, false)
  assert.equal(parseArgs(['--since', 'not-a-date']).ok, false)
  assert.equal(parseArgs(['--file']).ok, false)
  assert.equal(parseArgs(['--nope']).ok, false)

  const ok = parseArgs(['--window', '5', '--json', '--since', '2026-09-01'])
  assert.equal(ok.ok, true)
  assert.equal(ok.options.window, 5)
  assert.equal(ok.options.json, true)
  assert.equal(Number.isFinite(ok.options.since), true)
  assert.equal(parseArgs([]).options.window, 20)
})

test('main: usage errors exit 2, an empty audit exits INSUFFICIENT', () => {
  assert.equal(main(['--window', 'abc']), USAGE_EXIT_CODE)
  assert.equal(main(['--nope']), USAGE_EXIT_CODE)
  const empty = main([
    '--file',
    'C:/definitely/not/here/audit.jsonl',
    '--latency',
    'C:/definitely/not/here/llm-latency.jsonl',
  ])
  assert.equal(empty, VERDICT_EXIT_CODES.INSUFFICIENT)
})

test('exit-code mapping stays documented and distinct from the usage code', () => {
  assert.deepEqual(VERDICT_EXIT_CODES, { PASS: 0, FAIL: 1, VACUOUS: 2, INSUFFICIENT: 3 })
  assert.equal(USAGE_EXIT_CODE, VERDICT_EXIT_CODES.VACUOUS)
})

test('the text and --json paths share one verdict and exit code', () => {
  const missing = 'C:/definitely/not/here/audit.jsonl'
  const missingLatency = 'C:/definitely/not/here/llm-latency.jsonl'
  const text = captureLogs(() => main(['--file', missing, '--latency', missingLatency]))
  const json = captureLogs(() => main(['--json', '--file', missing, '--latency', missingLatency]))
  assert.equal(text.code, json.code)
  assert.equal(text.code, VERDICT_EXIT_CODES.INSUFFICIENT)
  assert.match(text.output, /verdict:/)
  const parsed = JSON.parse(json.output)
  assert.equal(parsed.criterion.exitCode, json.code)
})

test('renderReport carries the criterion verdict instead of deriving its own', () => {
  const criterion = evaluateCriterion([], { window: 20 })
  const rendered = renderReport({
    decisions: summarizeDecisions([]),
    latency: settlementByChannel([]),
    criterion,
    overturns: [],
    since: false,
    badLines: 0,
  })
  assert.equal(rendered.exitCode, criterion.exitCode)
  assert.match(rendered.text, /no decision records found/)
})

test('a ledger holding only a revocation still fails, never a usage error', () => {
  const only = [{ type: 'learning-revoked', at: 1_000 }]
  const result = evaluateCriterion(only, { window: 20 })
  assert.equal(result.learningRevocations, 1)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.exitCode, VERDICT_EXIT_CODES.FAIL)
  assert.notEqual(result.exitCode, USAGE_EXIT_CODE)
})

test('rotation constants stay pinned to the audit module they mirror', async () => {
  const audit = await import('../lib/auto/audit.js')
  assert.equal(AUDIT_BYTE_LIMIT, audit.MAX_AUDIT_BYTES)
  assert.equal(AUDIT_LINE_LIMIT, audit.MAX_AUDIT_LINES)
})
