/**
 * dsh-auto-approval-llm · where the plugin's persisted files live.
 *
 * The plugin writes six files: the approval history, the append-only audit, the
 * debug trace, the review-latency telemetry, the confirmation-learning store and
 * the per-session review-mode snapshot. They used to be derived independently in
 * four source files and all landed beside `package.json`, so the package root
 * accumulated runtime data next to the source tree.
 *
 * This module is the single owner of those locations. The canonical location is
 * `<plugin root>/runtime/`, and three rules keep the move safe for a plugin that
 * is already installed and running elsewhere:
 *
 *   1. READING prefers the new location but falls back to the old root path, so
 *      an upgraded install keeps its existing learning entries, review modes and
 *      history until the files are moved.
 *   2. WRITING creates `runtime/` first. If the directory cannot be made (the
 *      plugin root is writable but the directory is blocked, for instance),
 *      writes fall back to the old root path with a warning rather than failing.
 *      That matters most for the audit: `appendAuditLine` returning false makes
 *      every verdict fail closed, so a missing directory must not silently turn
 *      into "refuse everything".
 *   3. The NEW location always wins when both exist. Deleting a moved file must
 *      not resurrect a stale copy from the old path.
 *   4. Append-only files carry their pre-move content forward on the first
 *      write, because a fresh target would otherwise shadow records that are
 *      still intact in the old file.
 *
 * The files stay listed in `RUNTIME_STATE_BASENAMES` (`./paths.ts`), which is a
 * basename match, so moving them into a subdirectory does not weaken the hard
 * deny that protects them.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Compiled to lib/auto/runtime-paths.js, so two levels up is the plugin root.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Test-only redirection of both roots.
 *
 * The fallback and priority rules can only be exercised with two real
 * directories, and pointing them at the plugin root would make the test write
 * probe files into the repository. Nothing in production sets this.
 */
interface RuntimePathOverrides {
  /** Directory the runtime files live in. */
  runtimeDir?: string
  /** Directory the pre-move files lived in. */
  legacyRoot?: string
}

let overrides: RuntimePathOverrides | undefined

/** Test-only: redirect both roots (pass undefined to restore the defaults). */
export function setRuntimePathsForTests(next: RuntimePathOverrides | undefined): void {
  overrides = next
  runtimeDirUsable = false
  warnedAboutFallback = false
}

function effectiveRoot(): string {
  return overrides?.legacyRoot ?? PLUGIN_ROOT
}

function effectiveRuntimeDir(): string {
  return overrides?.runtimeDir ?? join(effectiveRoot(), 'runtime')
}

/** The directory the runtime files belong in. */
export function runtimeDirPath(): string {
  return effectiveRuntimeDir()
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
  return join(effectiveRuntimeDir(), name)
}

/** The pre-move location of `name`, read for one upgrade window. */
export function legacyRootFilePath(name: string): string {
  return join(effectiveRoot(), name)
}

/**
 * Cache the directory's usability so the hot append path does not re-create it
 * on every write.
 *
 * The cache is re-validated rather than trusted blindly. `runtime/` can be
 * removed while the process is running — it is gitignored, and a routine
 * `git clean -xdf`, an installer replacing the plugin directory or a cleanup
 * script deletes it under a live host. If the cached success survived that, the
 * write path would keep aiming at the REMOVED directory while the read path
 * fell back to the legacy file: a split brain in which `appendAuditLine` fails,
 * the fail-closed gate refuses every verdict, and history/latency/learning stop
 * persisting — all silently. One `existsSync` per resolution is the price of not
 * having that failure mode.
 */
let runtimeDirUsable = false
let warnedAboutFallback = false

/** Recreate the directory when the cached success no longer holds. */
export function ensureRuntimeDir(): boolean {
  if (runtimeDirUsable && existsSync(effectiveRuntimeDir())) return true
  try {
    mkdirSync(effectiveRuntimeDir(), { recursive: true })
    runtimeDirUsable = true
    return true
  } catch {
    // Failure is never cached: a transient failure (a lock, a slow mount) must
    // be retried by the next write.
    runtimeDirUsable = false
    return false
  }
}

/** Warn once per process that writes are landing in the old root location. */
function warnFallbackOnce(): void {
  if (warnedAboutFallback) return
  warnedAboutFallback = true
  console.warn(
    `[dsh-auto-approval-llm] cannot use ${effectiveRuntimeDir()}; runtime files stay in ${effectiveRoot()}`,
  )
}

/**
 * Where to READ `name` from: the new location when it exists, otherwise the old
 * root path. Falls back to the new path when neither exists, so a caller that
 * reports the path shows the canonical location rather than a legacy one.
 */
export function resolveRuntimeReadPath(name: string): string {
  const next = runtimeFilePath(name)
  if (existsSync(next)) return next
  const legacy = legacyRootFilePath(name)
  if (existsSync(legacy)) return legacy
  return next
}

/**
 * Files that are only ever APPENDED to, so a write that lands in a fresh file
 * loses everything written before the move.
 *
 * The overwrite-style files (`learning.json`, `review-mode.json`) do not need
 * this: their writer serializes the whole in-memory state, which was loaded
 * through the read fallback, so the first persist already carries the legacy
 * content across. Append-only files have no such moment — the first append to an
 * empty `runtime/history.jsonl` would leave the pre-move records behind in a
 * file the read rule then never consults again, because the runtime copy now
 * exists and wins. That is silent, partial data loss on the upgrade path, so the
 * legacy content is copied forward before the first append.
 */
const APPEND_ONLY_FILENAMES: ReadonlySet<string> = new Set([
  HISTORY_FILENAME,
  AUDIT_FILENAME,
  DEBUG_FILENAME,
  LATENCY_FILENAME,
])

/**
 * Copy the pre-move file forward into the runtime location, once.
 *
 * The copy goes to a temporary sibling and is renamed into place, so a copy that
 * fails partway can never leave a truncated target. That matters because the
 * target's mere EXISTENCE is what makes the read rule stop consulting the legacy
 * file: a half-written target would permanently shadow data that is still
 * intact, which is precisely the silent partial loss this carry-forward exists
 * to prevent.
 *
 * Best-effort by design: a failed copy must not stop the append that follows —
 * the new record still has to be persisted, and the audit in particular is the
 * fail-closed commit gate.
 */
function carryForwardAppendOnly(name: string): void {
  const target = runtimeFilePath(name)
  if (existsSync(target)) return
  const legacy = legacyRootFilePath(name)
  if (!existsSync(legacy) || legacy === target) return
  const tmp = `${target}.carry-${process.pid}`
  try {
    copyFileSync(legacy, tmp)
    renameSync(tmp, target)
  } catch {
    // The append that follows still creates the target and persists the record.
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {
      // Leaving a stray temp file is preferable to failing the append.
    }
  }
}

/**
 * Where to WRITE `name`: the new location once the directory exists, otherwise
 * the old root path. Never throws — a write that cannot pick its home must still
 * return a path the caller can attempt.
 *
 * For append-only files this also carries the pre-move content forward first, so
 * the switch to `runtime/` does not truncate the file's history to whatever was
 * written after the upgrade.
 */
export function resolveRuntimeWritePath(name: string): string {
  if (ensureRuntimeDir()) {
    if (APPEND_ONLY_FILENAMES.has(name)) carryForwardAppendOnly(name)
    return runtimeFilePath(name)
  }
  warnFallbackOnce()
  return legacyRootFilePath(name)
}
