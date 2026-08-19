/**
 * dsh-auto-approval-llm · pure decision helpers.
 *
 * These are kept free of live Cordis/DSH objects (only plain data + callbacks)
 * so the fail-closed contract of the approval pipeline can be unit-tested
 * without a running harness.
 */

import { sanitizeClassifierArguments, sanitizeClassifierText } from './classifier.js'

export interface ReviewResult {
  decision: 'ALLOW' | 'DENY' | 'ESCALATE'
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  reason?: string
  failure?: string
}

/**
 * Strictly parse a reviewer text into a {@link ReviewResult}. Any deviation
 * (missing JSON, invalid decision/risk level, non-string reason) throws so the
 * caller's catch path fails closed; a half-parsed decision is never trusted.
 */
export function parseReview(text: string): ReviewResult {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('reviewer output contains no JSON object')
  const parsed = JSON.parse(stripped.slice(start, end + 1))
  const decision = parsed?.decision
  if (decision !== 'ALLOW' && decision !== 'DENY' && decision !== 'ESCALATE') {
    throw new Error(`reviewer output has invalid decision "${String(decision)}"`)
  }
  const riskLevel = parsed?.risk_level
  if (riskLevel !== undefined && !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(riskLevel)) {
    throw new Error(`reviewer output has invalid risk_level "${String(riskLevel)}"`)
  }
  const reason = parsed?.reason
  if (reason !== undefined && typeof reason !== 'string') throw new Error('reviewer output has non-string reason')
  return {
    decision,
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(reason === undefined ? {} : { reason }),
  }
}

export type TimeoutAction = 'reject' | 'allow'

export interface HumanDecisionStatus {
  seconds: number
  action: TimeoutAction
}

export interface HumanDecisionOptions {
  status: HumanDecisionStatus
  callId?: string
  recordTimeout: (callId: string, text: string) => void
}

export interface HumanDecision {
  outcome: string
  timedOut: boolean
}

/**
 * Claim handle wired up by {@link raceHumanDecision}. When a caller can decide
 * the outcome authoritatively (e.g. a decisive LLM conclusion arrives before
 * the human), it calls {@link claim} to cancel the host countdown and settle
 * the race immediately.
 */
export interface RaceHumanHandle {
  claim: (outcome: 'allowed-once' | 'rejected') => void
}

/**
 * Race a delegated human answer (nextPromise) against a host-authoritative
 * countdown. When the timer wins the request is claimed locally with the
 * configured timeout action and the canonical timeout notice is recorded via
 * the supplied callback (never via an untrusted client text). A caller that
 * wanted a plain delegation (no time limit) should not use this helper.
 *
 * When `handle` is supplied its `claim` lets a decisive caller pre-empt the
 * countdown: the timer is cleared and the race settles with the pure outcome
 * string and `timedOut: false`, so the returned shape stays identical whether
 * the human, the host timer, or the caller's claim wins.
 */
export async function raceHumanDecision(
  next: () => Promise<any>,
  opts: HumanDecisionOptions,
  handle?: RaceHumanHandle,
): Promise<HumanDecision> {
  const humanMs = Math.max(1, Math.round(opts.status.seconds)) * 1000
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let claimed = false
  let settle: (outcome: string, didTimeout: boolean) => void = () => {}
  const racedPromise = new Promise<string>((resolve) => {
    settle = (outcome: string, didTimeout: boolean) => {
      timedOut = didTimeout
      resolve(outcome)
    }
    timeoutTimer = setTimeout(() => {
      if (claimed) return
      if (opts.callId !== undefined) {
        const actionText = opts.status.action === 'allow' ? 'approved' : 'rejected'
        opts.recordTimeout(
          opts.callId,
          `[dsh-auto-approval-llm] no response: auto-${actionText} (${opts.status.seconds}s)`,
        )
      }
      settle(opts.status.action === 'allow' ? 'allowed-once' : 'rejected', true)
    }, humanMs)
  })
  if (handle !== undefined) {
    handle.claim = (outcome: 'allowed-once' | 'rejected') => {
      if (claimed) return
      claimed = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      settle(outcome, false)
    }
  }
  try {
    const outcome = await Promise.race([Promise.resolve().then(() => next()), racedPromise])
    return { outcome, timedOut }
  } finally {
    if (!timedOut && !claimed && timeoutTimer !== undefined) clearTimeout(timeoutTimer)
  }
}

/**
 * Fail-closed LOW-risk reviewer outcome policy (single source of truth; the
 * "never auto-allow on ESCALATE/failure" rule):
 *  - ALLOW                     -> allow
 *  - DENY                      -> deny (counts toward the LLM-denial breaker)
 *  - reviewer failure          -> deny (fail closed; NOT an LLM denial streak)
 *  - genuine ESCALATE          -> ask human (never auto-answer uncertainty)
 */
export type LowRiskOutcome =
  | { kind: 'allow' }
  | { kind: 'deny'; llmDenied: boolean }
  | { kind: 'ask' }

export function lowRiskReviewOutcome(review: {
  decision: string
  failure?: string
  riskLevel?: string
  reason?: string
}): LowRiskOutcome {
  if (review.decision === 'ALLOW') return { kind: 'allow' }
  if (review.decision === 'DENY') return { kind: 'deny', llmDenied: true }
  if (review.failure !== undefined) return { kind: 'deny', llmDenied: false }
  return { kind: 'ask' }
}

