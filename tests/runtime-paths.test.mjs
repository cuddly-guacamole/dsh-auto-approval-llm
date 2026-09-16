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
  appendRuntimeLine,
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
  //
  // The environment value is DRIVEN here rather than recomputed. On a machine
  // whose DSH_HOME already equals `~/.dsh` (this one), an implementation that
  // ignored DSH_HOME and returned the fallback satisfied every assertion below,
  // so a temporary DSH_HOME that differs from the fallback is what gives the
  // derivation its teeth.
  const previous = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'dsa-m18-'))
  const dshHome = join(dir, 'dsh-home')
  assert.notEqual(dshHome, join(homedir(), '.dsh'), 'precondition: the driven env value differs from the fallback')
  try {
    process.env.DSH_HOME = dshHome
    setRuntimeStateDir(undefined)
    const stateDir = join(dshHome, 'auto-approval-llm')
    assert.equal(stateDirPath(), stateDir, 'the state directory follows DSH_HOME')
    assert.ok(stateDirPath().startsWith(dshHome), 'the state directory lives under DSH_HOME')
    for (const name of RUNTIME_FILENAMES) {
      assert.equal(runtimeFilePath(name), join(stateDir, name))
      assert.equal(resolveRuntimeReadPath(name), join(stateDir, name), `${name}: the read path follows DSH_HOME`)
      assert.equal(resolveRuntimeWritePath(name), join(stateDir, name), `${name}: the write path follows DSH_HOME`)
    }
    // The state directory must NOT be inside the package tree — that is the whole
    // point: npm replaces the package directory on a version upgrade.
    assert.ok(
      !stateDirPath().startsWith(REPO_ROOT),
      `state must live outside the installed package, got ${stateDirPath()}`,
    )
    // Control for the direction above: a blank DSH_HOME still falls back to
    // `~/.dsh`, so the assertions are about the env branch, not about the
    // directory simply being "wherever the test pointed it".
    process.env.DSH_HOME = '   '
    assert.equal(stateDirPath(), join(homedir(), '.dsh', 'auto-approval-llm'), 'a blank DSH_HOME falls back to ~/.dsh')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    setRuntimeStateDir(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
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
    // "Lands there" is about the bytes, not about a directory appearing: a write
    // helper that resolved somewhere else would satisfy every check above. Drive
    // the append through the module's own write chain and read the record back at
    // the canonical path.
    const line = '{"id":"landing"}\n'
    assert.equal(appendRuntimeLine(HISTORY_FILENAME, line), join(stateDir, HISTORY_FILENAME), 'the append reports the canonical file')
    assert.equal(readFileSync(join(stateDir, HISTORY_FILENAME), 'utf8'), line, 'the record is readable at the canonical path')
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

/**
 * `src` with comment bodies blanked out, character indices preserved.
 *
 * A comment that mentions a call must not be counted as one, and blanking (rather
 * than deleting) keeps every index usable for the region assertions below.
 */
function blankComments(src) {
  const out = [...src]
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1
        i += 1
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      for (let j = i; j < stop; j += 1) out[j] = ' '
      i = stop - 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) break
      for (let j = i; j < end + 2; j += 1) out[j] = ' '
      i = end + 1
    }
  }
  return out.join('')
}

test('the host seam is applied before the stores are loaded', () => {
  // The ordering claim F1 violated. Reading from one directory while writing to
  // another is a split brain, so the load call must come after the seam is set.
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const code = blankComments(source)
  // Banning `loadHistory()` alone was a one-name guard: `loadRuntimeStores()` is
  // the entry point that reaches every store, so a second call site — at module
  // scope or from another seam — would restore the split brain while that ban
  // stayed green. Count EVERY call site in code (comments blanked, the definition
  // excluded), not just a bare whole-line call: `if (f) loadRuntimeStores()`,
  // `void loadRuntimeStores()` and `loadRuntimeStores();` all escape a line-shape
  // regex while loading the stores from somewhere else.
  const callSites = [...code.matchAll(/(?<!function\s)loadRuntimeStores\s*\(/g)]
  assert.equal(callSites.length, 1, `expected exactly one loadRuntimeStores() call site, got ${callSites.length}`)
  const loadAt = callSites[0].index
  const seamAt = code.search(/^\s+setRuntimeStateDir\(join\(/m)
  assert.ok(seamAt > 0, 'the host seam is called from apply()')
  assert.ok(seamAt < loadAt, 'the state directory is set BEFORE the stores are loaded')
  // And it is inside the apply() BODY, not merely after the apply() header: the
  // closing brace of that body is the first top-level `}` after the header.
  const applyAt = code.search(/export function apply\s*\(/)
  assert.notEqual(applyAt, -1, 'apply() is present')
  const applyEnd = code.indexOf('\n}', applyAt)
  assert.notEqual(applyEnd, -1, 'the apply() body is delimited by a top-level close brace')
  assert.ok(applyAt < loadAt && loadAt < applyEnd, 'the load call is inside the apply() body, where the state directory is known')
  // And nothing may load them at module scope, which is what broke the ordering.
  assert.doesNotMatch(source, /^loadRuntimeStores\(\)$/m, 'the stores are not loaded at module load')
  assert.doesNotMatch(source, /^loadHistory\(\)$/m, 'history is not loaded at module load on its own either')
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
