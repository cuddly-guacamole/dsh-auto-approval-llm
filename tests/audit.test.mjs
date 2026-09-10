// Contract tests for src/auto/audit.ts rotation (F3-audit).
//
// Rotation was byte-triggered (>5MB stat) but line-bounded (5000 lines), so
// files whose lines average >1KB could never shrink below the trigger and
// every append re-ran a full read→split→slice→join→write (O(n²) amplification).
// auditRotateContent now converges on BOTH bounds in one backward byte scan,
// and appendAuditLine replaces the file atomically (tmp + rename).
//
// These tests write and replace multi-megabyte files, so they run against a
// scratch path rather than the plugin-root audit.jsonl. The default path is the
// same file a running dsh process appends to; displacing it made the suite
// race that process and could leave the live location holding a fresh,
// near-empty file after a lost restore rename.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendAuditLine, auditFilePath, auditRotateContent, setAuditFilePathForTests,
  MAX_AUDIT_BYTES, MAX_AUDIT_LINES,
} from '../lib/auto/audit.js'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), 'dsh-audit-test-'))
const AUDIT_FILE = join(SCRATCH_DIR, 'audit.jsonl')
const AUDIT_TMP = `${AUDIT_FILE}.tmp`

setAuditFilePathForTests(AUDIT_FILE)
after(() => {
  setAuditFilePathForTests(undefined)
  rmSync(SCRATCH_DIR, { recursive: true, force: true })
})

// Give each test a clean scratch file; nothing outside the scratch directory is
// touched, so a concurrently running plugin is never disturbed.
function withAuditBackup(fn) {
  rmSync(AUDIT_FILE, { force: true })
  rmSync(AUDIT_TMP, { force: true })
  try {
    fn()
  } finally {
    rmSync(AUDIT_FILE, { force: true })
    rmSync(AUDIT_TMP, { force: true })
  }
}

test('auditFilePath: the default is the plugin-root audit.jsonl (redirection is opt-in)', () => {
  // The override exists only for this file's rotation fixtures. If the default
  // ever stopped being the plugin-root path, the writing plugin and the durable
  // trail would silently diverge.
  setAuditFilePathForTests(undefined)
  const defaultPath = auditFilePath()
  setAuditFilePathForTests(AUDIT_FILE)
  assert.equal(defaultPath, join(REPO_ROOT, 'audit.jsonl'))
  assert.equal(auditFilePath(), AUDIT_FILE, 'the explicit override wins while it is set')
})


function longLines(count, width) {
  return Array.from({ length: count }, (_, i) => `${'x'.repeat(width)}${i}`)
}

test('auditRotateContent: >maxLines keeps the last maxLines (regression)', () => {
  const content = Array.from({ length: 6001 }, (_, i) => `{"n":${i}}`).join('\n')
  const rotated = auditRotateContent(content)
  const lines = rotated.split('\n').filter(Boolean)
  assert.equal(lines.length, MAX_AUDIT_LINES)
  assert.equal(lines[0], '{"n":1001}')
  assert.equal(lines.at(-1), '{"n":6000}')
  assert.ok(rotated.endsWith('\n'))
})

test('auditRotateContent: long-line tails converge under the byte cap (no O(n²) band)', () => {
  // 3000 lines × ~2KB ≈ 6.1MB: under the line cap (3000 < 5000) but far over
  // the byte cap — the exact regime that used to rotate forever.
  const lines = longLines(3000, 2048)
  const content = lines.join('\n') + '\n'
  assert.ok(Buffer.byteLength(content) > MAX_AUDIT_BYTES, 'precondition: content exceeds the byte cap')
  const rotated = auditRotateContent(content)
  assert.ok(Buffer.byteLength(rotated) <= MAX_AUDIT_BYTES, 'rotated must sit under the byte cap')
  const kept = rotated.split('\n').filter(Boolean)
  assert.ok(kept.length < lines.length, 'leading long lines must be dropped')
  assert.ok(kept.length > 0)
  assert.equal(kept.at(-1), lines.at(-1), 'the newest tail line is kept')
  // Idempotent: a simulated next append+rotate sees a file already under the
  // trigger and rewrites nothing — the O(n²) band is gone.
  assert.equal(auditRotateContent(rotated), rotated)
})

test('auditRotateContent: a single oversized line is kept, never dropped', () => {
  const huge = 'y'.repeat(6 * 1024 * 1024) // 6MB single line
  const rotated = auditRotateContent(`${huge}\n`)
  assert.equal(rotated, `${huge}\n`)
  assert.ok(Buffer.byteLength(rotated) > MAX_AUDIT_BYTES, 'documented: one line cannot fit, so it is kept whole')
})

test('appendAuditLine: returns true on success and persists the line', () => {
  withAuditBackup(() => {
    const ok = appendAuditLine('{"type":"probe","n":1}')
    assert.equal(ok, true)
    const after = readFileSync(AUDIT_FILE, 'utf8')
    assert.ok(after.endsWith('{"type":"probe","n":1}\n'))
  })
})

test('appendAuditLine: returns false (fail-closed signal) when the audit path is blocked', () => {
  withAuditBackup(() => {
    // A directory at the audit path makes the append fail: the fail-closed
    // commit gate (APPROVAL-07) depends on this false, and it must not throw.
    mkdirSync(AUDIT_FILE)
    try {
      assert.equal(appendAuditLine('{"type":"probe","n":1}'), false)
    } finally {
      rmSync(AUDIT_FILE, { recursive: true, force: true })
    }
  })
})
test('appendAuditLine: rotation converges the file atomically with no tmp residue', () => {
  withAuditBackup(() => {
    const lines = longLines(3000, 2048)
    writeFileSync(AUDIT_FILE, lines.join('\n') + '\n')
    assert.ok(existsSync(AUDIT_FILE))
    appendAuditLine('{"type":"probe","n":1}')
    const after = readFileSync(AUDIT_FILE, 'utf8')
    assert.ok(Buffer.byteLength(after) <= MAX_AUDIT_BYTES, 'file converged under the byte cap')
    assert.ok(after.endsWith('{"type":"probe","n":1}\n'), 'the freshly appended line survives the rotation')
    assert.ok(!existsSync(AUDIT_TMP), 'no tmp residue after a successful rotation')
  })
})

test('appendAuditLine: a failed rotation never damages the original file', () => {
  withAuditBackup(() => {
    const lines = longLines(3000, 2048)
    const oversized = lines.join('\n') + '\n'
    writeFileSync(AUDIT_FILE, oversized)
    // Block the atomic replace: a directory at the tmp path makes the tmp
    // write fail, so the rotation must abort and leave the audit file intact.
    mkdirSync(AUDIT_TMP)
    try {
      appendAuditLine('{"type":"probe","n":1}') // best-effort: must not throw
      const after = readFileSync(AUDIT_FILE, 'utf8')
      assert.ok(after.startsWith(`${'x'.repeat(2048)}0\n`), 'existing head is untouched by the failed rotation')
      assert.ok(after.endsWith('{"type":"probe","n":1}\n'), 'the append itself still succeeded')
    } finally {
      rmSync(AUDIT_TMP, { recursive: true, force: true })
    }
  })
})
