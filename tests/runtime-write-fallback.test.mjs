/**
 * dsh-auto-approval-llm · a runtime directory that exists but refuses writes.
 *
 * `mkdirSync(dir, { recursive: true })` reports SUCCESS on a directory that
 * already exists, so the original "can I make the directory?" test could not see
 * a directory that exists while rejecting every write. That state is not exotic:
 * a state directory created by another account, a read-only mount, or a stray
 * directory where a runtime file belongs. Its consequence was the worst one
 * available: `appendAuditLine` returned false, and the fail-closed gate then
 * refused every verdict while the other files stopped persisting in silence.
 *
 * The contracts pinned here:
 *   1. the boot probe notices the rejection and degrades ONCE, with a warning;
 *   2. the write ladder notices it too, and the record still lands somewhere
 *      (relocating is not the same as dropping it);
 *   3. degradation is STICKY — a directory already shown to reject writes is not
 *      retried on every append;
 *   4. the ladder degrades only on "this location refuses writes" errors. An
 *      error raised after bytes moved (or before anything was written for an
 *      unrelated reason) must keep failing closed instead of silently moving the
 *      audit somewhere else. Both directions are exercised with real filesystem
 *      failures, not by asserting the whitelist against itself.
 *
 * The indistinguishable-on-Windows permission case (ACL denial) is NOT
 * constructed here: on this platform `chmod 0o555` does not stop writes, so the
 * degradable shape used is a directory where the target file belongs (EISDIR).
 *
 * Run: node --test tests/runtime-write-fallback.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIT_FILENAME,
  appendRuntimeLine,
  HISTORY_FILENAME,
  LATENCY_FILENAME,
  isDegradableRuntimeWriteError,
  isRetryableRuntimeWriteError,
  legacyRootFilePath,
  reconcileRuntimeCopies,
  probeRuntimeDirWritable,
  resolveRuntimeReadPath,
  resolveRuntimeWritePath,
  runtimeFilePath,
  setRuntimePathsForTests,
  setRuntimeStateDir,
  stateDirPath,
  writeRuntimeAtomic,
} from '../lib/auto/runtime-paths.js'

/**
 * A scratch chain: an existing, normally-writable state directory plus a legacy
 * root. `setup` runs after the directories exist and before any resolution, which
 * is where a test plants the shape that makes the directory unusable.
 */
function sandbox(setup, body) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-write-'))
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

test('a writable state directory is left alone (the probe must not degrade on its own)', () => {
  sandbox(undefined, ({ stateDir }) => {
    const warnings = captureWarnings(() => {
      assert.equal(probeRuntimeDirWritable(), true)
    })
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
    assert.deepEqual(warnings, [])
    // The probe cleans up after itself rather than leaving a file behind.
    assert.deepEqual(readdirSync(stateDir), [])
  })
})

test('the boot probe degrades once when the directory rejects writes, and says where files went', () => {
  sandbox(({ stateDir }) => {
    // Plant a DIRECTORY where the probe file belongs: the directory itself is
    // fine, but this path can never be written.
    mkdirSync(join(stateDir, `.write-probe-${process.pid}`), { recursive: true })
  }, ({ legacyRoot, stateDir }) => {
    const warnings = captureWarnings(() => {
      assert.equal(probeRuntimeDirWritable(), false)
    })
    assert.equal(warnings.length, 1, 'exactly one warning, not one per write')
    assert.match(warnings[0], /cannot use/)
    assert.ok(warnings[0].includes(legacyRoot), 'the warning names the location actually used')
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(legacyRoot, AUDIT_FILENAME))
    // Nothing was written into the unusable directory beyond the planted entry.
    assert.deepEqual(readdirSync(stateDir), [`.write-probe-${process.pid}`])
  })
})

