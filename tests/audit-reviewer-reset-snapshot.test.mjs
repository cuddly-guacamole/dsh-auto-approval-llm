/**
 * The reviewer card's reset saved the configuration and then discarded the
 * server's response, so the card kept the pre-save revision: the next save from
 * any card was rejected (optimistic concurrency) and the card reported "unsaved"
 * against a value that was no longer stored. Every other save path adopts the
 * response baseline; this one must too.
 *
 * Pins the client wiring (a UI state property, not a pure function): after
 * `broadcastSettings` in the reset path, `setSnapshot` must run before the
 * credential DELETE, and the other four save paths must keep doing it.
 * Run: node --test tests/audit-reviewer-reset-snapshot.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')

test('the reset path adopts the server snapshot before it clears the credential', () => {
  const reset = src.indexOf('const resetReviewerCard')
  assert.ok(reset > 0, 'the reset handler exists')
  const body = src.slice(reset, reset + 4_000)
  const broadcast = body.indexOf('broadcastSettings(data.value)')
  const snapshot = body.indexOf('setSnapshot(data.value)', broadcast)
  const credentialDelete = body.indexOf('REVIEWER_CREDENTIAL_ROUTE', broadcast)
  assert.ok(broadcast > 0, 'the reset path saves settings first')
  assert.ok(snapshot > broadcast, 'the response baseline must be adopted after the save')
  assert.ok(credentialDelete > snapshot, 'the snapshot must be adopted before the credential delete')
})

test('every settings save path adopts the response baseline', () => {
  const sites = src.match(/setSnapshot\(data\.value\)/g) ?? []
  assert.ok(sites.length >= 5, `expected the five save paths to adopt the baseline, found ${sites.length}`)
})
