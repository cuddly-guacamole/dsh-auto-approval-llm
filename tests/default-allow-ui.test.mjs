/**
 * Default-allow tools display UI anchors (compiled client bundle).
 *
 * The exact-list card must (a) offer the「显示默认放行的工具列表/隐藏」toggle and
 * (b) render the grouped catalog from the shared constants (same source the
 * policy allows by). Static anchors catch a refactor that drops the wiring.
 * Run: node --test tests/default-allow-ui.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('client bundle: the default-allow toggle copy is wired', () => {
  assert.ok(client.includes('settings.rules.defaultAllowShow'), 'show toggle key referenced')
  assert.ok(client.includes('settings.rules.defaultAllowHide'), 'hide toggle key referenced')
})

test('client bundle: catalog renders from the shared constant groups', () => {
  assert.ok(client.includes('DEFAULT_ALLOW_TOOL_GROUPS'), 'group constant bundled')
  assert.ok(client.includes('dsa-defaultAllowGroup'), 'group container class in styles')
  assert.ok(client.includes('dsa-defaultAllowTools'), 'tools row style hook present')
  assert.ok(client.includes('settings.rules.allowGroup.'), 'group labels go through the locale map')
})

test('client bundle: the list hint still renders under the field', () => {
  assert.ok(client.includes('settings.rules.listsHint'), 'hint key still referenced')
})
