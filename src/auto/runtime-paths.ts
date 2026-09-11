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
 *   2. WRITING creates the canonical directory. If it cannot be made, or if it
 *      demonstrably rejects writes, writes fall back to the legacy path rather
 *      than failing. That matters most for the audit: `appendAuditLine` returning
 *      false makes every verdict fail closed, so an unusable directory must not
 *      silently turn into "refuse everything".
 *
 *      A directory that already EXISTS was the blind spot: `mkdirSync` on an
 *      existing directory reports success, so "unwritable" was never noticed and
 *      every append failed against it. Two mechanisms close it, both without a
 *      check-then-write window (the write itself stays the writability test):
 *      `probeRuntimeDirWritable()` at boot, and the write-failure ladder in
 *      `appendRuntimeLine` / `writeRuntimeAtomic`, which retries once at the same
 *      path (to absorb the transient rename races seen on Windows) and only then
 *      concludes the directory is unusable and degrades. The decision is sticky,
 *      so a rejected directory is not revisited on every append.
 *   3. The canonical copy wins while the canonical directory is usable, so a stale
 *      legacy copy can never shadow live data. Once writes degrade to the legacy
 *      chain, the NEWER of the two copies wins instead, because that is where the
 *      records are going. The two transitions keep "newer" equal to "superset":
 *      degrading seeds each legacy file from the canonical copy (or leaves a
 *      legacy copy that is already newer, which can only mean the canonical copy
 *      was seeded into it earlier), and a later boot with a usable canonical
 *      directory copies a newer legacy file back (`reconcileRuntimeCopies`).
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
 * RETIREMENT: the legacy fallback, the carry-forward, the write fallback, the boot
 * probe and the write-failure ladder are a one-way migration shim for installs
 * that predate the DSH_HOME layout. Remove them once three releases have shipped
 * from this change — i.e. when the package version reaches 0.0.25 — leaving only
 * the canonical directory. Registered as a backlog row so the removal is not left
 * to memory.
 */
import { appendFileSync, existsSync, mkdirSync, copyFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  stateDirWriteDenied = false
  lastWriteError = undefined
  warnedAboutFallback = false
  warnedAboutNoLocation = false
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
  // A verdict about the previous directory must not survive re-alignment to a
  // different one: `apply()` sets the directory and then probes it.
  stateDirWriteDenied = false
  lastWriteError = undefined
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
/**
 * Warning flags are separate: a deployment where neither location accepted writes
 * during boot may recover later (a repair, an ACL fixed), and the "records are
 * moving to X" warning must still be able to fire — sharing one flag let the
 * first message permanently silence the second, which told the operator the
 * opposite of what was happening.
 */
let warnedAboutNoLocation = false

/**
 * Sticky verdict that the canonical directory REJECTS writes.
 *
 * Kept separate from `stateDirUsable` on purpose. `ensureRuntimeDir` re-validates
 * the cache with `mkdirSync`, which reports success on a directory that merely
 * exists — so clearing the usability cache would not stop the next append from
 * aiming at a directory already shown to reject writes. This flag is what does.
 */
let stateDirWriteDenied = false

/** The error from the most recent failed write attempt, for the ladder's verdict. */
let lastWriteError: unknown

/**
 * Error codes that mean "this location refuses writes" rather than "this attempt
 * failed". Everything here is raised while OPENING the target, so a retry cannot
 * duplicate or truncate a record. Errors raised after bytes moved (`ENOSPC`,
 * `EIO`, `EMFILE`) are deliberately absent: those must keep failing closed rather
 * than silently relocating the audit.
 */
const DEGRADABLE_WRITE_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'EISDIR',
  'ENOTDIR',
])

/** Pure: would this write error justify moving the runtime files? */
export function isDegradableRuntimeWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && DEGRADABLE_WRITE_CODES.has(code)
}

