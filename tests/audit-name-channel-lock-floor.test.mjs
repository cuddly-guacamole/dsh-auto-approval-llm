/**
 * A name-based pre-authorization channel names a TOOL, never a path, so it must
 * not settle a call the policy would keep away from names: delete/disk stay
 * unreachable for such a channel, and key material is never released by naming
 * a tool — the credential-read floor holds however the caller got there.
 *
 * Pins the pure predicate and BOTH wiring points (the pre-execute allowlist
 * mirror and the answerer's static-allow path); a floor implemented in one
 * plane only is the failure this test exists for.
 * Run: node --test tests/audit-name-channel-lock-floor.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nameChannelLockRefusal } from '../lib/index.js'

test('credential material is never name-authorized', () => {
  for (const category of ['protected', 'unknown', 'readOnly', 'fileEdit', undefined]) {
    const reason = nameChannelLockRefusal({ category, credentialRead: true })
    assert.match(reason ?? '', /credential/, `credentialRead under category ${String(category)} must refuse`)
  }
})

test('delete and disk stay unreachable for a name-based channel', () => {
  assert.match(nameChannelLockRefusal({ category: 'delete' }) ?? '', /delete/)
  assert.match(nameChannelLockRefusal({ category: 'disk' }) ?? '', /disk/)
  assert.equal(nameChannelLockRefusal({ category: 'delete', sessionArtifactDeletion: true }), undefined)
})

test('ordinary categories are still name-authorized', () => {
  for (const category of ['readOnly', 'fileEdit', 'network', 'unknown', undefined]) {
    assert.equal(nameChannelLockRefusal({ category }), undefined, `${String(category)} must stay allowed`)
  }
})

test('the floor is wired in both planes (pre-execute mirror and answerer)', () => {
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const callSites = lib.match(/nameChannelLockRefusal\(\{/g) ?? []
  assert.equal(callSites.length, 2, 'both name-based channels must consult the predicate')
  assert.match(lib, /const mirrorRefusal = nameChannelLockRefusal\(\{/)
  assert.match(lib, /credentialRead: assessment\?\.credentialRead === true/)
  assert.match(lib, /credentialRead: classified\.assessment\?\.credentialRead === true/)
  // The old hard-locked-only enumeration must be gone from both gates.
  assert.doesNotMatch(lib, /HARD_LOCKED_CATEGORIES\.includes\(category as never\)/)
  assert.doesNotMatch(lib, /HARD_LOCKED_CATEGORIES\.includes\(classified\.category as never\)/)
})
