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
