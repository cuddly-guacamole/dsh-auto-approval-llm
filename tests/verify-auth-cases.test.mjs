/**
 * Contract: the runtime auth-boundary helper asserts the composed carrier
 * fence, not the plugin's inner predicate.
 *
 * On the web carrier the official connection applies its Host/Origin fence
 * (403) and browser-session check (401) before the plugin handler runs, so a
 * loopback request without a session gets 401 — the helper must expect that,
 * not the plugin's 200, or its runtime verification fails against every
 * restarted host. This test models the carrier's requestRejection order on a
 * loopback port and drives the exported runner against it.
 *
 * Run: node --test tests/verify-auth-cases.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { authCases, exchangeToken, runAuthChecks } from '../scripts/verify-auth.mjs'

/** Model the official carrier fence: Host/Origin 403 first, then session 401. */
function modelCarrier() {
  return http.createServer((req, res) => {
    const host = req.headers.host ?? ''
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    if (!loopback) { res.statusCode = 403; res.end('forbidden'); return }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.statusCode = 403; res.end('forbidden'); return }
    const origin = req.headers.origin
    if (origin !== undefined) {
      let same = false
      try { same = new URL(origin).host === host } catch { same = false }
      if (!same) { res.statusCode = 403; res.end('forbidden'); return }
    }
    if (req.headers.cookie === undefined) { res.statusCode = 401; res.end('unauthorized'); return }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
}

async function listening(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test('the unauthenticated composed fence passes on a modeled carrier', async (t) => {
  const server = modelCarrier()
  const port = await listening(server)
  t.after(() => server.close())
  const { pass, fail, results, authenticated } = await runAuthChecks({ host: '127.0.0.1', port })
  assert.equal(authenticated, false)
  assert.equal(fail, 0, JSON.stringify(results))
  assert.equal(pass, authCases({ authenticated: false }).length)
  assert.equal(results.every((r) => r.ok), true)
})

test('a session cookie flips the loopback expectation to 200', async (t) => {
  const server = modelCarrier()
  const port = await listening(server)
  t.after(() => server.close())
  const { fail, results, authenticated } = await runAuthChecks({ host: '127.0.0.1', port, cookie: 'dsh_session=test' })
  assert.equal(authenticated, true)
  assert.equal(fail, 0, JSON.stringify(results))
  const loopback = results.filter((r) => r.name.startsWith('loopback'))
  assert.equal(loopback.length, 2)
  assert.ok(loopback.every((r) => r.status === 200 && r.expect === 200))
})

test('the harness has teeth: a mismatched expectation fails', async (t) => {
  const server = modelCarrier()
  const port = await listening(server)
  t.after(() => server.close())
  const { fail } = await runAuthChecks({
    host: '127.0.0.1',
    port,
    cases: [{ name: 'loopback but session expected', path: '/review-status', headers: { host: '127.0.0.1:3080' }, expect: 200 }],
  })
  assert.equal(fail, 1)
})

test('exchangeToken captures the session cookie from the launch redirect', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/?token=')) {
      res.statusCode = 302
      res.setHeader('set-cookie', 'dsh_session=abc; Path=/; HttpOnly; SameSite=Strict')
      res.setHeader('location', '/')
      res.end()
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  const port = await listening(server)
  t.after(() => server.close())
  const session = await exchangeToken(`http://127.0.0.1:${port}/?token=test-token`)
  assert.equal(session.cookie, 'dsh_session=abc')
  assert.equal(session.authority, `127.0.0.1:${port}`)
  assert.equal(session.host, '127.0.0.1')
  assert.equal(session.port, port)
})

test('the default case table pins the carrier ordering (fence before session)', () => {
  const unauthenticated = authCases({ authenticated: false })
  assert.ok(unauthenticated.some((c) => c.expect === 401 && c.headers.host.includes('127.0.0.1')), 'loopback without a session must expect 401')
  assert.ok(unauthenticated.every((c) => c.expect === 401 || c.expect === 403), 'the unauthenticated table only carries the carrier fence codes')
  const authenticated = authCases({ authenticated: true })
  assert.ok(authenticated.some((c) => c.expect === 200), 'a session flips loopback to 200')
})