test('degradation is sticky: the rejected directory is not retried on later writes', () => {
  sandbox(({ stateDir }) => {
    mkdirSync(join(stateDir, `.write-probe-${process.pid}`), { recursive: true })
  }, ({ legacyRoot }) => {
    captureWarnings(() => {
      assert.equal(probeRuntimeDirWritable(), false)
    })
    const first = appendRuntimeLine(AUDIT_FILENAME, 'one\n')
    const second = appendRuntimeLine(AUDIT_FILENAME, 'two\n')
    assert.equal(first, join(legacyRoot, AUDIT_FILENAME))
    assert.equal(second, first)
    assert.equal(readFileSync(join(legacyRoot, AUDIT_FILENAME), 'utf8'), 'one\ntwo\n')
  })
})

test('an append that fails against the directory relocates the record instead of dropping it', () => {
  sandbox(({ stateDir }) => {
    // No boot probe here: this is the runtime failure path.
    mkdirSync(join(stateDir, AUDIT_FILENAME), { recursive: true })
  }, ({ legacyRoot, stateDir }) => {
    const warnings = captureWarnings(() => {
      const file = appendRuntimeLine(AUDIT_FILENAME, '{"a":1}\n')
      assert.equal(file, join(legacyRoot, AUDIT_FILENAME))
    })
    assert.equal(readFileSync(join(legacyRoot, AUDIT_FILENAME), 'utf8'), '{"a":1}\n')
    assert.equal(warnings.length, 1)
    // The planted directory is still a directory: nothing was written "into" it.
    assert.ok(existsSync(join(stateDir, AUDIT_FILENAME)))
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(legacyRoot, AUDIT_FILENAME))
  })
})

test('the atomic writer relocates the whole snapshot on the same rule', () => {
  sandbox(({ stateDir }) => {
    mkdirSync(join(stateDir, 'review-mode.json'), { recursive: true })
  }, ({ legacyRoot }) => {
    captureWarnings(() => {
      assert.equal(writeRuntimeAtomic('review-mode.json', '{"s":"manual"}', '.tmp'), true)
    })
    assert.equal(readFileSync(join(legacyRoot, 'review-mode.json'), 'utf8'), '{"s":"manual"}')
    // No temp file is left behind at either location.
    assert.ok(!existsSync(join(legacyRoot, 'review-mode.json.tmp')))
  })
})

test('degradation keeps the read chain and the write chain on the SAME file', () => {
  sandbox(({ stateDir }) => {
    // A canonical copy exists and holds rows; then the file position becomes
    // unusable while the directory itself stays fine.
    mkdirSync(join(stateDir, AUDIT_FILENAME), { recursive: true })
  }, ({ legacyRoot, stateDir }) => {
    captureWarnings(() => {
      assert.ok(appendRuntimeLine(AUDIT_FILENAME, '{"row":"legacy"}\n') !== undefined)
    })
    // The invariant runtime-paths.test.mjs already states for the other failure
    // shape: a read that disagrees with the write chain is a split brain. Here it
    // would mean the process appends where it never reads back — every persisted
    // mode/learning/history change silently lost on the next load.
    assert.equal(resolveRuntimeReadPath(AUDIT_FILENAME), resolveRuntimeWritePath(AUDIT_FILENAME))
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(legacyRoot, AUDIT_FILENAME))
    // The planted directory at the canonical file position is untouched.
    assert.ok(existsSync(join(stateDir, AUDIT_FILENAME)))
  })
})

test('degradation carries the canonical append-only content into the new location', () => {
  sandbox(({ stateDir }) => {
    // Pre-degrade rows live ONLY in the canonical file...
    writeFileSync(resolveRuntimeWritePath(AUDIT_FILENAME), '{"row":1}\n')
    // ...and the boot probe is the constructible way to degrade while that file
    // still exists: make the probe path itself unwritable.
    mkdirSync(join(stateDir, `.write-probe-${process.pid}`), { recursive: true })
  }, ({ legacyRoot }) => {
    captureWarnings(() => {
      assert.equal(probeRuntimeDirWritable(), false)
    })
    // The read rule now follows the write chain, so rows that stayed behind in a
    // frozen canonical copy would be unreachable forever.
    const legacy = readFileSync(join(legacyRoot, AUDIT_FILENAME), 'utf8')
    assert.match(legacy, /\{"row":1\}/, 'the pre-degrade row survives in the location now being written')
  })
})

