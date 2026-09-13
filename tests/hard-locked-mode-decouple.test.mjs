/**
 * The hard-locked categories (delete/disk) are mode-decoupled: their
 * unconfigured ask comes from the category layer in EVERY mode, so the
 * locked hard-reject countdown (pinned to reject, immune to timeoutAction)
 * applies under `standard` too — not only under `aggressive`. protected and
 * privilege keep the mode-dependent clamp: unconfigured under `standard`
 * they inherit into the ordinary review pipeline, where timeoutAction does
 * settle the outcome. The session-artifact delete exemption still outranks
 * the clamp, and both wiring planes read the same single implementation.
 * Run: node --test tests/hard-locked-mode-decouple.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { categoryDirective, categoryDirectiveFor } from '../lib/auto/category.js'

const stdCfg = { categoryPolicy: {}, categoryMode: 'standard' }
const askEligible = { decision: 'ask', classifierEligible: true }

test('delete and disk are locked asks under standard with no explicit config', () => {
  assert.equal(categoryDirective(stdCfg, 'delete', askEligible), 'ask')
  assert.equal(categoryDirective(stdCfg, 'disk', askEligible), 'ask')
})

test('protected and privilege stay inherit under standard with no explicit config', () => {
  // negative direction: the decoupling must not silently widen to the
  // overrideable LOCKED categories
  assert.equal(categoryDirective(stdCfg, 'protected', askEligible), 'inherit')
  assert.equal(categoryDirective(stdCfg, 'privilege', askEligible), 'inherit')
})

test('delete and disk stay locked asks under aggressive — unchanged by the decoupling', () => {
  const agg = { categoryPolicy: {}, categoryMode: 'aggressive' }
  assert.equal(categoryDirective(agg, 'delete', askEligible), 'ask')
  assert.equal(categoryDirective(agg, 'disk', askEligible), 'ask')
})

test('the session-artifact delete exemption still outranks the hard lock', () => {
  assert.equal(
    categoryDirective(stdCfg, 'delete', { ...askEligible, sessionArtifactDeletion: true }),
    'inherit',
  )
})

test('both wiring planes derive the same directive for delete', () => {
  // single implementation, two call sites: pre-execute and the answerer each
  // go through categoryDirectiveFor, so a divergence is impossible — pin it
  const exec = { name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }
  const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
  const derived = categoryDirectiveFor(exec, roots, stdCfg, askEligible)
  assert.equal(derived.directive, categoryDirective(stdCfg, derived.category, askEligible))
  assert.equal(derived.directive, 'ask')
})
