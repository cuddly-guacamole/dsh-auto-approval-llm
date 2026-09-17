/**
 * dsh-auto-approval-llm · route-handler contract tests (M5).
 *
 * Drive the registered web handlers directly with fake req/res, covering the
 * routes that previously had no handler-level coverage: settings (GET shape,
 * POST validation + host-only preservation), history (GET/DELETE + auth
 * fence) and review-status (never 404; {ok:false} contract).
 *
 * Feedback-route handler tests live in contract.test.mjs (loopback privileged
 * plane). Run: node --test tests/routes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  installHistoryRoute, installLatencyRoute, installLlmCatalogRoutes, installReviewStatusRoute, installSessionModeRoute, installSettingsRoute,
} from '../lib/index.js'

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }

function capture(installer, ...args) {
  const registrations = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (desc) => registrations.push(desc) } : undefined),
    effect: (fn) => fn(),
  }
  installer(ctx, ...args)
  assert.ok(registrations.length >= 1, 'at least one registration')
  return { registrations }
}

function handlerOf(registrations, pathPart) {
  const spec = registrations.find((r) => r.path.includes(pathPart))
  assert.ok(spec, `no route matching ${pathPart}`)
  return spec.handler
}

function fakeRes() {
  const state = { statusCode: 0, body: '' }
  const res = {
    setHeader: () => {},
    writeHead: (code) => { state.statusCode = code },
    end: (chunk) => { state.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
  }
  return { res, state }
}

async function callJson(handler, req) {
  const { res, state } = fakeRes()
  await handler(req, res)
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null }
}

// ── settings route ────────────────────────────────────────────────────────

function fakeSettings(initial) {
  let value = { ...initial }
  let revision = 1
  return {
    describe: () => [{ ns: 'auto-approval-llm', value, revision, applies: 'live' }],
    get: () => value,
    writable: true,
    replace: async (ns, v, rev) => {
      if (rev !== revision) throw new Error('revision conflict')
      value = v
      revision += 1
    },
  }
}

function settingsReq(over = {}) {
  return { ...LOOPBACK, ...over }
}

function jsonPost(payload, over = {}) {
  return {
    ...settingsReq({ method: 'POST' }),
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield JSON.stringify(payload) },
    ...over,
  }
}

test('settings GET: loopback returns the describe shape; foreign Host is 403', async () => {
  const settings = fakeSettings({ timeoutAction: 'reject', rejectGuidance: true })
  const { registrations: regs } = capture(installSettingsRoute, settings)
  const handler = handlerOf(regs, 'settings')
  const ok = await callJson(handler, settingsReq())
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.value.value.rejectGuidance, true)
  assert.equal(ok.body.value.revision, 1)
  const denied = await callJson(handler, settingsReq({ headers: { host: 'evil.example:3080' }, socket: { remoteAddress: '192.168.1.9' } }))
  assert.equal(denied.status, 403)
  assert.equal(denied.body.ok, false)
})

test('settings POST: requires expectedRevision, preserves host-only keys', async () => {
  const settings = fakeSettings({ timeoutAction: 'reject', trustedDirs: ['C:/etc/x'] })
  const { registrations: regs } = capture(installSettingsRoute, settings)
  const handler = handlerOf(regs, 'settings')
  // No JSON content type: the body reader refuses before the value guard runs,
  // so this case alone can never tell whether a non-object value is rejected.
  const missing = await callJson(handler, {
    ...settingsReq({ method: 'POST' }),
    body: null,
  })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.ok, false, 'POST without a value object fails')
  assert.equal(missing.body.error, 'Content-Type must be application/json')
  // A readable JSON body with a matching revision reaches the value guard: an
  // array spreads to `{}` and a null spreads to `{}`, so both used to 200 and
  // silently reset every card key to its schema default.
  for (const value of [[], null]) {
    const badValue = await callJson(handler, jsonPost({ value, expectedRevision: 1 }))
    assert.equal(badValue.status, 400, `a ${JSON.stringify(value)} value must be rejected`)
    assert.equal(badValue.body.ok, false)
    assert.equal(badValue.body.error, 'value is required')
  }
  assert.equal(settings.get().timeoutAction, 'reject', 'a rejected save must not touch the stored settings')
  const noRev = await callJson(handler, {
    ...settingsReq({ method: 'POST' }),
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ value: { timeoutAction: 'reject', trustedDirs: [] } }) },
  })
  assert.equal(noRev.status, 400, 'expectedRevision is mandatory')
  const good = await callJson(handler, {
    ...settingsReq({ method: 'POST' }),
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield JSON.stringify({ value: { timeoutAction: 'allow', trustedDirs: [] }, expectedRevision: 1 })
    },
  })
  assert.equal(good.status, 200)
  assert.equal(good.body.value.value.timeoutAction, 'allow')
  assert.deepEqual(good.body.value.value.trustedDirs, ['C:/etc/x'], 'host-only key survives the save')
  assert.equal(good.body.ok, true)
})

// ── history route ─────────────────────────────────────────────────────────

test('history GET: loopback 200 with records + llmLatency; foreign Host 403', async () => {
  const { registrations: regs } = capture(installHistoryRoute)
  const handler = handlerOf(regs, 'history')
  const ok = await callJson(handler, LOOPBACK)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  // Existence alone says nothing about the payload: pin the exact key set and
  // the full shape of every lane summary.
  assert.deepEqual(
    Object.keys(ok.body.value).sort(),
    ['llmLatency', 'llmLatencyAll', 'llmLatencyClassifier', 'records'],
    'the history payload carries the record list plus the three lane summaries',
  )
  assert.ok(Array.isArray(ok.body.value.records), 'records is the record array')
  for (const lane of ['llmLatency', 'llmLatencyClassifier', 'llmLatencyAll']) {
    assert.deepEqual(
      Object.keys(ok.body.value[lane]).sort(),
      ['abortedCount', 'avgMs', 'count', 'maxMs', 'minMs', 'windowStartAt'],
      `${lane} is a full latency summary`,
    )
  }
  assert.equal(
    ok.body.value.llmLatencyAll.count,
    ok.body.value.llmLatency.count + ok.body.value.llmLatencyClassifier.count,
    'the merged summary counts both lanes',
  )
  const denied = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example:3080' }, socket: { remoteAddress: '10.0.0.7' } })
  assert.equal(denied.status, 403)
})

test('history registers exactly one route; the models and export routes stay deleted', () => {
  const { registrations: regs } = capture(installHistoryRoute)
  assert.equal(regs.length, 1, 'the history installer registers a single route')
  assert.ok(!regs.some((r) => r.path.includes('export')), 'no history/export download route')
  // The retired /models and /history/export routes had no consumers anywhere
  // (client, tests, scripts); their path constants must not resurface.
  const compiled = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.ok(!compiled.includes('auto-approval-llm/models'), 'the retired models route is gone')
  assert.ok(!compiled.includes('auto-approval-llm/history/export'), 'the retired history export route is gone')
})

// ── llm-latency route (2026-09-06 "clear timings" action) ──────────────────

test('llm-latency registers one route; DELETE-only with the loopback fence', async () => {
  // The "clear timings" button clears only the latency telemetry window/file
  // (the history DELETE deliberately leaves latency alone, so this clear
  // leaves history alone). DELETE's file-truncation side effect is covered by
  // the clearLatencySamples contract test with a temp path — the handler test
  // here pins registration, the method gate and the trust fence without
  // touching the live llm-latency.jsonl.
  const { registrations: regs } = capture(installLatencyRoute)
  assert.equal(regs.length, 1, 'the latency installer registers a single route')
  const handler = handlerOf(regs, 'llm-latency')
  const methodDenied = await callJson(handler, LOOPBACK)
  assert.equal(methodDenied.status, 405, 'GET is not allowed on the latency route')
  const foreign = await callJson(handler, { method: 'DELETE', headers: { host: 'evil.example:3080' }, socket: { remoteAddress: '10.0.0.7' } })
  assert.equal(foreign.status, 403, 'foreign Host is refused even for DELETE')
})

// ── llm catalog routes (Issue #5 model-source pickers) ────────────────────

function fakeLlm({ providers = [], modelsByProvider = {}, modelInfoByRoute = {} } = {}) {
  return {
    listProviders: () => providers.map((p) => ({ id: p.id, name: p.name ?? p.id })),
    listModels: async (provider) => (modelsByProvider[provider] ?? []).map((m) => ({ provider, id: m.id, name: m.name ?? m.id })),
    resolveModelInfo: async (provider, model) => {
      const hit = modelInfoByRoute[`${provider}/${model}`]
      if (!hit) throw new Error('no such route')
      return hit
    },
  }
}

test('llm catalog: providers GET returns the registered adapter routes on the loopback plane', async () => {
  const llm = fakeLlm({ providers: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'anthropic', name: 'Anthropic' }] })
  const { registrations: regs } = capture(installLlmCatalogRoutes, llm)
  assert.equal(regs.length, 3, 'providers + llm-models + reasoning-efforts routes register')
  const handler = handlerOf(regs, 'providers')
  const res = await callJson(handler, LOOPBACK)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.value.providers, [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'anthropic', name: 'Anthropic' }])
})

test('llm catalog: llm-models GET lists the provider models; foreign Host 403', async () => {
  const llm = fakeLlm({ modelsByProvider: { deepseek: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] } })
  const { registrations: regs } = capture(installLlmCatalogRoutes, llm)
  const handler = handlerOf(regs, 'llm-models')
  const ok = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/llm-models?provider=deepseek' })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.value.models, [{ provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }])
  const denied = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/llm-models?provider=deepseek', headers: { host: 'evil.example' }, socket: { remoteAddress: '10.0.0.7' } })
  assert.equal(denied.status, 403)
})

test('llm catalog: llm-models without a provider or for an unknown provider returns 400', async () => {
  const { registrations: regs } = capture(installLlmCatalogRoutes, fakeLlm())
  const handler = handlerOf(regs, 'llm-models')
  const missing = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/llm-models' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error, 'provider is required')
  const throwing = fakeLlm({})
  throwing.listModels = async () => { throw new Error('NO_ADAPTER') }
  const { registrations: regs2 } = capture(installLlmCatalogRoutes, throwing)
  const handler2 = handlerOf(regs2, 'llm-models')
  const bad = await callJson(handler2, { ...LOOPBACK, url: '/api/auto-approval-llm/llm-models?provider=nope' })
  assert.equal(bad.status, 400)
})

test('llm catalog: reasoning-efforts GET returns the adapter-declared efforts for one route', async () => {
  const llm = fakeLlm({ modelInfoByRoute: { 'goat/deepseek-v4-flash': { provider: 'goat', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: 'high' } } } })
  const { registrations: regs } = capture(installLlmCatalogRoutes, llm)
  const handler = handlerOf(regs, 'reasoning-efforts')
  const ok = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/reasoning-efforts?provider=goat&model=deepseek-v4-flash' })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.value.efforts, [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }])
  assert.equal(ok.body.value.defaultEffort, 'high')
  const denied = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/reasoning-efforts?provider=goat&model=deepseek-v4-flash', headers: { host: 'evil.example' }, socket: { remoteAddress: '10.0.0.7' } })
  assert.equal(denied.status, 403)
})

test('llm catalog: reasoning-efforts for an unresolvable model degrades to an empty list', async () => {
  const { registrations: regs } = capture(installLlmCatalogRoutes, fakeLlm())
  const handler = handlerOf(regs, 'reasoning-efforts')
  const missing = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/reasoning-efforts' })
  assert.equal(missing.status, 400, 'missing params stay a 400')
  const unresolvable = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/reasoning-efforts?provider=nope&model=none' })
  assert.equal(unresolvable.status, 200)
  assert.deepEqual(unresolvable.body.value.efforts, [], 'an adapter without the route degrades to default-only')
})

test('review-status GET: never 404 — unknown callId returns ok:false at 200', async () => {
  const { registrations: regs } = capture(installReviewStatusRoute)
  const handler = handlerOf(regs, 'review')
  const res = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080', 'x-auto-approval-call-id': 'call-does-not-exist' },
  })
  assert.equal(res.status, 200, 'the route always answers 200')
  assert.equal(res.body.ok, false, 'an unknown call reads as {ok:false}')
  assert.equal(res.body.error, 'not-found')
  const denied = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example' }, socket: { remoteAddress: '192.168.1.9' } })
  assert.equal(denied.status, 403)
})

// ── session-mode route ────────────────────────────────────────────────────

function sessionModeHarness() {
  const registrations = []
  const agent = { session: { id: 'sess-1' } }
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return { register: (desc) => registrations.push(desc) }
      if (name === 'agents') return { get: (sid) => (sid === 'sess-1' ? agent : undefined) }
      if (name === 'permissionPresets') return { permissionState: () => ({ preset: 'auto', sandbox: 'danger-full-access', approval: 'ask' }) }
      return undefined
    },
    effect: (fn) => fn(),
  }
  installSessionModeRoute(ctx)
  return handlerOf(registrations, 'session-mode')
}

test('session-mode GET: session id arrives in a request header; the query form is dead', async () => {
  const handler = sessionModeHarness()
  const ok = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080', 'x-auto-approval-session-id': 'sess-1' },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.value.mode, 'auto-approval', 'legacy raw auto is normalized to the machine name')
  // Legacy query transport must not be honored: the header discipline is the
  // same as the review-status call-id (2026-09-03 audit).
  const legacy = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080' },
    url: '/api/auto-approval-llm/session-mode?sessionId=sess-1',
  })
  assert.equal(legacy.status, 400, 'a query-only call must fail: sessionId is required')
  const missing = await callJson(handler, LOOPBACK)
  assert.equal(missing.status, 400)
  const foreign = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example:3080' }, socket: { remoteAddress: '10.0.0.7' } })
  assert.equal(foreign.status, 403)
})