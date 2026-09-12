/**
 * dsh-auto-approval-llm · a failed rotation must not deny a recorded allow.
 *
 * `appendAuditLine` returns whether the line was persisted, and every verdict
 * commit fails closed (denied) when it returns false. The append and the
 * rotation share one try/catch, so a rotation that could not replace the file
 * (a directory parked at the tmp path, EPERM/EBUSY from an AV or backup agent,
 * a full volume) reported failure for a line that was already durable: the
 * call flipped to denied while history.jsonl and the audit both already said
 * allowed-once, and the operator got a denial message that was not true.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAuditLine, MAX_AUDIT_BYTES, setAuditFilePathForTests } from '../lib/auto/audit.js'

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-audit-rotate-'))
  const file = join(dir, 'audit.jsonl')
  setAuditFilePathForTests(file)
  try {
    fn(file)
  } finally {
    setAuditFilePathForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

const oversized = () => {
  const line = `${'x'.repeat(1024)}\n`
  return line.repeat(Math.ceil((MAX_AUDIT_BYTES + 4096) / line.length))
}

test('a successful append reports success even when the rotation failed', () => {
  withScratch((file) => {
    writeFileSync(file, oversized())
    assert.ok(readFileSync(file, 'utf8').length > MAX_AUDIT_BYTES, 'the fixture is over the byte cap')
    // Block the atomic replace: a directory at the tmp path makes the tmp
    // write fail, so the append lands but the rotation cannot complete.
    mkdirSync(`${file}.tmp`)
    const persisted = appendAuditLine('{"type":"decision","outcome":"allowed-once"}')
    assert.equal(persisted, true, 'the line is durable, so the verdict must not be flipped to denied')
    assert.ok(readFileSync(file, 'utf8').endsWith('{"type":"decision","outcome":"allowed-once"}\n'), 'the appended line is in the file')
    assert.ok(existsSync(`${file}.tmp`), 'the blocked tmp path is left alone')
  })
})

test('a failed append still reports failure', () => {
  withScratch((file) => {
    // A directory at the audit path itself makes the append impossible.
    rmSync(file, { force: true })
    mkdirSync(file)
    assert.equal(appendAuditLine('{"type":"decision"}'), false, 'an unwritable target must keep failing closed')
  })
})

test('a normal append plus rotation still converges the file', () => {
  withScratch((file) => {
    writeFileSync(file, oversized())
    assert.equal(appendAuditLine('{"type":"probe","n":1}'), true)
    const after = readFileSync(file, 'utf8')
    assert.ok(Buffer.byteLength(after) <= MAX_AUDIT_BYTES, 'rotation converged under the byte cap')
    assert.ok(after.endsWith('{"type":"probe","n":1}\n'))
  })
})
