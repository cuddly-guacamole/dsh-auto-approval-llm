/**
 * The pre-execute category deny is the primary terminal for that verdict (the
 * answerer's copy is defense-in-depth), but it was the only deny family that
 * handed the model no user-role guidance: `category` is a registered guidance
 * source and the answerer path already injects it, while the plane that
 * actually fires in Auto sessions stayed silent — so the model had no "the
 * same target stays denied, ask the user" signal on the path it really hit.
 * Run: node --test tests/audit-category-deny-guidance.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildRejectGuidanceText } from '../lib/index.js'

const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

test('the guidance text names the category source and the category label', () => {
  const text = buildRejectGuidanceText('category', 'delete')
  assert.match(text, /denied by category policy/)
  assert.match(text, /category: delete/)
  const unknownCategory = buildRejectGuidanceText('category', '/tmp/x')
  assert.doesNotMatch(unknownCategory, /\/tmp\/x/, 'only closed-set category keys are echoed')
})

test('the pre-execute category deny injects the guidance before it returns', () => {
  const deny = src.indexOf("[dsh-auto-approval-llm] category deny ${exec.name}")
  assert.ok(deny > 0)
  const window = src.slice(Math.max(0, deny - 700), deny)
  assert.match(window, /maybeInjectRejectGuidance\(exec\.agent, exec\.callId, config, buildRejectGuidanceText\('category', category\)\)/,
    'the primary terminal must inject the guidance')
  // The other two pre-execute deny families were already covered; keep them.
  assert.match(src, /maybeInjectRejectGuidance\(exec\.agent, exec\.callId, config, buildRejectGuidanceText\('rule'\)\)/)
  assert.match(src, /maybeInjectRejectGuidance\(exec\.agent, exec\.callId, config, buildRejectGuidanceText\('denyList'\)\)/)
})
