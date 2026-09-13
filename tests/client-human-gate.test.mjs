/**
 * dsh-auto-approval-llm · the overlay's human-hand rate shares its source list
 * with the offline friction report and never claims more than its window.
 *
 * The derivation is pure and dependency-free so the tests can import the
 * compiled module directly; the bundle anchors keep the overlay wired.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { humanGateStats, HUMAN_SOURCES } from '../lib/client/human-gate.js'
import { HUMAN_SOURCES as REPORT_HUMAN_SOURCES } from '../scripts/friction-report.mjs'
import { zh, en } from '../lib/client/locale.js'

test('the human-source list is the same one the friction report uses', () => {
  assert.deepEqual([...HUMAN_SOURCES].sort(), [...REPORT_HUMAN_SOURCES].sort(), 'one shared notion of "settled by a person", not a second criterion')
})

test('humanGateStats: an empty window is vacuous, never a zero claim', () => {
  assert.deepEqual(humanGateStats([]), { total: 0, humanCount: 0, everyNth: null, empty: true })
})

test('humanGateStats: only person-settled sources count', () => {
  const records = [
    { source: 'human-allow' },
    { source: 'human-deny' },
    { source: 'llm-allow' },
    { source: 'classifier-allow' },
    { source: 'static-allow' },
    { source: 'allowlist-allow' },
    { source: 'timeout-deny' },
    { source: 'llm-blocked' },
    { source: 'llm-failed' },
    { source: 'guard' },
    { source: 'hard-deny' },
    { source: 'learned-allow' },
  ]
  const s = humanGateStats(records)
  assert.equal(s.total, 12)
  assert.equal(s.humanCount, 2, 'timers, LLM verdicts and fuses are not human hands')
  assert.equal(s.empty, false)
  assert.equal(s.everyNth, 6, '12 records with 2 human hands = one hand in every 6')
})

test('humanGateStats: rows without a usable source are counted in the total but never as human hands', () => {
  const s = humanGateStats([{ source: 'human-allow' }, {}, { source: 42 }, null, { source: undefined }])
  assert.equal(s.total, 5)
  assert.equal(s.humanCount, 1)
  assert.equal(s.everyNth, 5)
})

test('humanGateStats: rounding keeps the claim within the window', () => {
  assert.equal(humanGateStats([{ source: 'human-allow' }, {}, {}]).everyNth, 3)
  assert.equal(humanGateStats([{ source: 'human-allow' }, { source: 'human-deny' }, {}, {}, {}]).everyNth, 3, 'Math.round(2.5) rounds up')
  assert.equal(humanGateStats([{ source: 'human-deny' }]).everyNth, 1, 'a window that is all human hands claims 1-in-1')
})

test('the overlay copy exists in both languages and names the window', () => {
  for (const key of ['panel.humanGate', 'panel.humanGateNone', 'panel.humanGateEmpty']) {
    assert.equal(typeof zh[key] === 'undefined' ? 'missing' : 'string', 'string', `zh dictionary has ${key}`)
    assert.equal(typeof en[key] === 'undefined' ? 'missing' : 'string', 'string', `en dictionary has ${key}`)
  }
  assert.match(zh['panel.humanGate'], /近 \{total\} 条/, 'the zh copy states the window, not all history')
  assert.match(en['panel.humanGate'], /last \{total\} records/, 'the en copy states the window, not all history')
})

test('the overlay renders the derived line and the bundle keeps the module', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('humanGateStats('), 'the derivation is called from the overlay render path')
  assert.ok(bundle.includes('panel.humanGateEmpty') && bundle.includes('panel.humanGateNone'), 'all three overlay states are wired')
  assert.ok((bundle.match(/panel\.humanGate(?![A-Za-z])/g) ?? []).length >= 3, 'the rate key itself is wired (two dictionaries + the render call)')
})
