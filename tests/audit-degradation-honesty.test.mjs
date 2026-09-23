/**
 * Degradation must be visible and honest, not silently rendered as a good state.
 * Four low-risk gaps from the same audit:
 *  - the approval panel rendered a failed history load as "0 records";
 *  - the learning-store DELETE was the one route with no error contract, so its
 *    bare non-JSON 400 was unreadable in the UI;
 *  - the settings POST accepted an ARRAY for `value`, which spreads to `{}` and
 *    silently resets every card key behind a 200;
 *  - `clearInvalidKeys` POSTs but was the one settings write button without the
 *    read-only gate.
 *
 * The settings gap changed owner. The array guard sat on this plugin's own write
 * route, and that route is retired: the card writes through the host form, so the
 * route advertises GET only and the guard has no branch left to protect. The
 * refusal now happens one step earlier, on the method gate — a write answers
 * 405 + `Allow: GET` and never reaches the settings plane. The third case asserts
 * that same invariant through the array payload it was written for, while
 * `routes.test.mjs` pins the write-contract shape and `client-row-config.test.mjs`
 * pins the card-side projection to `EDITABLE_CONFIG_KEYS`.
 * Run: node --test tests/audit-degradation-honesty.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installSettingsRoute } from '../lib/index.js'
import { carrierContext, findSpec, callSpec } from './helpers/carrier-route.mjs'

const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const client = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')
const locale = readFileSync(fileURLToPath(new URL('../src/client/locale.ts', import.meta.url)), 'utf8')

function fakeSettings(initial) {
  let value = { ...initial }
  let revision = 1
  let replaced = 0
  return {
    describe: () => [{ ns: 'auto-approval-llm', value, revision, applies: 'live' }],
    get: () => value,
    replacedCount: () => replaced,
    writable: true,
    replace: async (ns, v, rev) => {
      replaced += 1
      if (rev !== revision) throw new Error('revision conflict')
      value = v
      revision += 1
    },
  }
}

function arrayPost(items) {
  return {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ value: items, expectedRevision: 1 }) },
  }
}

test('the panel says the history failed instead of rendering zeroes', () => {
  assert.match(client, /const \[historyUnavailable, setHistoryUnavailable\] = React\.useState\(false\)/)
  assert.match(client, /if \(!data\?\.ok\) \{\s*\n\s*setHistoryUnavailable\(true\)/)
  assert.match(client, /\.catch\(\(\) => \{ if \(!disposed\) setHistoryUnavailable\(true\) \}\)/)
  assert.match(client, /historyUnavailable\s*\n?\s*\? t\('panel\.historyUnavailable'\)/)
  assert.match(client, /historyUnavailable \? t\('panel\.historyRetry'\) : t\('panel\.empty'\)/)
  for (const key of ['panel.historyUnavailable', 'panel.historyRetry']) {
    const hits = locale.match(new RegExp(`'${key}':`, 'g')) ?? []
    assert.equal(hits.length, 2, `${key} must exist in both locales`)
  }
})

test('the learning-store DELETE answers a JSON 413/400 like its siblings', () => {
  const route = host.indexOf("'dsh-auto-approval-llm: learning-store route'")
  assert.notEqual(route, -1, 'the learning-store route must be registered with its label')
  const nextRoute = host.indexOf('export function installReviewStatusRoute', route)
  const body = host.slice(route, nextRoute === -1 ? route + 4_000 : nextRoute)
  assert.match(body, /if \(method === 'DELETE'\) \{\s*\n\s*\/\/ Same error contract/, 'the branch explains the contract')
  assert.match(body, /error instanceof RangeError \? 413 : 400/, 'the error contract matches every sibling route')
  assert.match(body, /error: error instanceof Error \? error\.message : String\(error\)/, 'the failure text crosses the wire')
})

test('the settings POST refuses an array value', async () => {
  // An array spread to `{}` and reset every card key behind a 200. The write
  // route that used to guard against it is retired, so the refusal moved to the
  // method gate: no write reaches the settings plane at all, array or not.
  const settings = fakeSettings({ timeoutAction: 'reject', trustedDirs: ['C:/etc/x'] })
  const { ctx, specs } = carrierContext()
  installSettingsRoute(ctx, settings)
  const handler = findSpec([...specs.values()], 'settings')
  assert.deepEqual([...handler.methods], ['GET'], 'the settings route advertises GET only')
  const post = await callSpec(handler, arrayPost([1, 2, 3]))
  assert.equal(post.status, 405, 'an array value cannot reach a write path that no longer exists')
  assert.equal(post.headers.get('allow'), 'GET', 'the refusal names the surviving method')
  assert.equal(post.body.error, 'method-not-allowed')
  assert.equal(settings.replacedCount(), 0, 'an array body must not reach the settings plane')
  assert.deepEqual(settings.get(), { timeoutAction: 'reject', trustedDirs: ['C:/etc/x'] }, 'every card key keeps its stored value')
})

test('clearInvalidKeys is gated like every other settings write', () => {
  const button = client.indexOf("t('settings.clearInvalid')")
  assert.ok(button > 0)
  const window = client.slice(Math.max(0, button - 400), button)
  assert.match(window, /disabled: saving \|\| !snapshot\.writable/)
})
