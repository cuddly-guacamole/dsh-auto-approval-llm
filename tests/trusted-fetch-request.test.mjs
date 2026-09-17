/**
 * Contract: the Fetch-shaped trust predicate for the carrier-neutral route
 * plane.
 *
 * A Fetch handler has no socket; the carrier owns the transport and applies its
 * own host/Origin/auth fence before dispatch. The plugin still verifies the
 * authority the handler sees: a loopback authority (or a non-HTTP carrier-owned
 * scheme) is trusted, a non-loopback authority must match the LAN whitelist,
 * and cross-site / cross-origin requests are refused. This file carries the
 * authority-side cases the retired socket-based predicate used to pin, minus
 * the socket check the Fetch seam cannot make.
 *
 * Run: node --test tests/trusted-fetch-request.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedFetchRequest } from '../lib/auto/trust.js'

function request(url, { headers = {}, method = 'GET' } = {}) {
  return new Request(url, { method, headers })
}

test('a loopback authority is accepted', () => {
  assert.equal(isTrustedFetchRequest(request('http://localhost:3080/api/x'), []), true)
  assert.equal(isTrustedFetchRequest(request('http://127.0.0.1:3080/api/x'), []), true)
  assert.equal(isTrustedFetchRequest(request('http://[::1]:3080/api/x'), []), true)
  assert.equal(isTrustedFetchRequest(request('http://127.0.0.2:3080/api/x'), []), true, 'the whole 127/8 range is loopback')
})

test('a non-HTTP carrier scheme is a carrier-owned loopback caller', () => {
  assert.equal(isTrustedFetchRequest(request('dsh-app://app/api/x'), []), true)
})

test('a foreign network authority is refused on the privileged plane', () => {
  assert.equal(isTrustedFetchRequest(request('http://10.0.0.7:3080/api/x'), []), false)
  assert.equal(isTrustedFetchRequest(request('http://0.0.0.0:3080/api/x'), []), false)
  assert.equal(isTrustedFetchRequest(request('http://evil.example/api/x'), []), false)
})

test('a LAN authority must match the trusted-host whitelist', () => {
  assert.equal(isTrustedFetchRequest(request('http://192.168.1.50:3000/api/x'), ['192.168.1.50:3000']), true)
  assert.equal(isTrustedFetchRequest(request('http://192.168.1.50:3001/api/x'), ['192.168.1.50:3000']), false, 'a pinned port does not match another port')
  assert.equal(isTrustedFetchRequest(request('http://192.168.1.50:3001/api/x'), ['192.168.1.50']), true, 'a port-less entry matches any port')
  assert.equal(isTrustedFetchRequest(request('http://192.168.1.50/api/x'), ['192.168.1.51']), false)
})

test('the Host header is the authority; the request URL is only the fallback', () => {
  const withHost = request('http://127.0.0.1:3080/api/x', { headers: { host: '192.168.1.50:3000' } })
  assert.equal(isTrustedFetchRequest(withHost, ['192.168.1.50:3000']), true)
  assert.equal(isTrustedFetchRequest(withHost, []), false)
  assert.equal(isTrustedFetchRequest(request('http://127.0.0.1:3080/api/x'), []), true, 'no Host header falls back to the URL authority')
})

test('cross-site is refused even on a loopback authority', () => {
  assert.equal(isTrustedFetchRequest(request('http://localhost/api/x', { headers: { 'sec-fetch-site': 'cross-site' } }), []), false)
  assert.equal(isTrustedFetchRequest(request('http://localhost/api/x', { headers: { 'sec-fetch-site': 'same-site' } }), []), true)
})

test('an Origin header must match the authority host exactly', () => {
  assert.equal(isTrustedFetchRequest(request('http://localhost:3080/api/x', { headers: { origin: 'http://localhost:3080' } }), []), true)
  assert.equal(isTrustedFetchRequest(request('http://localhost:3080/api/x', { headers: { origin: 'http://localhost:9999' } }), []), false, 'same host, different port -> rejected')
  assert.equal(isTrustedFetchRequest(request('http://localhost:3080/api/x', { headers: { origin: 'http://evil.com' } }), []), false)
  assert.equal(isTrustedFetchRequest(request('http://localhost:3080/api/x', { headers: { origin: 'null' } }), []), false)
  assert.equal(isTrustedFetchRequest(request('http://localhost:3080/api/x', { headers: { origin: 'not-a-url' } }), []), false)
})

test('a bare IPv6 authority is unparseable and fails closed', () => {
  assert.equal(isTrustedFetchRequest(request('http://[::1]:3080/api/x', { headers: { host: '::1' } }), []), false)
})
