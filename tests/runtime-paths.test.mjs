/**
 * dsh-auto-approval-llm · where the runtime files live, and how the move is safe.
 *
 * The plugin's six persisted files used to sit beside `package.json`. They now
 * belong in `<plugin root>/runtime/`, which is a host-seam change: it moves the
 * approval history, the append-only audit and the confirmation-learning store,
 * so getting it wrong loses data for installs that already have it.
 *
 * Three rules are pinned here, and the third is the one that is easy to get
 * backwards:
 *   1. the canonical location is `runtime/`, and the default is derived from the
 *      module's own location (never a hardcoded checkout path);
 *   2. a missing `runtime/` file is READ from the pre-move root path, so an
 *      upgrading install does not start with an empty learning store;
 *   3. the canonical path WINS when both exist — a stale root copy must not
 *      shadow the live file once the move has happened.
 *
 * The failure path is pinned too. The audit is the fail-closed commit gate, so a
 * directory that cannot be created must fall back to the old location with a
 * warning rather than making every verdict unauditable.
 *
 * Run: node --test tests/runtime-paths.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIT_FILENAME,
  DEBUG_FILENAME,
  HISTORY_FILENAME,
  LATENCY_FILENAME,
  LEARNING_FILENAME,
  REVIEW_MODE_FILENAME,
  RUNTIME_FILENAMES,
  ensureRuntimeDir,
  legacyRootFilePath,
  resolveRuntimeReadPath,
  resolveRuntimeWritePath,
  runtimeDirPath,
  runtimeFilePath,
  setRuntimePathsForTests,
} from '../lib/auto/runtime-paths.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Run `body` with both roots redirected into a scratch tree, then clean up. */
function sandbox(body) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-paths-'))
  const legacyRoot = join(dir, 'plugin-root')
  const runtimeDir = join(legacyRoot, 'runtime')
  mkdirSync(legacyRoot, { recursive: true })
  try {
    setRuntimePathsForTests({ legacyRoot, runtimeDir })
    return body({ dir, legacyRoot, runtimeDir })
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the canonical location is runtime/ under the plugin root', () => {
  // The default must be derived from the module location, not a hardcoded
  // checkout path: a worktree, a CI checkout or another user must all get their
  // own plugin root.
  assert.equal(runtimeDirPath(), join(REPO_ROOT, 'runtime'))
  for (const name of RUNTIME_FILENAMES) {
    assert.equal(runtimeFilePath(name), join(REPO_ROOT, 'runtime', name))
  }
  assert.equal(legacyRootFilePath(HISTORY_FILENAME), join(REPO_ROOT, HISTORY_FILENAME))
  assert.ok(!runtimeFilePath(AUDIT_FILENAME).includes('T/A') && !runtimeFilePath(AUDIT_FILENAME).includes('C:/Users/'), 'no checkout path is baked in')
})

test('every persisted file has exactly one name and the set has no duplicates', () => {
  const expected = [
    'history.jsonl',
    'audit.jsonl',
    'approval-debug.jsonl',
    'llm-latency.jsonl',
    'learning.json',
    'review-mode.json',
  ]
  assert.deepEqual([...RUNTIME_FILENAMES].sort(), [...expected].sort())
  assert.equal(new Set(RUNTIME_FILENAMES).size, RUNTIME_FILENAMES.length, 'the set has no duplicate names')
  // The single exported constant per file must agree with the set.
  assert.deepEqual(
    [HISTORY_FILENAME, AUDIT_FILENAME, DEBUG_FILENAME, LATENCY_FILENAME, LEARNING_FILENAME, REVIEW_MODE_FILENAME].sort(),
    [...expected].sort(),
  )
})

test('read falls back to the pre-move root file when the runtime copy is absent', () => {
  sandbox(({ legacyRoot, runtimeDir }) => {
    // The upgrade case: the file only exists at the old location.
    writeFileSync(join(legacyRoot, LEARNING_FILENAME), '{"entries":[]}')
    assert.equal(resolveRuntimeReadPath(LEARNING_FILENAME), join(legacyRoot, LEARNING_FILENAME))

    // With neither present, the read reports the canonical path (not a legacy
    // one), so a missing-file error names the location writes would use.
    assert.equal(resolveRuntimeReadPath(REVIEW_MODE_FILENAME), join(runtimeDir, REVIEW_MODE_FILENAME))
  })
})

