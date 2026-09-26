/**
 * THE FENCE MUST COVER THE CONNECTION, NOT ONLY A PRE-FLIGHT RESOLUTION.
 *
 * `callEndpointText` (reviewer + classifier) and the `/test` online probe both
 * resolved the target once and then issued the request by hostname, so a FQDN
 * that answers the check with a public address and the connection with a
 * private/metadata one carried the API key across. The official
 * dsh-web-fetch-http provider closes exactly that window by serving the
 * validated address set to the connection's lookup; the endpoint transport now
 * does the same, and every raw-endpoint call site has to go through it.
 *
 * Behavioural proof of the pinning lives in tests/endpoint-call.test.mjs (the
 * `.invalid` hostname that still reaches the local server). This file pins the
 * wiring: both call sites pin, and no raw `fetch` remains on the surface.
 * Run: node --test tests/audit-endpoint-connection-pinning.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENDPOINT_RESPONSE_MAX_BYTES, createPinnedLookup } from '../lib/auto/endpoint-call.js'

const endpointCall = readFileSync(fileURLToPath(new URL('../src/auto/endpoint-call.ts', import.meta.url)), 'utf8')
// The probe route moved to the installer module, so the call-site wiring is
// read where it is written; the entry only re-exports the installers.
const host = readFileSync(fileURLToPath(new URL('../src/auto/route-installers.ts', import.meta.url)), 'utf8')
const entry = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

test('the transport pins a non-loopback hostname to the validated address set', () => {
  assert.match(endpointCall, /if \(isIP\(host\.replace\(\/\^\\\[|\\\]\$\/g, ''\)\) === 0\) lookup = createPinnedLookup\(resolved\.addresses\)/)
  assert.match(endpointCall, /lookup: init\.lookup as any/)
  assert.match(endpointCall, /const send = target\.protocol === 'https:' \? httpsRequest : httpRequest/)
})

test('no raw fetch remains on the raw-endpoint surface', () => {
  assert.doesNotMatch(endpointCall, /\bfetch\(/, 'the endpoint transport must not fall back to global fetch')
  // Both halves of the raw-endpoint surface: the probe route (installer
  // module) and whatever the entry still reaches endpoints with.
  assert.doesNotMatch(host, /\bfetch\(/, 'the probe route must reach endpoints only through the shared transport')
  assert.doesNotMatch(entry, /\bfetch\(/, 'the entry must reach endpoints only through the shared transport')
})

test('the response body is bounded before it is buffered', () => {
  assert.ok(ENDPOINT_RESPONSE_MAX_BYTES > 20_000 && ENDPOINT_RESPONSE_MAX_BYTES <= 1_048_576)
  assert.match(endpointCall, /size > maxBytes/)
  assert.match(endpointCall, /tooLarge: true/)
})

test('the probe route shares the transport and pins the validated set', () => {
  const probe = host.indexOf('reviewerProbeTargetAllowed(probeUrl)')
  assert.ok(probe > 0)
  const window = host.slice(probe, probe + 2_600)
  assert.match(window, /probeLookup = createPinnedLookup\(resolved\.addresses\)/, 'the probe pins the validated set')
  assert.match(window, /requestEndpointText\(new URL\(`\$\{baseUrl\}\$\{probePath\}`\)/, 'the probe uses the shared transport')
  assert.match(window, /probe\.status < 200 \|\| probe\.status >= 300/, 'a 3xx is reported as a failure, never followed')
})

test('the pinned lookup never consults DNS', () => {
  const lookup = createPinnedLookup([{ address: '203.0.113.9', family: 4 }])
  const answers = []
  lookup('rebind.example', { family: 0 }, (...args) => answers.push(args))
  assert.deepEqual(answers, [[null, '203.0.113.9', 4]])
})
