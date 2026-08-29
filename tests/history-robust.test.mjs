/**
 * dsh-auto-approval-llm · F-2 robustness contract tests.
 *
 * JSONL rotation for history/debug/latency must be atomic (same-directory
 * temp file + rename), and loadHistory must tolerate a corrupt line without
 * dropping the records after it — history.jsonl is the durable evidence
 * source for the approval chain, so a crash-mid-rotation tail line must
 * never silently orphan every newer record on the next restart.
 *
 * Pure-function tests over the compiled lib.
 * Run: node --test tests/history-robust.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile, parseHistoryLines } from '../lib/index.js'

const goodLine = (id) => JSON.stringify({ id, at: 1, sessionId: 's', toolName: 't', outcome: 'allowed-once', source: 'human-allow' })

test('parseHistoryLines: clean lines load fully with badCount 0', () => {
  const { records, badCount } = parseHistoryLines([goodLine('h1'), goodLine('h2')])
  assert.deepEqual(records.map((r) => r.id), ['h1', 'h2'])
  assert.equal(badCount, 0)
})

test('parseHistoryLines: a corrupt line in the middle does not drop later records', () => {
  // A bad line anywhere must be skipped, never abort the load of the lines
  // after it (the F-2 regression: one truncated line orphaned everything
  // newer on every restart).
  const { records, badCount } = parseHistoryLines([goodLine('h1'), '{"id":"h2","at":1, TRAILING', goodLine('h3')])
  assert.deepEqual(records.map((r) => r.id), ['h1', 'h3'], 'records after the corrupt line must still load')
  assert.equal(badCount, 1)
})

test('parseHistoryLines: truncated tail (crash mid-rotation) is counted, not fatal', () => {
  const { records, badCount } = parseHistoryLines([goodLine('h1'), '{"id":"h9"'])
  assert.deepEqual(records.map((r) => r.id), ['h1'])
  assert.equal(badCount, 1)
})

test('parseHistoryLines: parse-valid but non-record JSON stays silently skipped (id gate)', () => {
  // Only JSON.parse failures count as corrupt; the id-shape gate semantics
  // are preserved unchanged.
  const { records, badCount } = parseHistoryLines(['{}', '{"at":1}'])
  assert.equal(records.length, 0)
  assert.equal(badCount, 0)
})

test('atomicWriteFile: replaces the target atomically and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const file = join(dir, 'history.jsonl')
  writeFileSync(file, 'stale\n')
  atomicWriteFile(file, 'line1\nline2\n')
  assert.equal(readFileSync(file, 'utf8'), 'line1\nline2\n', 'content must be replaced')
  assert.ok(!readdirSync(dir).some((n) => n.includes('.tmp')), 'no temp file may remain')
  rmSync(dir, { recursive: true, force: true })
})

test('atomicWriteFile: failed rotation cleans the temp file and preserves the target (fail-closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  const blockerDir = join(dir, 'blocked')
  mkdirSync(blockerDir)
  // renameSync(tmp-file, existing-directory) fails on every platform, so the
  // cleanup path must remove the temp file and leave the target untouched.
  assert.throws(() => atomicWriteFile(blockerDir, 'x'))
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp')), [], 'temp file must be removed on failure')
  assert.equal(readdirSync(blockerDir).length, 0, 'target must be left untouched')
  rmSync(dir, { recursive: true, force: true })
})