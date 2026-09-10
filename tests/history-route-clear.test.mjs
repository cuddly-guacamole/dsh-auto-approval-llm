/**
 * dsh-auto-approval-llm · /history DELETE must never touch the live files.
 *
 * The history route is the only runtime-state consumer without a test seam:
 * `installHistoryRoute(ctx)` took nothing but the plugin context, served the
 * `history.jsonl` loaded at import time, and its DELETE branch truncated that
 * same live path while tombstoning the live `audit.jsonl`. The suite's only
 * history test asserted the GET response shape, so a DELETE that wiped the
 * running host's audit trail was invisible — the exact accident the audit-file
 * seam was added to prevent, still open on the one sibling that lacked it.
 *
 * `setHistoryFilePathForTests` / `historyFilePath()` mirror
 * `setAuditFilePathForTests` / `auditFilePath()` in `src/auto/audit.ts`.
 *
 * BOTH seams are engaged for every test here, and each one asserts the live
 * files are byte-identical afterwards. Overriding only the history path is not
 * enough: the DELETE also appends a recoverable `clear` tombstone through the
 * audit plane, so a half-isolated test writes into the live audit ledger while
 * looking fully isolated. That is not hypothetical — an earlier revision of
 * this file did exactly that, which is why the live-file assertion is on both
 * planes rather than just the one being truncated.
 *
 * Run: node --test tests/history-route-clear.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  historyFilePath, installHistoryRoute, setHistoryFilePathForTests,
} from '../lib/index.js'
import { auditFilePath, setAuditFilePathForTests } from '../lib/auto/audit.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function historyHandler() {
  const registrations = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (desc) => registrations.push(desc) } : undefined),
    effect: (fn) => fn(),
  }
  installHistoryRoute(ctx)
  assert.equal(registrations.length, 1, 'the history installer registers exactly one route')
  return registrations[0].handler
}

const LOOPBACK = { headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }

async function call(method, { host = 'localhost:3080', remoteAddress = '127.0.0.1' } = {}) {
  const state = { statusCode: 0, body: '' }
  const res = {
    setHeader: () => {},
    writeHead: (code) => { state.statusCode = code },
    end: (chunk) => { state.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
  }
  await historyHandler()({ method, headers: { host }, socket: { remoteAddress } }, res)
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null }
}

/**
 * Read a live runtime file, or null when it is absent.
 *
 * After the move to `runtime/`, the live files need not exist yet — the running
 * host only creates them on its next write — so a snapshot helper must treat
 * "absent" as a state rather than an error.
 */
function snapshot(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/**
 * Run `body` with BOTH runtime paths redirected into a scratch directory, and
 * assert afterwards that the live files were not touched. Fails loudly if
 * either plane escaped the redirect.
 */
async function isolated(body) {
  const dir = mkdtempSync(join(tmpdir(), 'history-clear-'))
  const scratchHistory = join(dir, 'history.jsonl')
  const scratchAudit = join(dir, 'audit.jsonl')
  const liveHistory = historyFilePath()
  const liveAudit = auditFilePath()
  const beforeHistory = snapshot(liveHistory)
  const beforeAudit = snapshot(liveAudit)
  writeFileSync(scratchHistory, '')
  writeFileSync(scratchAudit, '')
  try {
    setHistoryFilePathForTests(scratchHistory)
    setAuditFilePathForTests(scratchAudit)
    const result = await body({ dir, scratchHistory, scratchAudit })
    assert.equal(snapshot(liveHistory), beforeHistory, 'the LIVE history file must be byte-identical')
    assert.equal(
      snapshot(liveAudit),
      beforeAudit,
      'the LIVE audit file must be byte-identical — a half-isolated DELETE tombstones the real ledger',
    )
    return result
  } finally {
    setHistoryFilePathForTests(undefined)
    setAuditFilePathForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('history: the default paths are the runtime/ files', () => {
  // The seams must not change production behaviour: with no override (the only
  // state production is ever in) both effective paths are the runtime location.
  assert.equal(historyFilePath(), join(REPO_ROOT, 'runtime', 'history.jsonl'))
  assert.equal(auditFilePath(), join(REPO_ROOT, 'runtime', 'audit.jsonl'))
})

test('history DELETE: truncates the configured file, writes the tombstone to the configured audit', async () => {
  await isolated(async ({ scratchHistory, scratchAudit }) => {
    writeFileSync(scratchHistory, '{"id":"a"}\n{"id":"b"}\n')
    // The tombstone counts the records dropped from the IN-MEMORY window (the
    // bounded 200-record view the route serves), not the lines in the file.
    // Read that window back from the route first so the count is derived
    // rather than hard-coded.
    const before = await call('GET')
    const inMemory = before.body.value.records.length

    const res = await call('DELETE')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, value: { records: [] } })

    assert.equal(readFileSync(scratchHistory, 'utf8'), '', 'the DELETE truncates the configured history file')
    const audit = readFileSync(scratchAudit, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(audit.length, 1, 'exactly one tombstone is appended to the configured audit file')
    const record = JSON.parse(audit[0])
    assert.equal(record.type, 'clear', 'the clear is recorded rather than a silent erase')
    assert.equal(record.cleared, inMemory, 'the tombstone reports how many records were dropped')
  })
})

test('history GET still serves the shape the client reads', async () => {
  await isolated(async () => {
    const res = await call('GET')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.value.records))
    assert.ok('llmLatency' in res.body.value)
    assert.ok('llmLatencyClassifier' in res.body.value)
    assert.ok('llmLatencyAll' in res.body.value)
  })
})

test('history route: a foreign Host is refused before any write', async () => {
  await isolated(async ({ scratchHistory }) => {
    writeFileSync(scratchHistory, '{"id":"keep"}\n')
    const res = await call('DELETE', { host: 'evil.example:3080', remoteAddress: '10.0.0.7' })
    assert.equal(res.status, 403)
    assert.equal(readFileSync(scratchHistory, 'utf8'), '{"id":"keep"}\n', 'a refused request writes nothing')
  })
})

test('history route: a non-GET/DELETE method is 405 and writes nothing', async () => {
  await isolated(async ({ scratchHistory }) => {
    writeFileSync(scratchHistory, '{"id":"keep"}\n')
    const res = await call('POST')
    assert.equal(res.status, 405)
    assert.equal(readFileSync(scratchHistory, 'utf8'), '{"id":"keep"}\n')
  })
})
