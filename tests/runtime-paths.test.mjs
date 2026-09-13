/**
 * dsh-auto-approval-llm · where the runtime files live.
 *
 * The six persisted files belong in `<DSH_HOME>/auto-approval-llm/`, outside the
 * installed package, because npm replaces the package tree on a version upgrade.
 * There is exactly ONE location: the package-root fallback chain (read fallback,
 * carry-forward, write fallback, boot probe, copy reconciliation) was a one-way
 * migration shim for installs predating the DSH_HOME layout and has been retired
 * on the schedule its own note declared.
 *
 * The rules pinned here:
 *   1. the canonical directory is `<DSH_HOME>/auto-approval-llm`, derived from
 *      the environment (never a hardcoded checkout path);
 *   2. reads and writes always name the canonical path — a read that disagreed
 *      with the write chain would be a split brain;
 *   3. the write path creates the directory; a directory that cannot be created
 *      or refuses writes fails closed (the audit gate refuses every verdict)
 *      with a one-time warning, and never relocates records into the package;
 *   4. the usability cache is re-validated (a removed directory is recreated),
 *      and a transient failure is retried rather than cached;
 *   5. the host seam (`setRuntimeStateDir`) aligns the directory with the guard's
 *      dshHome and refuses relative spellings.
 *
 * Run: node --test tests/runtime-paths.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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
  resolveRuntimeReadPath,
  resolveRuntimeWritePath,
  runtimeFilePath,
  setRuntimePathsForTests,
  setRuntimeStateDir,
  stateDirPath,
} from '../lib/auto/runtime-paths.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Run `body` with the chain redirected into a scratch tree, then clean up. */
function sandbox(body) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-paths-'))
  const stateDir = join(dir, 'dsh-home', 'auto-approval-llm')
  try {
    setRuntimePathsForTests({ stateDir })
    return body({ dir, stateDir })
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the canonical location is <DSH_HOME>/auto-approval-llm', () => {
  // Derived from the environment, not a hardcoded checkout path: a worktree, a CI
  // checkout or another user must each get their own state directory.
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  assert.equal(stateDirPath(), join(dshHome, 'auto-approval-llm'))
  assert.ok(stateDirPath().startsWith(dshHome), 'the state directory lives under DSH_HOME')
  for (const name of RUNTIME_FILENAMES) {
    assert.equal(runtimeFilePath(name), join(dshHome, 'auto-approval-llm', name))
  }
  // The state directory must NOT be inside the package tree — that is the whole
  // point: npm replaces the package directory on a version upgrade.
  assert.ok(
    !stateDirPath().startsWith(REPO_ROOT),
    `state must live outside the installed package, got ${stateDirPath()}`,
  )
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
  assert.deepEqual(
    [HISTORY_FILENAME, AUDIT_FILENAME, DEBUG_FILENAME, LATENCY_FILENAME, LEARNING_FILENAME, REVIEW_MODE_FILENAME].sort(),
    [...expected].sort(),
  )
})

test('the retired <plugin root>/runtime/ layout is NOT read any more', () => {
  // That layout shipped in no release, so no install can have data there and the
  // compatibility branch was deleted. Pinned so it is not reintroduced by accident
  // (a reintroduction would need its own migration evidence).
  const source = readFileSync(new URL('../src/auto/runtime-paths.ts', import.meta.url), 'utf8')
  assert.ok(!/'runtime'\)/.test(source), 'no runtime/ path is derived any more')
  assert.ok(!source.includes('legacyRuntimeFilePath'), 'the runtime/ helper is gone')
})

test('the package-root fallback chain is retired from source and bundle', () => {
  // The migration shim (read fallback, carry-forward, write fallback, boot probe,
  // reconciliation) was removed on its own retirement schedule. Pinned so it is
  // not reintroduced silently: any of these names coming back means a fallback
  // location exists again, and the retirement contract requires exactly one.
  for (const file of ['../src/auto/runtime-paths.ts', '../lib/auto/runtime-paths.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const name of ['legacyRoot', 'carryForward', 'degradeToLegacy', 'probeRuntimeDirWritable', 'reconcileRuntimeCopies', 'PLUGIN_ROOT']) {
      assert.ok(!source.includes(name), `${file} must not carry the retired shim name ${name}`)
    }
  }
})

test('with nothing on disk the read and write paths are the canonical ones', () => {
  sandbox(({ stateDir }) => {
    assert.equal(resolveRuntimeReadPath(REVIEW_MODE_FILENAME), join(stateDir, REVIEW_MODE_FILENAME))
    assert.equal(resolveRuntimeWritePath(REVIEW_MODE_FILENAME), join(stateDir, REVIEW_MODE_FILENAME))
  })
})

test('the read path is the canonical path whether or not the file exists', () => {
  // One location means one answer: a file in some other directory can never be
  // consulted, and the canonical path is returned even before the file exists.
  sandbox(({ stateDir }) => {
    assert.equal(resolveRuntimeReadPath(LEARNING_FILENAME), join(stateDir, LEARNING_FILENAME))
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, LEARNING_FILENAME), '{"where":"state"}')
    assert.equal(resolveRuntimeReadPath(LEARNING_FILENAME), join(stateDir, LEARNING_FILENAME))
  })
})

test('write creates the canonical directory and lands there', () => {
  sandbox(({ stateDir }) => {
    assert.equal(existsSync(stateDir), false, 'precondition: the directory does not exist yet')
    const path = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.equal(path, join(stateDir, HISTORY_FILENAME))
    assert.ok(existsSync(stateDir), 'the write path creates the directory')
  })
})

