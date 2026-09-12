/**
 * dsh-auto-approval-llm · shared endpoint text call (llm-channel-unify batch 2).
 *
 * Contract tests over the compiled lib for callEndpointText / extractEndpointText:
 * the single implementation every raw-endpoint consumer (reviewer, classifier,
 * test probe) shares — protocol routing, SSRF/redirect fence and text
 * extraction must not drift apart across consumers.
 *
 * The transport is now node:http(s) (the SSRF fence must PIN the connection to
 * the validated address set, which `fetch(url)` cannot do), so these tests drive
 * a real local server instead of stubbing `globalThis.fetch`; the
 * fake-hostname case below proves the pinned lookup is what opens the socket.
 *
 * Run: node --test tests/endpoint-call.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  callEndpointText, createPinnedLookup, extractEndpointText, requestEndpointText,
} from '../lib/auto/endpoint-call.js'

/** Local endpoint: records every request and answers with the canned reply. */
async function startServer(reply) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      const answer = typeof reply === 'function' ? reply(req, body) : reply
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json', ...(answer.headers ?? {}) })
      res.end(answer.body ?? '')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const json = (payload, status = 200) => ({ status, body: JSON.stringify(payload) })

test('openai: posts system+user, carries the key, returns the text', async (t) => {
  const server = await startServer(json({ choices: [{ message: { content: 'the answer' } }] }))
  t.after(() => server.close())
  const result = await callEndpointText({
    baseUrl: `${server.base}/v1`, model: 'ep-model', protocol: 'openai',
    apiKey: 'sk-test', system: 'sys', messages: ['hello'], signal: undefined,
  })
  assert.deepEqual(result, { ok: true, text: 'the answer' })
  assert.equal(server.requests.length, 1)
  const request = server.requests[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer sk-test')
  assert.equal(request.headers['content-type'], 'application/json')
  const body = JSON.parse(request.body)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ])
  assert.equal(body.model, 'ep-model')
  assert.equal(body.max_tokens, 256)
})

test('anthropic: posts the system field and joins the text blocks', async (t) => {
  const server = await startServer(json({ content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }] }))
  t.after(() => server.close())
  const result = await callEndpointText({
    baseUrl: server.base, model: 'claude-x', protocol: 'anthropic', apiKey: 'sk-test', system: 'sys', messages: ['hi'],
  })
  assert.deepEqual(result, { ok: true, text: 'one two' })
  const request = server.requests[0]
  assert.equal(request.url, '/messages')
  assert.equal(request.headers['x-api-key'], 'sk-test')
  const body = JSON.parse(request.body)
  assert.equal(body.system, 'sys')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
})

test('reasoning effort is forwarded only when set (openai shape)', async (t) => {
  const server = await startServer(json({ choices: [{ message: { content: 'ok' } }] }))
  t.after(() => server.close())
  await callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'openai', messages: ['x'], reasoningEffort: 'low' })
  assert.equal(JSON.parse(server.requests[0].body).reasoning_effort, 'low')
  await callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'openai', messages: ['x'], reasoningEffort: '' })
  assert.equal(JSON.parse(server.requests[1].body).reasoning_effort, undefined)
})

test('HTTP failure maps to { ok:false } with status, summary and retry-after', async (t) => {
  const server = await startServer({ status: 429, headers: { 'retry-after': '7' }, body: 'rate limited' })
  t.after(() => server.close())
  const result = await callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'openai', messages: ['x'] })
  assert.equal(result.ok, false)
  assert.equal(result.status, 429)
  assert.match(result.message, /429/)
  assert.equal(result.retryAfterMs, 7_000)
})

test('a redirect is not followed (node:http keeps the 302 in-band)', async (t) => {
  const seen = []
  const server = await startServer((req) => {
    seen.push(req.url)
    return req.url === '/v1/chat/completions' && seen.length === 1
      ? { status: 302, headers: { location: 'https://evil.example/steal' }, body: '' }
      : json({ choices: [{ message: { content: 'stolen' } }] })
  })
  t.after(() => server.close())
  const result = await callEndpointText({ baseUrl: `${server.base}/v1`, model: 'm', protocol: 'openai', messages: ['x'] })
  assert.equal(result.ok, false, 'the 302 is a failure, never a followed request')
  assert.equal(result.status, 302)
  assert.equal(seen.length, 1, 'the redirect target is never contacted')
})

test('an oversized response body is dropped instead of buffered', async (t) => {
  const server = await startServer({ status: 200, body: 'x'.repeat(300_000) })
  t.after(() => server.close())
  const result = await callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'openai', messages: ['x'] })
  assert.equal(result.ok, false)
  assert.match(result.message, /exceeded/)
})

test('cleartext http off loopback is refused before any request', async () => {
  await assert.rejects(
    callEndpointText({ baseUrl: 'http://evil.example/v1', model: 'm', protocol: 'openai', messages: ['x'] }),
    TypeError,
  )
})

test('invalid URL and empty baseUrl are refused', async () => {
  await assert.rejects(callEndpointText({ baseUrl: 'not a url', model: 'm', protocol: 'openai', messages: ['x'] }), TypeError)
  await assert.rejects(callEndpointText({ baseUrl: '', model: 'm', protocol: 'openai', messages: ['x'] }), TypeError)
})

test('the pinned lookup answers with the validated address, for either callback shape', () => {
  const lookup = createPinnedLookup([{ address: '93.184.216.34', family: 4 }])
  const single = []
  lookup('attacker.example', { family: 0, hints: 0 }, (...args) => single.push(args))
  assert.deepEqual(single, [[null, '93.184.216.34', 4]], 'the queried hostname is ignored')
  const all = []
  lookup('attacker.example', { all: true, family: 4 }, (...args) => all.push(args))
  assert.deepEqual(all, [[null, [{ address: '93.184.216.34', family: 4 }]]])
})

test('the transport really uses the pinned lookup for the connection', async (t) => {
  // A hostname that does not resolve (`.invalid`) plus a pinned lookup: the
  // socket must still reach the local server, which is the whole point of the
  // fence — the connection follows the validated address, not DNS.
  const server = await startServer(json({ choices: [{ message: { content: 'pinned' } }] }))
  t.after(() => server.close())
  const target = new URL(`${server.base.replace('127.0.0.1', 'does-not-resolve.invalid')}/chat/completions`)
  const lookup = createPinnedLookup([{ address: '127.0.0.1', family: 4 }])
  const response = await requestEndpointText(target, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
    lookup,
  })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).choices[0].message.content, 'pinned')
  assert.equal(server.requests.length, 1, 'the pinned address is what got connected')
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
