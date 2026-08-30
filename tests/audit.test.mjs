// Contract tests for src/auto/audit.ts rotation (F3-audit).
//
// Rotation was byte-triggered (>5MB stat) but line-bounded (5000 lines), so
// files whose lines average >1KB could never shrink below the trigger and
// every append re-ran a full read→split→slice→join→write (O(n²) amplification).
// auditRotateContent now converges on BOTH bounds in one backward byte scan,
// and appendAuditLine replaces the file atomically (tmp + rename).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { appendAuditLine, auditFilePath, auditRotateContent, MAX_AUDIT_BYTES, MAX_AUDIT_LINES } from '../lib/auto/audit.js'

const AUDIT_FILE = auditFilePath()
const AUDIT_TMP = `${AUDIT_FILE}.tmp`

// appendAuditLine writes the real plugin-root audit.jsonl (no injection
// point), so every test snapshots/restores it and removes any tmp residue.
function withAuditBackup(fn) {
  const backup = `${AUDIT_FILE}.bak-test`
  const had = existsSync(AUDIT_FILE)
  if (had) renameSync(AUDIT_FILE, backup)
  try {
    fn()
  } finally {
    rmSync(AUDIT_FILE, { force: true })
    rmSync(AUDIT_TMP, { force: true })
    if (had) renameSync(backup, AUDIT_FILE)
  }
}

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

test('appendAuditLine: rotation converges the real file atomically with no tmp residue', () => {
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
