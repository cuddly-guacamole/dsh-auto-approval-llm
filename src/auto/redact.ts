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
 * connection strings, `:\s*["']` / `:\s*\S{6,}` for JSON and bare colon
 * forms). It only decides whether to run the replacement chain
 * — never which replacement applies — so a benign huge result (e.g. a file
 * read) skips the multi-pass scan without any false-negative gate.
 */
const SECRET_FEATURES = /[=]|bearer|begin|akia|eyj|github_pat|\bsk[-_]|ghp[-_]|xox|:\/\/|:\s*["']|:\s*\S{6,}/i

/** Redact likely secrets (key formats, bearer tokens, key=value pairs). */
export function redactSecrets(value: string): string {
  if (!SECRET_FEATURES.test(value)) return value
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted-secret]')
    .replace(/((?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted-secret]')
    // JSON colon forms (`{"token": "…"}`, `'api_key': '…'`): keep the key and
    // the quoted structure, replace the value only (quotes preserved so the
    // text stays parseable after redaction).
    .replace(/(["'])(api[_-]?key|token|secret|password|access_key|auth[_-]?token)\1\s*:\s*(["'])[^"']+["']/gi, '$1$2$1: $3[redacted-secret]$3')
    // Bare colon forms (`token: abc12345`): the value must be at least six
    // non-space characters so short values / negations (`token: none`,
    // `secret: no`) stay readable text.
    .replace(/\b(api[_-]?key|token|secret|password)\s*:\s*\S{6,}/gi, '$1: [redacted-secret]')
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
 * Depth past which the walk stops descending. It carries three jobs at once,
 * which is why it stays even though it bounds secret coverage:
 *
 * - Stack guard. The walk is recursive and a tool result is untrusted JSON:
 *   `JSON.parse` accepts 20000 levels, while an unbounded version of this walk
 *   was measured dying with a RangeError between 5000 and 8000. That failure is
 *   worse than a missed secret — the caller's catch reports `auditMaskFailed`
 *   and forwards the UNMASKED result, so a deep-nesting payload would defeat
 *   masking entirely rather than partially.
 * - Cycle terminator. A self-referencing result stops here.
 * - Cost guard on pathological shapes.
 *
 * 64 rather than 6: the copy-on-write walk below made the realistic cases
 * cheaper (2000 file rows: 4.50ms → 0.91ms), which buys the headroom to cover
 * far deeper results while staying an order of magnitude inside the stack.
 */
const DEFAULT_MAX_DEPTH = 64

/**
 * Recursively mask credential-shaped material inside one tool result value.
 * Pure JSON semantics: only replace, NEVER truncate (a benign large result such
 * as a file read must survive byte-exact), and return the ORIGINAL reference
 * when nothing changed.
 *
 * Copy-on-write: a container is cloned only once something inside it actually
 * changed, so a benign result costs a walk and no allocation. The previous
 * shape built a replacement object for every container and threw it away when
 * nothing matched, which is where the old depth cost came from — and the clone
 * is a spread, so an own `__proto__` key (JSON.parse creates one) stays an
 * ordinary data key instead of hijacking the copy's prototype.
 *
 * Coverage is honest about its edge: everything down to `maxDepth`, plus the
 * field names and string values of the containers sitting one level past it.
 * Nothing deeper is inspected at all — a string buried below that boundary is
 * NOT cleaned, because the walk never reaches it. `{token: …}` at the boundary
 * itself is masked rather than handed back raw, which is the leak this bound
 * used to have at 6.
 */
export function redactResultValue(value: unknown, depth = 0, maxDepth = DEFAULT_MAX_DEPTH): unknown {
  if (typeof value === 'string') {
    const cleaned = redactSecrets(value)
    return cleaned === value ? value : cleaned
  }
  if (typeof value !== 'object' || value === null) return value
  const beyond = depth > maxDepth
  if (Array.isArray(value)) {
    // An array carries no field names, so there is nothing to check at the
    // bound: pass it through untouched.
    if (beyond) return value
    let out: unknown[] | null = null
    for (let i = 0; i < value.length; i += 1) {
      const item = redactResultValue(value[i], depth + 1, maxDepth)
      if (out === null && item !== value[i]) out = value.slice()
      if (out !== null) out[i] = item
    }
    return out ?? value
  }
  const record = value as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue
    const entry = record[key]
    let cleaned: unknown
    if (SECRET_KEYS.test(key)) {
      cleaned = REDACTED_FIELD
    } else if (beyond) {
      // At the bound the field name above has already been checked; hand the
      // value back without descending (stack/cycle/cost guard). A string is
      // still cheap to clean and can hide a secret of its own.
      cleaned = typeof entry === 'string' ? redactSecrets(entry) : entry
    } else {
      cleaned = redactResultValue(entry, depth + 1, maxDepth)
    }
    if (out === null && cleaned !== entry) out = { ...record }
    if (out !== null) out[key] = cleaned
  }
  return out ?? value
}
