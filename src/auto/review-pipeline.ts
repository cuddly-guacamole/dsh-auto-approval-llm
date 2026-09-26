/**
 * dsh-auto-approval-llm · the deep-review lane (LLM reviewer pipeline).
 *
 * Snapshot resolution, the single attempt, the bounded retry loop and the
 * failure-code mapping. The module owns no mutable state: the entry keeps the
 * wiring order, and the frozen snapshot guarantees every retry reuses the
 * route, key and budget resolved before the first attempt.
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from '../index.js'
import { THRESHOLD_DEFAULTS } from './constants.js'
import { debugLog } from './debug-and-decisions.js'
import { assembleReviewerSystem, extractToolPath, frameReviewerInput, parseReview, type ReviewResult } from './decision.js'
import { callEndpointText } from './endpoint-call.js'
import { PLUGIN_MESSAGE_SOURCE } from './message-source.js'
import { normalizeLane, normalizeSharedEndpoint, resolveTransport } from './model-channel.js'
import { isWithin, normalizePath } from './paths.js'
import { isReviewRetryable, retryAfterMs, retryReviewLoop, type RetryAttempt, type ReviewFailure } from './retry.js'
import { REVIEWER_CREDENTIAL_REF, reviewerKeyFromCredentialFile } from './route-table.js'
import { findToolCallArguments, findToolDescription, sessionModelRoute } from './session-introspect.js'
import { validateReviewerBaseUrl } from './trust.js'

/**
 * Retry calibration history: the original 3.5s fit the
 * mock/opencode latency profile (p95 ≈ 3.06s); direct DeepSeek official
 * review latency spans 266ms–4.9s, so the per-attempt
 * timeout became a user setting (`reviewWaitSeconds`, default 5, schema-clamped
 * 1..10). It should stay at or below the LOW countdown so a healthy review
 * still lands inside the window.
 */
const REVIEW_RETRY_BACKOFF_MS = 500
const REVIEW_RETRY_GUARD_MS = 1_500

/**
 * Frozen review context. Route/baseUrl/protocol/model/system/payload and the
 * API key are resolved ONCE before the first attempt; every retry reuses the
 * snapshot so a credential rotation or settings change mid-review can never
 * steer a retry toward a different endpoint or key.
 */
interface ReviewSnapshot {
  /** host = DSH LLM route (session/preset); raw = shared endpoint config. */
  transport: 'host' | 'raw'
  payload: string
  system: string
  route?: { provider: string; model: string }
  baseUrl?: string
  /** Reviewer model fixed at snapshot time (raw attempts re-read it otherwise). */
  model?: string
  protocol?: 'openai' | 'anthropic'
  apiKey?: string
  /** Output budget + reasoning effort, frozen with the rest so a settings
   * change mid-review cannot steer retry N>1 to a different budget/effort. */
  maxTokens?: number
  reasoningEffort?: string
}

/**
 * Resolve the shared endpoint API key once from the credentials service, with
 * the shared-credential-file fallback. Disable the file read with
 * DSH_AUTO_APPROVAL_READ_CRED_FILE=0 (keeps contract tests isolated from the
 * host machine's credential file).
 */
export async function resolveReviewerApiKey(credentials: any): Promise<string | undefined> {
  let apiKey: string | undefined
  try {
    const resolved = await credentials?.resolve?.(REVIEWER_CREDENTIAL_REF)
    apiKey = resolved?.value
  } catch {
    apiKey = undefined
  }
  if (!apiKey && process.env.DSH_AUTO_APPROVAL_READ_CRED_FILE !== '0') {
    apiKey = reviewerKeyFromCredentialFile()
  }
  return apiKey
}

/**
 * Optimistic route-availability predicate for the deep-review lane, consumed
 * by both the confirmation-learning gate and the main risk pipeline. Mirrors
 * the exact snapshot-time resolution but without the async key lookup: a
 * session/preset source with a resolvable host route or an endpoint source
 * with a configured URL+model counts as available. The snapshot re-checks
 * precisely and fails loudly on any half-configuration — the gate is an
 * optimistic pre-check only (misjudgment worst case is ESCALATE/ask, never an
 * auto-allow).
 */
export function reviewerRouteAvailable(config: Config, session: any): boolean {
  const lane = normalizeLane({
    source: config.reviewerSource,
    presetProvider: config.reviewerProvider,
    presetModel: config.reviewerModel,
  })
  const endpoint = normalizeSharedEndpoint({
    url: config.endpointUrl,
    model: config.endpointModel,
    protocol: config.endpointProtocol,
  })
  const transport = resolveTransport(lane.source, lane, endpoint, sessionModelRoute(session))
  return transport.transport !== 'none'
}

