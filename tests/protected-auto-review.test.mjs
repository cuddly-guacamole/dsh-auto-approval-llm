/**
 * Protected-category unlock contract tests.
 *
 * `protected` is a LOCKED category: its directive is clamped to 'ask' and the
 * answerer pins the countdown to reject, so no LLM takeover and no timeout
 * action can ever answer it. That is correct for an unattended session, but it
 * also means a read of an ordinary protected path (a profile's .npmrc, say)
 * becomes an unanswerable countdown while the policy plane had already decided
 * the call was eligible for semantic review — the classifierEligible signal was
 * dead on that path.
 *
 * `protectedAutoReview` mirrors the existing `privilegeAutoReview` opt-out: when
 * on, protected follows the ordinary pipeline. It ships off, because the
 * default is what keeps protected paths out of an unattended auto-allow.
 *
 * The tests pin both directions: the switch must actually lift the clamp, and
 * with it off nothing may change. The blast radius is pinned too — a credential
 * tree stays hard-denied whatever this switch says.
 *
 * Run: node --test tests/protected-auto-review.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { categoryDirective, categorizeTool, LOCKED_CATEGORIES, HARD_LOCKED_CATEGORIES } from '../lib/auto/category.js'
import { assessTool } from '../lib/auto/policy.js'
import { Config } from '../lib/index.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
const artifacts = { has: () => false }

const cfg = (overrides = {}) => ({ categoryPolicy: {}, categoryMode: 'aggressive', ...overrides })

// The exact assessment the policy plane produces for a protected read: an ask
// the reviewer is nominally eligible for.
const protectedAsk = (name = 'read', path = 'C:/Users/u/.dsh/profiles/web/.npmrc') => {
  const assessment = assessTool({ name, arguments: { path } }, roots, artifacts)
  return { assessment, category: categorizeTool({ name, arguments: { path } }, roots) }
}

test('precondition: a protected read is an ask the reviewer is eligible for', () => {
  const { assessment, category } = protectedAsk()
  assert.equal(category, 'protected', 'the fixture path must classify as protected')
  assert.equal(assessment.decision, 'ask')
  assert.equal(assessment.classifierEligible, true)
})

test('default off: protected stays clamped to ask so no LLM takeover can answer it', () => {
  assert.equal(categoryDirective(cfg(), 'protected', { decision: 'ask', classifierEligible: true }), 'ask')
  // Even an explicit auto cannot lift a locked category while the switch is off.
  assert.equal(
    categoryDirective(cfg({ categoryPolicy: { protected: 'auto' } }), 'protected', { decision: 'ask', classifierEligible: true }),
    'ask',
  )
  // An explicit deny is also clamped: a locked category accepts only 'ask'.
  assert.equal(
    categoryDirective(cfg({ categoryPolicy: { protected: 'deny' } }), 'protected', { decision: 'ask', classifierEligible: true }),
    'ask',
  )
})

test('on: the clamp is lifted and the category follows its policy like an ordinary one', () => {
  const on = { protectedAutoReview: true }
  // Unconfigured: no category tightening, so the ordinary pipeline (classifier
  // fast path included) decides — this is what lets a protected read be
  // answered instead of waiting out an unanswerable countdown.
  assert.equal(categoryDirective(cfg(on), 'protected', { decision: 'ask', classifierEligible: true }), 'inherit')
  // Explicit tri-state now flows through.
  assert.equal(categoryDirective(cfg({ ...on, categoryPolicy: { protected: 'auto' } }), 'protected', { decision: 'ask', classifierEligible: true }), 'auto')
  assert.equal(categoryDirective(cfg({ ...on, categoryPolicy: { protected: 'ask' } }), 'protected', { decision: 'ask', classifierEligible: true }), 'ask')
  assert.equal(categoryDirective(cfg({ ...on, categoryPolicy: { protected: 'deny' } }), 'protected', { decision: 'ask', classifierEligible: true }), 'deny')
})

test('on: an auto directive still refuses to auto-allow a call the reviewer cannot answer', () => {
  // 'auto' only lowers an ask-classified, classifier-eligible call; anything
  // else degrades to inherit rather than auto (the manual/opaque guard).
  assert.equal(
    categoryDirective(cfg({ protectedAutoReview: true, categoryPolicy: { protected: 'auto' } }), 'protected', { decision: 'ask', classifierEligible: false }),
    'inherit',
  )
  assert.equal(
    categoryDirective(cfg({ protectedAutoReview: true, categoryPolicy: { protected: 'auto' } }), 'protected', { decision: 'allow', classifierEligible: false }),
    'inherit',
  )
})

test('the switch is scoped to protected: the other locked categories are untouched', () => {
  for (const other of ['delete', 'disk']) {
    assert.equal(
      categoryDirective(cfg({ protectedAutoReview: true, categoryPolicy: { [other]: 'auto' } }), other, { decision: 'ask', classifierEligible: true }),
      'ask',
      `${other} must stay clamped`,
    )
  }
  // privilege keeps its own, separate switch.
  assert.equal(categoryDirective(cfg({ protectedAutoReview: true }), 'privilege', { decision: 'ask', classifierEligible: true }), 'ask')
  assert.equal(categoryDirective(cfg({ privilegeAutoReview: true }), 'privilege', { decision: 'ask', classifierEligible: true }), 'inherit')
  // And the privilege switch does not unlock protected.
  assert.equal(categoryDirective(cfg({ privilegeAutoReview: true }), 'protected', { decision: 'ask', classifierEligible: true }), 'ask')
})

test('blast radius: credential reads are protected asks, and the switch really does open them', () => {
  // Measured, not assumed. The hard-deny fuses cover *mutations* of credential
  // trees (isCriticalPath), not reads of them: a read of ~/.ssh/id_rsa is an
  // ordinary protected ask. So this switch genuinely widens what the LLM may
  // answer — a private key read included. The test states that plainly instead
  // of claiming a narrower radius than the code has.
  for (const target of ['C:/Users/u/.ssh/id_rsa', 'C:/Users/u/.aws/credentials', 'C:/Users/u/.gnupg/secring.gpg']) {
    const read = assessTool({ name: 'read', arguments: { path: target } }, roots, artifacts)
    assert.equal(read.decision, 'ask', `${target} read is an ask`)
    assert.equal(read.classifierEligible, true, `${target} read is reviewer-eligible`)
    assert.equal(categorizeTool({ name: 'read', arguments: { path: target } }, roots), 'protected')
    // The clamp is what keeps that ask unanswerable today; the unlock lifts it.
    assert.equal(categoryDirective(cfg(), 'protected', { decision: 'ask', classifierEligible: true }), 'ask')
    assert.equal(categoryDirective(cfg({ protectedAutoReview: true }), 'protected', { decision: 'ask', classifierEligible: true }), 'inherit')
  }
})

test('mutations of a credential tree stay hard-denied whatever the switch says', () => {
  // This half of the claim is true and is the reason the unlock is defensible
  // at all: the switch moves the category clamp, not the hard-deny fuse.
  for (const target of ['C:/Users/u/.ssh/id_rsa', 'C:/Users/u/.aws/credentials']) {
    const write = assessTool({ name: 'write', arguments: { file_path: target, content: 'x' } }, roots, artifacts)
    assert.equal(write.decision, 'deny', `${target} write must stay hard-denied`)
    assert.equal(write.classifierEligible, false, `${target} write must not reach the classifier`)
  }
})

test('LOCKED_CATEGORIES still lists protected: the unlock is a configured opt-out, not a delisting', () => {
  // Delisting protected from LOCKED_CATEGORIES would change every consumer at
  // once and silently widen the default. The opt-out is evaluated per call.
  assert.ok(LOCKED_CATEGORIES.includes('protected'))
  assert.ok(!HARD_LOCKED_CATEGORIES.includes('protected'), 'HARD_LOCKED keeps its own, narrower meaning')
})

test('the config schema ships the switch off and typed as a boolean', () => {
  const parsed = Config({})
  assert.equal(parsed.protectedAutoReview, false, 'the default must be fail-closed')
  assert.equal(parsed.privilegeAutoReview, false, 'and it must not change its neighbour')
})

test('the settings card exposes the switch in both locales', () => {
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert.ok(client.includes('settings.category.protectedAutoReview'), 'the row label key reaches the bundle')
  const locale = readFileSync(fileURLToPath(new URL('../src/client/locale.ts', import.meta.url)), 'utf8')
  for (const key of ['settings.category.protectedAutoReview', 'settings.category.protectedAutoReviewHint']) {
    const hits = locale.split(`'${key}'`).length - 1
    assert.equal(hits, 2, `${key} must exist in both the zh and the en map`)
  }
})

test('the answerer half is anchored: the locked predicate honours the same switch', () => {
  // The false positive needs BOTH halves: pre-execute must stop intercepting
  // (covered above) AND the answerer must stop pinning the countdown to reject.
  // The predicate that does the second half is a closure inside the plugin
  // function, so anchor the compiled bundle instead of leaving it untested —
  // an unlock that only reached one half would look fixed and still be
  // unanswerable.
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const predicate = host.slice(host.indexOf('const isLockedCategory = ('))
  const body = predicate.slice(0, predicate.indexOf('\n    }'))
  assert.ok(body.length > 0, 'the locked-category predicate is present in the compiled host')
  assert.ok(
    /category === ['"]protected['"] && config\.protectedAutoReview === true/.test(body),
    `the protected opt-out must be wired into the locked predicate, got:\n${body}`,
  )
  assert.ok(
    /category === ['"]privilege['"] && config\.privilegeAutoReview === true/.test(body),
    'the privilege opt-out must remain wired too',
  )
  assert.ok(
    /LOCKED_CATEGORIES\.includes\(category\)/.test(body),
    'delete/disk must still fall through to the locked list',
  )
})

test('the privilege hint no longer claims protected stays locked', () => {
  // Its old text said delete/protected/disk stay locked to a human, which this
  // change makes false. A stale claim here would misdescribe the very switch
  // sitting next to it.
  const locale = readFileSync(fileURLToPath(new URL('../src/client/locale.ts', import.meta.url)), 'utf8')
  const zh = locale.split("'settings.category.privilegeAutoReviewHint': '")[1].split("',")[0]
  const en = locale.split("'settings.category.privilegeAutoReviewHint': '")[2].split("',")[0]
  assert.ok(!zh.includes('受保护'), `the zh privilege hint must not still promise protected is locked: ${zh}`)
  assert.ok(!en.includes('protected'), `the en privilege hint must not still promise protected is locked: ${en}`)
})
