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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIT_FILENAME,
  appendRuntimeLine,
  isDegradableRuntimeWriteError,
  legacyRootFilePath,
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

test('the ladder checks the error class BEFORE replaying the line', () => {
  // The same-path retry exists only to absorb a transient sharing violation. It
  // must not run for an error that can fail AFTER a partial write (ENOSPC and
  // friends): replaying the same text would splice a fragment and a full line
  // into one corrupt record, i.e. a silently lost audit line. That ordering is
  // not constructible with a real filesystem failure on this platform, so it is
  // pinned against the compiled artifact instead: the first class check must
  // precede the second attempt at the same path in `appendRuntimeLine`.
  const lib = readFileSync(fileURLToPath(new URL('../lib/auto/runtime-paths.js', import.meta.url)), 'utf8')
  const body = lib.slice(lib.indexOf('export function appendRuntimeLine'), lib.indexOf('export function writeRuntimeAtomic'))
  const firstCheck = body.indexOf('isDegradableRuntimeWriteError(lastWriteError)')
  const secondAttempt = body.indexOf('tryAppend(primary, text)', body.indexOf('tryAppend(primary, text)') + 1)
  assert.ok(firstCheck >= 0, 'the ladder must consult the error class')
  assert.ok(secondAttempt >= 0, 'the ladder must keep its single same-path retry')
  assert.ok(firstCheck < secondAttempt, 'the error class must be judged before the retry, not after')
})

test('the degradable set is exactly the "location refuses writes" codes', () => {
  // Pins the whitelist in both directions. The negative side is the safety
  // property: ENOSPC/EIO/EMFILE mean bytes may already have moved, so a silent
  // relocation would trade a loud failure for a quiet one.
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR']) {
    assert.equal(isDegradableRuntimeWriteError({ code }), true, `${code} should degrade`)
  }
  for (const code of ['ENOSPC', 'EIO', 'EMFILE', 'ENOENT', 'ERR_INVALID_ARG_TYPE', 'ENAMETOOLONG']) {
    assert.equal(isDegradableRuntimeWriteError({ code }), false, `${code} must stay fail-closed`)
  }
  // A plain Error and a thrown string carry no verdict and must not degrade.
  assert.equal(isDegradableRuntimeWriteError(new Error('boom')), false)
  assert.equal(isDegradableRuntimeWriteError('boom'), false)
  assert.equal(isDegradableRuntimeWriteError(undefined), false)
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
