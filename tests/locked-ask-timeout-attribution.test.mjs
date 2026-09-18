/**
 * dsh-auto-approval-llm · a locked-category ask must not credit `timeoutAction`
 * for the rejection it never chose.
 *
 * `lockedAsk` statuses pin `action` to reject by design: neither the configured
 * timeout action nor an authorization typed in the conversation can release
 * them. The timeout copy said "auto-rejected by your setting" / "按配置自动拒绝",
 * which is a false attribution — and with `timeoutAction='allow'` it directly
 * contradicts the setting the user chose.
 *
 * The flag has to survive the whole path: ask status -> timeout notice ->
 * follow record -> host payload -> client store -> chip state -> locale copy.
 * Negative controls pin the ordinary countdown timeout on its existing copy, so
 * the fix cannot leak the lock into the configured-action wording.
 *
 * Run: node --test tests/locked-ask-timeout-attribution.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { followResolution, raceHumanDecision } from '../lib/auto/decision.js'
import { createApprovalStatusStore, chipState } from '../lib/client/approvals/status-store.js'
import { zh, en } from '../lib/client/locale.js'

const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

test('followResolution: a locked ask keeps its provenance in the follow record', () => {
  const locked = followResolution(
    'countdown',
    { risk: 'HIGH', outcome: 'rejected', lockedAsk: true },
    { timedOut: true, aborted: false },
  )
  assert.deepEqual(locked.kind === 'publish' && locked.follow, {
    risk: 'HIGH', phase: 'follow', action: 'reject', seconds: 0, source: 'timeout', lockedAsk: true,
  })
  // Negative control: an ordinary countdown timeout must not gain the flag
  // (other tests deepEqual this object and depend on its exact shape).
  const plain = followResolution('countdown', { risk: 'HIGH', outcome: 'rejected' }, { timedOut: true, aborted: false })
  assert.deepEqual(plain.kind === 'publish' && plain.follow, {
    risk: 'HIGH', phase: 'follow', action: 'reject', seconds: 0, source: 'timeout',
  })
})

test('raceHumanDecision: the locked timeout notice names the lock, not the setting', async () => {
  const recorded = []
  await raceHumanDecision(() => new Promise(() => {}), {
    status: { seconds: 1, action: 'reject', lockedAsk: true },
    callId: 'locked-1',
    recordTimeout: (id, text) => recorded.push(`${id}|${text}`),
  })
  assert.equal(recorded.length, 1)
  assert.ok(recorded[0].startsWith('locked-1|'), 'the notice must be recorded for the exact callId')
  assert.ok(recorded[0].includes('locked category'), 'the notice must name the lock')
  assert.ok(!recorded[0].includes('configured timeout action'), 'must not credit the configured action')
})

test('raceHumanDecision: an ordinary countdown keeps the configured-action notice', async () => {
  const recorded = []
  await raceHumanDecision(() => new Promise(() => {}), {
    status: { seconds: 1, action: 'reject' },
    callId: 'plain-1',
    recordTimeout: (_id, text) => recorded.push(text),
  })
  assert.ok(recorded[0].includes('by the configured timeout action'))
  assert.ok(!recorded[0].includes('locked category'))
})

test('the client store carries the lock from the countdown into the timeout chip', () => {
  const locked = createApprovalStatusStore(() => 1_000)
  locked.publishStatus('s1', 'c1', { phase: 'countdown', action: 'reject', seconds: 10, lockedAsk: true })
  locked.resolve('s1', 'c1', 'timeout', 'reject')
  assert.deepEqual(
    chipState(locked.activeFor('s1', 1_000), 1_000, false),
    { kind: 'timeout', action: 'reject', lockedAsk: true },
    'the lock must survive the countdown -> follow transition',
  )

  const plain = createApprovalStatusStore(() => 1_000)
  plain.publishStatus('s2', 'c2', { phase: 'countdown', action: 'reject', seconds: 10 })
  plain.resolve('s2', 'c2', 'timeout', 'reject')
  assert.deepEqual(
    chipState(plain.activeFor('s2', 1_000), 1_000, false),
    { kind: 'timeout', action: 'reject' },
    'an ordinary timeout must keep the flag absent, not false',
  )
})

test('a follow payload alone still carries the lock', () => {
  const store = createApprovalStatusStore(() => 1_000)
  store.publishStatus('s3', 'c3', { phase: 'follow', action: 'reject', source: 'timeout', lockedAsk: true })
  assert.deepEqual(chipState(store.activeFor('s3', 1_000), 1_000, false), {
    kind: 'timeout', action: 'reject', lockedAsk: true,
  })
})

test('askHuman threads the lock into the racer and the follow record', () => {
  // The two host-side wiring points that had to pass the structural flag on.
  assert.equal(host.split('...(status.lockedAsk === true ? { lockedAsk: true } : {})').length - 1, 2)
})

test('the locked timeout chip uses its own copy in both locales', () => {
  assert.ok(
    client.includes("state.lockedAsk === true ? t('chip.lockedTimeout')"),
    'the chip must branch on the structural flag, not on the timeoutAction',
  )
  for (const [name, table] of [['zh', zh], ['en', en]]) {
    const copy = table['chip.lockedTimeout']
    assert.equal(typeof copy, 'string', `${name} must define chip.lockedTimeout`)
    assert.ok(!/按配置|by your setting/.test(copy), `${name} copy must not credit the user's setting`)
  }
  assert.ok(zh['chip.lockedTimeout'].includes('锁定类别'), 'zh copy must name the lock')
  assert.ok(en['chip.lockedTimeout'].includes('locked category'), 'en copy must name the lock')
})
