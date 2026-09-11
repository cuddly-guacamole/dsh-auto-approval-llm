/**
 * dsh-auto-approval-llm · where the plugin's persisted files live.
 *
 * The plugin writes six files: the approval history, the append-only audit, the
 * debug trace, the review-latency telemetry, the confirmation-learning store and
 * the per-session review-mode snapshot.
 *
 * The canonical home is `<DSH_HOME>/auto-approval-llm/`, deliberately OUTSIDE the
 * installed package. Mutable state must not live in a directory npm owns: a
 * version upgrade replaces the whole package tree, so state kept under the
 * package root is deleted on every `npm install` of a new version (measured —
 * same-version reinstall keeps it, a version change does not, and this was
 * already true when the files sat directly beside `package.json`). A state
 * directory under DSH_HOME survives upgrades, and it is also protected more
 * broadly: the guard denies writes anywhere under DSH_HOME, not only for the six
 * basenames.
 *
 * Three rules govern the location, ordered by which one must win:
 *
 *   1. READING prefers the canonical directory and falls back to the legacy
 *      package-root file, so an install whose data still sits where shipped
 *      releases wrote it keeps its history, audit and learned entries.
 *   2. WRITING creates the canonical directory. If it cannot be made, writes fall
 *      back to the legacy path rather than failing. That matters most for the
 *      audit: `appendAuditLine` returning false makes every verdict fail closed,
 *      so an unusable directory must not silently turn into "refuse everything".
 *   3. The canonical copy always wins when it exists, so a stale legacy copy can
 *      never shadow live data.
 *
 * Append-only files additionally carry their legacy content forward on the first
 * write, because a fresh target would otherwise shadow records that are still
 * intact in the old file. Overwrite-style stores need nothing: their writer
 * serializes the whole in-memory state, which was loaded through rule 1.
 *
 * There is no compatibility path for the short-lived `<plugin root>/runtime/`
 * layout: it shipped in no release (the published line still wrote to the package
 * root), so no install can have data there.
 *
 * RETIREMENT: the legacy fallback, the carry-forward and the write fallback are a
 * one-way migration shim for installs that predate the DSH_HOME layout. Remove
 * them once three releases have shipped from this change — i.e. when the package
 * version reaches 0.0.25 — leaving only the canonical directory. Registered as a
 * backlog row so the removal is not left to memory.
 */
