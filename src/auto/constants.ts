/**
 * Hard cap on a free-text reason accepted from a model, in characters. Not a
 * user setting: it bounds what a reviewer endpoint can push into
 * history/audit/UI regardless of configuration. `parseClassifierDecision`
 * rejects a longer reason outright (its response schema is strict);
 * `parseReview` truncates instead, because dropping a decisive reviewer
 * verdict over a long explanation would turn a DENY into an ESCALATE.
 */
export const MODEL_REASON_MAX_CHARS = 1_000

/**
 * The direct-human-approval tool name: an agent calls this to ask that a
 * follow-up operation be reviewed by a human instead of the LLM classifier.
 * Single source of truth shared by the policy layer (policy.ts forces the
 * call onto the pure-human ask plane) and the host answerer (index.ts routes
 * the ask through the confirmation-learning hook with the target signature).
 * The name deliberately avoids the destructive / external-write /
 * security-change risk patterns so the policy sees it as an ordinary ask.
 */
export const DIRECT_HUMAN_TOOL = 'dsa_request_human'


/**
 * Single source of truth for numeric threshold defaults. The host Config
 * schema, host fallbacks and the client settings draft/reset values all
 * reference these so one change lands everywhere at once.
 */
export const THRESHOLD_DEFAULTS = {
  lowRiskSeconds: 5,
  mediumRiskSeconds: 8,
  highRiskSeconds: 10,
  maxConsecutiveDenials: 3,
  maxTotalDenials: 20,
  maxArgsChars: 4_000,
  breakerAntiHijackMs: 0,
  classifierTimeoutMs: 8_000,
  classifierMaxOutputTokens: 1_024,
  reviewMaxRetries: 1,
  /** Per-attempt wait for one reviewer response, in seconds. */
  reviewWaitSeconds: 5,
  /** Cap for rule text injected into the reviewer system prompt. */
  rulesSummaryMaxChars: 2_000,
  /** Human confirmations (default) before a same-signature call may auto-allow. */
  learningThreshold: 3,
  /** Learning entries expire after this many days without a confirmation. */
  learningTtlDays: 30,
  /** Hard ceiling on stored learning entries (LRU by lastAt evicts). */
  learningMaxEntries: 100,
  /** Learned allows per root session before the learning layer sleeps. */
  learningSessionAllowCap: 50,
} as const
