/**
 * dsh-auto-approval-llm · shared endpoint text call (llm-channel-unify batch 2).
 *
 * Contract tests over the compiled lib for callEndpointText / extractEndpointText:
 * the single implementation every raw-endpoint consumer (reviewer, classifier,
 * test probe) shares — protocol routing, SSRF/redirect fence and text
 * extraction must not drift apart across consumers. fetch is stubbed per test.
 * Run: node --test tests/endpoint-call.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { callEndpointText, extractEndpointText } from '../lib/auto/endpoint-call.js'

const originalFetch = globalThis.fetch

function stubFetch(handler) {
  globalThis.fetch = handler
  return () => { globalThis.fetch = originalFetch }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

test('callEndpointText: openai chat/completions posts system+user and returns the text', async () => {
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, 'https://api.example.com/v1/chat/completions')
    const body = JSON.parse(init.body)
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
    assert.equal(body.model, 'ep-model')
    assert.equal(body.max_tokens, 256)
    assert.equal(init.headers.Authorization, 'Bearer sk-test')
    assert.equal(init.redirect, 'error')
    return jsonResponse({ choices: [{ message: { content: 'the answer' } }] })
  })
  try {
    const result = await callEndpointText({
      baseUrl: 'https://api.example.com/v1', model: 'ep-model', protocol: 'openai',
      apiKey: 'sk-test', system: 'sys', messages: ['hello'], signal: undefined,
    })
    assert.deepEqual(result, { ok: true, text: 'the answer' })
  } finally { restore() }
})

test('callEndpointText: anthropic messages posts system field and returns joined text blocks', async () => {
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, 'https://api.example.com/messages')
    const body = JSON.parse(init.body)
    assert.equal(body.system, 'sys')
    assert.equal(init.headers['x-api-key'], 'sk-test')
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
    return jsonResponse({ content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }] })
  })
  try {
    const result = await callEndpointText({
      baseUrl: 'https://api.example.com', model: 'claude-x', protocol: 'anthropic',
      apiKey: 'sk-test', system: 'sys', messages: ['hi'],
    })
    assert.deepEqual(result, { ok: true, text: 'one two' })
  } finally { restore() }
})

test('callEndpointText: HTTP failure maps to { ok:false } with status + summary', async () => {
  const restore = stubFetch(async () => jsonResponse('rate limited', 429))
  try {
    const result = await callEndpointText({
      baseUrl: 'https://api.example.com/v1', model: 'm', protocol: 'openai', messages: ['x'],
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 429)
    assert.ok(result.message.includes('429'), 'summary carries the status')
  } finally { restore() }
})

test('callEndpointText: cleartext http off loopback is refused before any fetch', async () => {
  let called = false
  const restore = stubFetch(async () => { called = true; return jsonResponse({}) })
  try {
    await assert.rejects(
      callEndpointText({ baseUrl: 'http://evil.example/v1', model: 'm', protocol: 'openai', messages: ['x'] }),
      TypeError,
    )
    assert.equal(called, false, 'no fetch happens for a cleartext-off-loopback target')
  } finally { restore() }
})

test('callEndpointText: invalid URL is refused', async () => {
  const restore = stubFetch(async () => jsonResponse({}))
  try {
    await assert.rejects(
      callEndpointText({ baseUrl: 'not a url', model: 'm', protocol: 'openai', messages: ['x'] }),
      TypeError,
    )
  } finally { restore() }
})

test('callEndpointText: empty baseUrl is refused', async () => {
  await assert.rejects(
    callEndpointText({ baseUrl: '', model: 'm', protocol: 'openai', messages: ['x'] }),
    TypeError,
  )
})

test('callEndpointText: loopback http is allowed (mock / Ollama / LM Studio)', async () => {
  const restore = stubFetch(async (url) => {
    assert.ok(url.startsWith('http://127.0.0.1:18777/'), `loopback base honored, got ${url}`)
    return jsonResponse({ choices: [{ message: { content: 'mock ok' } }] })
  })
  try {
    const result = await callEndpointText({
      baseUrl: 'http://127.0.0.1:18777/v1', model: 'mock-model', protocol: 'openai', messages: ['ping'],
    })
    assert.deepEqual(result, { ok: true, text: 'mock ok' })
  } finally { restore() }
})

test('extractEndpointText: handles both protocol response shapes', () => {
  assert.equal(extractEndpointText('openai', { choices: [{ message: { content: 'a' } }] }), 'a')
  assert.equal(extractEndpointText('openai', { choices: [] }), '')
  assert.equal(
    extractEndpointText('anthropic', { content: [{ type: 'text', text: 'x' }, { type: 'tool_use' }] }),
    'x',
  )
  assert.equal(extractEndpointText('anthropic', { content: 'not-array' }), '')
})
