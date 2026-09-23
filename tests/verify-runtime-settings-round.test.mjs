/**
 * Contract: the runtime helper's settings round writes through the host
 * settings plane, never through a plugin route.
 *
 * The host owns configuration writes: the browser settings page hands path ops
 * to it over the shared /api Remote channel, and the plugin's own settings POST
 * route is retired (GET only). A helper that still POSTed to that route would
 * print `method-not-allowed` and then read it as "the mock config never took",
 * so this test models the host plane on a loopback port and drives the exported
 * round: the requests must carry the client-request envelope, target the
 * plugin's namespace, write only fields the host exposes as editable, and the
 * rollback must put the captured stored section back without an expected
 * revision.
 *
 * Run: node --test tests/verify-runtime-settings-round.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { MOCK_CONFIG, useSession, planMockSettings, commitMockSettings, restoreSettings, driftedAfterRestore } from '../scripts/verify-runtime.mjs'
import { EDITABLE_CONFIG_KEYS } from '../lib/auto/decision.js'

const SETTINGS_NS = 'auto-approval-llm'
const PLUGIN_SETTINGS_ROUTE = '/api/auto-approval-llm/settings'
const HOST_DESCRIBE = '/api/settings/describe'
const HOST_MUTATE = '/api/settings/mutate'

const MOCK_KEYS = Object.keys(MOCK_CONFIG)
const EDITABLE = new Set(EDITABLE_CONFIG_KEYS)
// The payload fields the card owns. The remainder are host-owned: the host
// plane neither projects nor accepts them, so the round must leave them alone.
const EDITABLE_MOCK_KEYS = MOCK_KEYS.filter((key) => EDITABLE.has(key))
const HOST_OWNED_MOCK_KEYS = MOCK_KEYS.filter((key) => !EDITABLE.has(key))

/**
 * Model the host settings plane on the shared /api channel: session cookie
 * first, then the Remote envelope, then path-op writes into a stored section.
 * The plugin's own settings route is modeled as GET-only, exactly as the
 * retired write path leaves it.
 */
function modelHostPlane({ fields = EDITABLE_MOCK_KEYS, base = {}, user = {}, revision = 7, applyWrites = true } = {}) {
  const state = { user: structuredClone(user), revision, requests: [], retiredWrites: 0, refusals: 0 }
  const value = () => ({ ...base, ...state.user })
  const view = () => ({
    autoGenerate: true,
    ns: SETTINGS_NS,
    schema: { uid: 1, refs: { 1: { type: 'object', meta: {}, dict: Object.fromEntries(fields.map((field, index) => [field, index + 2])) } } },
    value: value(),
    user: structuredClone(state.user),
    applies: 'live',
    secrets: [],
    revision: state.revision,
  })
  const answer = (res, rpcId, result) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }
  const applyOps = (ops) => {
    for (const op of ops) {
      const key = op.path[0]
      if (op.op === 'unset') delete state.user[key]
      else state.user[key] = op.value
    }
    state.revision += 1
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const parsed = body === '' ? null : JSON.parse(body)
      state.requests.push({ method: req.method, path: req.url, body: parsed })
      if (req.headers.cookie === undefined) { res.statusCode = 401; res.end('unauthorized'); return }
      if (req.url === PLUGIN_SETTINGS_ROUTE) {
        if (req.method !== 'GET') { state.retiredWrites += 1; res.statusCode = 405; res.setHeader('Allow', 'GET'); res.end('{"ok":false,"error":"method-not-allowed"}'); return }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, value: { value: value(), revision: state.revision, writable: true, applies: 'live', configError: null } }))
        return
      }
      if (req.method !== 'POST' || parsed?.type !== 'client-request') { res.statusCode = 404; res.end('not found'); return }
      if (req.url === HOST_DESCRIBE) {
        answer(res, parsed.rpcId, { ok: true, value: { writable: true, hasDocument: true, namespaces: [view()] } })
        return
      }
      if (req.url === HOST_MUTATE) {
        const args = parsed.payload?.args ?? {}
        if (args.expectedRevision !== undefined && args.expectedRevision !== state.revision) {
          state.refusals += 1
          answer(res, parsed.rpcId, { ok: false, error: { code: 'settings/conflict', message: 'changed since it was read', details: { ns: SETTINGS_NS } } })
          return
        }
        if (applyWrites) applyOps(args.ops ?? [])
        answer(res, parsed.rpcId, { ok: true, value: view() })
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
  })
  return { server, state, view }
}

