/**
 * dsh-auto-approval-llm · debug trail, rules-parse reporting, pure gate verdicts.
 *
 * The debug switch binding lives in `approval-state.ts` and is written through
 * `setDebugOn`. The four exported verdict helpers are pure: each answers one
 * question about a call and returns `undefined` when the call may proceed.
 */
import { readFileSync, statSync } from 'node:fs'
import { appendAuditLine } from './audit.js'
import { debugOn } from './approval-state.js'
import { HARD_LOCKED_CATEGORIES } from './category.js'
import { recordDecisionFeedback } from './feedback-maps.js'
import { atomicWriteFile } from './route-table.js'
import { DEBUG_FILENAME, appendRuntimeLine } from './runtime-paths.js'
import { hardDenyReason, type Roots } from './policy.js'
import { summarizeRulesParseErrors, type RuleParseError } from './rules.js'
import { resolveDeepest, symlinkEscapeReason } from './symlink.js'

// Gated by the settings「调试」switch (`config.debug`); off by default so the
// debug trail is only written while diagnosing.

// Latest config-init/update error (illegal persisted value, failing
// describe/register). Surfaced to the settings card as a red banner so the
// user can see why the plugin is running on fallback defaults and clear it.

// Debug trail for the reviewer/approval timeline (append-only, size-capped).
// Lets a human inspect whether/when the LLM reviewed, what it said and how
// long it took — useful to tell "LLM too slow" from a wrongful timeout label.
export function debugLog(entry: Record<string, unknown>): void {
  if (!debugOn) return
  try {
    const file = appendRuntimeLine(DEBUG_FILENAME, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
    if (file === undefined) return
    if (statSync(file).size > 1_048_576) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      atomicWriteFile(file, `${lines.slice(-2000).join('\n')}\n`)
    }
  } catch {
    // Debug is best-effort; never affects the approval outcome.
  }
}

// One shared loud path for a malformed rulesText block. rulesText is parsed
// in both evaluation planes — pre-execute and the answerer — and a block
// with parse errors disables the whole declared-rules segment in each
// (documented semantics, not changed here). The pre-execute plane used to
// skip that in silence and the answerer only console.error'd, so a deny rule
// dropped by a hand-edited block could fail open with nothing consistent to
// search for. Both planes now funnel through this single reporter (same
// payload, same channels): console always, the debug trail when enabled, and
// a dedicated non-decision audit event that never counts as a verdict.
// Per-plane suppression keyed on the reported signature keeps a broken block
// from re-alerting on every tool call or rotating real decision records out
// of the audit file; any edit that leaves the block broken changes the
// signature and re-reports.
const rulesParseReported = new Map<string, string>()

export function reportRulesParseErrors(plane: 'pre-execute' | 'answerer', errors: RuleParseError[]): void {
  try {
    const { entries, more } = summarizeRulesParseErrors(errors)
    if (entries.length === 0) return
    const signature = `${plane}:${entries.map((e) => `${e.line}:${e.message}`).join('|')}`
    if (rulesParseReported.get(plane) === signature) return
    rulesParseReported.set(plane, signature)
    const detail = entries.map((e) => `L${e.line}: ${e.message}`).join('; ')
    const overflow = more > 0 ? `；另有 ${more} 处未列出` : ''
    console.error(`[dsh-auto-approval-llm][rules-parse-error] ${plane}: rulesText 解析错误，整段声明规则不生效（共 ${errors.length} 处）: ${detail}${overflow}`)
    debugLog({ ev: 'rules-parse-error', plane, count: errors.length, errors: entries })
    appendAuditLine(JSON.stringify({
      type: 'rules-parse-error',
      at: Date.now(),
      plane,
      count: errors.length,
      errors: entries,
    }))
  } catch {
    // Reporting is observational; a failure here never touches the decision path.
  }
}

/**
 * The guard's refusal reason for a call, as a value: `undefined` means the call
 * may dispatch.
 *
 * The guard hook needs a resolved `roots` (it is built from the live config by
 * the caller), so this takes the roots rather than resolving them. Lifting the
 * fuse order out of the hook is what makes it reachable from a unit test: the
 * composed "hard deny wins, otherwise symlink escape" decision had no
 * behavioural coverage at all, because the hook itself cannot be booted outside
 * a running plugin — only its SOURCE TEXT was pinned, so a change to the
 * composition would have passed. The Auto-only gate stays with the caller,
 * where it also decides whether the denial is recorded.
 */
