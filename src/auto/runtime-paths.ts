/**
 * dsh-auto-approval-llm · where the plugin's persisted files live.
 *
 * The plugin writes six files: the approval history, the append-only audit, the
 * debug trace, the review-latency telemetry, the confirmation-learning store and
 * the per-session review-mode snapshot.
 *
 * All six live in ONE place: `<DSH_HOME>/auto-approval-llm/`, deliberately OUTSIDE
 * the installed package. Mutable state must not live in a directory npm owns: a
 * version upgrade replaces the whole package tree, so state kept under the
 * package root is deleted on every `npm install` of a new version (measured —
 * same-version reinstall keeps it, a version change does not, and this was
 * already true when the files sat directly beside `package.json`). A state
 * directory under DSH_HOME survives upgrades, and it is also protected more
 * broadly: the guard denies writes anywhere under DSH_HOME, not only for the six
 * basenames.
 *
 * There is no fallback location. An earlier migration shim (a package-root read
 * fallback, a legacy carry-forward, a write fallback behind a boot probe, and
 * two-way copy reconciliation) served installs that predate the DSH_HOME layout
 * and was retired on the schedule its own note declared: three releases after
 * the move. When the directory cannot be created or refuses writes, the writes
 * fail and `appendAuditLine` returns false, which the audit gate turns into a
 * refusal of every verdict — loud and fail-closed by design, never a silent
 * relocation of records into the npm-owned package tree. A process-wide one-time
 * warning names the directory that does not accept writes.
 *
 * One same-path retry remains, and it is not part of any fallback: `EBUSY` /
 * `EAGAIN` / `EINTR` (and the open-stage "location refuses writes" codes) are
 * raised while OPENING the target, so one retry cannot duplicate or splice a
 * record — it absorbs the transient sharing violations a Windows anti-virus
 * scanner or backup agent produces while it holds the target for a moment.
 * Errors that can fail after bytes moved (`ENOSPC`, `EIO`, `EMFILE`) are never
 * retried: replaying the same text would splice a fragment and a full line into
 * one corrupt record.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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
 * The write path can only be exercised with real directories, and pointing it at
 * the plugin root would make tests write probe files into the repository.
 * Nothing in production sets this.
 */
interface RuntimePathOverrides {
  /** Canonical directory. */
  stateDir?: string
}

let overrides: RuntimePathOverrides | undefined
let stateDirFromHost: string | undefined

/** Test-only: redirect the chain (pass undefined to restore the defaults). */
export function setRuntimePathsForTests(next: RuntimePathOverrides | undefined): void {
  overrides = next
  stateDirUsable = false
  lastWriteError = undefined
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
  // A cached success about the previous directory must not survive re-alignment
  // to a different one: the next write re-creates the directory if it is missing.
  stateDirUsable = false
}

/** The canonical directory all six files belong in. */
export function stateDirPath(): string {
  return overrides?.stateDir ?? stateDirFromHost ?? defaultStateDir()
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

/**
 * Cache the directory's usability so the hot append path does not re-create it
 * on every write.
 *
 * The cache is re-validated rather than trusted blindly. A state directory can
 * be removed while the process is running, and if the cached success survived
 * that, the write path would keep aiming at the REMOVED directory while reads
 * asked for files that no longer exist: history/latency/learning would stop
 * persisting and `appendAuditLine` would refuse every verdict — all silently.
 * One `existsSync` per resolution is the price of not having that failure mode.
 */
let stateDirUsable = false

/**
 * Warning flags stay separate from the usability cache: a deployment whose
 * directory refused writes during boot may recover later (a repair, an ACL
 * fixed), and the operator must still learn about a failure that happens after
 * a successful earlier write. Sharing one flag would let the first message
 * permanently silence the later, more urgent one.
 */
let warnedAboutNoLocation = false

/** The error from the most recent failed write attempt, for the retry verdict. */
let lastWriteError: unknown

/**
 * Error codes worth one immediate retry.
 *
 * `EBUSY`/`EAGAIN` are the sharing violations a Windows anti-virus scanner or
 * backup agent produces while it holds the target for a moment; `EINTR` is an
 * interrupted call. The "location refuses writes" codes (`EACCES`/`EPERM`/
 * `EROFS`/`EISDIR`/`ENOTDIR`) are included because they too are raised while
 * OPENING the target — the retry re-raises them, it never relocates anything.
 * All of these are safe to retry because no byte has moved yet. `ENOSPC`/`EIO`/
 * `EMFILE` are deliberately absent: they can fail after bytes moved, and
 * replaying the line would splice a fragment and a full line into one corrupt
 * record.
 */
const RETRYABLE_WRITE_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'EISDIR',
  'ENOTDIR',
  'EBUSY',
  'EAGAIN',
  'EINTR',
])

/** Pure: may the same write be attempted once more without risking the record? */
export function isRetryableRuntimeWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RETRYABLE_WRITE_CODES.has(code)
}

function tryMakeDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** Create the canonical directory if needed; false means writes into it fail. */
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

/** Warn once per process that the runtime directory does not accept writes. */
function warnNoUsableLocation(): void {
  if (warnedAboutNoLocation) return
  warnedAboutNoLocation = true
  console.warn(
    `[dsh-auto-approval-llm] the runtime directory ${stateDirPath()} does not accept writes; `
    + 'the audit is the fail-closed commit gate, so verdicts will be refused until it is writable',
  )
}

/**
 * Where to READ `name` from: always the canonical file. Reads and writes must
 * name the same path — a read that disagreed with the write chain would be a
 * split brain in which every persisted change (per-session review mode, learned
 * entries, history) is silently lost on the next load.
 */
export function resolveRuntimeReadPath(name: string): string {
  return runtimeFilePath(name)
}

/**
 * Where to WRITE `name`: always the canonical file. When the directory cannot
 * be created the caller's write attempt fails and the append gate fails closed;
 * the one-time warning says which directory is the problem.
 */
export function resolveRuntimeWritePath(name: string): string {
  if (!ensureRuntimeDir()) warnNoUsableLocation()
  return runtimeFilePath(name)
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
 * Append one line to a runtime file.
 *
 * Returns the file the line landed in, or `undefined` when no attempt succeeded
 * (the caller treats that as a failed persist; the audit gate fails closed).
 * The caller needs the RETURNED path rather than a fresh resolution because the
 * size-capped files rotate the very file they appended to.
 *
 * The ladder: one attempt, then — only when the error is one a retry cannot
 * damage (see `isRetryableRuntimeWriteError`) — a single retry at the SAME path.
 * There is no relocation step: a location that refuses writes fails closed.
 */
export function appendRuntimeLine(name: string, text: string, fixedPath?: string): string | undefined {
  // An explicit target (the audit test seam) never participates in the ladder:
  // the caller owns that path, including its failures.
  if (fixedPath !== undefined) return tryAppend(fixedPath, text) ? fixedPath : undefined
  const primary = resolveRuntimeWritePath(name)
  if (tryAppend(primary, text)) return primary
  if (!isRetryableRuntimeWriteError(lastWriteError)) return undefined
  return tryAppend(primary, text) ? primary : undefined
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
  return isRetryableRuntimeWriteError(lastWriteError) ? attempt(primary) : false
}
