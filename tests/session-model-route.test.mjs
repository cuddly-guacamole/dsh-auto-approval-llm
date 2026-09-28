/**
 * dsh-auto-approval-llm · the session model route reads the live request header.
 *
 * `sessionModelRoute` resolves which provider/model a session talks through.
 * It used to fall back to scanning recorded `request/header` events when the
 * live header carried no usable config. `Session.requestHeader()` is the
 * incrementally-maintained form of folding those same events, so the two
 * agreed on every session whose newest header event is well formed, and the
 * scan could only ever contribute a config from a SUPERSEDED header event.
 *
 * This file pins the residue of that removal:
 *   - the live header wins, including when a recorded event disagrees with it;
 *   - a session with no live header resolves to undefined, and the recorded
 *     `request/header` events are not consulted, so a superseded config is
 *     never reported as the current route;
 *   - `sessionEventList` still exists and is unchanged, because
 *     `findToolCallArguments` and `trusted-intent.ts` read the event log.
 *
 * Run: node --test tests/session-model-route.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionEventList, sessionModelRoute } from '../lib/auto/session-introspect.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const ROUTE_A = { provider: 'alpha', model: 'model-a' }
const ROUTE_B = { provider: 'beta', model: 'model-b' }

/** A session whose live header fold is `header`, over the given recorded events. */
function sessionWith(header, events = []) {
  return {
    requestHeader: () => header,
    snapshotEvents: () => events,
  }
}

const headerEvent = config => ({ type: 'request/header', data: { header: { config } } })

test('the live request header supplies the route', () => {
  assert.deepEqual(sessionModelRoute(sessionWith({ config: ROUTE_A })), ROUTE_A)
  assert.deepEqual(sessionModelRoute(sessionWith({ config: ROUTE_B })), ROUTE_B)
})

test('a recorded header event does not override the live header', () => {
  const session = sessionWith({ config: ROUTE_B }, [headerEvent(ROUTE_A)])
  assert.deepEqual(sessionModelRoute(session), ROUTE_B)
})

test('a session with no live header resolves to undefined', () => {
  // A fold and a scan can only be reconciled into a disagreement if a header
  // event is recorded while the live fold is absent. The host fold is built from
  // those same events, so on a real session the pair co-occur; the fixture pins
  // the resolver's answer for the combination anyway, because a reader that
  // reached for the event log here would resurrect a route the host no longer
  // reports.
  const session = sessionWith(undefined, [headerEvent(ROUTE_A)])
  assert.equal(sessionModelRoute(session), undefined)
})

test('a superseded header config is never reported as the current route', () => {
  // The live header exists but carries no usable config, while an older recorded
  // event still does. The event scan would return that older config and the
  // caller would route to a model the session is no longer using. The resolver
  // reports no route instead, which resolveTransport turns into
  // `transport: 'none'`.
  const withoutModel = { provider: 'alpha', model: '' }
  const session = sessionWith({ config: withoutModel }, [headerEvent(ROUTE_A)])
  assert.equal(sessionModelRoute(session), undefined)
})

test('a session object with no header reader resolves to undefined', () => {
  for (const session of [undefined, null, {}, { requestHeader: undefined }]) {
    assert.equal(sessionModelRoute(session), undefined)
  }
})

test('sessionEventList still reads the event log for its remaining callers', () => {
  const events = [headerEvent(ROUTE_A), { type: 'other' }]
  assert.deepEqual(sessionEventList({ snapshotEvents: () => events }), events)
  assert.deepEqual(sessionEventList({}), [])
  assert.deepEqual(sessionEventList(undefined), [])
  // A host that only exposes the live reader still needs this to stay a pure
  // snapshot read, not a header read.
  assert.deepEqual(sessionEventList(sessionWith({ config: ROUTE_A }, events)), events)
})

test('the compiled resolver contains no event scan', () => {
  // Structural anchor: the fallback is gone from the built artifact, not only
  // from the source, so a stale lib/ cannot keep serving it.
  const compiled = readFileSync(join(root, 'lib', 'auto', 'session-introspect.js'), 'utf8')
  const body = compiled.slice(compiled.indexOf('function sessionModelRoute'))
  const end = body.indexOf('\n}')
  assert.equal(body.slice(0, end).includes('snapshotEvents'), false, 'sessionModelRoute must not read the event log')
  assert.equal(body.slice(0, end).includes('request/header'), false, 'sessionModelRoute must not scan header events')
})
