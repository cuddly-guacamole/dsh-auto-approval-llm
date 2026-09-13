/**
 * Declarative rules resolve to the strictest policy across ALL matching rules
 * (deny > human > allow), not to the first declared match — rule order in
 * rulesText must not change the outcome. Ties keep declaration order (the
 * first rule of the winning severity is the audited one).
 * Run: node --test tests/rules-strictest-priority.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRulesText, evaluateRules } from '../lib/auto/rules.js'

test('a deny rule wins over an earlier allow rule on the same call', () => {
  const { rules, errors } = parseRulesText('bash(ls.*) | allow | arguments\nbash(rm.*) | deny | arguments')
  assert.equal(errors.length, 0)
  const subject = { toolName: 'bash', arguments: '{"command":"ls; rm x"}' }
  // both patterns match the same arguments; the strictest side must win
  assert.equal(evaluateRules(rules, subject)?.policy, 'deny')
})

test('a human rule wins over an earlier allow rule on the same call', () => {
  const { rules, errors } = parseRulesText('write(tmp.*) | allow | arguments\nwrite(secret.*) | human | arguments')
  assert.equal(errors.length, 0)
  const subject = { toolName: 'write', arguments: '{"file_path":"tmp/secret.key"}' }
  assert.equal(evaluateRules(rules, subject)?.policy, 'human')
})

test('the winning rule is the audited one: the strictest side names the audit source', () => {
  const { rules, errors } = parseRulesText('bash(echo.*) | allow | arguments\nbash(rm.*) | deny | arguments')
  assert.equal(errors.length, 0)
  const subject = { toolName: 'bash', arguments: '{"command":"echo hi; rm x"}' }
  const matched = evaluateRules(rules, subject)
  assert.equal(matched?.policy, 'deny')
  // the consumer writes `matched ${rule.source}` into history llmReason and
  // dry-run logs; the winner must carry the deny rule's own declared source
  assert.ok(String(matched?.rule.source).includes('rm'), `the deny rule must be the winner, got ${matched?.rule.source}`)
})

test('ties keep declaration order: the first deny rule of equal severity wins', () => {
  const { rules, errors } = parseRulesText('bash(alpha.*) | deny | arguments\nbash(beta.*) | deny | arguments')
  assert.equal(errors.length, 0)
  const subject = { toolName: 'bash', arguments: '{"command":"alpha; beta"}' }
  const matched = evaluateRules(rules, subject)
  assert.equal(matched?.policy, 'deny')
  assert.ok(String(matched?.rule.source).includes('alpha'), `equal severity must keep declaration order, got ${matched?.rule.source}`)
})

test('an allow-only match still allows: strictest of one is that one', () => {
  const { rules, errors } = parseRulesText('bash(git status.*) | allow | arguments')
  assert.equal(errors.length, 0)
  const subject = { toolName: 'bash', arguments: '{"command":"git status"}' }
  assert.equal(evaluateRules(rules, subject)?.policy, 'allow')
})

test('no match stays undefined even with many declared rules', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `bash(pat${i}.*) | deny | arguments`)
  const { rules, errors } = parseRulesText(lines.join('\n'))
  assert.equal(errors.length, 0)
  assert.equal(rules.length, 200)
  const subject = { toolName: 'bash', arguments: '{"command":"nothing matches here"}' }
  const started = process.hrtime.bigint()
  assert.equal(evaluateRules(rules, subject), undefined)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  // full scan over all rules must stay linear and fast; the guard is a floor
  // against accidental re-compile-per-rule or quadratic scanning, not a perf claim
  assert.ok(elapsedMs < 500, `200-rule full scan took ${elapsedMs.toFixed(1)}ms`)
})