export async function buildReviewSnapshot(
  credentials: any, tools: any, session: any, req: any, config: Config,
  opts: {
    userMessages?: string[]
    workspaceRoot?: string
    home?: string
  },
): Promise<ReviewSnapshot | { failure: string }> {
  // Reasoning-blind payload: tool identity + sanitized args + bounded direct
  // user messages + workspace facts only. req.reason (which can carry model
  // prose / the classifier's own words) is deliberately NOT forwarded.
  const rawArgs = findToolCallArguments(session, req.callId, config.maxArgsChars)
  let targetRelative: string | null | undefined
  let inWorkspace: boolean | null | undefined
  const target = extractToolPath(rawArgs)
  if (target !== undefined && opts.workspaceRoot) {
    const normalized = normalizePath(target, opts.workspaceRoot, opts.home ?? opts.workspaceRoot)
    inWorkspace = isWithin(opts.workspaceRoot, normalized)
    targetRelative = normalized
  }
  const payload = frameReviewerInput({
    toolName: req.toolName,
    description: findToolDescription(tools, req.toolName),
    rawArguments: rawArgs,
    trustedUserMessages: opts.userMessages ?? [],
    workspaceRoot: opts.workspaceRoot ?? undefined,
    targetRelative,
    inWorkspace,
  })
  // system = REVIEWER_SYSTEM + safetyPrompt + sanitized/bounded rules
  // summary (rules are constraints only; they can never authorize).
  const system = assembleReviewerSystem(config.safetyPrompt, config.rulesText)

  // Channel-driven transport: the reviewer
  // source switch decides how this review travels — session/preset ride the
  // host LLM through a provider/model route; endpoint rides raw fetch to the
  // shared custom endpoint config. The API key (endpoint) resolves once into
  // the snapshot (never cached beyond one review), so a settings change
  // mid-review cannot steer a retry toward a different endpoint or key.
  const reviewerLane = normalizeLane({
    source: config.reviewerSource,
    presetProvider: config.reviewerProvider,
    presetModel: config.reviewerModel,
  })
  if (reviewerLane.error) {
    // The operator explicitly chose a source and misconfigured it — fail
    // loudly, never silently follow the session model (ruling).
    return { failure: reviewerLane.error }
  }
  const endpoint = normalizeSharedEndpoint({
    url: config.endpointUrl,
    model: config.endpointModel,
    protocol: config.endpointProtocol,
  })
  const transport = resolveTransport(
    reviewerLane.source,
    reviewerLane,
    endpoint,
    sessionModelRoute(session),
  )
  if (transport.transport === 'none') {
    if (reviewerLane.source === 'session') return { failure: 'no reviewer route' }
    return { failure: transport.reason }
  }
  if (transport.transport === 'raw') {
    const validated = validateReviewerBaseUrl(transport.baseUrl)
    if (!validated.ok) {
      console.warn(`[dsh-auto-approval-llm] ${validated.reason}`)
      return { failure: validated.reason }
    }
    const apiKey = await resolveReviewerApiKey(credentials)
    // A configured endpoint without a resolved key is treated as unconfigured:
    // log what is missing and fail — an endpoint review without a key can only
    // produce AUTH.
    if (!apiKey) {
      debugLog({ ev: 'reviewer-incomplete', callId: req.callId, baseUrl: validated.baseUrl, missing: ['key'] })
      return { failure: 'endpoint source needs a resolved API key' }
    }
    return {
      transport: 'raw',
      payload,
      system,
      baseUrl: validated.baseUrl,
      model: transport.model,
      protocol: transport.protocol,
      apiKey,
      maxTokens: config.reviewerMaxTokens ?? 2_048,
    }
  }
  return {
    transport: 'host',
    payload,
    system,
    route: { provider: transport.provider, model: transport.model },
    maxTokens: config.reviewerMaxTokens ?? 2_048,
    reasoningEffort: config.reviewerReasoning ?? '',
  }
}

/** Map a non-2xx HTTP status to a stable review failure code. */
function httpStatusFailure(status: number, message: string, response: any): ReviewFailure {
  const code =
    status === 429 ? 'RATE_LIMIT'
      : status >= 500 ? 'SERVER'
        : status === 401 || status === 403 ? 'AUTH'
          : status === 400 || status === 413 ? 'INVALID_REQUEST'
            : `HTTP_${status}`
  const providerRetryAfterMs = retryAfterMs(response?.headers?.get?.('retry-after') ?? null)
  return {
    code,
    message,
    status,
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
  }
}