import { existsSync, mkdirSync, copyFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Compiled to lib/auto/runtime-paths.js, so two levels up is the plugin root.
// Used ONLY for the legacy read/write chain — never for the canonical location.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The state directory's name under DSH_HOME. */
const STATE_DIR_NAME = 'auto-approval-llm'

/**
 * DSH_HOME resolution, mirroring `resolveRoots` in `./paths.ts`: a non-empty
 * `DSH_HOME` wins, otherwise `~/.dsh`. Nothing here reads the plugin config,
 * because these paths are resolved while the module loads; the host re-aligns
 * this from its own resolved `dshHome` at startup (see `setRuntimeStateDir`).
 */
function envDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

function defaultStateDir(): string {
  return join(envDshHome(), STATE_DIR_NAME)
}

/**
 * Test-only redirection of the whole chain.
 *
 * The priority rules can only be exercised with real directories, and pointing
 * them at the plugin root would make tests write probe files into the repository.
 * Nothing in production sets this.
 */
interface RuntimePathOverrides {
  /** Canonical directory. */
  stateDir?: string
  /** Legacy package-root layout (the location shipped releases wrote to). */
  legacyRoot?: string
}

let overrides: RuntimePathOverrides | undefined
let stateDirFromHost: string | undefined

/** Test-only: redirect the chain (pass undefined to restore the defaults). */
export function setRuntimePathsForTests(next: RuntimePathOverrides | undefined): void {
  overrides = next
  stateDirUsable = false
  warnedAboutFallback = false
}

/**
 * Host-only: point the canonical directory at the SAME `dshHome` the guard uses.
 *
 * The guard resolves roots from config (`config.dshHome` overrides `DSH_HOME`), so
 * if the two ever disagreed the plugin would persist outside the protected
 * subtree while the guard protected a different one. `apply()` calls this with its
 * own resolved `dshHome`, which makes location and protection agree by
 * construction. Passing undefined restores the environment-derived default.
 *
 * A non-absolute argument is IGNORED rather than stored: a relative path would
 * resolve against whatever the process's cwd happens to be, which could land the
 * state outside the guarded tree. Callers pass a resolved path.
 */
export function setRuntimeStateDir(dir: string | undefined): void {
  if (dir !== undefined && !isAbsolute(dir)) return
  stateDirFromHost = dir
  stateDirUsable = false
}

/** The canonical directory all six files belong in. */
export function stateDirPath(): string {
  return overrides?.stateDir ?? stateDirFromHost ?? defaultStateDir()
}

function legacyRoot(): string {
  return overrides?.legacyRoot ?? PLUGIN_ROOT
}

export const HISTORY_FILENAME = 'history.jsonl'
export const AUDIT_FILENAME = 'audit.jsonl'
export const DEBUG_FILENAME = 'approval-debug.jsonl'
export const LATENCY_FILENAME = 'llm-latency.jsonl'
export const LEARNING_FILENAME = 'learning.json'
export const REVIEW_MODE_FILENAME = 'review-mode.json'

/** Every persisted file name, so a caller can map over the set instead of listing it again. */
export const RUNTIME_FILENAMES = [
  HISTORY_FILENAME,
  AUDIT_FILENAME,
  DEBUG_FILENAME,
  LATENCY_FILENAME,
  LEARNING_FILENAME,
  REVIEW_MODE_FILENAME,
] as const

/** The canonical location of `name` (the directory may not exist yet). */
export function runtimeFilePath(name: string): string {
  return join(stateDirPath(), name)
}

/** The legacy package-root location of `name` (where shipped releases wrote). */
export function legacyRootFilePath(name: string): string {
  return join(legacyRoot(), name)
}

/**
 * Cache the directory's usability so the hot append path does not re-create it
 * on every write.
 *
 * The cache is re-validated rather than trusted blindly. A state directory can
 * be removed while the process is running, and if the cached success survived
 * that, the write path would keep aiming at the REMOVED directory while the read
 * path fell back to a legacy file: a split brain in which `appendAuditLine`
 * fails, the fail-closed gate refuses every verdict, and history/latency/learning
 * stop persisting — all silently. One `existsSync` per resolution is the price of
 * not having that failure mode.
 */
let stateDirUsable = false
let warnedAboutFallback = false

function tryMakeDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** Create the canonical directory if needed; false means writes use the legacy chain. */
export function ensureRuntimeDir(): boolean {
  const dir = stateDirPath()
  if (stateDirUsable && existsSync(dir)) return true
  if (tryMakeDir(dir)) {
    stateDirUsable = true
    return true
  }
  // Failure is never cached: a transient failure (a lock, a slow mount) must be
  // retried by the next write.
  stateDirUsable = false
  return false
}

/** Warn once per process that writes are landing in a legacy location. */
function warnFallbackOnce(used: string): void {
  if (warnedAboutFallback) return
  warnedAboutFallback = true
  console.warn(
    `[dsh-auto-approval-llm] cannot use ${stateDirPath()}; runtime files stay in ${used}`,
  )
}

/**
 * Where to READ `name` from: the canonical copy when it exists, otherwise the
 * legacy package-root file. Falls back to the canonical path when neither
 * exists, so a caller reporting the path shows the intended location rather than
 * a historical one.
 */
export function resolveRuntimeReadPath(name: string): string {
  const canonical = runtimeFilePath(name)
  if (existsSync(canonical)) return canonical
  const legacy = legacyRootFilePath(name)
  if (existsSync(legacy)) return legacy
  return canonical
}

/**
 * Files that are only ever APPENDED to, so a write that lands in a fresh file
 * loses everything written before the move.
 *
 * The overwrite-style files (`learning.json`, `review-mode.json`) do not need
 * this: their writer serializes the whole in-memory state, which was loaded
 * through the read chain, so the first persist already carries the old content
 * across. Append-only files have no such moment — the first append to an empty
 * canonical file would leave earlier records in a file the read rule then never
 * consults again, because the canonical copy now exists and wins.
 */
const APPEND_ONLY_FILENAMES: ReadonlySet<string> = new Set([
  HISTORY_FILENAME,
  AUDIT_FILENAME,
  DEBUG_FILENAME,
  LATENCY_FILENAME,
])

/**
 * Copy a legacy file forward into the canonical directory, once.
 *
 * The copy is staged through a temporary sibling and renamed into place, so a
 * copy that fails partway can never leave a truncated target. That matters
 * because the target's mere EXISTENCE is what makes the read rule stop consulting
 * the legacy file: a half-written target would permanently shadow data that is
 * still intact.
 *
 * Best-effort by design: a failed copy must not stop the append that follows —
 * the new record still has to be persisted, and the audit in particular is the
 * fail-closed commit gate.
 */
function carryForwardAppendOnly(name: string): void {
  const target = runtimeFilePath(name)
  if (existsSync(target)) return
  const source = legacyRootFilePath(name)
  if (source === target || !existsSync(source)) return
  const tmp = `${target}.carry-${process.pid}`
  try {
    copyFileSync(source, tmp)
    renameSync(tmp, target)
  } catch {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {
      // Leaving a stray temp file is preferable to failing the append.
    }
  }
}

/**
 * Where to WRITE `name`: the canonical directory once it exists, otherwise the
 * legacy package-root path. Never throws — a write that cannot pick its home must
 * still return a path the caller can attempt.
 */
export function resolveRuntimeWritePath(name: string): string {
  if (ensureRuntimeDir()) {
    if (APPEND_ONLY_FILENAMES.has(name)) carryForwardAppendOnly(name)
    return runtimeFilePath(name)
  }
  const fallback = legacyRoot()
  if (tryMakeDir(fallback)) warnFallbackOnce(fallback)
  // The fallback IS the legacy location, so an append continues that file rather
  // than starting a fresh one — no carry-forward applies here.
  return join(fallback, name)
}