export function guardDenyDecision(exec: any, roots: Roots): string | undefined {
  return hardDenyReason(exec, roots) ?? symlinkEscapeReason(exec, roots, resolveDeepest)
}

/**
 * Pure: may a `dsa_request_user` target use the human-only channel, and if not,
 * why? `undefined` means the target may.
 *
 * The channel exists to hand a human an operation the static policy leaves to
 * the ordinary pipeline, so every verdict the ordinary pipeline would have
 * reached on its own must refuse here: a HIGH tier, an explicit `deny`
 * directive (the operator's denial, which `applyCategoryDirective` turns into
 * the terminal DENY regardless of tier), and a LOCKED category (the one the
 * answerer refuses to auto-answer at all). Only the tier used to be read, so a
 * `{risk:'LOW', directive:'deny'}` target and every locked target slipped past
 * the gate into a channel whose granted approval also trains the confirmation
 * layer for the target signature.
 */
export function directHumanTargetRefusal(input: {
  risk?: string
  directive?: string
  lockedCategory?: boolean
}): string | undefined {
  if (input.risk !== 'LOW' && input.risk !== 'MEDIUM') {
    return `graded ${input.risk ?? 'UNKNOWN'}`
  }
  if (input.directive === 'deny') return 'the policy denies the target'
  if (input.lockedCategory === true) return 'the target category is locked'
  return undefined
}

/**
 * Whether two endpoint URLs name the same request target: scheme, host, port
 * and path must agree, with a trailing slash ignored and a default port
 * normalized away. The stored reviewer credential is issued for the configured
 * endpoint only, so it is attached to a probe of that address and to no other —
 * anything unparsable or different counts as a different target (the caller
 * then probes without the stored key).
 */
export function sameEndpointTarget(a: string, b: string): boolean {
  const parse = (raw: unknown): URL | undefined => {
    try {
      return new URL(String(raw ?? '').trim())
    } catch {
      return undefined
    }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === undefined || right === undefined) return false
  const port = (url: URL): string => url.port !== '' ? url.port : (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '')
  return left.protocol === right.protocol
    && left.hostname === right.hostname
    && port(left) === port(right)
    && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '')
}

/**
 * Pure: why a name-based pre-authorization channel must not settle this call on
 * its own — `undefined` means it may.
 *
 * Both name-based channels (the allowlist mirror in pre-execute and the
 * answerer's static-allow path) enumerated only delete/disk, so an operator's
 * `allowlist: ['read']` — a TOOL name, never a path — also pre-authorized reads
 * of key material, and the allowlist carries no `credentialRead` judgement of
 * its own. The documented floor is that no name-based channel unlocks
 * credential material, exactly as `protectedAutoReview` cannot; delete/disk
 * stay unreachable for the same reason they always were (their damage is not
 * recoverable), with the one non-name-based exception the policy itself proved:
 * a deletion targeting only paths this session created.
 */
export function nameChannelLockRefusal(input: {
  category?: string
  sessionArtifactDeletion?: boolean
  credentialRead?: boolean
  opaqueLocked?: boolean
}): string | undefined {
  if (input.opaqueLocked === true) return 'opaque destructive program is locked'
  if (input.category === 'delete' && input.sessionArtifactDeletion === true) return undefined
  if (input.credentialRead === true) return 'credential material read is not name-authorized'
  if (input.category !== undefined && HARD_LOCKED_CATEGORIES.includes(input.category as never)) {
    return `hard-locked category ${input.category}`
  }
  return undefined
}

/**
 * Fail-closed downgrade for an allow verdict whose audit record could not be
 * persisted: leave an honest feedback trail (surfaced to the model through
 * the post-execute injection on the denied result) and let the caller answer
 * denied. Callers must also skip any learning bookkeeping — an unaudited
 * verdict must never train the confirmation layer.
 */
export function denyOnAuditFailure(callId: string | undefined): void {
  recordDecisionFeedback(callId, '[dsh-auto-approval-llm] audit failure the decision audit could not be persisted; failing closed to rejected so no unaudited allow can take effect')
  debugLog({ ev: 'audit-failure-deny', callId: callId ?? null })
}
