/**
 * dsh-auto-approval-llm · restore-defaults guard anchors (compiled bundle).
 *
 * "Restore defaults" must never flip autoSwitchPolicyToAsk: the key has no UI
 * control on the settings card, so a silent flip is invisible and undoable
 * only through the config file — and flipping it to on stops the auto-answer
 * flow for sessions whose preset policy it guards. Its value is a host-level
 * fact (the cordis patch pins it true at install time). Run:
 * node --test tests/restore-defaults-guard.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('restore defaults: autoSwitchPolicyToAsk is not in the defaults literal', () => {
  const literalAt = client.indexOf('enabled: "on"') >= 0
    ? client.indexOf('enabled: "on"')
    : client.indexOf("enabled: 'on'")
  assert.ok(literalAt > 0, 'the restore-defaults literal is wired')
  const scope = client.slice(literalAt, literalAt + 400)
  assert.ok(!scope.includes('autoSwitchPolicyToAsk'), 'the defaults literal must not flip autoSwitchPolicyToAsk')
})

test('restore defaults: the deliberate-omission rationale is in the source', () => {
  const src = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('autoSwitchPolicyToAsk is deliberately NOT restored'), 'the why-comment guards against re-adding the key')
})

test('restore defaults: the key still rides the top-card save (never dropped)', () => {
  // TOP_KEYS keeps the key in the per-card save overlay so a card save
  // re-posts the stored value unchanged (full-replace settings semantics).
  const src = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(src, /TOP_KEYS = \['enabled', 'autoSwitchPolicyToAsk'/, 'TOP_KEYS membership preserved')
})

test('timer card reset: breakerAntiHijackMs is not zeroed', () => {
  // The card default is 0 (guard no-op); resetting the card must not close an
  // anti-hijack window configured only through YAML (no control exists to
  // restore it). Same guard family as the restore-defaults omission above.
  const src = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const resetAt = src.indexOf('const resetTimerCard = () => {')
  assert.ok(resetAt > 0, 'the timer reset handler is wired')
  const body = src.slice(resetAt, src.indexOf('}', src.indexOf('directHumanEnabled', resetAt)))
  assert.ok(!/breakerAntiHijackMs\s*:/.test(body), 'resetTimerCard must not assign breakerAntiHijackMs')
  assert.ok(src.includes('breakerAntiHijackMs is deliberately NOT reset'), 'the why-comment guards against re-adding the key')
})
