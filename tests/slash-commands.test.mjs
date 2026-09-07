/**
 * dsh-auto-approval-llm · optional slash-command registration
 * (slashCommandsEnabled).
 *
 * /approval-mode, /approval-reset and /approval-reset-all are escape-hatch /
 * review-mode commands that were previously always registered when the
 * commands service is present. They are now gated behind an opt-in switch
 * (default off, fail-closed), mirroring the direct-human tool: registered
 * ONLY when the switch is on at boot (command sets are not hot-swappable —
 * enabling needs a restart), while each handler reads the switch LIVE and
 * refuses with a clear error when it is off, so disabling stops the
 * already-registered commands at once. The settings card row sits directly
 * above the "Register dsa_request_user tool" row, and the key rides the same
 * timer/breaker save card (TIMER_KEYS) so a card save never drops it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const locale = readFileSync(new URL('../src/client/locale.ts', import.meta.url), 'utf8')
const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('static anchors: the new switch defaults to off (fail closed)', () => {
  assert.match(src, /slashCommandsEnabled: z\.boolean\(\)\.default\(false\)/, 'schema defaults off')
  assert.ok(src.includes('slashCommandsEnabled'), 'interface field declared')
  assert.ok(src.includes('/approval-mode'), 'schema comment names the trio')
})

test('static anchors: the trio registers only inside the boot-time gate', () => {
  const lib2 = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const gateAt = lib2.indexOf('if (commands && config.slashCommandsEnabled === true)')
  assert.ok(gateAt > 0, 'the registration gate exists in the compiled host')
  const resetAllAt = lib2.indexOf("name: 'approval-reset-all'")
  assert.ok(resetAllAt > gateAt, '/approval-reset-all registers after the gate')
  const resetAt = lib2.indexOf("name: 'approval-reset'")
  assert.ok(resetAt > resetAllAt, '/approval-reset registers after the global one')
  const modeAt = lib2.indexOf("name: 'approval-mode'")
  assert.ok(modeAt > resetAt, '/approval-mode registers last inside the same gate')
})

test('static anchors: every handler first checks the live switch and refuses when off', () => {
  // Command sets are boot-level; the live guard makes a mid-run disable stop
  // the already-registered commands at once (same two-layer semantics as the
  // direct-human tool). Each handler's first statement must be the guard.
  for (const name of ['approval-reset-all', 'approval-reset', 'approval-mode']) {
    const at = lib.indexOf(`name: '${name}'`)
    assert.ok(at > 0, `${name} is registered`)
    const afterName = lib.indexOf('handler:', at)
    assert.ok(afterName > at, `${name} has a handler`)
    const head = lib.slice(afterName, afterName + 260)
    assert.match(head, /slashCommandsLive\(\)/, `${name} handler carries the live switch guard`)
    assert.ok(head.includes('Slash commands are disabled'), `${name} guard message names the switch`)
  }
})

test('static anchors: the disabled message tells the user how to re-enable', () => {
  const count = (lib.match(/re-enable the switch and restart to use \/approval-/g) ?? []).length
  assert.equal(count, 3, 'all three handlers name the re-enable path')
})

test('static anchors: schema comment documents the two-layer truth', () => {
  assert.match(src, /REGISTERED only when the switch is on at boot/, 'boot-registration layer documented')
  assert.match(src, /reads the\s+switch LIVE|switch LIVE/, 'live-guard layer documented')
})

test('client wiring: draft + valueOf carry the switch (off by default)', () => {
  assert.match(client, /slashCommandsEnabled: value\?\.slashCommandsEnabled === true \? 'on' : 'off'/, 'draftOf maps the boolean to on/off')
  assert.match(client, /slashCommandsEnabled: draft\.slashCommandsEnabled === 'on'/, 'valueOf maps on/off back to the boolean')
  assert.match(client, /slashCommandsEnabled: 'on' \| 'off'/, 'Draft interface declares the key')
})

test('client wiring: the key rides the timer/breaker save card (never dropped)', () => {
  assert.match(client, /TIMER_KEYS = \[[\s\S]*?'directHumanEnabled', 'slashCommandsEnabled'\]/, 'TIMER_KEYS membership preserved')
})

test('client wiring: timer-card reset restores the switch to off', () => {
  const resetAt = client.indexOf('const resetTimerCard = () => {')
  assert.ok(resetAt > 0, 'the timer reset handler is wired')
  const body = client.slice(resetAt, client.indexOf('resetReviewerCard', resetAt))
  assert.match(body, /slashCommandsEnabled: 'off'/, 'resetTimerCard restores the switch to off')
})

test('client wiring: the row sits directly above the dsa_request_user row', () => {
  const slashAt = client.indexOf("row(t('settings.slashCommands.title')")
  const directAt = client.indexOf("row(t('settings.directHuman.title')")
  assert.ok(slashAt > 0 && directAt > 0, 'both rows are rendered')
  assert.ok(slashAt < directAt, 'the slash-commands row renders above the direct-human row')
  assert.ok(client.slice(slashAt, directAt).length < 1400, 'the direct-human row immediately follows (same card)')
})

test('locale: zh + en carry the label and the restart/live desc', () => {
  assert.ok(locale.includes("'settings.slashCommands.title': '注册 /approval-mode /approval-reset /approval-reset-all 命令'"), 'zh label lists the trio')
  assert.ok(locale.includes('命令注册需重启'), 'zh desc states registration needs a restart')
  assert.ok(locale.includes('已注册命令立即停用'), 'zh desc states the live disable')
  assert.ok(locale.includes("'settings.slashCommands.title': 'Register /approval-mode /approval-reset /approval-reset-all commands'"), 'en label lists the trio')
  assert.ok(locale.includes('Registering needs a restart'), 'en desc states registration needs a restart')
  assert.ok(locale.includes('disables the already-registered commands at once'), 'en desc states the live disable')
})
