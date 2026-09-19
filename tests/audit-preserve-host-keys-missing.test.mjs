/**
 * A HOST_ONLY key absent from the stored settings must be stripped from a
 * submitted payload, not passed through.
 *
 * The protection only replaced keys already present in `current`: while the
 * settings namespace was still empty (before the first card save), a crafted
 * POST could plant `workspaceRoot` / `trustedDirs` / `dshHome` into
 * settings.yaml and repoint the roots — exactly what the owner comment says
 * must not happen. Empty-current submissions are the normal first-save state,
 * not an edge case.
 *
 * Run: node --test tests/audit-preserve-host-keys-missing.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOST_ONLY_KEYS, preserveHostKeys } from '../lib/auto/decision.js'

test('an empty stored namespace cannot gain a host-only key through POST', () => {
  const out = preserveHostKeys({}, {
    enabled: true,
    workspaceRoot: 'C:/evil',
    dshHome: 'C:/evil/.dsh',
    trustedDirs: ['C:/evil'],
    tempRoots: ['C:/evil'],
  })
  for (const key of ['workspaceRoot', 'dshHome', 'trustedDirs', 'tempRoots']) {
    assert.equal(key in out, false, `${key} must be stripped when nothing is stored`)
  }
  assert.equal(out.enabled, true, 'card keys survive untouched')
})

test('a partial stored namespace still wins per key (unchanged)', () => {
  const out = preserveHostKeys({ workspaceRoot: 'C:/ws' }, { workspaceRoot: 'C:/evil', dshHome: 'C:/evil/.dsh' })
  assert.equal(out.workspaceRoot, 'C:/ws')
  assert.equal('dshHome' in out, false)
})

test('every HOST_ONLY member is covered by the strip, not just the root keys', () => {
  const submitted = Object.fromEntries(HOST_ONLY_KEYS.map((key) => [key, 'planted']))
  const out = preserveHostKeys({}, submitted)
  for (const key of HOST_ONLY_KEYS) {
    assert.equal(key in out, false, `${key} must be stripped`)
  }
})

test('the stored-value-wins contract keeps its shape (control, unchanged)', () => {
  const out = preserveHostKeys({ workspaceRoot: 'C:/ws', trustedDirs: ['D:/t'] }, { enabled: true })
  assert.equal(out.workspaceRoot, 'C:/ws')
  assert.deepEqual(out.trustedDirs, ['D:/t'])
  assert.equal(out.enabled, true)
})