/**
 * Error codes worth one immediate retry, whether or not they mean "this location
 * refuses writes".
 *
 * `EBUSY`/`EAGAIN` are the sharing violations a Windows anti-virus scanner or
 * backup agent produces while it holds the target for a moment; `EINTR` is an
 * interrupted call. All three are raised while OPENING the target, so a retry
 * cannot duplicate or truncate a record. `ENOSPC`/`EIO` are deliberately absent:
 * they can fail after bytes moved, and replaying the line would splice a fragment
 * and a full line into one corrupt record.
 */
const RETRYABLE_WRITE_CODES: ReadonlySet<string> = new Set([
  ...DEGRADABLE_WRITE_CODES,
  'EBUSY',
  'EAGAIN',
  'EINTR',
])

/** Pure: may the same write be attempted once more without risking the record? */
export function isRetryableRuntimeWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RETRYABLE_WRITE_CODES.has(code)
}

/**
 * Copy `source` over `target` through a temp sibling in the target's directory.
 * Returns whether the target now carries the source's content.
 */
function copyFileAtomic(source: string, target: string): boolean {
  if (source === target || !existsSync(source)) return false
  const tmp = `${target}.merge-${process.pid}`
  try {
    copyFileSync(source, tmp)
    renameSync(tmp, target)
    return true
  } catch {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {
      // Leaving a stray temp file is preferable to failing the caller.
    }
    return false
  }
}

/**
 * Make the canonical copy carry the legacy one when the legacy copy is newer.
 *
 * The reverse transition of `degradeToLegacy`. A previous process may have
 * degraded — the state directory refusing writes is not necessarily permanent,
 * an ACL fix is enough — and appended to the legacy copy for a while. Those
 * records are newer than anything in the canonical file, and since the legacy
 * file was SEEDED from the canonical one when the degradation started, "newer"
 * also means "contains everything the canonical one has". Copying it back is
 * therefore a union, not a loss, and it keeps the read chain (which prefers the
 * canonical copy when it is not degraded) from silently hiding the window.
 *
 * Best-effort and idempotent: once the canonical copy is the newer one, nothing
 * happens on later boots.
 */
export function reconcileRuntimeCopies(): void {
  if (!ensureRuntimeDir()) return
  for (const name of RUNTIME_FILENAMES) {
    const legacy = legacyRootFilePath(name)
    if (!existsSync(legacy)) continue
    const canonical = runtimeFilePath(name)
    if (!existsSync(canonical)) {
      copyFileAtomic(legacy, canonical)
      continue
    }
    if (newerCopyIs(legacy, canonical)) copyFileAtomic(legacy, canonical)
  }
}

/** Whether `candidate` is strictly newer on disk than `reference`. */
function newerCopyIs(candidate: string, reference: string): boolean {
  try {
    return statSync(candidate).mtimeMs > statSync(reference).mtimeMs
  } catch {
    return false
  }
}

/**
 * Sticky degradation: every later write goes to the legacy chain.
 *
 * The canonical copies are about to stop being written, so each one must seed the
 * location the write chain is moving to — otherwise the read rule would flip onto
 * a STALE legacy snapshot (the migration copy is never deleted, so a legacy file
 * routinely exists while being far behind) and every record written since the
 * migration would silently vanish.
 *
 * Seeding follows one rule, which holds because a degradation-seeded legacy file
 * starts as a copy of the canonical one: **the newer copy is the superset.** If
 * the canonical copy is newer it is copied over the legacy snapshot; if the
 * legacy copy is newer, it was seeded from the canonical one and then appended to
 * (an earlier degradation in a killed process), so it already contains it. The
 * fallback directory is created here and the warning emitted once, so the
 * operator sees WHERE records are going, not merely that something failed.
 */
