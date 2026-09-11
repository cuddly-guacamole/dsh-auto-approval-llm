/**
 * dsh-auto-approval-llm · where the runtime files live, and how the move is safe.
 *
 * The six persisted files belong in `<DSH_HOME>/auto-approval-llm/`, outside the
 * installed package, because npm replaces the package tree on a version upgrade.
 * Two earlier layouts exist and must keep working while installs migrate:
 * `<plugin root>/runtime/` and, before that, the package root itself.
 *
 * The rules pinned here:
 *   1. the canonical directory is `<DSH_HOME>/auto-approval-llm`, derived from
 *      the environment (never a hardcoded checkout path);
 *   2. a read walks the legacy chain when the canonical copy is absent, so an
 *      install coming from either earlier layout keeps its data;
 *   3. the canonical copy WINS when it exists — a stale legacy copy must never
 *      shadow live data;
 *   4. append-only files carry legacy content forward before the first write,
 *      staged through a rename so a partial copy cannot shadow intact data;
 *   5. if the canonical directory cannot be created, writes fall back down the
 *      legacy chain with a warning rather than failing, because `appendAuditLine`
 *      returning false makes every verdict fail closed.
 *
 * The whole legacy machine is a one-way migration shim; see the RETIREMENT note
 * in `src/auto/runtime-paths.ts`.
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
  legacyRootFilePath,
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
  const legacyRoot = join(dir, 'plugin-root')
  const stateDir = join(dir, 'dsh-home', 'auto-approval-llm')
  mkdirSync(legacyRoot, { recursive: true })
  try {
    setRuntimePathsForTests({ stateDir, legacyRoot })
    return body({ dir, legacyRoot, stateDir })
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

test('read falls back to the legacy package-root file when the canonical copy is absent', () => {
  sandbox(({ legacyRoot, stateDir }) => {
    // (a) only the legacy package-root layout exists (a shipped install)
    writeFileSync(join(legacyRoot, LEARNING_FILENAME), '{"where":"root"}')
    assert.equal(resolveRuntimeReadPath(LEARNING_FILENAME), join(legacyRoot, LEARNING_FILENAME))

    // (b) canonical exists: it wins
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, LEARNING_FILENAME), '{"where":"state"}')
    assert.equal(resolveRuntimeReadPath(LEARNING_FILENAME), join(stateDir, LEARNING_FILENAME))
  })
})

test('the retired <plugin root>/runtime/ layout is NOT read any more', () => {
  // That layout shipped in no release, so no install can have data there and the
  // compatibility branch was deleted. Pinned so it is not reintroduced by accident
  // (a reintroduction would need its own migration evidence).
  const source = readFileSync(new URL('../src/auto/runtime-paths.ts', import.meta.url), 'utf8')
  assert.ok(!/'runtime'\)/.test(source), 'no runtime/ path is derived any more')
  assert.ok(!source.includes('legacyRuntimeFilePath'), 'the runtime/ helper is gone')
})

test('with nothing on disk the reported path is the canonical one, not a legacy path', () => {
  sandbox(({ stateDir }) => {
    assert.equal(resolveRuntimeReadPath(REVIEW_MODE_FILENAME), join(stateDir, REVIEW_MODE_FILENAME))
  })
})

test('the canonical copy wins over the legacy copy', () => {
  // The direction that matters: after the move, a leftover older copy must never
  // shadow the live data.
  sandbox(({ legacyRoot, stateDir }) => {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(legacyRoot, AUDIT_FILENAME), 'stale\n')
    writeFileSync(join(stateDir, AUDIT_FILENAME), 'canonical\n')
    assert.equal(resolveRuntimeReadPath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
  })
})

test('write creates the canonical directory and lands there, not in the package', () => {
  sandbox(({ legacyRoot, stateDir }) => {
    assert.equal(existsSync(stateDir), false, 'precondition: the directory does not exist yet')
    const path = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.equal(path, join(stateDir, HISTORY_FILENAME))
    assert.ok(existsSync(stateDir), 'the write path creates the directory')
    assert.equal(existsSync(join(legacyRoot, HISTORY_FILENAME)), false, 'nothing is written to the package root')
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
  // write path would keep aiming at the REMOVED directory while the read path fell
  // back to a legacy file — the write silently stops persisting and the audit gate
  // refuses every verdict. Ask and answer must not diverge.
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

test('a transient directory failure is retried rather than cached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-paths-transient-'))
  const legacyRoot = join(dir, 'plugin-root')
  // A FILE where the canonical directory should be, so mkdir cannot succeed.
  const stateDir = join(dir, 'blocked-state')
  mkdirSync(legacyRoot, { recursive: true })
  writeFileSync(stateDir, 'blocker')
  try {
    setRuntimePathsForTests({ stateDir, legacyRoot })
    assert.equal(ensureRuntimeDir(), false)
    assert.equal(resolveRuntimeWritePath(HISTORY_FILENAME), join(legacyRoot, HISTORY_FILENAME), 'writes fall back to the legacy package root')
    // Clear the blocker: the next attempt must succeed rather than replay the failure.
    rmSync(stateDir, { force: true })
    assert.equal(ensureRuntimeDir(), true, 'success is retried after the blocker clears')
    assert.equal(resolveRuntimeWritePath(HISTORY_FILENAME), join(stateDir, HISTORY_FILENAME), 'writes return to canonical')
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an append-only file carries package-root content forward before the first write', () => {
  // The original layout: history.jsonl is append-only, so the first post-upgrade
  // write would land in a fresh canonical file, and once that exists the read rule
  // stops consulting the legacy copy — the pre-move records would become
  // unreachable on the next restart.
  sandbox(({ legacyRoot, stateDir }) => {
    const legacy = '{"id":"before-move"}\n'
    writeFileSync(join(legacyRoot, HISTORY_FILENAME), legacy)

    const target = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.equal(target, join(stateDir, HISTORY_FILENAME))
    assert.equal(readFileSync(target, 'utf8'), legacy, 'the pre-move records are carried into the canonical file')
    assert.equal(readFileSync(join(legacyRoot, HISTORY_FILENAME), 'utf8'), legacy, 'the legacy file is left intact')
  })
})

test('the carry forward never clobbers a canonical file that already has content', () => {
  // The dangerous inverse: copying stale legacy content over the live file would
  // lose exactly the data the move is supposed to protect.
  sandbox(({ legacyRoot, stateDir }) => {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(legacyRoot, AUDIT_FILENAME), 'stale\n')
    writeFileSync(join(stateDir, AUDIT_FILENAME), 'live\n')
    assert.equal(resolveRuntimeWritePath(AUDIT_FILENAME), join(stateDir, AUDIT_FILENAME))
    assert.equal(readFileSync(join(stateDir, AUDIT_FILENAME), 'utf8'), 'live\n', 'the canonical content is untouched')
  })
})

test('overwrite-style files are not carried forward — they persist whole state', () => {
  // learning.json / review-mode.json are rewritten in full from the in-memory
  // store (loaded through the read chain), so a copy would be redundant work on
  // the hot persist path.
  sandbox(({ legacyRoot, stateDir }) => {
    writeFileSync(join(legacyRoot, LEARNING_FILENAME), '{"legacy":true}')
    const target = resolveRuntimeWritePath(LEARNING_FILENAME)
    assert.equal(target, join(stateDir, LEARNING_FILENAME))
    assert.equal(existsSync(target), false, 'no copy is made; the caller writes the merged store here')
  })
})

test('a copy that cannot complete leaves no truncated target to shadow the legacy file', () => {
  // The target's mere existence stops the read rule consulting the legacy file, so
  // a copy that fails PARTWAY would permanently shadow data that is still intact.
  sandbox(({ legacyRoot, stateDir }) => {
    mkdirSync(join(legacyRoot, HISTORY_FILENAME), { recursive: true }) // a dir where the file should be
    const target = resolveRuntimeWritePath(HISTORY_FILENAME)
    assert.equal(target, join(stateDir, HISTORY_FILENAME), 'the append target is still returned')
    assert.equal(existsSync(target), false, 'no target is fabricated when the copy fails')
    const strays = readdirSync(stateDir).filter((n) => n.includes('carry'))
    assert.deepEqual(strays, [], 'the staging file is cleaned up on failure')
  })
})

test('the carry forward stages through a temp file rather than copying in place', () => {
  const source = readFileSync(new URL('../src/auto/runtime-paths.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('function carryForwardAppendOnly'))
  assert.match(body, /copyFileSync\(source, tmp\)/, 'the copy goes to a staging path')
  assert.match(body, /renameSync\(tmp, target\)/, 'and is renamed into place, so the target is never partial')
  assert.ok(
    body.indexOf('renameSync(tmp, target)') < body.indexOf('catch'),
    'the rename completes before any failure handling, so a partial copy never becomes the target',
  )
})

test('the migration shim carries a retirement trigger', () => {
  // New compatibility machinery needs a retirement trigger, not just a comment
  // saying it is temporary. The chain exists for installs that predate the
  // DSH_HOME layout and must be removed once they have had releases to migrate.
  const source = readFileSync(new URL('../src/auto/runtime-paths.ts', import.meta.url), 'utf8')
  assert.match(source, /RETIREMENT:/, 'the shim is marked for removal')
  assert.match(source, /0\.0\.2\d/, 'and names the version that retires it')
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
  void legacyRootFilePath(HISTORY_FILENAME)
  const after = new Set(readdirSync(repoRoot))
  assert.deepEqual([...after].sort(), [...before].sort(), 'resolving paths must not create anything')
})