/** One single-shot review attempt; throws a `ReviewFailure`-shaped error on failure. */
async function runReviewAttempt(
  snapshot: ReviewSnapshot, llm: any, session: any, req: any, config: Config, signal: AbortSignal,
): Promise<ReviewResult> {
  if (snapshot.transport === 'host') {
    const route = snapshot.route!
    const callConfig: any = { provider: route.provider, model: route.model, maxTokens: snapshot.maxTokens ?? 2_048 }
    // Reasoning effort: '' follows the adapter default; an explicit value is
    // forwarded to the dsh reasoningEffort. A model that does not support it
    // throws UNSUPPORTED_REASONING_EFFORT → the review fails loudly (never
    // silently). The stream spreads prepared.config, so the effort lands on
    // the wire only when the adapter accepted it.
    if (snapshot.reasoningEffort && snapshot.reasoningEffort !== '') callConfig.reasoningEffort = snapshot.reasoningEffort
    const prepared = await llm.prepareCall(callConfig, signal)
    const messages = [createUserMessage({
      content: [{ type: 'text', text: snapshot.payload }],
      source: PLUGIN_MESSAGE_SOURCE,
    })]
    const assembler = new BlockAssembler()
    // The stream options must match the prepared call's resolved config field
    // for field (provider/model/reasoningEffort/temperature/maxTokens/stop —
    // callConfigEquals), otherwise the adapter rejects the dispatch with
    // INVALID_PREPARED_CALL. Spreading prepared.config guarantees equality
    // even when adapter defaults filled optional fields.
    for await (const chunk of prepared.stream({
      ...(prepared.config as any),
      messages,
      system: snapshot.system,
      sessionId: session.id,
      signal,
    })) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const text = assembler.blocks()
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join(' ')
    return parseReviewTextOrThrow(text)
  }

  // Raw endpoint transport: the shared endpoint call owns the SSRF/redirect
  // fence and protocol routing; HTTP failures map to the review failure codes.
  const result = await callEndpointText({
    baseUrl: snapshot.baseUrl!,
    model: snapshot.model!,
    protocol: snapshot.protocol!,
    apiKey: snapshot.apiKey,
    system: snapshot.system,
    messages: [snapshot.payload],
    maxTokens: snapshot.maxTokens ?? 2_048,
    signal,
  })
  if (!result.ok) {
    const failure: ReviewFailure = httpStatusFailure(result.status ?? 0, result.message, { headers: { get: () => null } })
    if (result.retryAfterMs !== undefined) failure.providerRetryAfterMs = result.retryAfterMs
    throw failure
  }
  return parseReviewTextOrThrow(result.text)
}

/** Parse review JSON; empty output = EMPTY_RESPONSE, malformed = BAD_RESPONSE (not retried). */
function parseReviewTextOrThrow(text: string): ReviewResult {
  if (text.trim() === '') {
    throw { code: 'EMPTY_RESPONSE', message: 'reviewer returned no text' }
  }
  try {
    return parseReview(text)
  } catch (error) {
    throw { code: 'BAD_RESPONSE', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run the review with a bounded retry loop. Returns the settled review plus
 * the per-attempt failure trail. Retry policy: whitelisted transient codes
 * only, rolling-remainder budget, per-attempt timeout (gateway timeouts are
 * the retryable scenario; user cancellation aborts the loop immediately).
 */
export async function reviewWithLLM(
  credentials: any, llm: any, tools: any, session: any, req: any, config: Config,
  timeoutMs = 5_000,
  opts: {
    userMessages?: string[]
    workspaceRoot?: string
    home?: string
  } = {},
  retry: { maxRetries: number; budgetMs: number; asyncPath: boolean } = { maxRetries: 0, budgetMs: 5_000, asyncPath: false },
): Promise<{ review: ReviewResult; attempts: RetryAttempt[] }> {
  const snapshot = await buildReviewSnapshot(credentials, tools, session, req, config, opts)
  if ('failure' in snapshot) {
    return { review: { decision: 'ESCALATE', failure: snapshot.failure }, attempts: [] }
  }
  const outcome = await retryReviewLoop({
    budgetMs: retry.budgetMs,
    maxRetries: retry.maxRetries,
    attemptTimeoutMs: Math.min(10_000, Math.max(1_000, (config.reviewWaitSeconds ?? THRESHOLD_DEFAULTS.reviewWaitSeconds) * 1000)),
    backoffMs: REVIEW_RETRY_BACKOFF_MS,
    guardMs: REVIEW_RETRY_GUARD_MS,
    userSignal: req?.signal,
    retryable: (failure) => isReviewRetryable(failure, { asyncPath: retry.asyncPath }),
    onRetry: (info) => debugLog({
      ev: 'review-retry', callId: req.callId,
      attempt: info.n, code: info.code, delayMs: info.delayMs, remainingMs: info.remainingMs,
    }),
    attempt: (signal) => runReviewAttempt(snapshot, llm, session, req, config, signal),
  })
  if (outcome.ok) return { review: outcome.value, attempts: outcome.attempts }
  return {
    review: { decision: 'ESCALATE', failure: outcome.failure.message, attempts: outcome.attempts },
    attempts: outcome.attempts,
  }
}
