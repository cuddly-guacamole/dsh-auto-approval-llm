/**
 * dsh-auto-approval-llm · the boot probe classifies a failed write the way the
 * write ladder does.
 *
 * `probeRuntimeDirWritable()` used to relocate all six runtime files for ANY
 * error from its single `writeFileSync` — no same-path retry and no error-class
 * check — while the ladder it backs off into (`appendRuntimeLine`) relocates only
 * for an error that means "this location refuses writes". One transient sharing
 * violation on the probe path (`EBUSY`/`EPERM`, exactly what a Windows backup or
 * anti-virus scan raises) therefore moved the audit to the npm-owned package root
 * for the whole process lifetime and announced the directory as unusable.
 *
 * The contracts pinned here:
 *   1. a degradable probe failure (`EISDIR`, a directory where the probe file
 *      belongs) still relocates the files exactly once, with a warning — the
 *      behaviour the probe exists for must survive the classification;
 *   2. the probe consults the two shared predicates, in the ladder's order:
 *      retry guard → second attempt → degradable guard → relocation.
 *
 * Direction 3 — a NON-degradable probe failure (`ENOSPC`/`EIO`) must not relocate —
 * is not constructible on this platform: the probe writes a fixed empty payload to
 * a path inside the directory `ensureRuntimeDir()` has just accepted, so there is
 * no way to raise a post-open error there from a test. That direction is carried by
 * the anchor below plus the shared predicate table in
 * `tests/runtime-write-fallback.test.mjs` (which asserts `ENOSPC`/`EIO`/`EMFILE`
 * relocate nothing), not by an unverified claim.
 *
 * Run: node --test tests/runtime-probe-error-class.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIT_FILENAME,
  probeRuntimeDirWritable,
  resolveRuntimeWritePath,
  setRuntimePathsForTests,
} from '../lib/auto/runtime-paths.js'

/** A scratch state directory plus a legacy root; `setup` plants the shape first. */
function sandbox(setup, body) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-probe-'))
  const legacyRoot = join(dir, 'plugin-root')
  const stateDir = join(dir, 'dsh-home', 'auto-approval-llm')
  mkdirSync(legacyRoot, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  try {
    setRuntimePathsForTests({ stateDir, legacyRoot })
    if (setup) setup({ dir, legacyRoot, stateDir })
    return body({ dir, legacyRoot, stateDir })
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Silence the one-time relocation warning; returns the captured messages. */
function captureWarnings(body) {
  const original = console.warn
  const seen = []
  console.warn = (...args) => { seen.push(args.join(' ')) }
  try {
    body()
  } finally {
    console.warn = original
  }
  return seen
}

test('probe: a degradable failure still relocates the files once, and says so', () => {
  sandbox(({ stateDir }) => {
    // Real EISDIR: the probe path itself is a directory, so the empty-payload
    // write can never succeed.
    mkdirSync(join(stateDir, `.write-probe-${process.pid}`), { recursive: true })
  }, ({ legacyRoot, stateDir }) => {
    const warnings = captureWarnings(() => {
      assert.equal(probeRuntimeDirWritable(), false)
    })
    assert.equal(warnings.length, 1, 'exactly one warning, not one per write')
    assert.match(warnings[0], /cannot use/)
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(legacyRoot, AUDIT_FILENAME))
    assert.deepEqual(readdirSync(stateDir), [`.write-probe-${process.pid}`])
  })
})

test('probe: a writable directory is still accepted and left untouched', () => {
  sandbox(undefined, ({ stateDir }) => {
    const warnings = captureWarnings(() => {
      assert.equal(probeRuntimeDirWritable(), true)
    })
    assert.deepEqual(warnings, [])
    assert.deepEqual(readdirSync(stateDir), [], 'the probe file is removed again')
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
  })
})

test('probe: the failure is classified by the ladder predicates, in the ladder order', () => {
  // The retry/degrade split of a PROBE failure is not constructible with a real
  // filesystem failure here (see the file header), so it is pinned against the
  // compiled artifact: the first attempt must be followed by the retry guard, the
  // second attempt, the degradable guard, and only then the relocation.
  const lib = readFileSync(fileURLToPath(new URL('../lib/auto/runtime-paths.js', import.meta.url)), 'utf8')
  const start = lib.indexOf('export function probeRuntimeDirWritable')
  assert.ok(start >= 0, 'the probe is still exported from the compiled module')
  const body = lib.slice(start, lib.indexOf('\nfunction ', start))
  const firstAttempt = body.indexOf('probeRuntimeWrite(probe)')
  const retryGuard = body.indexOf('isRetryableRuntimeWriteError')
  const secondAttempt = body.indexOf('probeRuntimeWrite(probe)', firstAttempt + 1)
  const degradeGuard = body.indexOf('isDegradableRuntimeWriteError')
  const degrade = body.indexOf('degradeToLegacy()')
  assert.ok(firstAttempt >= 0 && retryGuard >= 0 && secondAttempt >= 0,
    'the probe keeps its single same-path retry')
  assert.ok(degradeGuard >= 0 && degrade >= 0, 'the probe keeps its degradation step')
  assert.ok(firstAttempt < retryGuard && retryGuard < secondAttempt,
    'the retry guard must precede the retried attempt')
  assert.ok(secondAttempt < degradeGuard && degradeGuard < degrade,
    'only a degradable error may relocate the runtime files')
})