test('a failure that is NOT "this location refuses writes" keeps failing closed, without relocating', () => {
  // Real failure, no mock: a non-string payload is rejected by `appendFileSync`
  // before any byte moves (ERR_INVALID_ARG_TYPE). It says nothing about the
  // directory, so the ladder must not retry it or move the runtime files because
  // of it — doing so would hide a genuine write bug behind a silent change of
  // location.
  sandbox(undefined, ({ stateDir }) => {
    const warnings = captureWarnings(() => {
      assert.equal(appendRuntimeLine(AUDIT_FILENAME, { not: 'a string' }), undefined)
      assert.equal(writeRuntimeAtomic(AUDIT_FILENAME, { not: 'a string' }), false)
    })
    assert.deepEqual(warnings, [])
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
    assert.ok(!existsSync(runtimeFilePath(AUDIT_FILENAME)))
  })
})

test('the ladder judges the error class BEFORE replaying the line, and only degrades on degradable codes', () => {
  // The same-path retry exists to absorb a transient sharing violation, and must
  // not run for an error that can fail AFTER a partial write (ENOSPC and friends):
  // replaying the same text would splice a fragment and a full line into one
  // corrupt record, i.e. a silently lost audit line. Neither that ordering nor the
  // retry/degrade split is constructible with a real filesystem failure on this
  // platform, so it is pinned against the compiled artifact instead: the retry
  // guard must precede the second attempt, which must precede the degradation.
  const lib = readFileSync(fileURLToPath(new URL('../lib/auto/runtime-paths.js', import.meta.url)), 'utf8')
  const body = lib.slice(lib.indexOf('export function appendRuntimeLine'), lib.indexOf('export function writeRuntimeAtomic'))
  const firstAttempt = body.indexOf('tryAppend(primary, text)')
  const retryGuard = body.indexOf('isRetryableRuntimeWriteError')
  const secondAttempt = body.indexOf('tryAppend(primary, text)', firstAttempt + 1)
  const degradeGuard = body.indexOf('isDegradableRuntimeWriteError')
  const degrade = body.indexOf('degradeToLegacy()')
  assert.ok(firstAttempt >= 0 && retryGuard >= 0 && secondAttempt >= 0, 'the ladder keeps its single same-path retry')
  assert.ok(degradeGuard >= 0 && degrade >= 0, 'the ladder keeps its degradation step')
  assert.ok(firstAttempt < retryGuard && retryGuard < secondAttempt, 'the retry guard must precede the retry')
  assert.ok(secondAttempt < degradeGuard && degradeGuard < degrade, 'only a degradable code may relocate the files')
})