test('the canonical runtime copy wins when both locations have the file', () => {
  // Rule 3, and the direction that matters: after the move, a leftover root copy
  // must never shadow the live data.
  sandbox(({ legacyRoot, runtimeDir }) => {
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(legacyRoot, LEARNING_FILENAME), '{"where":"legacy"}')
    writeFileSync(join(runtimeDir, LEARNING_FILENAME), '{"where":"runtime"}')
    assert.equal(resolveRuntimeReadPath(LEARNING_FILENAME), join(runtimeDir, LEARNING_FILENAME))
  })
})

test('write creates the runtime directory and lands there, not in the root', () => {
  sandbox(({ legacyRoot, runtimeDir }) => {
    assert.equal(existsSync(runtimeDir), false, 'precondition: the directory does not exist yet')
    const path = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.equal(path, join(runtimeDir, HISTORY_FILENAME))
    assert.ok(existsSync(runtimeDir), 'the write path creates the directory')
    assert.equal(existsSync(join(legacyRoot, HISTORY_FILENAME)), false, 'nothing is written to the old root')
  })
})

test('ensureRuntimeDir is idempotent and reports success', () => {
  sandbox(({ runtimeDir }) => {
    assert.equal(ensureRuntimeDir(), true)
    assert.equal(ensureRuntimeDir(), true, 'a second call is a cached success, not an error')
    assert.ok(existsSync(runtimeDir))
  })
})

test('an unusable runtime directory falls back to the old root instead of failing', () => {
  // The fail-closed-adjacent path: appendAuditLine returning false makes every
  // verdict unauditable, so an unwritable runtime/ must degrade to the old
  // writable location rather than break the gate.
  const dir = mkdtempSync(join(tmpdir(), 'runtime-paths-blocked-'))
  const legacyRoot = join(dir, 'plugin-root')
  mkdirSync(legacyRoot, { recursive: true })
  // A FILE where the runtime directory should go: mkdirSync cannot succeed.
  const runtimeDir = join(legacyRoot, 'runtime')
  writeFileSync(runtimeDir, 'not a directory')
  try {
    setRuntimePathsForTests({ legacyRoot, runtimeDir })
    assert.equal(ensureRuntimeDir(), false, 'the directory cannot be created')
    const path = resolveRuntimeWritePath(AUDIT_FILENAME)
    assert.equal(path, join(legacyRoot, AUDIT_FILENAME), 'writes fall back to the pre-move root path')
    assert.equal(path, legacyRootFilePath(AUDIT_FILENAME))
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory removed after a cached success is detected and recreated', () => {
  // The split brain this pins: `runtime/` is gitignored, so a `git clean -xdf`
  // or an installer replacing the plugin directory can delete it under a live
  // host. If the cached success were trusted blindly, the write path would keep
  // aiming at the REMOVED directory while the read path fell back to the legacy
  // file — the write silently stops persisting and the audit gate refuses every
  // verdict. Ask and answer must not diverge.
  sandbox(({ legacyRoot, runtimeDir }) => {
    assert.equal(ensureRuntimeDir(), true, 'precondition: the directory exists and is cached as usable')
    writeFileSync(join(legacyRoot, HISTORY_FILENAME), '{"id":"legacy"}\n')
    rmSync(runtimeDir, { recursive: true, force: true })

    const writePath = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.ok(existsSync(runtimeDir), 'the directory is recreated rather than assumed')
    assert.equal(writePath, join(runtimeDir, HISTORY_FILENAME), 'the write path is real, not a removed path')
    assert.equal(
      resolveRuntimeReadPath(HISTORY_FILENAME),
      writePath,
      'read and write must agree: a divergence is the split brain',
    )
  })
})

test('a transient directory failure is retried rather than cached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-paths-transient-'))
  const legacyRoot = join(dir, 'plugin-root')
  mkdirSync(legacyRoot, { recursive: true })
  const runtimeDir = join(legacyRoot, 'runtime')
  writeFileSync(runtimeDir, 'blocker')
  try {
    setRuntimePathsForTests({ legacyRoot, runtimeDir })
    assert.equal(ensureRuntimeDir(), false)
    assert.equal(resolveRuntimeWritePath(HISTORY_FILENAME), join(legacyRoot, HISTORY_FILENAME), 'writes fall back')
    // Remove the blocker: the next attempt must succeed rather than replay the
    // cached failure.
    rmSync(runtimeDir, { force: true })
    assert.equal(ensureRuntimeDir(), true, 'success is retried after the blocker clears')
    assert.equal(resolveRuntimeWritePath(HISTORY_FILENAME), join(runtimeDir, HISTORY_FILENAME), 'writes return home')
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an append-only file carries pre-move content forward before the first write', () => {
  // The upgrade path that would otherwise lose data silently. history.jsonl is
  // append-only: the first post-upgrade write lands in a brand-new
  // runtime/history.jsonl, and once that file exists the read rule stops
  // consulting the legacy copy (the runtime copy wins). Without the carry
  // forward, a restart would show only the records written since the upgrade.
  sandbox(({ legacyRoot, runtimeDir }) => {
    const legacyContent = '{"id":"before-move"}\n'
    writeFileSync(join(legacyRoot, HISTORY_FILENAME), legacyContent)

    const target = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.equal(target, join(runtimeDir, HISTORY_FILENAME))
    assert.equal(
      readFileSync(target, 'utf8'),
      legacyContent,
      'the pre-move records are carried into the runtime file',
    )
    assert.equal(readFileSync(join(legacyRoot, HISTORY_FILENAME), 'utf8'), legacyContent, 'the legacy file is left intact')
  })
})

