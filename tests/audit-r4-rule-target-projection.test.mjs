/**
 * Rule matching against the whole projected action surface.
 *
 * A declared rule's `arguments` field was matched against one projection
 * (`command ?? path ?? payload`). Because the DSH argument schema leaves
 * undeclared keys intact, a single extra field decided which value the rule
 * saw: a path `deny` rule stopped matching as soon as the call carried a
 * harmless `command`, and `str_replace_editor` — which declares both `command`
 * and `path` — could never match a path rule at all.
 *
 * Deny/human rules now match every projected target; an allow rule still
 * matches only the primary projection, so an allow is never widened by text in
 * an unrelated field.
 *
 * Run: node --test tests/audit-r4-rule-target-projection.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRules, extractRuleTarget, extractRuleTargets, parseRulesText } from '../lib/auto/rules.js'

function compiled(text) {
  const { rules, errors } = parseRulesText(text)
  assert.deepEqual(errors, [], 'the fixture rules must parse')
  return rules
}

test('an extra argument field cannot hide the value a deny rule names', () => {
  const rules = compiled('write(secret\\.env) | deny | arguments')
  assert.equal(evaluateRules(rules, { toolName: 'write', arguments: { file_path: 'C:/ws/secret.env' } }).policy, 'deny')
  assert.equal(
    evaluateRules(rules, { toolName: 'write', arguments: { command: 'noop', file_path: 'C:/ws/secret.env' } }).policy,
    'deny',
    'the added command field must not defeat the path rule',
  )
})

test('a path rule fires for a tool that declares both command and path', () => {
  const rules = compiled('str_replace_editor(\\.env) | deny | arguments')
  assert.equal(
    evaluateRules(rules, {
      toolName: 'str_replace_editor',
      arguments: { command: 'view', path: 'C:/ws/.env' },
    }).policy,
    'deny',
  )
})

test('human rules match the whole surface too', () => {
  const rules = compiled('write(secret\\.env) | human | arguments')
  assert.equal(
    evaluateRules(rules, { toolName: 'write', arguments: { command: 'noop', file_path: 'C:/ws/secret.env' } }).policy,
    'human',
  )
})

test('an allow rule is never widened by an unrelated field', () => {
  const rules = compiled('toolx(^ls$) | allow | arguments')
  assert.equal(evaluateRules(rules, { toolName: 'toolx', arguments: { command: 'ls' } }).policy, 'allow')
  assert.equal(
    evaluateRules(rules, { toolName: 'toolx', arguments: { file_path: 'x', content: 'ls' } }),
    undefined,
    'payload text must not pre-authorize through an allow rule',
  )
})

test('strictest wins across the widened surface', () => {
  const rules = compiled('toolx(^ls$) | allow | arguments\ntoolx(secret) | deny | arguments')
  assert.equal(
    evaluateRules(rules, { toolName: 'toolx', arguments: { command: 'ls', path: 'C:/ws/secret.txt' } }).policy,
    'deny',
  )
})

test('non-matching arguments still match nothing', () => {
  const rules = compiled('write(secret\\.env) | deny | arguments')
  assert.equal(evaluateRules(rules, { toolName: 'write', arguments: { command: 'x', file_path: 'C:/ws/public.txt' } }), undefined)
})

test('extractRuleTarget keeps its single projection contract', () => {
  assert.equal(extractRuleTarget('{"command":"git push -f origin main"}'), 'git push -f origin main')
  assert.equal(extractRuleTarget('{"file_path":"C:/ws/a.ts","content":"body"}'), 'C:/ws/a.ts')
  assert.deepEqual(extractRuleTargets({ file_path: 'C:/ws/a.ts', command: 'noop' }), ['noop', 'C:/ws/a.ts'])
})

test('an envelope with no action keys keeps its serialized form verbatim', () => {
  // The raw string is already the serialized envelope; re-serializing it would
  // double-encode and change which rules an empty envelope matches.
  assert.equal(extractRuleTarget('{}'), '{}')
  assert.deepEqual(extractRuleTargets('{}'), ['{}'])
  assert.equal(extractRuleTarget({}), '{}')
  assert.deepEqual(extractRuleTargets({ other: 1 }), ['{"other":1}'])
})