test('degradation seeds the new location from the canonical copy, even when a legacy copy exists', () => {
  sandbox(undefined, ({ legacyRoot, stateDir }) => {
    // The post-migration steady state: migration never deletes the legacy copy, so
    // a stale legacy file is the NORM while the canonical file has kept growing.
    const legacyAudit = join(legacyRoot, AUDIT_FILENAME)
    writeFileSync(legacyAudit, '{"row":"pre-migration"}\n')
    utimesSync(legacyAudit, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    writeFileSync(join(stateDir, AUDIT_FILENAME), '{"row":"pre-migration"}\n{"row":"canonical-period"}\n')
    // Degradation is directory-level: trigger it through a DIFFERENT broken file so
    // the audit canonical copy stays readable.
    mkdirSync(join(stateDir, LATENCY_FILENAME), { recursive: true })

    captureWarnings(() => {
      assert.equal(appendRuntimeLine(LATENCY_FILENAME, '{"s":1}\n'), join(legacyRoot, LATENCY_FILENAME))
      assert.equal(appendRuntimeLine(AUDIT_FILENAME, '{"row":"degraded-window"}\n'), legacyAudit)
    })
    // Both periods must survive: the seeding copy is what stops the read chain
    // from flipping onto the frozen pre-migration snapshot.
    const content = readFileSync(resolveRuntimeReadPath(AUDIT_FILENAME), 'utf8')
    assert.match(content, /canonical-period/, 'records written before the degradation stay reachable')
    assert.match(content, /degraded-window/)
  })
})

test('a later boot carries the degraded-window records back into the canonical copy', () => {
  sandbox(undefined, ({ legacyRoot, stateDir }) => {
    // Simulate a previous process that degraded and appended there: the legacy
    // copy is newer than the canonical one (it was seeded from it, then written).
    writeFileSync(join(stateDir, AUDIT_FILENAME), '{"row":"pre-migration"}\n')
    utimesSync(join(stateDir, AUDIT_FILENAME), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    writeFileSync(join(legacyRoot, AUDIT_FILENAME), '{"row":"pre-migration"}\n{"row":"degraded-window"}\n')

    reconcileRuntimeCopies()

    // Without this, the next write to the canonical copy would make it the newer
    // one and the degraded window would be orphaned forever.
    const content = readFileSync(resolveRuntimeReadPath(AUDIT_FILENAME), 'utf8')
    assert.match(content, /degraded-window/)
    assert.equal(resolveRuntimeReadPath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
  })
})

test('reconciliation leaves a normal install alone', () => {
  sandbox(undefined, ({ legacyRoot, stateDir }) => {
    // Canonical copy is newer (the normal case): the stale legacy snapshot must
    // never be copied over live data.
    writeFileSync(join(legacyRoot, HISTORY_FILENAME), '{"stale":true}\n')
    utimesSync(join(legacyRoot, HISTORY_FILENAME), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    writeFileSync(join(stateDir, HISTORY_FILENAME), '{"live":true}\n')
    captureWarnings(() => {
      reconcileRuntimeCopies()
    })
    assert.equal(readFileSync(join(stateDir, HISTORY_FILENAME), 'utf8'), '{"live":true}\n')
  })
})

test('the degradable and retryable error sets are pinned separately', () => {
  // Degradable = "this location refuses writes", and every member is raised while
  // OPENING the target, so relocating the files is safe. Retryable additionally
  // covers the transient sharing violations; the errors that can fail AFTER bytes
  // moved must be in neither set.
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR']) {
    assert.equal(isDegradableRuntimeWriteError({ code }), true, `${code} should degrade`)
    assert.equal(isRetryableRuntimeWriteError({ code }), true, `${code} should be retryable`)
  }
  for (const code of ['EBUSY', 'EAGAIN', 'EINTR']) {
    assert.equal(isRetryableRuntimeWriteError({ code }), true, `${code} should be retryable`)
    assert.equal(isDegradableRuntimeWriteError({ code }), false, `${code} must not relocate`)
  }
  for (const code of ['ENOSPC', 'EIO', 'EMFILE', 'ERR_INVALID_ARG_TYPE', 'ENAMETOOLONG']) {
    assert.equal(isRetryableRuntimeWriteError({ code }), false, `${code} must not be retried`)
    assert.equal(isDegradableRuntimeWriteError({ code }), false, `${code} must stay fail-closed`)
  }
  assert.equal(isRetryableRuntimeWriteError(new Error('boom')), false)
  assert.equal(isRetryableRuntimeWriteError(undefined), false)
})


test('a re-aligned state directory starts with a clean verdict', () => {
  sandbox(({ stateDir }) => {
    mkdirSync(join(stateDir, `.write-probe-${process.pid}`), { recursive: true })
  }, ({ stateDir, legacyRoot }) => {
    captureWarnings(() => {
      assert.equal(probeRuntimeDirWritable(), false)
    })
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(legacyRoot, AUDIT_FILENAME))

    // The host re-aligns the directory at startup; a verdict about the previous
    // one must not survive it.
    setRuntimeStateDir(stateDirPath())
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
  })
})

test('the legacy fallback path is the only relocation target', () => {
  sandbox(({ stateDir }) => {
    mkdirSync(join(stateDir, AUDIT_FILENAME), { recursive: true })
  }, ({ legacyRoot }) => {
    captureWarnings(() => {
      appendRuntimeLine(AUDIT_FILENAME, 'x\n')
    })
    assert.equal(legacyRootFilePath(AUDIT_FILENAME), join(legacyRoot, AUDIT_FILENAME))
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), legacyRootFilePath(AUDIT_FILENAME))
  })
})
