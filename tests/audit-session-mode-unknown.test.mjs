/**
 * dsh-auto-approval-llm · session-mode: an unknown session is an answer, not an error.
 *
 * The route used to answer 404 `agent not found` when this process had no live
 * agent for the requested id. That state is normal — right after a restart the
 * selected session exists in history while its agent is not instantiated yet —
 * the success shape already expresses it as `mode: null`, and a sibling route
 * resolving the same session fact (`/stats`) already answers 200 there. The 404
 * only became console noise: a browser logs every failed request and no page can
 * suppress it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSessionModeRoute } from '../lib/index.js'

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }

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
  const spec = registrations.find((r) => r.path.includes('session-mode'))
  assert.ok(spec, 'session-mode route must be registered')
  return spec.handler
}

/** Harness whose preset lookup resolves nothing, for the live-agent-no-preset case. */
function noPresetHarness() {
  const registrations = []
  const agent = { session: { id: 'sess-1' } }
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return { register: (desc) => registrations.push(desc) }
      if (name === 'agents') return { get: (sid) => (sid === 'sess-1' ? agent : undefined) }
      if (name === 'permissionPresets') return { current: () => undefined }
      return undefined
    },
    effect: (fn) => fn(),
  }
  installSessionModeRoute(ctx)
  const spec = registrations.find((r) => r.path.includes('session-mode'))
  assert.ok(spec, 'session-mode route must be registered')
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

function get(sessionId) {
  const headers = { host: 'localhost:3080' }
  if (sessionId !== undefined) headers['x-auto-approval-session-id'] = sessionId
  return { ...LOOPBACK, headers }
}

test('an unknown session id is a 200 with a null mode, never a 404', async () => {
  const handler = sessionModeHarness()
  const res = await callJson(handler, get('no-such-session'))
  // The teeth: restoring the 404 branch turns this red.
  assert.equal(res.status, 200, 'an id with no live agent must not read as a client error')
  assert.equal(res.body.ok, true)
  assert.equal(res.body.value.mode, null, 'the success shape expresses "no mode known" as null')
})

test('a known session still reports its real mode (no hardcoded null)', async () => {
  const handler = sessionModeHarness()
  const res = await callJson(handler, get('sess-1'))
  assert.equal(res.status, 200)
  assert.equal(res.body.value.mode, 'auto', 'the lookup must still resolve a live agent')
})

test('a live agent with no resolvable preset already answered 200 + null', async () => {
  // This is the pre-existing shape the unknown-agent answer now reuses: the
  // success branch has always been `currentPreset(...) ?? null`, so "no mode
  // known" on a 200 is not a new concept — and the client already treated it as
  // "clear the remembered mode". Answering 200 for an unknown agent therefore
  // makes both no-mode cases behave the same way instead of inventing a third.
  const handler = noPresetHarness()
  const res = await callJson(handler, get('sess-1'))
  assert.equal(res.status, 200)
  assert.equal(res.body.value.mode, null)
})

test('genuine misuse still fails: missing header, wrong method, untrusted host', async () => {
  const handler = sessionModeHarness()
  const missing = await callJson(handler, get(undefined))
  assert.equal(missing.status, 400, 'a missing session header stays an error')
  const notGet = await callJson(handler, { ...get('sess-1'), method: 'POST' })
  assert.equal(notGet.status, 405, 'a non-GET method stays an error')
  const foreign = await callJson(handler, {
    ...get('sess-1'),
    headers: { host: 'evil.example:3080', 'x-auto-approval-session-id': 'sess-1' },
    socket: { remoteAddress: '10.0.0.7' },
  })
  assert.equal(foreign.status, 403, 'an untrusted host stays rejected')
  // The authorization fence must also hold for an id that would take the new
  // 200 branch: moving that branch above the trust check would otherwise leave
  // this green.
  const foreignUnknown = await callJson(handler, {
    ...get('no-such-session'),
    headers: { host: 'evil.example:3080', 'x-auto-approval-session-id': 'no-such-session' },
    socket: { remoteAddress: '10.0.0.7' },
  })
  assert.equal(foreignUnknown.status, 403, 'an untrusted host is rejected before the agent lookup')
})

test('a blank session header is rejected before the agent lookup', async () => {
  const handler = sessionModeHarness()
  const blank = await callJson(handler, get('   '))
  assert.equal(blank.status, 400, 'whitespace-only ids must not read as a lookup miss')
})

test('repeated lookups for many distinct unknown ids stay answers, not failures', async () => {
  const handler = sessionModeHarness()
  for (let i = 0; i < 200; i += 1) {
    const res = await callJson(handler, get(`unknown-${i}`))
    assert.equal(res.status, 200, `request ${i} must stay a 200 answer`)
    assert.equal(res.body.value.mode, null)
  }
})

test('the diagnostic note is capped, not an unbounded per-id memory', () => {
  // The status code no longer carries "no live agent for this id", so the fact
  // is kept in a debug note instead. A hostile caller could send unbounded
  // distinct ids, so the guard around the record must be a real bound. There is
  // no runtime seam for the debug switch, so this pins the compiled expression:
  // dropping the cap would leave the Set growing once per distinct id.
  const compiled = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(
    compiled,
    /unknownSessionLogged\.size < UNKNOWN_SESSION_LOG_CAP/,
    'the per-id record must stay behind its cap',
  )
  assert.match(compiled, /const UNKNOWN_SESSION_LOG_CAP = 32/)
  assert.match(
    compiled,
    /if \(!unknownSessionLogged\.has\(sessionId\) && unknownSessionLogged\.size < UNKNOWN_SESSION_LOG_CAP\) \{\s*unknownSessionLogged\.add\(sessionId\);\s*debugLog\(/,
    'the record and the note must sit inside the once-per-id cap guard',
  )
})