function degradeToLegacy(): void {
  stateDirUsable = false
  if (stateDirWriteDenied) return
  stateDirWriteDenied = true
  const fallback = legacyRoot()
  if (!tryMakeDir(fallback)) {
    warnNoUsableLocation()
    return
  }
  for (const name of RUNTIME_FILENAMES) {
    const canonical = runtimeFilePath(name)
    if (!existsSync(canonical)) continue
    const legacy = join(fallback, name)
    if (!existsSync(legacy) || newerCopyIs(canonical, legacy)) copyFileAtomic(canonical, legacy)
  }
  warnFallbackOnce(fallback)
}

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
  if (stateDirWriteDenied) return false
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

/**
 * Boot probe: prove the canonical directory accepts writes before the session
 * starts serving verdicts.
 *
 * `ensureRuntimeDir` cannot answer this, because a directory that already exists
 * — the common shape, e.g. one created by another account — satisfies it while
 * rejecting every write. This runs once per process from `apply()`, so the
 * degradation is decided and announced up front instead of being discovered by
 * the first audited verdict. The probe file is removed on the way out; a failure
 * to remove it is harmless (it is never read).
 */
export function probeRuntimeDirWritable(): boolean {
  if (!ensureRuntimeDir()) return false
  const probe = join(stateDirPath(), `.write-probe-${process.pid}`)
  try {
    writeFileSync(probe, '')
  } catch {
    degradeToLegacy()
    return false
  }
  // Cleanup happens OUTSIDE the verdict. A probe file that cannot be removed is
  // exactly what the comment above calls harmless, and treating it as "refuses
  // writes" would move six files for a sharing violation on a file nobody reads.
  try {
    rmSync(probe, { force: true })
  } catch {
    // Harmless residue: the file is never read and carries a pid suffix.
  }
  return true
}

/** Warn once per process that writes are landing in a legacy location. */
function warnFallbackOnce(used: string): void {
  if (warnedAboutFallback) return
  warnedAboutFallback = true
  console.warn(
    `[dsh-auto-approval-llm] cannot use ${stateDirPath()}; runtime files stay in ${used}`,
  )
}

/** Warn once per process that NO location accepted the runtime files. */
function warnNoUsableLocation(): void {
  if (warnedAboutNoLocation) return
  warnedAboutNoLocation = true
  console.warn(
    `[dsh-auto-approval-llm] neither ${stateDirPath()} nor ${legacyRoot()} accepted writes; `
    + 'the audit is the fail-closed commit gate, so verdicts will be refused until one of them is writable',
  )
}

/**
 * Where to READ `name` from.
 *
 * The rule is "wherever the WRITE chain would put it", because a read that
 * disagrees with the write chain is a split brain: the process would read the
 * frozen canonical copy while appending to the legacy one, so every persisted
 * change (per-session review mode, learned entries, history) would be silently
 * lost on the next load, and the offline query tools would show a file that
 * stops growing. Hence:
 *
 *   - after degradation, the legacy copy wins when it exists (that is where new
 *     records go), otherwise the canonical one still holds the pre-degrade data;
 *   - otherwise the canonical copy wins when it exists, and the legacy file is
 *     the migration fallback.
 *
 * Falls back to the canonical path when neither exists, so a caller reporting
 * the path shows the intended location rather than a historical one.
 */
/** mtime of `path` when it is a regular file; undefined otherwise (or on error). */
function fileMtimeMs(path: string): number | undefined {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats.mtimeMs : undefined
  } catch {
    return undefined
  }
}

