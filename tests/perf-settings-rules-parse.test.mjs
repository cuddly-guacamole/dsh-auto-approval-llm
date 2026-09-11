/**
 * dsh-auto-approval-llm · settings render: declared rules parsed once.
 *
 * `buildSecurityBody` evaluated `parseRulesText(draft.rulesText)` twice in one
 * render — two full parses of the declared-rules block per keystroke. The
 * errors are now parsed once into a local binding and consumed twice.
 *
 * The static half pins the single evaluation; the behavioural half proves the
 * expression being collapsed can actually produce errors, so "parse nothing"
 * cannot pass as "parse once".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRulesText } from '../lib/auto/rules.js'

const client = () => readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

test('security card parses the declared rules exactly once per render', () => {
  const source = client()
  const evaluations = source.match(/parseRulesText\(draft\.rulesText\)/g) ?? []
  assert.equal(evaluations.length, 1, `expected one evaluation, found ${evaluations.length}`)
})

test('the single evaluation is bound and both consumers read the binding', () => {
  const source = client()
  const bound = source.match(/const\s+(\w+)\s*=\s*parseRulesText\(draft\.rulesText\)\.errors/)
  assert.ok(bound, 'the parse result must be bound to a local const')
  const name = bound[1]
  assert.match(source, new RegExp(`${name}\\.map\\(`), 'error list must consume the binding')
  assert.match(source, new RegExp(`${name}\\.length`), 'blocked-flag must consume the binding')
})

test('parseRulesText still reports a bad declared rule (no vacuous parse)', () => {
  const parsed = parseRulesText('bash | maybe')
  assert.ok(parsed.errors.length > 0, 'a malformed rule must still yield an error')
  assert.equal(parseRulesText('').errors.length, 0)
})
