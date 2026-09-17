/**
 * Tool-stats route contract tests (M5, mirrors routes.test.mjs discipline).
 *
 * Drives the registered web handler with fake req/res, covering the auth
 * fence (loopback 200 / forged Host 403) and the GET content ({ok:true, value:
 * {stats:{allow,deny,human,humanDenied}}} — asserted as the aggregate of the
 * in-memory history window, not merely as a shape).
 * Run: node --test tests/tool-stats-route.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateToolStats } from '../lib/auto/tool-stats.js'
import { installHistoryRoute, installToolStatsRoute } from '../lib/index.js'
import { carrierContext, findSpec, callSpec } from './helpers/carrier-route.mjs'

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }
const BUCKETS = ['allow', 'deny', 'human']

function capture(installer, ...args) {
  const { ctx, specs } = carrierContext()
  installer(ctx, ...args)
  const registrations = [...specs.values()]
  assert.ok(registrations.length >= 1, 'at least one registration')
  return { registrations }
}

async function callJson(spec, req) {
  const res = await callSpec(spec, req)
  return { status: res.status, body: res.text ? res.body : null }
}

test('tool-stats route: GET from loopback returns aggregated stats', async () => {
  const { registrations } = capture(installToolStatsRoute)
  const spec = findSpec(registrations, 'tool-stats')
  const { status, body } = await callJson(spec, LOOPBACK)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.value?.stats, 'stats object present')
  assert.deepEqual(Object.keys(body.value.stats).sort(), ['allow', 'deny', 'human', 'humanDenied'], 'the payload carries the four aggregate buckets')
  for (const tab of BUCKETS) {
    assert.ok(Array.isArray(body.value.stats[tab]), `${tab} bucket is an array`)
    for (const entry of body.value.stats[tab]) {
      assert.equal(typeof entry.name, 'string', `${tab} bucket entries name the tool`)
      assert.ok(Number.isInteger(entry.count) && entry.count > 0, `${tab} bucket entries carry a counted tally`)
    }
  }
  // "aggregated" is a claim about content, so assert the content: the chips
  // buckets are the counts over the in-memory history window, and the history
  // route serves that same window. Recomputing the aggregate over it is an
  // exact expectation for whatever the window currently holds — a stub that
  // returns a fixed shape fails it as soon as one adjudicated record is in the
  // window, and an inverted/miscounted bucket fails it always.
  const window = await historyWindow()
  assert.deepEqual(body.value.stats, aggregateToolStats(window), 'the buckets are the aggregation of the history window the route folds')
})

/** The very records the tool-stats route aggregates (same module instance). */
async function historyWindow() {
  const { registrations } = capture(installHistoryRoute)
  const spec = findSpec(registrations, 'history')
  const { status, body } = await callJson(spec, LOOPBACK)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.value.records), 'the history window is readable as records')
  return body.value.records
}

test('tool-stats route: forged non-loopback Host is denied', async () => {
  const { registrations } = capture(installToolStatsRoute)
  const spec = findSpec(registrations, 'tool-stats')
  const { status, body } = await callJson(spec, {
    method: 'GET',
    headers: { host: 'evil.example:3080' },
    socket: { remoteAddress: '192.168.1.9' },
  })
  assert.equal(status, 403)
  assert.equal(body.ok, false)
})

test('tool-stats route: non-GET answers 405', async () => {
  const { registrations } = capture(installToolStatsRoute)
  const spec = findSpec(registrations, 'tool-stats')
  const { status } = await callJson(spec, { ...LOOPBACK, method: 'POST' })
  assert.equal(status, 405)
})
