/**
 * The learning-store DELETE route reports persistence honestly.
 *
 * Revoking a learned entry must survive a restart, so the route is only done
 * once learning.json holds the new content. It returned 200 {removed:true}
 * without reading writeRuntimeAtomic's result, so an unwritable file answered
 * success while the entry stayed on disk and came back (rejoining the
 * auto-allow surface) after the next boot — the same false success the history
 * route refuses with a 500.
 *
 * A directory where learning.json belongs reproduces the open-stage failure
 * (EISDIR) the way tests/runtime-write-fallback.test.mjs already does.
 *
 * Run: node --test tests/audit-r4-learning-persist-failure.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installLearningStoreRoute } from '../lib/index.js'
import { LEARNING_FILENAME, setRuntimePathsForTests } from '../lib/auto/runtime-paths.js'

async function sandbox(blocked, body) {
  const dir = mkdtempSync(join(tmpdir(), 'r4-learning-'))
  const stateDir = join(dir, 'dsh-home', 'auto-approval-llm')
  mkdirSync(stateDir, { recursive: true })
  if (blocked) mkdirSync(join(stateDir, LEARNING_FILENAME), { recursive: true })
  try {
    setRuntimePathsForTests({ stateDir })
    return await body()
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

function routeHandler(revokeResult = true) {
  const registrations = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (desc) => registrations.push(desc) } : undefined),
    effect: (fn) => fn(),
  }
  installLearningStoreRoute(ctx, async () => revokeResult)
  assert.equal(registrations.length, 1, 'the learning-store installer registers exactly one route')
  return registrations[0].handler
}

function fakeRes() {
  const state = { statusCode: 0, body: '' }
  return {
    state,
    res: {
      setHeader: () => {},
      writeHead: (code) => { state.statusCode = code },
      end: (chunk) => { state.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
    },
  }
}

function deleteReq(payload) {
  const bytes = Buffer.from(JSON.stringify(payload))
  return {
    method: 'DELETE',
    headers: { host: 'localhost:8080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { yield bytes },
  }
}

test('a revoke that cannot be persisted is reported as a failure, not a 200', async () => {
  const handler = routeHandler(true)
  await sandbox(true, async () => {
    const { res, state } = fakeRes()
    await handler(deleteReq({ key: 'a'.repeat(64) }), res)
    assert.equal(state.statusCode, 500, 'an unwritable learning.json must not answer success')
    const body = JSON.parse(state.body)
    assert.equal(body.ok, false)
    assert.match(body.error, /could not be persisted/)
  })
})

test('control: a writable store still answers 200 after persisting', async () => {
  const handler = routeHandler(true)
  await sandbox(false, async () => {
    const { res, state } = fakeRes()
    await handler(deleteReq({ key: 'b'.repeat(64) }), res)
    assert.equal(state.statusCode, 200)
    assert.deepEqual(JSON.parse(state.body), { ok: true, value: { removed: true } })
  })
})

test('control: an unknown key stays a 404 and never reports success', async () => {
  const handler = routeHandler(false)
  await sandbox(false, async () => {
    const { res, state } = fakeRes()
    await handler(deleteReq({ key: 'c'.repeat(64) }), res)
    assert.equal(state.statusCode, 404)
  })
})
