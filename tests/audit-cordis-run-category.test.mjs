/**
 * `cordis_run` activates a Package whose `code.host` body is model-written
 * JavaScript, evaluated in the host process. It reaches the answerer as an
 * unrecognized registered tool (step 18: ask + classifier), so today the whole
 * decision is the model's; DSH's own approval flow only covers packages that
 * carry a browser half.
 *
 * This pins the opt-in switch instead of a new default: `cordis_run` gets its
 * own category (`dynamicPlugin`) that appears in the category card, is NOT
 * locked (all four values stay selectable) and is `inherit` while unset — so
 * an existing installation keeps exactly today's behaviour until its operator
 * decides otherwise. Setting it to `ask` buys the standing human ask (a normal
 * category ask is status-less: no countdown, nothing resolves automatically).
 *
 * Run: node --test tests/audit-cordis-run-category.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CATEGORY_KEYS, CATEGORY_PRECEDENCE, LOCKED_CATEGORIES, HARD_LOCKED_CATEGORIES,
  categorizeTool, categoryDirective, applyCategoryDirective,
} from '../lib/auto/category.js'
import { assessTool } from '../lib/auto/policy.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const KEY = 'dynamicPlugin'
const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: [],
}
const baseConfig = { categoryMode: 'standard', categoryPolicy: {}, privilegeAutoReview: false, protectedAutoReview: false }
const configWith = (value, mode = 'standard') => ({ ...baseConfig, categoryMode: mode, categoryPolicy: { [KEY]: value } })
const ASK = { decision: 'ask', classifierEligible: true }
const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

test('cordis_run is its own category', () => {
  assert.equal(CATEGORY_KEYS.includes(KEY), true, `${KEY} must be a configurable category key`)
  assert.equal(categorizeTool({ name: 'cordis_run', arguments: {} }, roots), KEY)
  assert.equal(categorizeTool({ name: 'cordis_define', arguments: {} }, roots), 'harnessInternal')
  assert.equal(categorizeTool({ name: 'cordis_stop', arguments: {} }, roots), 'harnessInternal')
  assert.equal(categorizeTool({ name: 'present', arguments: {} }, roots), 'harnessInternal')
})

test('the category sits above every existing tier so a compound line cannot drag it down', () => {
  for (const other of CATEGORY_KEYS.filter((key) => key !== KEY)) {
    assert.ok(CATEGORY_PRECEDENCE[KEY] > CATEGORY_PRECEDENCE[other], `${KEY} must outrank ${other}`)
  }
})

test('it is not locked: the switch offers every value and nothing is clamped', () => {
  assert.equal(LOCKED_CATEGORIES.includes(KEY), false, 'a locked category would clamp the operator to ask')
  assert.equal(HARD_LOCKED_CATEGORIES.includes(KEY), false)
  for (const value of ['auto', 'ask', 'deny']) {
    assert.equal(categoryDirective(configWith(value), KEY, ASK), value, `${value} must survive resolve-time`)
  }
})

test('unset is inherit in both modes: an existing installation is unchanged', () => {
  for (const mode of ['standard', 'aggressive']) {
    assert.equal(categoryDirective({ ...baseConfig, categoryMode: mode }, KEY, ASK), 'inherit', mode)
  }
  const verdict = assessTool({ name: 'cordis_run', arguments: { pluginId: 'p', packageId: 'k', mode: 'run' } }, roots, new ArtifactRegistry())
  assert.equal(verdict.decision, 'ask', 'the unset verdict must stay the unrecognized-tool ask')
  assert.equal(verdict.classifierEligible, true, 'the classifier keeps this call, exactly as before')
})

test('ask is a standing human ask and deny is terminal', () => {
  assert.equal(categoryDirective(configWith('ask'), KEY, ASK), 'ask')
  assert.equal(categoryDirective(configWith('deny'), KEY, ASK), 'deny')
  // A normal category ask carries no countdown status: it resolves only when a
  // human answers. The classification site must name the category so the
  // mapping cannot drift away from the switch.
  const category = src('src/auto/category.ts')
  assert.match(category, /if \(name === 'cordis_run'\) \{\s*[\s\S]{0,300}?return 'dynamicPlugin'/, 'the classification site maps cordis_run')
})

test('auto lowers an eligible ask to LOW and can never rise above HIGH', () => {
  assert.equal(applyCategoryDirective('MEDIUM', 'auto', ASK), 'LOW')
  assert.equal(applyCategoryDirective('HIGH', 'auto', ASK), 'HIGH', 'auto never beats a HIGH tier')
  assert.equal(applyCategoryDirective('DENY', 'auto', ASK), 'DENY', 'the hard-deny floor is not configurable')
})

test('the client exposes the row and both locales label it', () => {
  const client = src('src/client/index.ts')
  assert.match(client, /CATEGORY_KEY_LIST = \[[^\]]*'dynamicPlugin'/, 'the card iterates the key list')
  assert.equal(client.includes(`CATEGORY_LOCKED_LIST = ['delete', 'protected', 'privilege', 'disk']`), true, 'the locked list is untouched')
  const locale = src('src/client/locale.ts')
  const labelled = locale.match(/'category\.dynamicPlugin':/g) ?? []
  assert.equal(labelled.length, 2, 'the label must exist in both languages')
})
