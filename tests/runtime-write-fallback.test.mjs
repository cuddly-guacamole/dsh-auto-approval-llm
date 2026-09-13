/**
 * dsh-auto-approval-llm · what a failing runtime write does now that the
 * fallback chain is retired.
 *
 * There is exactly one runtime location (`<DSH_HOME>/auto-approval-llm/`), so a
 * write that cannot land there fails: `appendRuntimeLine` returns undefined and
 * `writeRuntimeAtomic` returns false, which makes the audit gate refuse every
 * verdict — loud and fail-closed, never a silent relocation into the npm-owned
 * package tree. What remains is the same-path retry, and its boundary is what
 * this file pins:
 *   1. the retry exists only for errors raised while OPENING the target, where
 *      no byte has moved — a retried write cannot duplicate or splice a record;
 *   2. errors that can fail after bytes moved (`ENOSPC`, `EIO`, `EMFILE`) are
 *      never retried, because replaying the same text would splice a fragment
 *      and a full line into one corrupt record;
 *   3. a failure that is not about the location at all (a bad argument) keeps
 *      failing closed without any retry or relocation.
 *
 * The indistinguishable-on-Windows permission case (ACL denial) is NOT
 * constructed here: on this platform `chmod 0o555` does not stop writes, so the
 * open-stage failure shape used is a directory where the target file belongs
 * (EISDIR).
 *
 * Run: node --test tests/runtime-write-fallback.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIT_FILENAME,
  appendRuntimeLine,
  isRetryableRuntimeWriteError,
  resolveRuntimeWritePath,
  runtimeFilePath,
  setRuntimePathsForTests,
  writeRuntimeAtomic,
} from '../lib/auto/runtime-paths.js'

/** A scratch chain with an existing, normally-writable state directory. */
function sandbox(setup, body) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-write-'))
  const stateDir = join(dir, 'dsh-home', 'auto-approval-llm')
  mkdirSync(stateDir, { recursive: true })
  try {
    setRuntimePathsForTests({ stateDir })
    if (setup) setup({ dir, stateDir })
    return body({ dir, stateDir })
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('an open-stage failure keeps failing closed without relocating anything', () => {
  sandbox(({ stateDir }) => {
    // Real EISDIR: a directory where the audit file belongs, so every open of it
    // fails before any byte moves. There is no fallback location to relocate to,
    // so the write fails and the caller (the audit gate) fails closed.
    mkdirSync(join(stateDir, AUDIT_FILENAME), { recursive: true })
  }, ({ stateDir }) => {
    assert.equal(appendRuntimeLine(AUDIT_FILENAME, '{"a":1}\n'), undefined)
    assert.equal(writeRuntimeAtomic(AUDIT_FILENAME, '{"a":1}'), false)
    // The planted directory is still a directory: nothing was written "into" it,
    // and no copy of the record appeared anywhere else in the state directory.
    assert.ok(existsSync(join(stateDir, AUDIT_FILENAME)))
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
  })
})

test('a failure that is not about the location keeps failing closed, without a retry', () => {
  // Real failure, no mock: a non-string payload is rejected by `appendFileSync`
  // before any byte moves (ERR_INVALID_ARG_TYPE). It says nothing about the
  // directory and is not in the retryable set, so the ladder must not retry it
  // or change anything about the location.
  sandbox(undefined, ({ stateDir }) => {
    assert.equal(appendRuntimeLine(AUDIT_FILENAME, { not: 'a string' }), undefined)
    assert.equal(writeRuntimeAtomic(AUDIT_FILENAME, { not: 'a string' }), false)
    assert.ok(!existsSync(runtimeFilePath(AUDIT_FILENAME)))
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
  })
})

test('the retryable set covers only open-stage errors; post-write errors are never retried', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'EBUSY', 'EAGAIN', 'EINTR']) {
    assert.equal(isRetryableRuntimeWriteError({ code }), true, `${code} should be retryable`)
  }
  for (const code of ['ENOSPC', 'EIO', 'EMFILE', 'ERR_INVALID_ARG_TYPE', 'ENAMETOOLONG']) {
    assert.equal(isRetryableRuntimeWriteError({ code }), false, `${code} must not be retried`)
  }
  assert.equal(isRetryableRuntimeWriteError(new Error('boom')), false)
  assert.equal(isRetryableRuntimeWriteError(undefined), false)
})

test('the ladder retries at the SAME path and has no relocation step', () => {
  // Pinned against the compiled artifact: the retry guard must precede the
  // second attempt, and the retired degradation must not have crept back.
  const lib = readFileSync(fileURLToPath(new URL('../lib/auto/runtime-paths.js', import.meta.url)), 'utf8')
  const body = lib.slice(lib.indexOf('export function appendRuntimeLine'), lib.indexOf('export function writeRuntimeAtomic'))
  const firstAttempt = body.indexOf('tryAppend(primary, text)')
  const retryGuard = body.indexOf('isRetryableRuntimeWriteError')
  const secondAttempt = body.indexOf('tryAppend(primary, text)', firstAttempt + 1)
  assert.ok(firstAttempt >= 0 && retryGuard >= 0 && secondAttempt >= 0, 'the ladder keeps its single same-path retry')
  assert.ok(firstAttempt < retryGuard && retryGuard < secondAttempt, 'the retry guard must precede the retry')
  assert.ok(!body.includes('degradeToLegacy'), 'the ladder has no relocation step')
})
