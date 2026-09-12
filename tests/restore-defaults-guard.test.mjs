/**
 * dsh-auto-approval-llm · restore-defaults guard anchors (compiled bundle).
 *
 * "Restore defaults" and the per-card resets must never flip a key the user
 * cannot see or undo from the card. Two mechanisms carry that promise now:
 *   - a deliberate omission inside each reset literal (autoSwitchPolicyToAsk,
 *     breakerAntiHijackMs); and
 *   - host ownership for every control-less key (decision.ts HOST_ONLY_KEYS),
 *     which makes a card save structurally unable to reach it.
 * This file pins both, plus the honest-label anchors for the `enabled` gate.
 * Run: node --test tests/restore-defaults-guard.test.mjs (tsc + tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const src = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

/** One reset handler's source body, up to the closing brace at its own indent. */
function handlerBody(marker) {
  const at = src.indexOf(marker)
  assert.ok(at > 0, `${marker} is wired`)
  const end = src.indexOf('\n  }', at)
  assert.ok(end > at, `${marker} has a body`)
  return src.slice(at, end)
}

test('restore defaults: autoSwitchPolicyToAsk is not in the defaults literal', () => {
  const literalAt = client.indexOf('enabled: "on"') >= 0
    ? client.indexOf('enabled: "on"')
    : client.indexOf("enabled: 'on'")
  assert.ok(literalAt > 0, 'the restore-defaults literal is wired')
  const scope = client.slice(literalAt, literalAt + 400)
  assert.ok(!scope.includes('autoSwitchPolicyToAsk'), 'the defaults literal must not flip autoSwitchPolicyToAsk')
})

test('restore defaults: the deliberate-omission rationale is in the source', () => {
  assert.ok(src.includes('autoSwitchPolicyToAsk is deliberately NOT restored'), 'the why-comment guards against re-adding the key')
})

test('every reset path leaves the control-less keys alone', () => {
  // These keys have no settings-card control at all, so a reset that wrote them
  // would change a value the user can neither see nor set back from the card.
  // HOST_ONLY_KEYS is the structural half of the guard (independent of the
  // literal omissions asserted here); tests/settings-key-ownership.test.mjs
  // pins that membership.
  const handlers = ['const resetCard = () => {', 'const resetTimerCard = () => {', 'const restoreTopDefaults = async () => {', 'const resetReviewerCard = async () => {']
  for (const marker of handlers) {
    const body = handlerBody(marker)
    for (const key of ['rulesDryRun', 'breakerAntiHijackMs', 'reviewMaxRetries']) {
      assert.ok(
        !new RegExp(`${key}\\s*:`).test(body),
        `${marker} must not assign ${key} (no control exists to set it back)`,
      )
    }
  }
})

test('timer card reset: breakerAntiHijackMs is not zeroed', () => {
  // The card default is 0 (guard no-op); resetting the card must not close an
  // anti-hijack window configured only through YAML. The key is additionally
  // host-only, so the stored value wins even if a literal ever wrote it.
  const body = handlerBody('const resetTimerCard = () => {')
  assert.ok(!/breakerAntiHijackMs\s*:/.test(body), 'resetTimerCard must not assign breakerAntiHijackMs')
  assert.ok(src.includes('breakerAntiHijackMs is deliberately NOT reset'), 'the why-comment guards against re-adding the key')
})

test('enabled setting: honest label + hint (it gates answering, not the plugin)', () => {
  // "Enable plugin" promised a master switch while config.enabled only gates
  // the answerer (pre-execute/guard keep running with it off). The label now
  // says "answering" and the row carries a hint stating the real scope.
  assert.match(src, /row\(t\('settings\.enable'\),[\s\S]*?t\('settings\.enableHint'\)/, 'the enabled row must carry the hint')
  const locale = readFileSync(new URL('../src/client/locale.ts', import.meta.url), 'utf8')
  for (const needle of ["'settings.enable': '自动审批应答'", "'settings.enableHint': '仅控制是否自动应答审批询问", "'settings.enable': 'Auto-approval answering'", "'settings.enableHint': 'Only gates auto-answering"]) {
    assert.ok(locale.includes(needle), `locale must carry: ${needle}`)
  }
  assert.ok(!locale.includes("'settings.enable': '启用插件'"), 'the master-switch label must be gone')
})

test('enabled gate: off means fall through to the official panel, nothing else', () => {
  // Behavior anchor for the honest-label semantics: config.enabled gates ONLY
  // the auto-answerer. The gate must be the first check inside the answerer
  // handler and its whole body must be the fall-through to next() — the
  // official approval UI — so a disabled plugin degrades to the host, never
  // to a silent deny or a runaway auto-answer.
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const handlerAt = host.indexOf("anyCtx.on('approval/request'")
  assert.ok(handlerAt !== -1, 'the answerer registration exists')
  const scope = host.slice(handlerAt, handlerAt + 300)
  const gateAt = scope.indexOf('if (!config.enabled)')
  assert.ok(gateAt !== -1, 'the enabled gate is the answerer entry check')
  const tail = scope.slice(gateAt, gateAt + 80)
  assert.ok(/if \(!config\.enabled\)\s*\n\s*return next\(\);/.test(tail), 'the gate body is exactly the official-panel fall-through')
})
