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
} as const
