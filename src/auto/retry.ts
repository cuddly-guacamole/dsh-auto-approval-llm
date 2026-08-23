/**
 * Plugin-owned LLM review retry (2026-08-23 design, see
 * docs/2026-08-23-review-retry-plan-insight.md).
 *
 * Why a plugin-owned loop instead of the platform `dsh-llm-retry` path: the
 * official `agent/request-error` recovery is guarded by an invariant that
 * forces every `llm/retry` record onto the currently open real turn/step with
 * a provider matching that step's request header — synthetic keys throw and
 * real keys collide with the agent loop's own counting chain.
 *
 * The retry parameters stay source-aligned with the platform (policy comes
 * from `ctx.llm.prepareCall().retryPolicy`; `resolveRetryPolicy` defaults
 * mirror dsh-llm), the budget is a *rolling remainder* of the approval window
 * (attempt 1 keeps the full window — a slow-but-healthy reviewer must not
 * start failing because retries were added), and all observation stays off the
 * session event stream (`dsh-session-persistence` rejects unknown event types
 * and would refuse to load the whole session).
 */

/** One attempt record: 1-based `n` (1 = the first call), its failure code. */
export interface RetryAttempt {
  n: number
  code: string
  at: number
}

export interface ReviewFailure {
  code: string
  message: string
  status?: number
  providerRetryAfterMs?: number
}

export interface RetryLoopOptions<T> {
  /** One single-shot reviewer call; throws on retryable/non-retryable failure. */
  attempt: (signal: AbortSignal) => Promise<T>
  /** User/session cancellation; aborting it stops retries and the backoff wait. */
  userSignal?: AbortSignal
  /** Total window from loop start (approval countdown remainder / review timeout). */
  budgetMs: number
  /** Cap on ADDITIONAL attempts after the first (default 1). */
  maxRetries: number
  /** Per-attempt timeout; calibrated 3500ms (measured review p95 ≈ 3.06s). */
  attemptTimeoutMs: number
  /** Base sleep between attempts (500ms; exponential not needed at cap 1). */
  backoffMs: number
  /** Time reserved before the deadline so a retry can never land on the countdown edge. */
  guardMs: number
  /** Decide whether a failure code is worth retrying (whitelist + path rules). */
  retryable: (failure: ReviewFailure) => boolean
  onRetry?: (info: { n: number; code: string; delayMs: number; remainingMs: number }) => void
  /** Test seam for time. */
  now?: () => number
}

export type RetryLoopResult<T> =
  | { ok: true; value: T; attempts: RetryAttempt[] }
  | { ok: false; failure: ReviewFailure; attempts: RetryAttempt[] }

/**
 * Normalize a thrown error into a stable review failure. Errors that already
 * carry a machine-routable `code` (dsh-llm `LlmError`, our own throws) keep
 * every field; bare errors default to TRANSPORT (a transport-level failure).
 */
export function toLlmFailure(error: unknown, fallbackCode = 'TRANSPORT'): ReviewFailure {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; status?: unknown; providerRetryAfterMs?: unknown }
    if (typeof candidate.code === 'string' && candidate.code.length > 0) {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' && candidate.message.length > 0 ? candidate.message : String(error),
        ...(Number.isInteger(candidate.status) ? { status: candidate.status as number } : {}),
        ...(Number.isFinite(candidate.providerRetryAfterMs) && (candidate.providerRetryAfterMs as number) > 0
          ? { providerRetryAfterMs: candidate.providerRetryAfterMs as number }
          : {}),
      }
    }
  }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) }
}

/**
 * Whitelist of transient failure classes the review may retry. Auth/config
 * errors (AUTH, INVALID_REQUEST, NO_ADAPTER, INVALID_PREPARED_CALL, …) must
 * never re-send the request body/credentials.
 */
export const REVIEW_RETRYABLE_CODES: readonly string[] = Object.freeze([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
])

/**
 * Whitelist gate. On the async approval paths (MEDIUM/HIGH racing the
 * countdown) TIMEOUT is not retried: it is the deadline's own signal, and
 * retrying only re-samples the oracle while sliding toward the countdown
 * edge. The sync LOW path has no countdown race, so TIMEOUT stays retryable.
 */
export function isReviewRetryable(failure: ReviewFailure, opts: { asyncPath: boolean }): boolean {
  if (!REVIEW_RETRYABLE_CODES.includes(failure.code)) return false
  if (opts.asyncPath && failure.code === 'TIMEOUT') return false
  return true
}

/** Cancellable sleep: resolves `false` when the user signal aborts. */
function cancellableSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run one review request with a bounded, rolling-remainder retry loop.
 *
 * - attempt 1 gets the full window (`budgetMs`); later attempts only run while
 *   `deadline - now - guardMs` is positive.
 * - A per-attempt `AbortSignal.timeout` maps to TIMEOUT deterministically
 *   (that is the "gateway timed out → retry" scenario); a user-cancelled
 *   signal aborts the whole loop immediately.
 * - `providerRetryAfterMs` (from a Retry-After header) wins over the fixed
 *   backoff when it fits in the remaining window; otherwise the loop gives up.
 */
export async function retryReviewLoop<T>(options: RetryLoopOptions<T>): Promise<RetryLoopResult<T>> {
  const now = options.now ?? Date.now
  const deadline = now() + options.budgetMs
  const maxAttempts = Math.max(1, options.maxRetries + 1)
  const attempts: RetryAttempt[] = []
  let failure: ReviewFailure | undefined

  for (let n = 1; n <= maxAttempts; n += 1) {
    const remaining = deadline - now() - options.guardMs
    if (remaining <= 0) break
    const attemptSignal = AbortSignal.timeout(Math.min(options.attemptTimeoutMs, remaining))
    const fused = options.userSignal ? AbortSignal.any([options.userSignal, attemptSignal]) : attemptSignal
    try {
      const value = await options.attempt(fused)
      return { ok: true, value, attempts }
    } catch (error) {
      const attemptTimedOut = attemptSignal.aborted && !(options.userSignal?.aborted ?? false)
      failure = toLlmFailure(attemptTimedOut ? { code: 'TIMEOUT', message: 'review attempt timed out' } : error)
      attempts.push({ n, code: failure.code, at: now() })
      if (options.userSignal?.aborted) break
      if (n >= maxAttempts) break
      if (!options.retryable(failure)) break
      let delayMs = options.backoffMs
      if (failure.providerRetryAfterMs !== undefined && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
        delayMs = failure.providerRetryAfterMs
      }
      if (delayMs > remaining) break
      options.onRetry?.({ n, code: failure.code, delayMs, remainingMs: remaining })
      if (!await cancellableSleep(delayMs, options.userSignal)) break
    }
  }
  return {
    ok: false,
    failure: failure ?? { code: 'TIMEOUT', message: 'review retry window exhausted' },
    attempts,
  }
}

/**
 * Parse a `Retry-After` response header (seconds or HTTP-date) into
 * milliseconds; `undefined` when absent or unparseable.
 */
export function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (/^\d+$/.test(trimmed)) {
    const delay = Number(trimmed) * 1000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(trimmed) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}