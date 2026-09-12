/**
 * `/history` DELETE answered 200 even when the truncate threw, and cleared the
 * in-memory window anyway: the panel then showed "no records" while
 * history.jsonl still held them, and the next boot resurrected the whole
 * window. A clear that reports success must actually have cleared the file; a
 * failure is a 500 with the records left alone (the recoverable tombstone is
 * only written after the truncate succeeded).
 * Run: node --test tests/audit-history-clear-honesty.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHistoryRoute, setHistoryFilePathForTests } from '../lib/index.js'
import { setAuditFilePathForTests } from '../lib/auto/audit.js'

function historyHandler() {
  const registrations = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (desc) => registrations.push(desc) } : undefined),
    effect: (fn) => fn(),
  }
  installHistoryRoute(ctx)
  assert.equal(registrations.length, 1)
  return registrations[0].handler
}

async function call(handler, method) {
  const state = { statusCode: 0, body: '' }
  const res = {
    setHeader: () => {},
    writeHead: (code) => { state.statusCode = code },
    end: (body) => { state.body = body ?? '' },
  }
  await handler({ method, headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }, res)
  return { statusCode: state.statusCode, json: JSON.parse(state.body || '{}') }
}

test('a failed truncate is a 500 and leaves the records in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-history-clear-'))
  const auditFile = join(dir, 'audit.jsonl')
  writeFileSync(auditFile, '')
  // A directory path can never be truncated into an empty file.
  setHistoryFilePathForTests(dir)
  setAuditFilePathForTests(auditFile)
  try {
    const result = await call(historyHandler(), 'DELETE')
    assert.equal(result.statusCode, 500, 'a failed clear must not report success')
    assert.equal(result.json.ok, false)
    assert.match(result.json.error, /could not be truncated/)
    assert.equal(readFileSync(auditFile, 'utf8'), '', 'no tombstone is written for a clear that did not happen')
  } finally {
    setHistoryFilePathForTests(undefined)
    setAuditFilePathForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a successful truncate still answers 200 and empties the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-history-clear-'))
  const historyFile = join(dir, 'history.jsonl')
  const auditFile = join(dir, 'audit.jsonl')
  writeFileSync(historyFile, '{"id":"1","outcome":"allowed-once"}\n')
  writeFileSync(auditFile, '')
  setHistoryFilePathForTests(historyFile)
  setAuditFilePathForTests(auditFile)
  try {
    const result = await call(historyHandler(), 'DELETE')
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.json.value, { records: [] })
    assert.equal(readFileSync(historyFile, 'utf8'), '', 'the file really is empty')
    assert.match(readFileSync(auditFile, 'utf8'), /"type":"clear"/, 'the clear leaves its recoverable tombstone')
  } finally {
    setHistoryFilePathForTests(undefined)
    setAuditFilePathForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
