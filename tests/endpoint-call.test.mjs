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
  callEndpointJson, callEndpointText, createPinnedLookup, endpointAuthHeader,
  endpointRequestPath, extractEndpointText, requestEndpointText,
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

test('extractEndpointText: handles both legacy protocol response shapes', () => {
  assert.equal(extractEndpointText('openai', { choices: [{ message: { content: 'a' } }] }), 'a')
  assert.equal(extractEndpointText('openai', { choices: [] }), '')
  assert.equal(
    extractEndpointText('anthropic', { content: [{ type: 'text', text: 'x' }, { type: 'tool_use' }] }),
    'x',
  )
  assert.equal(extractEndpointText('anthropic', { content: 'not-array' }), '')
})

test('responses: posts instructions+input, carries a bearer key, joins output_text blocks', async (t) => {
  const server = await startServer(json({
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'IGNORED' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'one ' }, { type: 'output_text', text: 'two' }] },
    ],
  }))
  t.after(() => server.close())
  const result = await callEndpointText({
    baseUrl: server.base, model: 'resp-model', protocol: 'responses',
    apiKey: 'sk-test', system: 'sys', messages: ['hi'], maxTokens: 512,
  })
  assert.deepEqual(result, { ok: true, text: 'one two' }, 'reasoning blocks never contribute to the answer')
  const request = server.requests[0]
  assert.equal(request.url, '/responses')
  assert.equal(request.headers.authorization, 'Bearer sk-test')
  assert.equal(request.headers['x-api-key'], undefined, 'responses uses the bearer header, not the anthropic one')
  const body = JSON.parse(request.body)
  assert.equal(body.instructions, 'sys', 'the system prompt rides the instructions field')
  assert.deepEqual(body.input, [{ role: 'user', content: 'hi' }])
  assert.equal(body.max_output_tokens, 512, 'the output budget is max_output_tokens, not max_tokens')
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.messages, undefined)
})

test('responses: reasoning effort is forwarded as reasoning:{effort}, never reasoning_effort', async (t) => {
  // The /responses route IGNORES reasoning_effort; it honours reasoning.effort.
  // Forwarding the chat-shaped field would silently drop the operator's choice.
  const server = await startServer(json({ output: [] }))
  t.after(() => server.close())
  await callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'responses', messages: ['x'], reasoningEffort: 'low' })
  const body = JSON.parse(server.requests[0].body)
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.equal(body.reasoning_effort, undefined)
  await callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'responses', messages: ['x'], reasoningEffort: '' })
  const absent = JSON.parse(server.requests[1].body)
  assert.equal(absent.reasoning, undefined, 'an empty effort sends no reasoning field at all')
})

test('responses: a body without an output array yields empty text, never a throw', async (t) => {
  const server = await startServer(json({}))
  t.after(() => server.close())
  const result = await callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'responses', messages: ['x'] })
  assert.deepEqual(result, { ok: true, text: '' })
})

test('systemone: posts state+model+questions and is NOT routed through the text exit', async (t) => {
  const server = await startServer(json({ model: 'typesafe/jev', answers: { ping: { type: 'noul', noul: 0.29 } } }))
  t.after(() => server.close())
  // callEndpointText is the TEXT exit. systemone has no text form, so it must
  // refuse rather than flatten a well-formed typed reply into ''.
  await assert.rejects(
    callEndpointText({
      baseUrl: server.base, model: 'jev-1.13-free', protocol: 'systemone',
      apiKey: 'sk-test', messages: [], systemone: { state: 'tool_call', questions: { ping: { type: 'noul' } } },
    }),
    /typed answers object/,
    'a well-formed systemone reply must not be flattened into empty text',
  )
  const request = server.requests[0]
  assert.equal(request.url, '/systemone')
  assert.equal(request.headers.authorization, 'Bearer sk-test')
  const body = JSON.parse(request.body)
  assert.equal(body.state, 'tool_call')
  assert.equal(body.model, 'jev-1.13-free')
  assert.deepEqual(body.questions, { ping: { type: 'noul' } })
  assert.equal(body.messages, undefined, 'systemone is not a conversation')
  assert.equal(body.max_tokens, undefined, 'systemone takes no token budget')
  assert.equal(body.max_output_tokens, undefined)
})

test('systemone: callEndpointJson returns the parsed answers object', async (t) => {
  const server = await startServer(json({ answers: { ping: { type: 'noul', noul: 0.29 } } }))
  t.after(() => server.close())
  const result = await callEndpointJson({
    baseUrl: server.base, model: 'm', protocol: 'systemone', messages: [],
    systemone: { state: 's', questions: { ping: { type: 'noul' } } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.json.answers.ping.noul, 0.29)
})

test('systemone: a missing question bundle is refused before any request is sent', async (t) => {
  const server = await startServer(json({ answers: {} }))
  t.after(() => server.close())
  await assert.rejects(
    callEndpointText({ baseUrl: server.base, model: 'm', protocol: 'systemone', messages: [] }),
    /needs a systemone/,
  )
  assert.equal(server.requests.length, 0, 'a misconfigured systemone call never reaches the network')
})

test('extractEndpointText: systemone is not a text protocol', () => {
  assert.throws(
    () => extractEndpointText('systemone', { answers: { q: { type: 'noul', noul: 0.1 } } }),
    /typed answers object/,
  )
})

test('endpointRequestPath / endpointAuthHeader: one vocabulary for every protocol', () => {
  assert.equal(endpointRequestPath('openai'), '/chat/completions')
  assert.equal(endpointRequestPath('anthropic'), '/messages')
  assert.equal(endpointRequestPath('responses'), '/responses')
  assert.equal(endpointRequestPath('systemone'), '/systemone')
  assert.deepEqual(endpointAuthHeader('openai', 'k'), { Authorization: 'Bearer k' })
  assert.deepEqual(endpointAuthHeader('anthropic', 'k'), { 'x-api-key': 'k' })
  assert.deepEqual(endpointAuthHeader('responses', 'k'), { Authorization: 'Bearer k' })
  assert.deepEqual(endpointAuthHeader('systemone', 'k'), { Authorization: 'Bearer k' })
})
