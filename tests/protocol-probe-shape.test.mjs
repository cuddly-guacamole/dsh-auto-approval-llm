/**
 * dsh-auto-approval-llm · the settings-card probe's protocol shape.
 *
 * There are TWO independent request-construction sites for the custom endpoint:
 * the formal channel (`postEndpoint` in endpoint-call.ts) and the settings
 * card's "test connection" probe (the `/test` route's online branch). Before
 * this file nothing pinned the probe at all — the formal channel's shape was
 * covered, the probe's was not.
 *
 * The probe only reads the STATUS, never the body, so a wrong path or a
 * wrong-shaped body shows up as a failed test connection: the one outcome an
 * operator cannot tell apart from a real outage. systemone is the sharp edge
 * (its `choice` criteria must be a record and its `score` criteria an array; a
 * chat-shaped body gets a 422 whose message reads "Endpoint is unavailable").
 *
 * This drives the real route against a LOCAL mock server and asserts what the
 * mock received. No third-party endpoint is contacted.
 *
 * Run: node --test tests/protocol-probe-shape.test.mjs (tsc + tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
// The installer lives in its own module (the entry only wires it), so the test
// drives it where it is written.
import { installTestRoute } from '../lib/auto/route-installers.js'
import { carrierContext, findSpec, callSpec } from './helpers/carrier-route.mjs'

/** A local mock endpoint: records requests, answers 200 with a minimal body. */
async function startMock() {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
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

function testRoute() {
  const { ctx, specs } = carrierContext()
  installTestRoute(ctx, {})
  return findSpec([...specs.values()], 'test')
}

const onlineProbe = (base, protocol, extra = {}) => ({
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ online: true, protocol, baseUrl: base, model: 'probe-model', ...extra }),
})

test('probe: each protocol goes to its own path', async (t) => {
  const paths = {
    openai: '/chat/completions',
    anthropic: '/messages',
    responses: '/responses',
    systemone: '/systemone',
  }
  for (const [protocol, expected] of Object.entries(paths)) {
    const mock = await startMock()
    try {
      const res = await callSpec(testRoute(), onlineProbe(mock.base, protocol))
      assert.equal(res.status, 200, `${protocol}: the probe accepts its own path`)
      assert.equal(mock.requests.length, 1, `${protocol}: exactly one probe request`)
      assert.equal(mock.requests[0].url, expected, `${protocol}: probe path`)
      assert.equal(mock.requests[0].method, 'POST')
    } finally {
      await mock.close()
    }
  }
})

test('probe: the auth header follows the protocol', async (t) => {
  const mock = await startMock()
  try {
    const spec = testRoute()
    await callSpec(spec, onlineProbe(mock.base, 'anthropic', { apiKey: 'sk-a' }))
    await callSpec(spec, onlineProbe(mock.base, 'openai', { apiKey: 'sk-o' }))
    await callSpec(spec, onlineProbe(mock.base, 'responses', { apiKey: 'sk-r' }))
    await callSpec(spec, onlineProbe(mock.base, 'systemone', { apiKey: 'sk-s' }))
    assert.equal(mock.requests[0].headers['x-api-key'], 'sk-a', 'anthropic uses x-api-key')
    assert.equal(mock.requests[0].headers.authorization, undefined)
    // The other three are bearer protocols.
    for (const [index, key] of [[1, 'sk-o'], [2, 'sk-r'], [3, 'sk-s']]) {
      assert.equal(mock.requests[index].headers.authorization, `Bearer ${key}`, `request ${index} uses bearer`)
      assert.equal(mock.requests[index].headers['x-api-key'], undefined)
    }
  } finally {
    await mock.close()
  }
})

test('probe: an unknown protocol keeps the openai fallback', async (t) => {
  const mock = await startMock()
  try {
    const res = await callSpec(testRoute(), onlineProbe(mock.base, 'no-such-protocol'))
    assert.equal(res.status, 200)
    assert.equal(mock.requests[0].url, '/chat/completions', 'a genuinely unknown value probes the historical default')
  } finally {
    await mock.close()
  }
})

