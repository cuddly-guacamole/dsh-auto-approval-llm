/**
 * dsh-auto-approval-llm · pre-execute user-terminal gate regression tests.
 *
 * Regression (2026-09-03 audit): denyList / declared rules / humanOnlyList
 * were only evaluated in the approval/request answerer, but the pre-execute
 * fast path answers static and classifier allows with `next()` without ever
 * creating an approval/request — so an explicit operator terminal
 * (denyList:['bash'], `Tool(bash)|deny`, humanOnlyList:['write']) was
 * silently bypassed by statically-routine calls. The same user policy is now
 * mirrored onto the pre-execute plane ahead of every fast-path allow, in the
 * answerer's precedence order (rules → denyList → humanOnly).
 *
 * 2026-09-05 (user decision): the allowlist is mirrored too. It previously
 * answered only in the answerer, so a classifier fast-path deny could
 * override a user's explicit allowlist entry (memory_* under allowlist was
 * still reviewable/rejectable by the LLM). A listed tool is the operator's
 * declared intent, so it now lets through on the pre-execute plane BEFORE
 * the classifier — still after category deny/ask, which LOCKED/protected
 * categories must always win.
 *
 * Run: node --test tests/audit-preexecute-lists.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HOST_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('pre-execute: user terminal gates run ahead of the static and classifier allows', () => {
  const start = HOST_SRC.indexOf("'tools/pre-execute'")
  const end = HOST_SRC.indexOf("'tools/result'", start)
  assert.ok(start !== -1 && end > start, 'the pre-execute handler is locatable')
  const pre = HOST_SRC.slice(start, end)
  const gateIdx = pre.indexOf('staticListDecision(config, exec.name)')
  const rulesIdx = pre.indexOf('evaluateRules(declared.rules, subject)')
  const allowIdx = pre.indexOf("assessment.decision === 'allow'")
  const classifyIdx = pre.indexOf('classifier.classify(')
  const denyListIdx = pre.indexOf('[auto-mode denyList]')
  const humanIdx = pre.indexOf('[auto-mode human-only]')
  const ruleDenyIdx = pre.indexOf('[auto-mode rule deny]')
  const categoryIdx = pre.indexOf('[auto-mode category deny]')
  for (const [name, idx] of [
    ['static-list gate', gateIdx], ['rules gate', rulesIdx],
    ['static-allow literal', allowIdx], ['classifier call', classifyIdx],
    ['denyList deny reason', denyListIdx], ['human-only ask reason', humanIdx],
    ['rule deny reason', ruleDenyIdx], ['category deny reason', categoryIdx],
  ]) {
    assert.ok(idx !== -1, `pre-execute contains ${name}`)
  }
  // Order: user terminals before any fast-path allow; category after them
  // (mirrors the answerer precedence rules → denyList → humanOnly → category).
  assert.ok(gateIdx < allowIdx && rulesIdx < allowIdx, 'the gates precede the static allow')
  assert.ok(denyListIdx < allowIdx && humanIdx < allowIdx && ruleDenyIdx < allowIdx, 'the user terminals precede the static allow')
  assert.ok(gateIdx < classifyIdx && rulesIdx < classifyIdx, 'the gates precede the classifier allow')
  assert.ok(denyListIdx < categoryIdx && humanIdx < categoryIdx && ruleDenyIdx < categoryIdx, 'the user terminals precede the category deny')
})

test('pre-execute: rule/denyList terminals leave the same durable trail as the answerer', () => {
  const start = HOST_SRC.indexOf("'tools/pre-execute'")
  const end = HOST_SRC.indexOf("'tools/result'", start)
  const pre = HOST_SRC.slice(start, end)
  assert.ok(pre.includes("source: 'rule-deny'"), 'rule denies write history with the rule-deny source')
  assert.ok(pre.includes("source: 'denyList-deny'"), 'denyList denies write history with the denyList-deny source')
  assert.ok(pre.includes("source: 'rule-allow'"), 'rule allows write history with the rule-allow source')
  assert.ok(pre.includes("source: 'allowlist-allow'"), 'the allowlist writes the same audit trail when it lets a call through')
  assert.ok(pre.includes("config.rulesText.trim() !== ''"), 'rules are only evaluated when configured')
  assert.ok(pre.includes('config.rulesDryRun'), 'rules dry-run is honored on the pre-execute plane too')
})

test('pre-execute: allowlist mirror sits after category deny/ask and before the classifier', () => {
  const start = HOST_SRC.indexOf("'tools/pre-execute'")
  const end = HOST_SRC.indexOf("'tools/result'", start)
  const pre = HOST_SRC.slice(start, end)
  const allowListAllowIdx = pre.indexOf('listDecision.kind === \'allow\'')
  const categoryDenyIdx = pre.indexOf('[auto-mode category deny]')
  const categoryAskIdx = pre.indexOf('[auto-mode category ask]')
  const staticAllowIdx = pre.indexOf("assessment.decision === 'allow'")
  const classifyIdx = pre.indexOf('classifier.classify(')
  assert.ok(allowListAllowIdx !== -1, 'allowlist allow branch exists in pre-execute')
  // LOCKED/protected categories must always win over an explicit name allow.
  assert.ok(categoryDenyIdx < allowListAllowIdx, 'category deny precedes the allowlist mirror')
  assert.ok(categoryAskIdx < allowListAllowIdx, 'category ask precedes the allowlist mirror')
  // The allowlist lets the call through before the classifier can override it.
  assert.ok(allowListAllowIdx < classifyIdx, 'allowlist mirror precedes the classifier fast path')
  assert.ok(staticAllowIdx < classifyIdx, 'static allow still precedes the classifier')
})

test('pre-execute: matched user rules short-circuit exactly like the answerer (no double record)', () => {
  const start = HOST_SRC.indexOf("'tools/pre-execute'")
  const end = HOST_SRC.indexOf("'tools/result'", start)
  const pre = HOST_SRC.slice(start, end)
  // Every matched branch returns (deny / ask / next) inside the gate; the
  // answerer is never reached for a rule-matched call, so no double record.
  assert.ok(pre.includes("return { kind: 'deny', reason: `[auto-mode rule deny]")
      || pre.includes("'[auto-mode rule deny]'"), 'rule deny returns a terminal denial')
  assert.ok(pre.includes('return { kind: \'deny\', reason: `[auto-mode denyList]'), 'denyList deny returns a terminal denial')
  assert.ok(pre.includes('return { kind: \'ask\', reason: `[auto-mode human-only]'), 'humanOnly converts the call into an official ask')
  assert.ok(pre.includes('return next()'), 'the rule-allow branch hands over to execution')
})