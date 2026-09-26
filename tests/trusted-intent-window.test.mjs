/**
 * dsh-auto-approval-llm · the authorization-evidence window must be honest
 * about what it dropped.
 *
 * The 4-message budget silently discards older user messages, so after a long
 * task a classifier denial reads "no authorization at all" even though the
 * user did authorize earlier — the evidence exists, it just fell outside the
 * window. `trustedIntentWindow` exposes what was dropped, the classifier deny
 * reason states it, and the trusted-intents observation event carries a
 * quantized `overflowed` flag (an exact monotonic count in the dedup signature
 * would append one audit row per user message).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { trustedIntentWindow, trustedUserIntents, withWindowOverflowNote } from '../lib/index.js'
import { formatAuditLine } from '../scripts/audit-query.mjs'

const userEvent = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const inboxUserMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const authorityWith = (events, inbox = { nextStep: [], nextTurn: [] }) => ({ session: { snapshotEvents: () => events }, inbox })

test('trustedIntentWindow: user messages beyond the 4-slot window are counted as overflow', () => {
  const events = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(userEvent)
  const w = trustedIntentWindow(authorityWith(events))
  assert.equal(w.admitted.length, 4, 'the window still admits exactly four')
  assert.deepEqual(w.admitted.map((t) => t.text), ['m3', 'm4', 'm5', 'm6'], 'the newest four win, oldest-first')
  assert.equal(w.overflow, 2, 'both dropped messages are reported')
})

test('trustedIntentWindow: after the window is full a duplicate is deduped, a unique text is overflow', () => {
  const events = [
    userEvent('m1'),
    userEvent('m2'),
    userEvent('m3'),
    userEvent('m4'),
    userEvent('m4'),
    userEvent('m5'),
  ]
  const w = trustedIntentWindow(authorityWith(events))
  assert.equal(w.admitted.length, 4)
  assert.deepEqual(w.admitted.map((t) => t.text), ['m2', 'm3', 'm4', 'm5'])
  assert.equal(w.overflow, 1, 'the repeated admitted text is no loss; the unique extra one is')
})

test('trustedIntentWindow: inbox steered prompts join the window first and can push events out', () => {
  const events = ['a', 'b', 'c', 'd'].map(userEvent)
  const authority = authorityWith(events, { nextStep: [[inboxUserMsg('steered 1')], [inboxUserMsg('steered 2')]], nextTurn: [] })
  const w = trustedIntentWindow(authority)
  assert.equal(w.admitted.length, 4)
  assert.deepEqual(w.admitted.map((t) => t.text), ['c', 'd', 'steered 1', 'steered 2'])
  assert.equal(w.overflow, 2, 'the two oldest events were displaced by the inbox prompts')
  assert.deepEqual(trustedUserIntents(authority), w.admitted, 'trustedUserIntents is exactly the admitted set')
})

test('trustedIntentWindow: user messages are sanitized to a per-text cap before the budget', () => {
  const events = [userEvent('x'.repeat(5000)), userEvent('small 1'), userEvent('small 2')]
  const w = trustedIntentWindow(authorityWith(events))
  assert.deepEqual(w.admitted.map((t) => t.text), ['x'.repeat(1000), 'small 1', 'small 2'], 'an oversized message is truncated and still fits the budget')
  assert.equal(w.overflow, 0)
})

const qaCallEvent = (callId, questions) => ({ type: 'tool/call', data: { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) } })
const qaResultEvent = (callId, answers) => ({
  type: 'tool/result',
  data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ answers }) }], isError: false }] } },
})

test('trustedIntentWindow: a rendered question answer too large for the budget is refused and counted', () => {
  const events = [
    qaCallEvent('q1', [{ id: 'a', question: 'q'.repeat(5000) }]),
    qaResultEvent('q1', [{ id: 'a', selected: ['ok'] }]),
  ]
  const w = trustedIntentWindow(authorityWith(events))
  assert.equal(w.admitted.length, 0)
  assert.equal(w.overflow, 1, 'the oversized rendered answer is refused by the budget, not silently kept')
})

test('trustedIntentWindow: the same text refused twice counts twice; undefined authority stays empty', () => {
  const events = ['gone', 'gone', 'm1', 'm2', 'm3', 'm4'].map(userEvent)
  const w = trustedIntentWindow(authorityWith(events))
  assert.equal(w.admitted.length, 4)
  assert.equal(w.overflow, 2, 'each refused candidate is one overflow unit, dedup only covers admitted texts')
  assert.deepEqual(trustedIntentWindow(undefined), { admitted: [], overflow: 0 })
})

test('withWindowOverflowNote: no overflow leaves the reason byte-identical', () => {
  const base = '[dsh-auto-approval-llm] classifier deny not authorized by any trusted user message'
  assert.equal(withWindowOverflowNote(base, 0), base)
  assert.equal(withWindowOverflowNote(base, -2), base)
  assert.equal(withWindowOverflowNote(base, Number.NaN), base)
  assert.equal(withWindowOverflowNote(base, Number.POSITIVE_INFINITY), base)
})

test('withWindowOverflowNote: overflow names the count and that the evidence is not treated as authorization', () => {
  const base = '[dsh-auto-approval-llm] classifier deny not authorized'
  const out = withWindowOverflowNote(base, 3)
  assert.ok(out.startsWith(`${base} (`), 'the note is appended after an explicit separator')
  assert.ok(out.includes('3 earlier user message'), 'the count is stated')
  assert.ok(out.includes('outside the 4-message evidence window'), 'the window boundary is named')
  assert.ok(out.includes('not treated as authorization'), 'the evidence status is stated, never implied')
  assert.ok(out.includes('restate the authorization'), 'the way out is the user, same direction as the deny guidance')
  const note = out.slice(base.length)
  assert.ok(!/undefined|\bretry\b|\bapprov/i.test(note), 'the note itself carries no dangling values, no retry or approval wording')
})

const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const trustedIntentSrc = readFileSync(new URL('../src/auto/trusted-intent.ts', import.meta.url), 'utf8')

test('the classifier deny reason carries the window note at the fast-path deny site', () => {
  const preAt = host.indexOf("anyCtx.on('tools/pre-execute'")
  const endAt = host.indexOf("anyCtx.on('tools/result'", preAt)
  assert.ok(preAt !== -1 && endAt > preAt, 'the pre-execute handler must be locatable')
  const pre = host.slice(preAt, endAt)
  const denyAt = pre.indexOf('withWindowOverflowNote(`[dsh-auto-approval-llm] classifier deny ${decision.reason}`')
  assert.ok(denyAt !== -1, 'the deny reason is wrapped by the window note')
  assert.ok(pre.includes(', intentWindow.overflow)'), 'the deny site passes the exact dropped-candidate count')
  assert.ok(pre.indexOf("ev: 'classifier-decision'") < denyAt, 'the decision is settled before the reason is shaped')
  // The same wiring must survive compilation: the built host lib keeps the
  // wrapped template inside its pre-execute handler (tsdown never sees this
  // file, but the tsc output is what the running process loads).
  const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const builtPreAt = built.indexOf("anyCtx.on('tools/pre-execute'")
  const builtEndAt = built.indexOf("anyCtx.on('tools/result'", builtPreAt)
  assert.ok(builtPreAt !== -1 && builtEndAt > builtPreAt, 'the compiled pre-execute handler must be locatable')
  assert.ok(built.slice(builtPreAt, builtEndAt).includes('withWindowOverflowNote(`[dsh-auto-approval-llm] classifier deny ${decision.reason}`'), 'the compiled deny site wraps the reason with the window note')
})

test('the trusted-intents event carries a quantized overflow flag, not a per-message counter', () => {
  // The reporter lives in src/auto/trusted-intent.ts; its call site stays at
  // the classifier boundary in the entry.
  const fnAt = trustedIntentSrc.indexOf('function reportTrustedIntentOrigins')
  assert.notEqual(fnAt, -1, 'the provenance reporter must exist')
  const fn = trustedIntentSrc.slice(fnAt, fnAt + 1600)
  assert.ok(fn.includes('overflowed,'), 'the row records the quantized flag')
  assert.ok(fn.includes("'overflow' : 'in-window'"), 'the dedup signature only flips with the quantized state')
  assert.ok(
    host.includes('reportTrustedIntentOrigins(authorityKeyFor(exec), trustedIntents, intentWindow.overflow > 0)'),
    'the classifier boundary reports the flag alongside the admitted set',
  )
})

test('audit-query renders the overflowed flag on trusted-intents rows and stays silent without it', () => {
  const line = formatAuditLine({ type: 'trusted-intents', at: 1, sessionId: 's', count: 2, origins: { 'user-message': 2 }, overflowed: true })
  assert.ok(line.startsWith('[trusted-intents] '))
  assert.ok(line.includes('overflowed=true'), 'the flag is visible to the audit reader')
  const without = formatAuditLine({ type: 'trusted-intents', at: 1, count: 2, origins: {} })
  assert.ok(!without.includes('overflowed'), 'rows without the field render exactly as before')
})