export function resolveRuntimeReadPath(name: string): string {
  const canonical = runtimeFilePath(name)
  const legacy = legacyRootFilePath(name)
  if (stateDirWriteDenied) {
    // Degraded: the write chain appends to the legacy copy, which was seeded from
    // the canonical one, so that copy carries both. Prefer the newer of the two
    // READABLE copies anyway: if the seeding copy failed, the canonical file still
    // holds the records the legacy snapshot predates, and reading past it would
    // hide them. A directory sitting at either path is not a copy at all.
    const legacyTime = fileMtimeMs(legacy)
    if (legacyTime === undefined) return canonical
    const canonicalTime = fileMtimeMs(canonical)
    if (canonicalTime === undefined) return legacy
    return canonicalTime > legacyTime ? canonical : legacy
  }
  if (fileMtimeMs(canonical) !== undefined) return canonical
  if (fileMtimeMs(legacy) !== undefined) return legacy
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
function carryForwardFile(source: string, target: string): void {
  if (existsSync(target)) return
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

/** Legacy → canonical, once, for append-only files (the migration direction). */
function carryForwardAppendOnly(name: string): void {
  carryForwardFile(legacyRootFilePath(name), runtimeFilePath(name))
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
  // Warn in BOTH outcomes: when the legacy root is usable the message says where
  // records go, and when it is not the operator still learns that neither
  // location accepts writes — otherwise every verdict fails closed in silence.
  if (tryMakeDir(fallback)) warnFallbackOnce(fallback)
  else warnNoUsableLocation()
  // The fallback IS the legacy location, so an append continues that file rather
  // than starting a fresh one — no carry-forward applies here.
  return join(fallback, name)
}

function tryAppend(file: string, text: string): boolean {
  try {
    appendFileSync(file, text)
    return true
  } catch (error) {
    lastWriteError = error
    return false
  }
}

/**
 * Append one line to a runtime file, degrading to the legacy chain when the
 * canonical directory demonstrably rejects writes.
 *
 * Returns the file the line landed in, or `undefined` when no attempt succeeded.
 * The caller needs the RETURNED path rather than a fresh resolution because the
 * size-capped files rotate the very file they appended to.
 *
 * The ladder, in this order for a reason: one retry at the SAME path, but only
 * after the error is known to be one a retry cannot damage (see
 * `isRetryableRuntimeWriteError`: it covers the "this location refuses writes"
 * codes and the transient sharing violations alike, and excludes the errors that
 * can fail after a partial write). A retry exists because Windows rename/open
 * races raise `EPERM`/`EBUSY` transiently, and degrading on a first such failure
 * would move six files for a sharing violation. Only when a DEGRADABLE error
 * repeats does the ladder conclude the directory refuses writes and try the
 * legacy path; a transient error that repeats is reported as a failure instead,
 * leaving the location alone.
 */
export function appendRuntimeLine(name: string, text: string, fixedPath?: string): string | undefined {
  // An explicit target (the audit test seam) never participates in the ladder:
  // the caller owns that path, including its failures.
  if (fixedPath !== undefined) return tryAppend(fixedPath, text) ? fixedPath : undefined
  const primary = resolveRuntimeWritePath(name)
  if (tryAppend(primary, text)) return primary
  if (!isRetryableRuntimeWriteError(lastWriteError)) return undefined
  if (tryAppend(primary, text)) return primary
  if (!isDegradableRuntimeWriteError(lastWriteError)) return undefined
  degradeToLegacy()
  const fallback = resolveRuntimeWritePath(name)
  return tryAppend(fallback, text) ? fallback : undefined
}

/** Write `content` to a runtime file through tmp+rename, with the same ladder. */
export function writeRuntimeAtomic(name: string, content: string, tmpSuffix = `.tmp.${process.pid}`): boolean {
  const attempt = (file: string): boolean => {
    const tmp = `${file}${tmpSuffix}`
    try {
      writeFileSync(tmp, content)
      renameSync(tmp, file)
      return true
    } catch (error) {
      lastWriteError = error
      try {
        if (existsSync(tmp)) rmSync(tmp, { force: true })
      } catch {
        // Best-effort cleanup; the previous target content is untouched.
      }
      return false
    }
  }
  const primary = resolveRuntimeWritePath(name)
  if (attempt(primary)) return true
  // Retry only for an error a retry cannot damage: the whole write is tmp+rename,
  // so a failed rename leaves the target untouched and the retry is idempotent.
  if (isRetryableRuntimeWriteError(lastWriteError) && attempt(primary)) return true
  if (!isDegradableRuntimeWriteError(lastWriteError)) return false
  degradeToLegacy()
  return attempt(resolveRuntimeWritePath(name))
}
