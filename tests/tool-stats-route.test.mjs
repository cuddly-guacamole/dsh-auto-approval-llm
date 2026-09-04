/**
 * Tool-stats route contract tests (M5, mirrors routes.test.mjs discipline).
 *
 * Drives the registered web handler with fake req/res, covering the auth
 * fence (loopback 200 / forged Host 403) and the GET shape ({ok:true, value:
 * {stats:{allow,deny,human}}} aggregated from the injected history window).
 * Run: node --test tests/tool-stats-route.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installToolStatsRoute } from '../lib/index.js'

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }

function capture(installer, ...args) {
  const registrations = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (desc) => registrations.push(desc) } : undefined),
    effect: (fn) => fn(),
  }
  installer(ctx, ...args)
  assert.ok(registrations.length >= 1, 'at least one registration')
  return { registrations }
}

function fakeRes() {
  const state = { statusCode: 0, body: '' }
  const res = {
    setHeader: () => {},
    writeHead: (code) => { state.statusCode = code },
    end: (chunk) => { state.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
  }
  return { res, state }
}

async function callJson(handler, req) {
  const { res, state } = fakeRes()
  await handler(req, res)
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null }
}

test('tool-stats route: GET from loopback returns aggregated stats', async () => {
  const { registrations } = capture(installToolStatsRoute)
  const spec = registrations.find((r) => r.path.includes('tool-stats'))
  assert.ok(spec, 'tool-stats route registered')
  const { status, body } = await callJson(spec.handler, LOOPBACK)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.value?.stats, 'stats object present')
  for (const tab of ['allow', 'deny', 'human']) {
    assert.ok(Array.isArray(body.value.stats[tab]), `${tab} bucket is an array`)
  }
})

test('tool-stats route: forged non-loopback Host is denied', async () => {
  const { registrations } = capture(installToolStatsRoute)
  const spec = registrations.find((r) => r.path.includes('tool-stats'))
  const { status, body } = await callJson(spec.handler, {
    method: 'GET',
    headers: { host: 'evil.example:3080' },
    socket: { remoteAddress: '192.168.1.9' },
  })
  assert.equal(status, 403)
  assert.equal(body.ok, false)
})

test('tool-stats route: non-GET answers 405', async () => {
  const { registrations } = capture(installToolStatsRoute)
  const spec = registrations.find((r) => r.path.includes('tool-stats'))
  const { status } = await callJson(spec.handler, { ...LOOPBACK, method: 'POST' })
  assert.equal(status, 405)
})