test('probe: the body is the shape each protocol accepts', async (t) => {
  const mock = await startMock()
  try {
    const spec = testRoute()
    await callSpec(spec, onlineProbe(mock.base, 'openai'))
    await callSpec(spec, onlineProbe(mock.base, 'anthropic'))
    await callSpec(spec, onlineProbe(mock.base, 'responses'))
    await callSpec(spec, onlineProbe(mock.base, 'systemone'))

    const openai = JSON.parse(mock.requests[0].body)
    assert.equal(openai.model, 'probe-model')
    assert.equal(openai.max_tokens, 1)
    assert.deepEqual(openai.messages, [{ role: 'user', content: 'ping' }])

    const anthropic = JSON.parse(mock.requests[1].body)
    assert.equal(anthropic.model, 'probe-model')
    assert.equal(anthropic.max_tokens, 1)
    assert.deepEqual(anthropic.messages, [{ role: 'user', content: 'ping' }])

    // responses takes `input[]` and `max_output_tokens`; a `messages[]` +
    // `max_tokens` body is the chat shape this route does not speak.
    const responses = JSON.parse(mock.requests[2].body)
    assert.equal(responses.model, 'probe-model')
    assert.deepEqual(responses.input, [{ role: 'user', content: 'ping' }])
    assert.equal(responses.max_output_tokens, 16)
    assert.equal(responses.messages, undefined)
    assert.equal(responses.max_tokens, undefined)

    // systemone is the sharp edge: `state` + `model` + `questions{}`, and the
    // criteria containers must be the RIGHT shapes (choice=record,
    // score=array). Passing options/levels, or swapping the containers, is the
    // measured 422 that reads like an outage.
    const systemone = JSON.parse(mock.requests[3].body)
    assert.equal(systemone.model, 'probe-model')
    assert.equal(typeof systemone.state, 'string')
    assert.ok(systemone.state.length > 0)
    assert.equal(typeof systemone.questions, 'object')
    const questions = Object.values(systemone.questions)
    assert.ok(questions.length > 0, 'the probe asks at least one question')
    const choice = questions.find((q) => q.type === 'choice')
    assert.ok(choice !== undefined, 'a choice question is present')
    assert.equal(Array.isArray(choice.criteria), false, 'choice criteria must be a record')
    assert.equal(typeof choice.criteria, 'object')
    assert.ok(Object.keys(choice.criteria).length > 0)
    // A chat-shaped body must not be sent to this route at all.
    assert.equal(systemone.messages, undefined)
    assert.equal(systemone.max_tokens, undefined)
    assert.equal(systemone.max_output_tokens, undefined)
  } finally {
    await mock.close()
  }
})

test('probe: the formal channel and the probe agree on the path', async () => {
  // The two request-construction sites must not drift: both read the path from
  // the one vocabulary. A drift here is a false test-connection failure.
  const { endpointRequestPath } = await import('../lib/auto/endpoint-call.js')
  assert.equal(endpointRequestPath('openai'), '/chat/completions')
  assert.equal(endpointRequestPath('anthropic'), '/messages')
  assert.equal(endpointRequestPath('responses'), '/responses')
  assert.equal(endpointRequestPath('systemone'), '/systemone')

  const mock = await startMock()
  try {
    const spec = testRoute()
    for (const protocol of ['openai', 'anthropic', 'responses', 'systemone']) {
      await callSpec(spec, onlineProbe(mock.base, protocol))
      assert.equal(
        mock.requests[mock.requests.length - 1].url,
        endpointRequestPath(protocol),
        `the probe uses the shared path for ${protocol}`,
      )
    }
  } finally {
    await mock.close()
  }
})

test('probe: a non-2xx from the endpoint is reported as a failure, not a success', async (t) => {
  // The probe reads only the status, so this is the one behaviour it has. A 422
  // (the systemone shape error) must surface as a failed test connection.
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Endpoint is unavailable"}}') })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const res = await callSpec(testRoute(), onlineProbe(base, 'systemone'))
  assert.equal(res.status, 400, 'the probe route reports a failed connection as ok:false')
  assert.equal(res.json.ok, false)
  assert.match(res.json.error, /422/)
})
