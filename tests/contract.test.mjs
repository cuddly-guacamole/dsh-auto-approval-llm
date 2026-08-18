/**
 * dsh-auto-approval-llm · fail-closed contract tests (P0.7a).
 *
 * Pure-function tests over the compiled lib so the approval pipeline's
 * fail-closed invariants stay pinned without a running harness.
 * Run: node --test tests/contract.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReview, lowRiskReviewOutcome, raceHumanDecision, detectConflicts, reviewerDecidable, preserveHostKeys, normalizeTimeoutAction, prepareReviewerArguments, extractToolPath, frameReviewerInput, breakerTripped } from '../lib/auto/decision.js'
import { trimAuditTail } from '../lib/auto/audit.js'
import { normalizeReviewMode } from '../lib/auto/review-mode.js'
import { parseRulesText, evaluateRules, extractRuleTarget } from '../lib/auto/rules.js'

test('parseReview: valid plain JSON', () => {
  const r = parseReview('{"decision":"ALLOW","risk_level":"LOW","reason":"safe"}')
  assert.equal(r.decision, 'ALLOW')
  assert.equal(r.riskLevel, 'LOW')
  assert.equal(r.reason, 'safe')
})

test('parseReview: fenced json block', () => {
  const r = parseReview('```json\n{"decision":"DENY","reason":"no"}\n```')
  assert.equal(r.decision, 'DENY')
  assert.equal(r.reason, 'no')
})

test('parseReview: optional fields omitted', () => {
  const r = parseReview('{"decision":"ESCALATE"}')
  assert.equal(r.decision, 'ESCALATE')
  assert.equal(r.riskLevel, undefined)
  assert.equal(r.reason, undefined)
})

test('parseReview: rejects invalid decision (fail closed)', () => {
  assert.throws(() => parseReview('{"decision":"MAYBE"}'), /invalid decision/)
})

test('parseReview: rejects invalid risk level', () => {
  assert.throws(() => parseReview('{"decision":"ALLOW","risk_level":"EXTREME"}'), /invalid risk_level/)
})

test('parseReview: rejects non-JSON garbage', () => {
  assert.throws(() => parseReview('sure, go ahead'), /no JSON object/)
})

test('parseReview: rejects non-string reason', () => {
  assert.throws(() => parseReview('{"decision":"DENY","reason":42}'), /non-string reason/)
})

test('lowRiskReviewOutcome: ALLOW -> allow', () => {
  assert.deepEqual(lowRiskReviewOutcome({ decision: 'ALLOW' }), { kind: 'allow' })
})

test('lowRiskReviewOutcome: DENY -> deny and counts as LLM denial', () => {
  assert.deepEqual(lowRiskReviewOutcome({ decision: 'DENY', reason: 'no' }), { kind: 'deny', llmDenied: true })
})

test('lowRiskReviewOutcome: genuine ESCALATE -> ask human (no auto-answer)', () => {
  assert.deepEqual(lowRiskReviewOutcome({ decision: 'ESCALATE', reason: 'unsure' }), { kind: 'ask' })
})

test('lowRiskReviewOutcome: reviewer failure -> deny, NOT an LLM denial (fail closed)', () => {
  assert.deepEqual(lowRiskReviewOutcome({ decision: 'ESCALATE', failure: 'timeout' }), { kind: 'deny', llmDenied: false })
})

test('lowRiskReviewOutcome: bogus decision with no failure -> ask (never allow)', () => {
  assert.deepEqual(lowRiskReviewOutcome({ decision: 'BLAH' }), { kind: 'ask' })
})

test('raceHumanDecision: human answers before the timer -> human outcome wins', async () => {
  let recorded = 0
  const raced = await raceHumanDecision(() => Promise.resolve('allowed-once'), {
    status: { seconds: 60, action: 'reject' },
    callId: 'c1',
    recordTimeout: () => { recorded += 1 },
  })
  assert.deepEqual(raced, { outcome: 'allowed-once', timedOut: false })
  assert.equal(recorded, 0, 'timeout notice must not be recorded when the human answers')
})

test('raceHumanDecision: no answer -> host timer decides + records canonical notice', async () => {
  const recorded = []
  const raced = await raceHumanDecision(() => new Promise(() => {}), {
    status: { seconds: 1, action: 'reject' },
    callId: 'c1',
    recordTimeout: (id, text) => recorded.push(`${id}|${text}`),
  })
  assert.deepEqual(raced, { outcome: 'rejected', timedOut: true })
  assert.equal(recorded.length, 1)
  assert.ok(recorded[0].startsWith('c1|'), 'notice must be recorded for the exact callId')
  assert.ok(recorded[0].includes('auto-rejected'))
})

test('raceHumanDecision: timeoutAction=allow -> allowed-once on timeout', async () => {
  const raced = await raceHumanDecision(() => new Promise(() => {}), {
    status: { seconds: 1, action: 'allow' },
    callId: 'c2',
    recordTimeout: () => {},
  })
  assert.deepEqual(raced, { outcome: 'allowed-once', timedOut: true })
})

test('detectConflicts: no competitors -> empty', () => {
  assert.deepEqual(detectConflicts(['dsh-auto-approval-llm', 'web-ui-skin-center']), [])
})

test('detectConflicts: known approval competitors flagged (case-insensitive)', () => {
  assert.deepEqual(detectConflicts(['dsh-approval-llm']), ['dsh-approval-llm'])
  assert.deepEqual(detectConflicts(['@nanmicoder/dsh-auto-mode', 'dsh-auto-review']), ['dsh-auto-review', '@nanmicoder/dsh-auto-mode'])
  assert.deepEqual(detectConflicts(['DSH-APPROVAL-TIMEOUT']), ['dsh-approval-timeout'])
})

test('reviewerDecidable: only ALLOW/DENY are decisive', () => {
  assert.ok(reviewerDecidable('ALLOW'))
  assert.ok(reviewerDecidable('DENY'))
  assert.ok(!reviewerDecidable('ESCALATE'))
})

test('preserveHostKeys: host-only fields survive a card save that omits them', () => {
  const current = { workspaceRoot: 'C:/ws', dshHome: 'C:/dsh', tempRoots: ['t'], classifierTimeoutMs: 9000, maxArgsChars: 4000, notifyUser: true, enabled: false }
  const submitted = { enabled: true, timeoutAction: 'reject' }
  const out = preserveHostKeys(current, submitted)
  assert.equal(out.enabled, true)
  assert.equal(out.timeoutAction, 'reject')
  assert.equal(out.workspaceRoot, 'C:/ws')
  assert.equal(out.dshHome, 'C:/dsh')
  assert.deepEqual(out.tempRoots, ['t'])
  assert.equal(out.classifierTimeoutMs, 9000)
  assert.equal(out.maxArgsChars, 4000)
  assert.equal(out.notifyUser, true)
})

test('preserveHostKeys: explicitly submitted host key wins over current', () => {
  const out = preserveHostKeys({ workspaceRoot: 'old' }, { workspaceRoot: 'new', enabled: true })
  assert.equal(out.workspaceRoot, 'new')
})

test('normalizeTimeoutAction: legacy/pending values collapse to reject, allow stays', () => {
  assert.equal(normalizeTimeoutAction('llm-low-risk-only'), 'reject')
  assert.equal(normalizeTimeoutAction(undefined), 'reject')
  assert.equal(normalizeTimeoutAction('reject'), 'reject')
  assert.equal(normalizeTimeoutAction('allow'), 'allow')
  assert.equal(normalizeTimeoutAction('low-risk-allow'), 'low-risk-allow')
})

test('prepareReviewerArguments: JSON args sanitized (secrets redacted, structure kept)', () => {
  const raw = JSON.stringify({ command: 'curl https://x -H "Authorization: Bearer sk-abcdefgh12345678"', file_path: 'a.ts' })
  const out = prepareReviewerArguments(raw)
  assert.equal(typeof out, 'object')
  assert.ok(!JSON.stringify(out).includes('sk-abcdefgh12345678'))
  assert.ok(JSON.stringify(out).includes('[redacted'))
  assert.equal(out.file_path, 'a.ts')
})

test('prepareReviewerArguments: non-JSON text falls back to sanitized text', () => {
  const out = prepareReviewerArguments('rm -rf ghp_12345678xyz')
  assert.ok(!String(out).includes('ghp_12345678xyz'))
})

test('extractToolPath: reads file_path/path/workdir from args JSON', () => {
  assert.equal(extractToolPath('{"file_path":"C:/a/b.ts"}'), 'C:/a/b.ts')
  assert.equal(extractToolPath('{"path":"x","other":1}'), 'x')
  assert.equal(extractToolPath('{"workdir":"C:/ws"}'), 'C:/ws')
  assert.equal(extractToolPath('{"command":"ls"}'), undefined)
  assert.equal(extractToolPath('not json'), undefined)
  assert.equal(extractToolPath(null), undefined)
})

test('frameReviewerInput: reasoning-blind payload carries no model reason text', () => {
  const payload = JSON.parse(frameReviewerInput({
    toolName: 'bash',
    description: 'run command',
    rawArguments: JSON.stringify({ command: 'rm -rf ghp_abcd1234' }),
    trustedUserMessages: ['please delete the temp file for me', 'another msg'],
    workspaceRoot: 'C:/ws',
    targetRelative: 'C:/ws/tmp/x',
    inWorkspace: true,
  }))
  assert.equal(payload.tool_name, 'bash')
  assert.ok(!JSON.stringify(payload).includes('ghp_abcd1234'))
  assert.equal(payload.trusted_user_messages.length, 2)
  assert.equal(payload.workspace.root, 'C:/ws')
  assert.equal(payload.workspace.in_workspace, true)
  // A model reason string must never reach the payload via any field.
  const injected = JSON.stringify(frameReviewerInput({ toolName: 'bash', rawArguments: '{"command":"ls"}', trustedUserMessages: [] }))
  assert.ok(!injected.includes('model-generated-reason'))
})

test('frameReviewerInput: trusted user messages are bounded at 4 and redacted', () => {
  const msgs = Array.from({ length: 8 }, (_, i) => `msg ${i} token sk-abcdefgh${i}`)
  const payload = JSON.parse(frameReviewerInput({ toolName: 'edit', rawArguments: '{"file_path":"a"}', trustedUserMessages: msgs }))
  assert.equal(payload.trusted_user_messages.length, 4)
  assert.ok(!JSON.stringify(payload).includes('abcdefgh'))
})

test('breakerTripped: consecutive rail (0 disables)', () => {
  assert.ok(breakerTripped(3, 0, 3, 100))
  assert.ok(breakerTripped(3, 20, 3, 1))
  assert.ok(!breakerTripped(3, 0, 2, 100))
  assert.ok(!breakerTripped(0, 0, 999, 999))
})

test('breakerTripped: cumulative rail independent of consecutive', () => {
  assert.ok(breakerTripped(0, 20, 0, 20))
  assert.ok(breakerTripped(5, 20, 2, 20))
  assert.ok(!breakerTripped(5, 20, 2, 19))
  assert.ok(breakerTripped(0, 1, 0, 1))
})

test('trimAuditTail: keeps the tail, never edits in place', () => {
  const content = Array.from({ length: 6001 }, (_, i) => `{"n":${i}}`).join('\n')
  const trimmed = trimAuditTail(content, 5000)
  const lines = trimmed.split('\n').filter(Boolean)
  assert.equal(lines.length, 5000)
  assert.equal(lines[0], '{"n":1001}')
  assert.equal(lines[4999], '{"n":6000}')
  assert.ok(trimmed.endsWith('\n'))
})

test('parseRulesText: scoped Tool(pattern) rule', () => {
  const { rules, errors } = parseRulesText('bash,git(git.push) | deny | arguments')
  assert.equal(errors.length, 0)
  assert.equal(rules.length, 1)
  assert.deepEqual(rules[0].tools, ['bash', 'git'])
  assert.equal(rules[0].policy, 'deny')
  assert.equal(rules[0].field, 'arguments')
  assert.ok(rules[0].pattern.test('git push --force origin main'))
})

test('parseRulesText: bare pattern applies to every tool, field defaults to arguments', () => {
  const { rules, errors } = parseRulesText('^git push$ | human')
  assert.equal(errors.length, 0)
  assert.equal(rules[0].tools, undefined)
  assert.equal(rules[0].field, 'arguments')
  assert.ok(rules[0].pattern.test('git push'))
})

test('parseRulesText: comments and blanks are skipped', () => {
  const { rules, errors } = parseRulesText('# comment\n\nfoo | allow\n')
  assert.equal(errors.length, 0)
  assert.equal(rules.length, 1)
})

test('parseRulesText: reports per-line errors (bad policy / bad regex)', () => {
  const text = 'a | nope\n( | deny\n^unclosed[ | deny'
  const { rules, errors } = parseRulesText(text)
  assert.equal(rules.length, 0)
  assert.equal(errors.length, 3)
  assert.deepEqual(errors.map((e) => e.line), [1, 2, 3])
})

test('evaluateRules: first match wins by policy; tool scoping respected', () => {
  const { rules, errors } = parseRulesText('bash(git.push) | deny | arguments\nwrite | human | toolName')
  assert.equal(errors.length, 0)
  assert.equal(evaluateRules(rules, { toolName: 'bash', arguments: '{"command":"git push -f"}' }).policy, 'deny')
  assert.equal(evaluateRules(rules, { toolName: 'bash', arguments: '{"command":"git status"}' }), undefined)
  assert.equal(evaluateRules(rules, { toolName: 'write', arguments: '{}' }).policy, 'human')
  assert.equal(evaluateRules(rules, { toolName: 'edit', arguments: '{}' }), undefined)
})

test('evaluateRules: reason and toolName fields route correctly', () => {
  const { rules, errors } = parseRulesText('ssh | deny | toolName\nexfil | human | reason')
  assert.equal(errors.length, 0)
  assert.equal(evaluateRules(rules, { toolName: 'ssh', reason: 'x' }).policy, 'deny')
  assert.equal(evaluateRules(rules, { toolName: 'bash', reason: 'exfil to remote' }).policy, 'human')
})

test('normalizeReviewMode: unknown/pending collapse to smart, valid stays', () => {
  assert.equal(normalizeReviewMode(undefined), 'smart')
  assert.equal(normalizeReviewMode('bogus'), 'smart')
  assert.equal(normalizeReviewMode('manual'), 'manual')
  assert.equal(normalizeReviewMode('smart'), 'smart')
  assert.equal(normalizeReviewMode('unattended'), 'unattended')
})

test('extractRuleTarget: command text projected for anchored patterns', () => {
  assert.equal(extractRuleTarget('{"command":"git push -f origin main"}'), 'git push -f origin main')
  assert.ok(extractRuleTarget('{"command":"git push -f"}').startsWith('git push'))
  assert.ok(extractRuleTarget('{"file_path":"a","content":"hello world"}').includes('hello world'))
})

test('evaluateRules: anchored git-push rule matches the bash command, not the JSON envelope', () => {
  const { rules, errors } = parseRulesText('bash(^git push) | deny | arguments')
  assert.equal(errors.length, 0)
  assert.equal(evaluateRules(rules, { toolName: 'bash', arguments: '{"command":"git push -f"}' }).policy, 'deny')
  assert.equal(evaluateRules(rules, { toolName: 'bash', arguments: '{"command":"git status"}' }), undefined)
})
