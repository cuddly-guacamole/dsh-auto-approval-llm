/**
 * dsh-auto-approval-llm · credential-shaped masking for tool RESULT values.
 *
 * redactSecrets and SECRET_KEYS are ported from @nanmicoder/dsh-auto-mode
 * (classifier.js) and moved here so both the classifier boundary and the
 * result-side masker share ONE implementation (never two drifting copies).
 * MIT License, Copyright (c) 2026 程序员阿江-Relakkes
 * (https://github.com/NanmiCoder/dsh-auto-mode).
 * Retained per the MIT License: this is a substantial portion of the original.
 *
 * The JWT / connection-string patterns and the feature pre-screen below are
 * written for this project (not copied from any third-party code).
 */

/** Field names that carry credential-shaped material (shared with the classifier). */
export const SECRET_KEYS = /(?:api|auth|access|secret|private|credential|password|token|cookie|authorization).*?(?:key|value|token)?$/i

/**
 * Cheap feature pre-screen: a strict superset of every literal the
 * redaction patterns below can match (`=` for key=value forms, `bearer`,
 * `begin` for PEM, `akia`, `eyj` for JWT, the token prefixes, `://` for
 * connection strings). It only decides whether to run the replacement chain
 * — never which replacement applies — so a benign huge result (e.g. a file
 * read) skips the multi-pass scan without any false-negative gate.
 */
const SECRET_FEATURES = /[=]|bearer|begin|akia|eyj|github_pat|\bsk[-_]|ghp[-_]|xox|:\/\//i

/** Redact likely secrets (key formats, bearer tokens, key=value pairs). */
export function redactSecrets(value: string): string {
  if (!SECRET_FEATURES.test(value)) return value
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted-secret]')
    .replace(/((?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted-secret]')
    // AWS access-key IDs (`AKIA...`) and AWS secret material (the
    // `aws_secret_access_key=`/`secret_access_key=` forms are NOT caught by
    // the `secret=` pattern above because `_access_key` sits between).
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-secret]')
    .replace(/((?:aws_secret_access_key|aws_access_key_id|secret_access_key|access_key_id|aws_session_token)\s*=\s*)[A-Za-z0-9/+=_-]{16,}/gi, '$1[redacted-secret]')
    // PEM private-key blocks (whole block, not just the header line). The
    // block body is capped at 8 KiB so a stream of BEGIN headers without an
    // END cannot degrade into quadratic scanning — a bounded scan stays
    // linear in the number of headers and is still far beyond real key sizes.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----/gi, '[redacted-secret]')
    // JWT: three base64url segments (header.payload.signature). Requiring a
    // plausible length on each segment keeps ordinary base64 or a bare `eyJ`
    // prefix untouched.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted:jwt]')
    // Connection strings with userinfo (user:password@ or redis-style
    // :password@): mask the credential part, keep scheme + host readable.
    // The lookahead demands a ':' before the '@' so a plain URL whose PATH
    // contains '@' (e.g. https://host/path@x) is never misread as userinfo.
    .replace(/\b((?:postgres(?:ql)?|rediss?|mongodb(?:\+srv)?|mysql|mariadb|amqps?|nats|https?):\/\/)(?=[^\s/:]*:)(?:[^\s:/@]+:)?[^@\s]+@/gi, '$1[redacted:connection-string]')
}

/** Marker for a value whose field name matches SECRET_KEYS (result side). */
export const REDACTED_FIELD = '[redacted:field]'

/**
 * Recursively mask credential-shaped material inside one tool result value.
 * Pure JSON semantics: only replace, NEVER truncate (a benign large result
 * such as a file read must survive byte-exact), and return the ORIGINAL
 * reference when nothing changed (zero copying on the common path). Objects
 * and arrays deeper than `maxDepth` are passed through untouched.
 */
export function redactResultValue(value: unknown, depth = 0, maxDepth = 6): unknown {
  if (depth > maxDepth) return value
  if (typeof value === 'string') {
    const cleaned = redactSecrets(value)
    return cleaned === value ? value : cleaned
  }
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = new Array<unknown>(value.length)
    for (let i = 0; i < value.length; i += 1) {
      const item = redactResultValue(value[i], depth + 1, maxDepth)
      out[i] = item
      if (item !== value[i]) changed = true
    }
    return changed ? out : value
  }
  const record = value as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (depth < maxDepth && SECRET_KEYS.test(key)) {
      out[key] = REDACTED_FIELD
      changed = true
    } else {
      const cleaned = redactResultValue(entry, depth + 1, maxDepth)
      out[key] = cleaned
      if (cleaned !== entry) changed = true
    }
  }
  return changed ? out : value
}