/**
 * Unique-terminator conflict detection: given the list of installed bundle
 * names, report any known approval-plugin competitors that would also try to
 * claim `approval/request`. Kept pure so P0.7a can assert it.
 */
export function detectConflicts(bundles: Iterable<string>): string[] {
  const names = new Set([...bundles].map((b) => b.toLowerCase()))
  const competitors = ['dsh-approval-llm', 'dsh-auto-review', '@nanmicoder/dsh-auto-mode', 'dsh-approval-ai', 'dsh-approval-timeout']
  return competitors.filter((c) => names.has(c.toLowerCase()))
}

/**
 * Whether a reviewer result (or its absence/rejection) may be auto-answered.
 * ESCALATE must always surface to a human; only ALLOW/DENY are decisive.
 */
export function reviewerDecidable(decision: string): boolean {
  return decision === 'ALLOW' || decision === 'DENY'
}

/**
 * Fields that are configured host-side (via patch/YAML) and never edited by
 * the browser settings card. A card save must preserve whatever the current
 * stored value holds for these, otherwise the full `settings.replace` would
 * silently drop them.
 */
export const HOST_ONLY_KEYS = [
  'workspaceRoot',
  'dshHome',
  'tempRoots',
  'classifierTimeoutMs',
  'classifierMaxOutputTokens',
  'maxArgsChars',
  'notifyUser',
]

/**
 * Whether the denial breaker is tripped for a session. Either threshold, when
 * enabled (> 0), trips; 0 disables that rail. Pure so the contract is testable.
 */
export function breakerTripped(
  maxConsecutive: number,
  maxTotal: number,
  consecutive: number,
  total: number,
): boolean {
  if (maxConsecutive > 0 && consecutive >= maxConsecutive) return true
  if (maxTotal > 0 && total >= maxTotal) return true
  return false
}

export interface DenialCounts {
  consecutive: number
  total: number
}

export interface BreakerTransition {
  counts: DenialCounts
  reset: boolean
  increment: boolean
}

/**
 * Pure denial-breaker state transition for one answered request. A human
 * decision (allow or deny) clears the streak; a decided LLM denial increments
 * it; every other outcome leaves the counters unchanged. Callers apply the
 * returned `counts` and may branch on `reset`/`increment` for side effects.
 */
export function applyBreaker(
  counts: DenialCounts,
  source: string,
  llmDecided: boolean,
): BreakerTransition {
  if (source === 'human-allow' || source === 'human-deny') {
    return { counts: { consecutive: 0, total: 0 }, reset: true, increment: false }
  }
  if (llmDecided && source === 'llm-deny') {
    return {
      counts: { consecutive: counts.consecutive + 1, total: counts.total + 1 },
      reset: false,
      increment: true,
    }
  }
  return { counts: { ...counts }, reset: false, increment: false }
}

export function preserveHostKeys(
  current: Record<string, unknown>,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...submitted }
  for (const key of HOST_ONLY_KEYS) {
    if (!(key in submitted) && key in current) out[key] = current[key]
  }
  return out
}

/**
 * Normalize a persisted timeoutAction for the client editor. The legacy
 * "llm-low-risk-only" value (subsumed by the LOW branch) is presented as and
 * saved back as "reject" so a card save always persists a valid value.
 */
export function normalizeTimeoutAction(value: unknown): 'reject' | 'allow' | 'low-risk-allow' {
  if (value === 'allow') return 'allow'
  if (value === 'low-risk-allow') return 'low-risk-allow'
  return 'reject'
}

// ── reasoning-blind reviewer input (A1) ────────────────────────────────────
// The reviewer sees ONLY: the tool identity, structurally sanitized arguments,
// a bounded set of direct user messages (the sole authorization evidence), and
// workspace facts. Assistant prose, tool output, and model-generated reason
// text are never forwarded, so a compromised page/context cannot steer the
// reviewer through text it controls.

/**
 * Prepare the tool-call arguments recovered from the session log (a JSON text)
 * for the reviewer: parse to a structure and sanitize (redact secrets, bound
 * bulk content); when the text is not JSON, fall back to plain-text sanitizing.
 */
export function prepareReviewerArguments(raw: string | undefined | null): unknown {
  if (raw === undefined || raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    return sanitizeClassifierArguments(parsed)
  } catch {
    return sanitizeClassifierText(raw)
  }
}

/** Extract the primary path argument (file_path/path/cwd/workdir) from args. */
export function extractToolPath(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof obj !== 'object' || obj === null) return undefined
  for (const key of ['file_path', 'path', 'cwd', 'workdir']) {
    if (typeof obj[key] === 'string') return obj[key]
  }
  return undefined
}

export interface ReviewerInput {
  toolName: string
  description?: string | null
  rawArguments?: string | null
  trustedUserMessages: string[]
  workspaceRoot?: string
  targetRelative?: string | null
  inWorkspace?: boolean | null
}

/** Frame the reasoning-blind reviewer payload as one JSON text. */
export function frameReviewerInput(input: ReviewerInput): string {
  return JSON.stringify({
    tool_name: input.toolName,
    description: input.description ?? null,
    arguments: prepareReviewerArguments(input.rawArguments ?? null),
    trusted_user_messages: (input.trustedUserMessages ?? [])
      .map((m) => sanitizeClassifierText(m))
      .slice(0, 4),
    workspace: {
      root: input.workspaceRoot ?? null,
      target_relative: input.targetRelative ?? null,
      in_workspace: input.inWorkspace ?? null,
    },
  })
}
