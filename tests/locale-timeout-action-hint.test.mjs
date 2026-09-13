/**
 * The timeout-action hint and the privilege hint must carry mode qualifiers
 * instead of claiming unconditional lock behaviour.
 *
 * Ground truth (see docs/17-category-switches.md, "which layer decides an
 * unconfigured LOCKED ask"): delete/disk ignore the timeout action in every
 * mode; protected/privilege settle by it on timeout only under the standard
 * mode when not explicitly configured — under aggressive or an explicit ask
 * the ask is a locked one that the timeout action cannot auto-allow.
 * The hints previously stated the aggressive-only behaviour as unconditional,
 * which read false under the standard mode where an unconfigured LOCKED ask
 * inherits into the normal review pipeline.
 * Run: node --test tests/locale-timeout-action-hint.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const locale = readFileSync(fileURLToPath(new URL('../src/client/locale.ts', import.meta.url)), 'utf8')

function hintValues(key) {
  const re = new RegExp(`'${key.replace(/\./g, '\\.')}': '([^']*)'`, 'g')
  const values = []
  let m
  while ((m = re.exec(locale)) !== null) values.push(m[1])
  return values
}

test('the timeout-action hint states its mode qualifiers instead of an unconditional lock claim', () => {
  const values = hintValues('settings.timeoutActionHint')
  assert.equal(values.length, 2, 'the hint must exist in both locales')
  for (const v of values) {
    assert.doesNotMatch(
      v,
      /一律自动拒绝|always auto-reject|永不因本选项放行|任何配置都无法放行|no timeoutAction setting can ever auto-allow/,
      `unconditional lock claim must be gone, got: ${v}`,
    )
    assert.match(v, /标准档|standard/i, 'the hint must name the standard mode')
    assert.match(v, /激进|aggressive/i, 'the hint must name the aggressive mode')
  }
})

test('the privilege hint drops the unconditional lock-only claim and states the mode', () => {
  const values = hintValues('settings.category.privilegeAutoReviewHint')
  assert.equal(values.length, 2, 'the hint must exist in both locales')
  for (const v of values) {
    assert.doesNotMatch(v, /否则锁定仅人工|locked to ask-human only/, `unconditional claim must be gone, got: ${v}`)
    assert.match(v, /标准档|standard/i, 'the hint must name the standard mode')
    assert.match(v, /激进|aggressive/i, 'the hint must name the aggressive mode')
  }
})

test('the sibling protected hint keeps its standard-mode qualifier as the shared wording baseline', () => {
  const values = hintValues('settings.category.protectedAutoReviewHint')
  assert.equal(values.length, 2, 'the hint must exist in both locales')
  assert.match(values[0], /标准档下该类别本就为 inherit/)
  assert.match(values[1], /under the standard mode the category is already inherit/)
})