test('the carry forward never clobbers a runtime file that already has content', () => {
  // The dangerous inverse: if the runtime copy already exists and is authoritative,
  // copying the stale legacy content over it would lose exactly the data the move
  // was supposed to protect.
  sandbox(({ legacyRoot, runtimeDir }) => {
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(legacyRoot, AUDIT_FILENAME), 'stale\n')
    writeFileSync(join(runtimeDir, AUDIT_FILENAME), 'live\n')
    const target = resolveRuntimeWritePath(AUDIT_FILENAME)
    assert.equal(target, join(runtimeDir, AUDIT_FILENAME))
    assert.equal(readFileSync(target, 'utf8'), 'live\n', 'the existing runtime content is untouched')
  })
})

test('overwrite-style files are not carried forward — they persist whole state', () => {
  // learning.json / review-mode.json are rewritten in full from the in-memory
  // store (which was loaded through the read fallback), so a carry forward would
  // be redundant work on the hot persist path.
  sandbox(({ legacyRoot, runtimeDir }) => {
    writeFileSync(join(legacyRoot, LEARNING_FILENAME), '{"legacy":true}')
    const target = resolveRuntimeWritePath(LEARNING_FILENAME)
    assert.equal(target, join(runtimeDir, LEARNING_FILENAME))
    assert.equal(existsSync(target), false, 'no copy is made; the caller writes the merged store here')
  })
})

test('a copy that cannot complete leaves no truncated target to shadow the legacy file', () => {
  // The target's mere existence stops the read rule consulting the legacy file,
  // so a copy that fails PARTWAY would permanently shadow data that is still
  // intact — the silent partial loss the carry-forward exists to prevent. The
  // copy is therefore staged and renamed, and a failure leaves nothing behind.
  sandbox(({ legacyRoot, runtimeDir }) => {
    // A DIRECTORY where the legacy file should be, so the copy cannot succeed.
    mkdirSync(join(legacyRoot, HISTORY_FILENAME), { recursive: true })
    const target = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.equal(target, join(runtimeDir, HISTORY_FILENAME), 'the append target is still returned')
    assert.equal(existsSync(target), false, 'no target is fabricated when the copy fails')
    // No staging litter either: a stray temp file would be indistinguishable
    // from a real one on the next run.
    const strays = readdirSync(runtimeDir).filter((n) => n.includes('carry'))
    assert.deepEqual(strays, [], 'the staging file is cleaned up on failure')
  })
})

test('the carry forward stages through a temp file rather than copying in place', () => {
  // Pins the atomicity mechanism directly: a partially written target is worse
  // than no target, because existence alone wins the read.
  const source = readFileSync(new URL('../src/auto/runtime-paths.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('function carryForwardAppendOnly'))
  assert.match(body, /copyFileSync\(legacy, tmp\)/, 'the copy goes to a staging path')
  assert.match(body, /renameSync\(tmp, target\)/, 'and is renamed into place, so the target is never partial')
  assert.ok(
    body.indexOf('renameSync(tmp, target)') < body.indexOf('catch'),
    'the rename completes before any failure handling, so a partial copy never becomes the target',
  )
})

test('the runtime directory does not leak into a clean checkout', () => {
  // With no override, nothing in this test may create <repo>/runtime: the suite
  // must not leave a directory behind in the working tree. This also pins that
  // merely REPORTING a path has no side effect.
  const entriesBefore = new Set(readdirSync(REPO_ROOT))
  for (const name of RUNTIME_FILENAMES) {
    void runtimeFilePath(name)
  }
  void runtimeDirPath()
  void legacyRootFilePath(HISTORY_FILENAME)
  const entriesAfter = new Set(readdirSync(REPO_ROOT))
  assert.deepEqual([...entriesAfter].sort(), [...entriesBefore].sort(), 'reporting paths must not create anything')
})
