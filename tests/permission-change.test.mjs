/**
 * dsh-auto-approval-llm · permission-plane changes leave a durable trail.
 *
 * The host already watched `permission/preset` and `approval/policy` to force
 * an Auto session back to `ask`, but that reaction left only a debug-gated log
 * line: a person switching the session to a `never` policy — which takes this
 * plugin out of the decision path entirely, because the official pipeline
 * settles before the approval waterfall — produced no durable record at all.
 * The observation now writes one audit line per real move, with pointers to the
 * most recent rejections.
 *
 * Two shapes must never be reported as a user switch, and they are what these
 * contracts are mostly about: the creation pin (all three planes are appended
 * once on a fresh session, including `approval/policy: never` whenever the
 * default preset is full access) and this plugin's own `never -> ask`
 * counter-move. Both are absorbed by the per-plane baseline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  RECENT_REJECTION_CAP,
  baselineFromPermissionState,
  observePermissionChange,
  permissionChangeFromEvent,
  recentRejectionPointers,
} from '../lib/auto/permission-change.js'

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const HOST = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('permissionChangeFromEvent: the three permission planes are read', () => {
  assert.deepEqual(permissionChangeFromEvent({ type: 'permission/preset', data: { preset: 'auto' } }), {
    scope: 'preset',
    to: 'auto',
  })
  assert.deepEqual(permissionChangeFromEvent({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }), {
    scope: 'sandbox',
    to: 'danger-full-access',
  })
  assert.deepEqual(permissionChangeFromEvent({ type: 'approval/policy', data: { policy: 'never' } }), {
    scope: 'policy',
    to: 'never',
  })
  // Switching back to ask is a move too: it is the plugin's own counter-move
  // when it runs, and a person can make it by hand.
  assert.deepEqual(permissionChangeFromEvent({ type: 'approval/policy', data: { policy: 'ask' } }), {
    scope: 'policy',
    to: 'ask',
  })
})

test('permissionChangeFromEvent: malformed or unrelated events never produce a change', () => {
  for (const event of [
    undefined,
    null,
    'permission/preset',
    {},
    { type: 'permission/preset' },
    { type: 'permission/preset', data: null },
    { type: 'permission/preset', data: {} },
    { type: 'permission/preset', data: { preset: 42 } },
    { type: 'permission/preset', data: { preset: '' } },
    { type: 'user/message', data: { text: 'permission/preset' } },
    { type: 'tools/result', data: { mode: 'danger-full-access' } },
  ]) {
    assert.equal(permissionChangeFromEvent(event), undefined, JSON.stringify(event))
  }
  // A neighbouring event carrying the right field name must not be mistaken for
  // a permission change: only the three host event types count.
  assert.equal(permissionChangeFromEvent({ type: 'session/config', data: { policy: 'never' } }), undefined)
})

test('baselineFromPermissionState: folds the host view, ignores junk', () => {
  assert.deepEqual(
    baselineFromPermissionState({ preset: 'auto', sandbox: 'danger-full-access', approval: 'never', seeded: true }),
    { preset: 'auto', sandbox: 'danger-full-access', policy: 'never' },
  )
  assert.deepEqual(baselineFromPermissionState({ preset: 'auto' }), { preset: 'auto' })
  assert.deepEqual(baselineFromPermissionState(undefined), {})
  assert.deepEqual(baselineFromPermissionState(null), {})
  assert.deepEqual(baselineFromPermissionState({ preset: 7, approval: null }), {})
})

test('observePermissionChange: the first value per plane is a baseline, never a record', () => {
  // Creation pin: preset then sandbox then policy, all first sightings.
  let state
  let step = observePermissionChange(state, { scope: 'preset', to: 'danger-full-access' })
  assert.equal(step.record, false)
  state = step.baseline
  step = observePermissionChange(state, { scope: 'sandbox', to: 'danger-full-access' })
  assert.equal(step.record, false)
  state = step.baseline
  step = observePermissionChange(state, { scope: 'policy', to: 'never' })
  assert.equal(step.record, false, 'the pinned never policy is a seed, not a user switch')
  state = step.baseline
  assert.deepEqual(state, { preset: 'danger-full-access', sandbox: 'danger-full-access', policy: 'never' })
  // A repeat of the same value (the host only appends on a real move, but a
  // restored session can replay) is still not a record.
  assert.equal(observePermissionChange(state, { scope: 'policy', to: 'never' }).record, false)
})

test('observePermissionChange: a real move is recorded, per plane, independently', () => {
  const baseline = { preset: 'auto', sandbox: 'workspace-write', policy: 'ask' }
  const flip = observePermissionChange(baseline, { scope: 'policy', to: 'never' })
  assert.equal(flip.record, true)
  assert.deepEqual(flip.baseline, { preset: 'auto', sandbox: 'workspace-write', policy: 'never' })
  // Only the plane that moved changes in the baseline.
  assert.equal(observePermissionChange(baseline, { scope: 'sandbox', to: 'danger-full-access' }).record, true)
  assert.deepEqual(
    observePermissionChange(baseline, { scope: 'preset', to: 'auto' }).baseline,
    baseline,
    'a preset re-announcement leaves the baseline untouched',
  )
  // A restored session whose baseline came from the host is covered the same
  // way: the first observed move still differs from what was on file.
  const restored = baselineFromPermissionState({ preset: 'auto', sandbox: 'danger-full-access', approval: 'never' })
  assert.equal(observePermissionChange(restored, { scope: 'policy', to: 'ask' }).record, true)
})

test('observePermissionChange: the plugin counter-move updates the baseline silently', () => {
  const baseline = { preset: 'auto', sandbox: 'workspace-write', policy: 'never' }
  const step = observePermissionChange(baseline, { scope: 'policy', to: 'ask' }, { pluginInitiated: true })
  assert.equal(step.record, false, 'the plugin writes its own record')
  assert.deepEqual(step.baseline, { preset: 'auto', sandbox: 'workspace-write', policy: 'ask' })
  // And the following observation of the same value is not a user switch.
  assert.equal(observePermissionChange(step.baseline, { scope: 'policy', to: 'ask' }).record, false)
})

test('recentRejectionPointers: newest first, rejected only, capped, ids only', () => {
  const records = [
    { id: 'a', outcome: 'allowed-once' },
    { id: 'b', outcome: 'rejected' },
    { id: 'c', outcome: 'allowed-once' },
    { id: 'd', outcome: 'rejected' },
    { id: 'e', outcome: 'rejected' },
    { outcome: 'rejected' },
    { id: '', outcome: 'rejected' },
    null,
  ]
  assert.deepEqual(recentRejectionPointers(records, 2), ['e', 'd'])
  assert.deepEqual(recentRejectionPointers(records, 5), ['e', 'd', 'b'])
  assert.deepEqual(recentRejectionPointers([], 5), [])
  assert.deepEqual(recentRejectionPointers(records, 0), [])
  assert.equal(RECENT_REJECTION_CAP, 5)
})

test('host wiring: the record is gated on the baseline, audited, and carries its payload', () => {
  for (const [label, source] of [
    ['src/index.ts', SRC],
    ['lib/index.js', HOST],
  ]) {
    // Region anchors instead of fixed character windows around a literal: the
    // statements may move, their presence in the handler may not.
    const handlerAt = source.lastIndexOf("'session/event'")
    assert.ok(handlerAt > 0, `${label}: the session/event handler is wired`)
    const handler = source.slice(handlerAt, handlerAt + 2000)
    for (const needle of [
      'permissionChangeFromEvent(',
      'observePermissionChange(',
      'permissionBaselines.set(',
      "type: 'permission-change'",
      'recentRejectedIds',
      'scope: change.scope',
      'to: change.to',
      "actor: 'user'",
    ]) {
      assert.ok(handler.includes(needle), `${label}: the handler carries ${needle}`)
    }
    // The baseline is also folded from the host's own view, at creation and for
    // sessions that were already live when the plugin booted.
    // The baseline is also folded from the host's own view, at creation and for
    // sessions that were already live when the plugin booted.
    const baselineCallAt = source.indexOf('baselineFromPermissionState(')
    assert.ok(baselineCallAt > 0, `${label}: the host view seeds the baseline`)
    assert.ok(
      source.slice(baselineCallAt, baselineCallAt + 200).includes('permissionState?.('),
      `${label}: the baseline comes from the host service`,
    )
    assert.ok(source.includes("'session/created'"), `${label}: a new session refreshes its baseline`)
    // The plugin's own counter-move is re-checked and marked before setPolicy,
    // and cleared after, so a no-op can never be recorded (setPolicy itself
    // early-returns when the policy is unchanged).
    const flipAt = source.lastIndexOf("approval.setPolicy(flip, 'ask')")
    assert.ok(flipAt > 0, `${label}: the ensureAsk flip is wired`)
    const after = source.slice(flipAt, flipAt + 1800)
    assert.ok(after.includes('pluginFlipSessions.delete('), `${label}: the marker is cleared after setPolicy`)
    assert.ok(after.includes("actor: 'plugin'"), `${label}: the counter-move records itself`)
    assert.ok(after.includes('recentRejectedIds'), `${label}: the counter-move carries the same shape`)
    const addAt = source.lastIndexOf('pluginFlipSessions.add(', flipAt)
    assert.ok(addAt > 0 && flipAt - addAt < 700, `${label}: the flip is marked before setPolicy`)
    assert.ok(
      source.slice(Math.max(0, addAt - 400), addAt).includes('overrideOf'),
      `${label}: the policy re-check immediately precedes the marker`,
    )
    assert.ok(!source.includes('liveSessions'), `${label}: the superseded activity gate is gone`)
  }
})