async function pointAt(model) {
  model.server.listen(0, '127.0.0.1')
  await once(model.server, 'listening')
  const port = model.server.address().port
  useSession({ host: '127.0.0.1', port, authority: '127.0.0.1:3080', cookie: 'dsh_session=test' })
  return port
}

test('the planned round speaks the host Remote envelope and writes nothing', async (t) => {
  const model = modelHostPlane()
  await pointAt(model)
  t.after(() => model.server.close())

  const plan = await planMockSettings()

  assert.equal(model.state.requests.length, 1, 'planning must not write')
  const [call] = model.state.requests
  assert.equal(call.method, 'POST')
  assert.equal(call.path, HOST_DESCRIBE)
  assert.equal(call.body.type, 'client-request')
  assert.equal(call.body.method, 'settings/describe')
  assert.equal(call.body.method, call.path.slice('/api/'.length), 'the envelope method must match the endpoint path')
  assert.deepEqual(call.body.payload, { args: {} })
  assert.equal(model.state.retiredWrites, 0, 'the plugin settings route must not be written')

  assert.equal(EDITABLE_MOCK_KEYS.length, 23)
  assert.equal(HOST_OWNED_MOCK_KEYS.length, 6)
  assert.deepEqual(plan.snapshot.fields, EDITABLE_MOCK_KEYS)
  assert.deepEqual(plan.untouched, HOST_OWNED_MOCK_KEYS)
  assert.equal(plan.revision, 7)
  assert.ok(plan.ops.every((op) => op.op === 'set' && op.path.length === 1 && op.value === MOCK_CONFIG[op.path[0]]))
  assert.ok(plan.ops.every((op) => EDITABLE.has(op.path[0])), 'only card-owned fields may be written')
})

test('committing applies the ops through the host plane and confirms the read-back', async (t) => {
  const model = modelHostPlane({ user: { enabled: false } })
  await pointAt(model)
  t.after(() => model.server.close())

  const plan = await planMockSettings()
  await commitMockSettings(plan)

  const mutate = model.state.requests.find((call) => call.path === HOST_MUTATE)
  assert.ok(mutate !== undefined, 'the write must target the host settings plane')
  assert.equal(mutate.body.method, 'settings/mutate')
  assert.equal(mutate.body.payload.args.ns, SETTINGS_NS)
  assert.equal(mutate.body.payload.args.expectedRevision, plan.revision, 'the write must carry the revision the snapshot was read at')
  assert.deepEqual(mutate.body.payload.args.ops, plan.ops)
  assert.equal(model.state.user.enabled, true, 'the host plane received the mock value')
  assert.equal(model.state.requests.at(-1).path, HOST_DESCRIBE, 'the applied payload is confirmed by a read-back')
  assert.equal(model.state.retiredWrites, 0)
})

test('a read-back that does not match the payload fails the round', async (t) => {
  const model = modelHostPlane({ applyWrites: false })
  await pointAt(model)
  t.after(() => model.server.close())

  const plan = await planMockSettings()
  await assert.rejects(() => commitMockSettings(plan), /did not apply: enabled/)
})

test('a refused write is surfaced as a refusal and never as a silent miss', async (t) => {
  const model = modelHostPlane()
  await pointAt(model)
  t.after(() => model.server.close())

  const plan = await planMockSettings()
  model.state.revision = 99
  await assert.rejects(() => commitMockSettings(plan), (error) => {
    assert.equal(error.refused, true, 'a Remote refusal must be distinguishable from an unknown outcome')
    assert.match(error.message, /settings\/conflict/)
    return true
  })
})

