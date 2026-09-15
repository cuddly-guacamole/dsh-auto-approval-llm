// Regression: the session-panel visibility predicate must follow the renamed
// `auto-approval` session tier. Before this contract, `panelMode: 'auto'`
// compared against the literal `'auto'`, so the route's new `auto-approval`
// mode hid the panel and its countdown entry point for every plugin session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePanelVisible, PANEL_GATED_SESSION_MODES } from '../lib/client/panel-visibility.js'

test('auto panel mode shows for the new auto-approval tier', () => {
    assert.equal(computePanelVisible('auto', 'auto-approval'), true)
})

test('auto panel mode hides the raw auto label (the host route normalises legacy auto to auto-approval)', () => {
    assert.equal(computePanelVisible('auto', 'auto'), false)
})

test('auto panel mode hides for a foreign preset, upstream auto review, or an unknown session', () => {
    assert.equal(computePanelVisible('auto', 'danger-full-access'), false)
    assert.equal(computePanelVisible('auto', 'auto-review'), false)
    assert.equal(computePanelVisible('auto', undefined), false)
    assert.equal(computePanelVisible('auto', 'workspace-write'), false)
})

test('on/off modes ignore the session tier', () => {
    assert.equal(computePanelVisible('on', undefined), true)
    assert.equal(computePanelVisible('on', 'workspace-write'), true)
    assert.equal(computePanelVisible('off', 'auto-approval'), false)
})

test('the gated mode list carries exactly the new machine value and the legacy alias', () => {
    assert.deepEqual([...PANEL_GATED_SESSION_MODES], ['auto-approval'])
})
