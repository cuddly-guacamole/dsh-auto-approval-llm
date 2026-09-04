/**
 * Exact-list chips UI wiring anchors (compiled client bundle).
 *
 * Static anchors on the built lib/client.js so the「精确名单」card actually
 * renders the recent-tool chips block and the TOOL_STATS_ROUTE fetch — a
 * refactor that drops the wiring (but keeps the pure helpers) is caught here.
 * Run: node --test tests/tool-chips-ui.test.mjs (requires npx tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('client bundle: fetches the tool-stats route when the security card opens', () => {
  assert.ok(client.includes('TOOL_STATS_ROUTE'), 'TOOL_STATS_ROUTE referenced')
  assert.ok(client.includes('/_dsh/auto-approval-llm/tool-stats'), 'tool-stats path literal present')
  assert.ok(client.includes('openSecurity'), 'fetch is gated on the security card being open')
})

test('client bundle: chips hint copy and more-revealer are wired for all three tabs', () => {
  for (const tab of ['allow', 'deny', 'human']) {
    assert.ok(client.includes(`settings.rules.chipsHint.${tab}`), `chipsHint.${tab} key referenced`)
  }
  assert.ok(client.includes('settings.rules.chipsMore'), 'chipsMore revealer referenced')
})

test('client bundle: chips render with the class/collapsed CSS hooks', () => {
  assert.ok(client.includes('dsa-chipRow'), 'chip row container class in styles')
  assert.ok(client.includes('dsa-chipClass'), 'collapsed-class chip style hook present')
  assert.ok(client.includes('dsa-chipMore'), 'more-revealer chip style hook present')
})

test('client bundle: a chip click edits the active list text through the draft path', () => {
  // The click handler routes through applyChipToList and the tab-specific
  // setter; the compiled bundle keeps both call sites.
  assert.ok(client.includes('applyChipToList'), 'applyChipToList bundled')
  assert.ok(client.includes('setCurrentListText'), 'chip click writes back into the list draft')
})