test('the rollback restores the captured stored section and is unconditional', async (t) => {
  const model = modelHostPlane({ user: { enabled: false, debug: false } })
  await pointAt(model)
  t.after(() => model.server.close())

  const plan = await planMockSettings()
  await commitMockSettings(plan)
  await restoreSettings(plan.snapshot)

  const mutate = model.state.requests.filter((call) => call.path === HOST_MUTATE).at(-1)
  const ops = mutate.body.payload.args.ops
  const held = new Set(['enabled', 'debug'])
  assert.equal(ops.length, plan.snapshot.fields.length)
  for (const op of ops) {
    if (held.has(op.path[0])) {
      assert.equal(op.op, 'set', `${op.path[0]} was stored before the run and must be restored to that value`)
      assert.equal(op.value, false)
    } else {
      assert.deepEqual(op, { op: 'unset', path: [op.path[0]] }, `${op.path[0]} was introduced by the run and must be unset`)
    }
  }
  assert.equal(Object.hasOwn(mutate.body.payload.args, 'expectedRevision'), false, 'a rollback must not be blocked by a revision bump')
  assert.equal(model.state.user.enabled, false)
  assert.equal(Object.hasOwn(model.state.user, 'rulesText'), false)
  assert.equal(model.state.retiredWrites, 0)
})

test('the full round never touches the plugin settings route', async (t) => {
  const model = modelHostPlane({ user: { enabled: false } })
  await pointAt(model)
  t.after(() => model.server.close())

  const plan = await planMockSettings()
  await commitMockSettings(plan)
  await restoreSettings(plan.snapshot)

  const paths = new Set(model.state.requests.map((call) => call.path))
  assert.deepEqual([...paths].sort(), [HOST_DESCRIBE, HOST_MUTATE])
  assert.equal(model.state.retiredWrites, 0, 'a POST to the retired plugin route would have been answered 405')
})

test('a field that did not come back is reported, not swallowed', async (t) => {
  const before = { enabled: false, debug: false, rulesText: '' }
  const model = modelHostPlane({ base: before, user: { enabled: false, debug: false, rulesText: '' } })
  await pointAt(model)
  t.after(() => model.server.close())

  const snapshot = { fields: ['enabled', 'debug'], user: { enabled: false, debug: false } }
  assert.deepEqual(await driftedAfterRestore(snapshot, before), [])

  model.state.user.enabled = true
  assert.deepEqual(await driftedAfterRestore(snapshot, before), ['enabled'])
  assert.equal(model.state.requests.at(-1).method, 'GET')
  assert.equal(model.state.requests.at(-1).path, PLUGIN_SETTINGS_ROUTE)
})

test('the source keeps the retired write path out and the rollback wired in', () => {
  const source = readFileSync(new URL('../scripts/verify-runtime.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes("request('POST', SETTINGS_ROUTE"), false, 'the retired POST branch must not come back')
  assert.equal(source.includes('settings POST failed'), false, 'the retired error text must not come back')
  assert.equal(source.includes('putSettings'), false, 'the retired write helper must not come back')
  assert.equal(source.includes("'/api/auto-approval-llm/settings'"), true, 'the read-only snapshot route stays')
  assert.ok(source.includes("const HOST_SETTINGS_MUTATE = `${API_CHANNEL}settings/mutate`"), 'the write channel is the host settings plane')
  assert.ok(source.includes('await restoreSettings(settingsSnapshot)'), 'the rollback is wired into the exit path')
  assert.ok(source.includes('if (dirty) await restore()'), 'the rollback runs from the finally path')
  assert.equal((source.match(/process\.on\('SIG(INT|TERM)', \(\) => \{ void restore\(\)/g) ?? []).length, 2, 'Ctrl-C and SIGTERM both restore')
})
