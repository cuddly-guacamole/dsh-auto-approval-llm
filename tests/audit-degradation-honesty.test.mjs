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
 * Run: node --test tests/audit-degradation-honesty.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const client = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')
const locale = readFileSync(fileURLToPath(new URL('../src/client/locale.ts', import.meta.url)), 'utf8')

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
  const body = host.slice(Math.max(0, route - 2_600), route)
  assert.match(body, /if \(req\.method === 'DELETE'\) \{\s*\n\s*\/\/ Same error contract/, 'the branch explains the contract')
  assert.match(body, /error instanceof RangeError \? 413 : 400/, 'the error contract matches every sibling route')
  assert.match(body, /error: error instanceof Error \? error\.message : String\(error\)/, 'the failure text crosses the wire')
})

test('the settings POST refuses an array value', () => {
  assert.match(host, /typeof body\?\.value !== 'object' \|\| body\.value === null \|\| Array\.isArray\(body\.value\)/)
})

test('clearInvalidKeys is gated like every other settings write', () => {
  const button = client.indexOf("t('settings.clearInvalid')")
  assert.ok(button > 0)
  const window = client.slice(Math.max(0, button - 400), button)
  assert.match(window, /disabled: saving \|\| !snapshot\.writable/)
})
