/**
 * The online reviewer probe must never hand the STORED reviewer API key to an
 * address the caller picked. The route sits on the loopback trust plane (the
 * agent's own shell passes it) and the target host arrives in the request body,
 * so the saved key may be attached only when the probe names the endpoint that
 * key belongs to — the configured endpoint URL.
 *
 * Pins the pure target comparison and the wiring that consumes it (a guard
 * nobody consults is not a guard).
 * Run: node --test tests/audit-reviewer-probe-key-scope.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sameEndpointTarget } from '../lib/index.js'

test('the same endpoint target is recognized across cosmetic differences', () => {
  assert.equal(sameEndpointTarget('https://api.example.com/v1', 'https://api.example.com/v1'), true)
  assert.equal(sameEndpointTarget('https://api.example.com/v1/', 'https://api.example.com/v1'), true)
  assert.equal(sameEndpointTarget('https://api.example.com:443/v1', 'https://api.example.com/v1'), true)
  assert.equal(sameEndpointTarget('http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/'), true)
  assert.equal(sameEndpointTarget('  https://API.example.com/v1  ', 'https://api.example.com/v1'), true)
})

test('a different target is never the stored key target', () => {
  assert.equal(sameEndpointTarget('https://api.example.com/v1', 'https://attacker.example/v1'), false)
  assert.equal(sameEndpointTarget('https://api.example.com/v1', 'https://api.example.com/v2'), false)
  assert.equal(sameEndpointTarget('https://api.example.com/v1', 'https://api.example.com:8443/v1'), false)
  assert.equal(sameEndpointTarget('https://api.example.com/v1', 'http://api.example.com/v1'), false)
  assert.equal(sameEndpointTarget('https://api.example.com/v1', 'https://api.example.com.evil.test/v1'), false)
})

test('unparsable or empty input is a different target', () => {
  assert.equal(sameEndpointTarget('', ''), false)
  assert.equal(sameEndpointTarget('not a url', 'not a url'), false)
  assert.equal(sameEndpointTarget('https://api.example.com/v1', ''), false)
  assert.equal(sameEndpointTarget('', 'https://api.example.com/v1'), false)
})

test('the probe route gates the stored-key fallback on the target match', () => {
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.match(lib, /const storedKeyAllowed = sameEndpointTarget\(baseUrl, endpointUrlFor\(\)\)/)
  // The fallback body (credential service + shared credential file) must only
  // run behind that gate.
  assert.match(lib, /const probeApiKey = apiKey \|\| \(storedKeyAllowed \? await \(async \(\) => \{/)
  // And the configured endpoint URL must be the thing it is compared against.
  assert.match(lib, /installTestRoute\(anyCtx, llm, \(\) => config\.endpointUrl\)/)
})
