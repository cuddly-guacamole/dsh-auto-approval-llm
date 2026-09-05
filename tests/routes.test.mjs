/**
 * dsh-auto-approval-llm · route-handler contract tests (M5).
 *
 * Drive the registered web handlers directly with fake req/res, covering the
 * routes that previously had no handler-level coverage: settings (GET shape,
 * POST validation + host-only preservation), history (GET/DELETE + auth
 * fence) and review-status (never 404; {ok:false} contract).
 *
 * Feedback-route handler tests live in contract.test.mjs (loopback privileged
 * plane). Run: node --test tests/routes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  installHistoryRoute, installReviewStatusRoute, installSessionModeRoute, installSettingsRoute,
} from '../lib/index.js'

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

function handlerOf(registrations, pathPart) {
  const spec = registrations.find((r) => r.path.includes(pathPart))
  assert.ok(spec, `no route matching ${pathPart}`)
  return spec.handler
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

// ── settings route ────────────────────────────────────────────────────────

function fakeSettings(initial) {
  let value = { ...initial }
  let revision = 1
  return {
    describe: () => [{ ns: 'auto-approval-llm', value, revision, applies: 'live' }],
    get: () => value,
    writable: true,
    replace: async (ns, v, rev) => {
      if (rev !== revision) throw new Error('revision conflict')
      value = v
      revision += 1
    },
  }
}

function settingsReq(over = {}) {
  return { ...LOOPBACK, ...over }
}

test('settings GET: loopback returns the describe shape; foreign Host is 403', async () => {
  const settings = fakeSettings({ timeoutAction: 'reject', rejectGuidance: true })
  const { registrations: regs } = capture(installSettingsRoute, settings)
  const handler = handlerOf(regs, 'settings')
  const ok = await callJson(handler, settingsReq())
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.value.value.rejectGuidance, true)
  assert.equal(ok.body.value.revision, 1)
  const denied = await callJson(handler, settingsReq({ headers: { host: 'evil.example:3080' }, socket: { remoteAddress: '192.168.1.9' } }))
  assert.equal(denied.status, 403)
  assert.equal(denied.body.ok, false)
})

test('settings POST: requires expectedRevision, preserves host-only keys', async () => {
  const settings = fakeSettings({ timeoutAction: 'reject', trustedDirs: ['C:/etc/x'] })
  const { registrations: regs } = capture(installSettingsRoute, settings)
  const handler = handlerOf(regs, 'settings')
  const missing = await callJson(handler, {
    ...settingsReq({ method: 'POST' }),
    body: null,
  })
  assert.equal(missing.body.ok, false, 'POST without a value object fails')
  const noRev = await callJson(handler, {
    ...settingsReq({ method: 'POST' }),
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ value: { timeoutAction: 'reject', trustedDirs: [] } }) },
  })
  assert.equal(noRev.status, 400, 'expectedRevision is mandatory')
  const good = await callJson(handler, {
    ...settingsReq({ method: 'POST' }),
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield JSON.stringify({ value: { timeoutAction: 'allow', trustedDirs: [] }, expectedRevision: 1 })
    },
  })
  assert.equal(good.status, 200)
  assert.equal(good.body.value.value.timeoutAction, 'allow')
  assert.deepEqual(good.body.value.value.trustedDirs, ['C:/etc/x'], 'host-only key survives the save')
  assert.equal(good.body.ok, true)
})

// ── history route ─────────────────────────────────────────────────────────

test('history GET: loopback 200 with records + llmLatency; foreign Host 403', async () => {
  const { registrations: regs } = capture(installHistoryRoute)
  const handler = handlerOf(regs, 'history')
  const ok = await callJson(handler, LOOPBACK)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.ok(Array.isArray(ok.body.value.records))
  assert.ok('llmLatency' in ok.body.value)
  const denied = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example:3080' }, socket: { remoteAddress: '10.0.0.7' } })
  assert.equal(denied.status, 403)
})

test('history registers exactly one route; the models and export routes stay deleted', () => {
  const { registrations: regs } = capture(installHistoryRoute)
  assert.equal(regs.length, 1, 'the history installer registers a single route')
  assert.ok(!regs.some((r) => r.path.includes('export')), 'no history/export download route')
  // The retired /models and /history/export routes had no consumers anywhere
  // (client, tests, scripts); their path constants must not resurface.
  const compiled = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.ok(!compiled.includes('auto-approval-llm/models'), 'the retired models route is gone')
  assert.ok(!compiled.includes('auto-approval-llm/history/export'), 'the retired history export route is gone')
})

test('review-status GET: never 404 — unknown callId returns ok:false at 200', async () => {
  const { registrations: regs } = capture(installReviewStatusRoute)
  const handler = handlerOf(regs, 'review')
  const res = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080', 'x-auto-approval-call-id': 'call-does-not-exist' },
  })
  assert.equal(res.status, 200, 'the route always answers 200')
  assert.equal(res.body.ok, false, 'an unknown call reads as {ok:false}')
  assert.equal(res.body.error, 'not-found')
  const denied = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example' }, socket: { remoteAddress: '192.168.1.9' } })
  assert.equal(denied.status, 403)
})

// ── session-mode route ────────────────────────────────────────────────────

function sessionModeHarness() {
  const registrations = []
  const agent = { session: { id: 'sess-1' } }
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return { register: (desc) => registrations.push(desc) }
      if (name === 'agents') return { get: (sid) => (sid === 'sess-1' ? agent : undefined) }
      if (name === 'permissionPresets') return { current: () => 'auto' }
      return undefined
    },
    effect: (fn) => fn(),
  }
  installSessionModeRoute(ctx)
  return handlerOf(registrations, 'session-mode')
}

test('session-mode GET: session id arrives in a request header; the query form is dead', async () => {
  const handler = sessionModeHarness()
  const ok = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080', 'x-auto-approval-session-id': 'sess-1' },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.value.mode, 'auto')
  // Legacy query transport must not be honored: the header discipline is the
  // same as the review-status call-id (2026-09-03 audit).
  const legacy = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080' },
    url: '/_dsh/auto-approval-llm/session-mode?sessionId=sess-1',
  })
  assert.equal(legacy.status, 400, 'a query-only call must fail: sessionId is required')
  const missing = await callJson(handler, LOOPBACK)
  assert.equal(missing.status, 400)
  const foreign = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example:3080' }, socket: { remoteAddress: '10.0.0.7' } })
  assert.equal(foreign.status, 403)
})