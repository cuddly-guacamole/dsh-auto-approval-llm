/**
 * The dsa_request_user channel may only serve targets the ordinary pipeline
 * would leave to it. A target the static policy grades HIGH, denies through an
 * explicit directive, or locks by category must be refused — the granted
 * approval of this channel also records a confirmation for the TARGET
 * signature, so letting a denied or locked target through would train the
 * learning layer on an operation the policy refuses.
 *
 * Pins both halves of the gate: the pure predicate, and the wiring that must
 * read the locked-category verdict (a predicate nobody calls is not a gate).
 * Run: node --test tests/audit-direct-human-target-gate.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { directHumanTargetRefusal } from '../lib/index.js'

test('LOW and MEDIUM targets without a deny directive may use the channel', () => {
  assert.equal(directHumanTargetRefusal({ risk: 'LOW', directive: 'inherit' }), undefined)
  assert.equal(directHumanTargetRefusal({ risk: 'MEDIUM', directive: 'inherit' }), undefined)
  assert.equal(directHumanTargetRefusal({ risk: 'LOW', directive: 'ask' }), undefined)
  assert.equal(directHumanTargetRefusal({ risk: 'LOW', directive: undefined }), undefined)
})

test('HIGH / DENY tier, DENY directive and locked categories are refused', () => {
  assert.match(directHumanTargetRefusal({ risk: 'HIGH', directive: 'inherit' }) ?? '', /HIGH/)
  assert.match(directHumanTargetRefusal({ risk: 'DENY', directive: 'inherit' }) ?? '', /DENY/)
  assert.ok(directHumanTargetRefusal({ risk: undefined, directive: 'inherit' }))
  // The case the tier-only gate let through: an explicit operator denial on a
  // low-tier target carries the verdict in the directive, not the tier.
  assert.match(directHumanTargetRefusal({ risk: 'LOW', directive: 'deny' }) ?? '', /denies/)
  assert.match(directHumanTargetRefusal({ risk: 'MEDIUM', directive: 'deny' }) ?? '', /denies/)
  // A locked target (delete/protected/privilege/disk) is refused whatever its
  // tier says.
  assert.match(directHumanTargetRefusal({ risk: 'LOW', directive: 'inherit', lockedCategory: true }) ?? '', /locked/)
  assert.match(directHumanTargetRefusal({ risk: 'MEDIUM', directive: 'inherit', lockedCategory: true }) ?? '', /locked/)
})

test('the answerer wiring reads the directive and the locked-category verdict', () => {
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  // Trigger condition itself is pinned: the gate must be evaluated on the
  // target's own classification, with the locked predicate fed by the same
  // structured flags the answerer uses.
  assert.match(lib, /const targetLocked = isLockedCategory\(/)
  assert.match(lib, /targetClassified\.assessment\?\.sessionArtifactDeletion === true/)
  assert.match(lib, /targetClassified\.assessment\?\.credentialRead === true/)
  assert.match(lib, /const refusal = directHumanTargetRefusal\(\{/)
  assert.match(lib, /targetClassified\.directive/)
})