test('setRuntimeStateDir is the host seam, and a relative path is refused', () => {
  // F1 regression. The state directory depends on `config.dshHome`, which only
  // exists inside apply(); a relative spelling would resolve against the process
  // cwd and could land the state outside the guarded tree, so it must be ignored
  // rather than stored.
  const dir = mkdtempSync(join(tmpdir(), 'runtime-paths-host-'))
  const absolute = join(dir, 'dsh-home', 'auto-approval-llm')
  const envDefault = stateDirPath()
  try {
    setRuntimeStateDir(absolute)
    assert.equal(stateDirPath(), absolute, 'an absolute host dir is honoured')

    setRuntimeStateDir('relative/auto-approval-llm')
    assert.equal(stateDirPath(), absolute, 'a relative path is ignored, keeping the last good value')
    assert.ok(isAbsolute(stateDirPath()), 'the effective directory is always absolute')

    setRuntimeStateDir(undefined)
    assert.equal(stateDirPath(), envDefault, 'undefined restores the environment-derived default')
  } finally {
    setRuntimeStateDir(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the host seam is applied before the stores are loaded', () => {
  // The ordering claim F1 violated. Reading from one directory while writing to
  // another is a split brain, so the load call must come after the seam is set.
  // Match the CALLS by their indentation, not the nearest mention: the name also
  // appears in the import list, in the function definition and in comments.
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const seamAt = source.search(/^\s+setRuntimeStateDir\(join\(/m)
  const loadAt = source.search(/^\s+loadRuntimeStores\(\)$/m)
  assert.ok(seamAt > 0, 'the host seam is called from apply()')
  assert.ok(loadAt > 0, 'the stores are loaded from apply()')
  assert.ok(seamAt < loadAt, 'the state directory is set BEFORE the stores are loaded')
  // And nothing may load them at module scope, which is what broke the ordering.
  assert.doesNotMatch(source, /^loadHistory\(\)$/m, 'history is not loaded at module load')
})

test('ensureRuntimeDir is idempotent and reports success', () => {
  sandbox(({ stateDir }) => {
    assert.equal(ensureRuntimeDir(), true)
    assert.equal(ensureRuntimeDir(), true, 'a second call is a cached success, not an error')
    assert.ok(existsSync(stateDir))
  })
})

test('a directory removed after a cached success is detected and recreated', () => {
  // The split brain this pins. If the cached success were trusted blindly, the
  // write path would keep aiming at the REMOVED directory: the write silently
  // stops persisting and the audit gate refuses every verdict. Ask and answer
  // must not diverge.
  sandbox(({ stateDir }) => {
    assert.equal(ensureRuntimeDir(), true, 'precondition: the directory exists and is cached as usable')
    writeFileSync(join(stateDir, HISTORY_FILENAME), '{"id":"x"}\n')
    rmSync(stateDir, { recursive: true, force: true })

    const writePath = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.ok(existsSync(stateDir), 'the directory is recreated rather than assumed')
    assert.equal(writePath, join(stateDir, HISTORY_FILENAME), 'the write path is real, not a removed path')
    assert.equal(resolveRuntimeReadPath(HISTORY_FILENAME), writePath, 'read and write must agree: divergence is the split brain')
  })
})

test('a transient directory failure is retried rather than cached, and never rerouted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-paths-transient-'))
  // A FILE where the canonical directory should be, so mkdir cannot succeed.
  const stateDir = join(dir, 'blocked-state')
  writeFileSync(stateDir, 'blocker')
  try {
    setRuntimePathsForTests({ stateDir })
    assert.equal(ensureRuntimeDir(), false)
    // No fallback location exists: the reported write path stays canonical, so a
    // write there fails (and the audit gate fails closed) instead of silently
    // relocating records into the package tree.
    assert.equal(resolveRuntimeWritePath(HISTORY_FILENAME), join(stateDir, HISTORY_FILENAME))
    // Clear the blocker: the next attempt must succeed rather than replay the failure.
    rmSync(stateDir, { force: true })
    assert.equal(ensureRuntimeDir(), true, 'success is retried after the blocker clears')
    assert.equal(resolveRuntimeWritePath(HISTORY_FILENAME), join(stateDir, HISTORY_FILENAME))
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolving paths neither creates nor targets anything inside the repository', () => {
  // Two invariants, both falsifiable:
  //   (a) merely asking for a path creates nothing anywhere;
  //   (b) the canonical directory is NOT inside the checked-out package — which is
  //       the entire reason for the DSH_HOME move, since npm replaces the package
  //       directory on a version upgrade.
  const repoRoot = REPO_ROOT.replace(/[\\/]+$/, '')
  assert.ok(readdirSync(repoRoot).includes('package.json'), `REPO_ROOT must be the package root, got ${repoRoot}`)

  const before = new Set(readdirSync(repoRoot))
  for (const name of RUNTIME_FILENAMES) {
    assert.ok(!runtimeFilePath(name).replace(/\\/g, '/').startsWith(repoRoot.replace(/\\/g, '/')), `${name} must not resolve inside the package`)
    void runtimeFilePath(name)
  }
  assert.ok(!stateDirPath().replace(/\\/g, '/').startsWith(repoRoot.replace(/\\/g, '/')), 'the state dir must not be inside the package')
  const after = new Set(readdirSync(repoRoot))
  assert.deepEqual([...after].sort(), [...before].sort(), 'resolving paths must not create anything')
})
