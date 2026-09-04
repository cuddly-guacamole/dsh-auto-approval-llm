/**
 * Reviewer-preview UI wiring anchors (compiled client bundle).
 *
 * The「评审模型会看到什么？」toggle must (a) exist in the settings card,
 * (b) assemble the system prompt from the live draft via the SAME function the
 * host uses (assembleReviewerSystem), and (c) render it in a read-only block.
 * Static anchors catch a refactor that drops the wiring while keeping the pure
 * helpers. Run: node --test tests/reviewer-preview-ui.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('client bundle: toggle copy is wired for show and back', () => {
  assert.ok(client.includes('settings.rules.previewShow'), 'previewShow key referenced')
  assert.ok(client.includes('settings.rules.previewBack'), 'previewBack key referenced')
})

test('client bundle: preview assembles from the live draft with the host function', () => {
  assert.ok(client.includes('assembleReviewerSystem'), 'assembleReviewerSystem bundled')
  assert.ok(client.includes('REVIEWER_SYSTEM'), 'REVIEWER_SYSTEM bundled')
  // The call passes the CURRENT draft values, so the preview tracks edits
  // before save — grep the compiled call shape loosely.
  assert.ok(client.includes('draft.safetyPrompt'), 'preview reads draft.safetyPrompt')
  assert.ok(client.includes('draft.rulesText'), 'preview reads draft.rulesText')
})

test('client bundle: preview renders inside a read-only block', () => {
  assert.ok(client.includes('dsa-reviewerPreview'), 'preview container class in styles')
  assert.ok(client.includes('dsa-reviewerPreviewBody'), 'preview body style hook present')
  assert.ok(client.includes('user-select:text'), 'preview text is selectable')
})

test('client bundle: stale hot-reload wording is gone (settings are live everywhere)', () => {
  // With native HMR every setting is live after save, so the「保存后热生效」hint
  // and the「未生效」badge (which implied a restart or deferred activation) no
  // longer reflect reality — a refactor that reintroduces them is caught here.
  assert.ok(!client.includes('settings.rules.safetyPromptHint'), 'no hot-apply hint key')
  assert.ok(!client.includes('notYetEffective'), 'no not-yet-effective badge copy')
  assert.ok(!client.includes('securityActive'), 'no securityActive state/badge wiring')
})
