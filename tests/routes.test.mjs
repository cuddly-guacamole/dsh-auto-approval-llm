/**
 * dsh-auto-approval-llm · route-handler contract tests (M5).
 *
 * Drive the registered web handlers directly with fake req/res, covering the
 * routes that previously had no handler-level coverage: settings (read-only GET
 * shape + the retired write path) and review-status (never 404; {ok:false}
 * contract).
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
import { carrierContext, findSpec, callSpec } from './helpers/carrier-route.mjs'

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' } }

function capture(installer, ...args) {
  const { ctx, specs } = carrierContext()
  installer(ctx, ...args)
  const registrations = [...specs.values()]
  assert.ok(registrations.length >= 1, 'at least one registration')
  return { registrations }
}

function handlerOf(registrations, pathPart) {
  return findSpec(registrations, pathPart)
}

function callJson(route, req) {
  return callSpec(route, req)
}

// ── settings route ────────────────────────────────────────────────────────

function fakeSettings(initial) {
  let value = { ...initial }
  let revision = 1
  let replaced = 0
  return {
    describe: () => [{ ns: 'auto-approval-llm', value, revision, applies: 'live' }],
    get: () => value,
    replacedCount: () => replaced,
    writable: true,
    replace: async (ns, v, rev) => {
      replaced += 1
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
  const denied = await callJson(handler, settingsReq({ headers: { host: 'evil.example:3080' } }))
  assert.equal(denied.status, 403)
  assert.equal(denied.body.ok, false)
})

test('settings POST: the write path is retired — 405 with Allow: GET, no stored write', async () => {
  const settings = fakeSettings({ timeoutAction: 'reject', trustedDirs: ['C:/etc/x'] })
  const { registrations: regs } = capture(installSettingsRoute, settings)
  const handler = handlerOf(regs, 'settings')
  // The card writes through the host form, so this route owns GET alone: a
  // spec that still advertised POST would put a second writer back on the wire.
  assert.deepEqual([...handler.methods], ['GET'], 'the settings route advertises GET only')
  // The retired POST used to answer 200 and replace the whole namespace. It now
  // has to fail loudly rather than silently degrade to a last-write-wins save.
  const post = await callJson(handler, jsonPost({ value: { timeoutAction: 'allow', trustedDirs: [] }, expectedRevision: 1 }))
  assert.equal(post.status, 405, 'POST is retired, never a silent 200')
  assert.equal(post.headers.get('allow'), 'GET', 'the refusal names the surviving method')
  assert.equal(post.body.ok, false)
  assert.equal(post.body.error, 'method-not-allowed')
  assert.equal(settings.replacedCount(), 0, 'a retired POST must not reach the settings plane')
  assert.equal(settings.get().timeoutAction, 'reject', 'the stored settings are untouched')
  // The read-only degradation snapshot (no host form: entry not ACTIVE) keeps
  // serving the merged value plus the revision the card needs.
  const snapshot = await callJson(handler, settingsReq())
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.body.ok, true)
  assert.equal(snapshot.body.value.value.timeoutAction, 'reject')
  assert.deepEqual(snapshot.body.value.value.trustedDirs, ['C:/etc/x'], 'the host-owned key still renders')
  assert.equal(snapshot.body.value.revision, 1)
  assert.equal(snapshot.body.value.writable, true)
})

test('settings route: no write branch survives in the compiled installer', () => {
  const compiled = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const start = compiled.indexOf('function installSettingsRoute')
  // Bounded by the next installer that stays in the entry: the credential
  // installer moved to its own module, and a -1 end marker would have widened
  // this window instead of failing.
  const end = compiled.indexOf('function installHistoryRoute')
  assert.ok(start > 0 && end > start, 'the settings installer is locatable in the build')
  const installer = compiled.slice(start, end)
  assert.match(installer, /methods:\s*\[['"]GET['"]\]/, 'the route registers GET only')
  assert.ok(!installer.includes('preserveHostKeys'), 'the retired host-key projection is not called')
  assert.ok(!installer.includes('expectedRevision'), 'the optimistic-concurrency write guard is gone')
  assert.ok(!installer.includes('readJson('), 'the route no longer reads a request body')
  assert.ok(!installer.includes('.replace('), 'the whole-namespace write is gone')
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
  const denied = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example:3080' } })
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
  const foreign = await callJson(handler, { method: 'DELETE', headers: { host: 'evil.example:3080' } })
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
  const denied = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/llm-models?provider=deepseek', headers: { host: 'evil.example' } })
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
  const denied = await callJson(handler, { ...LOOPBACK, url: '/api/auto-approval-llm/reasoning-efforts?provider=goat&model=deepseek-v4-flash', headers: { host: 'evil.example' } })
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
  const denied = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example' } })
  assert.equal(denied.status, 403)
})

// ── session-mode route ────────────────────────────────────────────────────

function sessionModeHarness() {
  const agent = { session: { id: 'sess-1' } }
  const { ctx, specs } = carrierContext({
    agents: { get: (sid) => (sid === 'sess-1' ? agent : undefined) },
    permissionPresets: { permissionState: () => ({ preset: 'auto', sandbox: 'danger-full-access', approval: 'ask' }) },
  })
  installSessionModeRoute(ctx)
  return findSpec([...specs.values()], 'session-mode')
}

test('session-mode GET: session id arrives in a request header; the query form is dead', async () => {
  const handler = sessionModeHarness()
  const ok = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080', 'x-auto-approval-session-id': 'sess-1' },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.value.mode, 'auto', 'a raw auto is reported as the upstream name, never the plugin preset')
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
  const foreign = await callJson(handler, { ...LOOPBACK, headers: { host: 'evil.example:3080' } })
  assert.equal(foreign.status, 403)
})