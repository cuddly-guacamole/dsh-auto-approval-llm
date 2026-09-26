/**
 * dsh-auto-approval-llm · cross-cluster approval state.
 *
 * The plugin's plugin-lifetime mutable state lives here so that a module split
 * shares one binding per store instead of each consumer rebuilding a private
 * copy. Every mutable container (`Set` / `Map` / array) is exported directly
 * and never behind a copy-returning accessor: `approvalHistory.length = 0` is
 * an in-place clear that must be observed by every reader, and
 * `holdWhileUnchanged` compares the `revision` published in `reviewStates`, so
 * a shallow copy would silently turn a wake-on-change long poll into a
 * full-budget wait that reports nothing wrong.
 *
 * The three `let` bindings carry a setter because ESM forbids assigning to an
 * imported binding: the owner of the write (the entry's `apply()`) calls
 * `setDebugOn` / `setConfigError` / `setLearningStore` instead.
 *
 * Only declarations live here. Every decision, route and helper that reads
 * them stays in the entry.
 */

import type { HistoryRecord } from '../index.js'
import type { ReviewResult } from './decision.js'
import type { LatencySample } from './latency.js'
import { emptyLearningStore, type LearningStore } from './learning.js'
import type { LoopGuardState } from './loop-guard.js'

// ── first-use onboarding notice ───────────────────────────────────────────
// A process-lifetime one-shot greeting for a fresh AUTO session: the very
// first tool call of each root session queues the notice once through the
// safe notice queue above (never a bare append). The marker lives only in
// memory and never touches disk, so a restart may greet the same session
// again — an accepted semantic (documented in HANDOFF).
export const firstAutoNoticeSeen = new Set<string>()

// ── reject guidance dedup ─────────────────────────────────────────────────
// Bounded the same way as firstAutoNoticeSeen: keys are (sessionId, callId)
// and would otherwise grow without limit in a long-lived process. The cap is
// a simple insert-order FIFO (Set iteration follows insertion order), and
// session/disposed drops a session's prefix wholesale (see apply()).
export const rejectGuidanceSeen = new Set<string>()

// ── timeout feedback ──────────────────────────────────────────────────────
// When the human countdown expires we still must return `'rejected'` (the
// approval vocabulary has no timeout outcome), but the agent should be able to
// tell a timeout apart from a deliberate user denial. Record a marker and let
// `tools/post-execute` inject it into the denied tool result.
export const timeoutFeedback = new Map<string, { text: string; at: number }>()

export const decisionFeedback = new Map<string, { text: string; at: number }>()

// Loop guard state: per-session streaks of identical auto-allowed calls, plus
// the one-shot cross-plane pin that routes the escalated ask into the locked
// countdown shape in the answerer. Neither map writes history rows nor reads
// or writes the breaker counters — the escalation rides the ordinary ask
// vocabulary, so no new adjudicated source exists. Streaks whose authority
// cannot be resolved share the 'unknown' key (bounded by the per-state FIFO).
export const loopStates = new Map<string, LoopGuardState>()
export const loopGuardPinned = new Map<string, { consecutive: number; threshold: number; at: number }>()

// ── approval history ──────────────────────────────────────────────────────
/**
 * Adjudicated records, newest last.
 *
 * This binding is shared by reference on purpose: `loadRuntimeStores` and the
 * history DELETE route both clear it with `length = 0`, which only discards the
 * records for every reader if they all hold this very array.
 */
export const approvalHistory: HistoryRecord[] = []

// ── debug trail and the settings error banner ─────────────────────────────
// Gated by the settings「调试」switch (`config.debug`); off by default so the
// debug trail is only written while diagnosing.
export let debugOn = false

/** The single writer for the debug switch (`config.debug`). */
export function setDebugOn(next: boolean): void {
  debugOn = next
}

// Latest config-init/update error (illegal persisted value, failing
// describe/register). Surfaced to the settings card as a red banner so the
// user can see why the plugin is running on fallback defaults and clear it.
export let configError: string | null = null

/** The single writer for the banner text; `null` clears the banner. */
export function setConfigError(next: string | null): void {
  configError = next
}

// ── LLM review latency telemetry ──────────────────────────────────────────
// Independent of approval history: history records adjudicated facts, latency
// records how long each reviewer call actually took. Every attempt is sampled
// (including aborted ones and late responses that lost the countdown race),
// so the recent-100 min/avg/max cannot suffer survivor bias. Persisted in
// llm-latency.jsonl (same append+rotate pattern as history.jsonl); clear
// history intentionally leaves it alone — telemetry is not an approval record.
export const llmLatency: LatencySample[] = []

// ── confirmation-learning store ───────────────────────────────────────────
// Loaded once per process like history/latency; every mutation happens under
// the per-signature keyed mutex with a synchronous persist, so the on-disk
// snapshot can trail by at most one finished critical section. Corrupt or
// poisoned files degrade to an empty store = everything stays with a human.
// The LOAD prefers the canonical state path and falls back to the legacy
// package-root file, so an install upgrading keeps the entries it already
// earned; the persister then writes the merged store to the canonical path.
export let learningStore: LearningStore = emptyLearningStore()

/**
 * The single writer for the learning store. `loadRuntimeStores` replaces the
 * whole store at boot, and a rebind is not a mutation of the exported object.
 */
export function setLearningStore(next: LearningStore): void {
  learningStore = next
}

// ── review status ─────────────────────────────────────────────────────────
export interface ReviewStatus {
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  phase: 'countdown' | 'follow'
  action: 'reject' | 'allow'
  seconds: number
  note?: string
  feedback?: string
  /** Resolution origin, set on follow-phase statuses so the client can skip
   * re-answering approvals the human already settled. 'abort' labels a
   * cancelled/aborted ask (no human and no LLM decided) so it is never
   * misread as a human answer. */
  source?: 'human' | 'llm' | 'timeout' | 'abort'
  /**
   * The category layer's label for this call, when one was derived. Carried on
   * the status so the ask's own terminal record can name it: the rejected
   * records written from `askHuman` (timeout-deny, human-deny, llm-deny,
   * llm-failed) sit in a scope that cannot see `classifyStaticRisk`'s result,
   * and without the label a refusal cannot be grouped by category — which is
   * how a whole class of false refusals stayed uncountable. It is the same
   * closed-set key the decision records already carry, never a path or a
   * command string.
   */
  category?: string
  /**
   * Monotonic per-ask revision, allocated at the single publish choke point.
   * A client that receives a replayed or out-of-order payload compares it
   * against the revision it already holds and ignores the older one.
   */
  revision?: number
  /**
   * Host epoch ms the countdown expires. Carried so a client that observes the
   * ask mid-countdown (page reload, panel held back, late poll) shows the time
   * that is actually left instead of restarting from the published seconds.
   */
  expiresAt?: number
  /**
   * Set on the attached asks whose countdown is pinned to reject because a
   * locked category (or the credential-read floor, or the by-name channel
   * refusal) forbids every automatic release. It is a structural flag rather
   * than something derived from the reason text, and the panel needs it:
   * without it a locked ask is indistinguishable from an ordinary countdown, so
   * a user who authorized the operation in the conversation waits for an answer
   * that the design will never give. Only the STATUS carries the fact; the
   * ask's outcome semantics are unchanged.
   */
  lockedAsk?: true
}

/** Live review status per callId, shared by the answerer and the status routes. */
export const reviewStates = new Map<string, ReviewStatus>()
// Session association for the session-scoped discovery route: review states
// are keyed by callId only, and the client has to find a pending ask before
// the official panel exists (it is held back for `panelDelayMs`).
export const reviewSessions = new Map<string, string>()
// Held official panels, keyed by callId: the release callback lets the panel
// appear before the delay elapsed (the client's "show it now" entry).
export const pendingPanelReleases = new Map<string, () => void>()

/** Longest a review-status long poll may be held open. */
export const REVIEW_STATUS_HOLD_MS = 20_000

// Follow-phase statuses are retained briefly after the host resolution so the
// client's poll can observe the follow and close the official panel with the
// real outcome. Swept by FOLLOW_STATE_TTL_MS; released earlier on client ACK.
export const followExpiry = new Map<string, number>()

// Latest reviewer verdict per callId (covers both decisive MEDIUM takeovers
// and advisory MEDIUM/HIGH opinions). askHuman emits it into history so the
// LLM's review is always visible, even when it did not take over.
export const reviewVerdicts = new Map<string, ReviewResult>()

// callIds whose approval/request has already been settled by the host (any
// resolution path). The client's follow ACK (FEEDBACK POST) arrives AFTER
// askHuman finished, so without this set the ACK would relabel a resolved ask
// with the timeout notice. Map<callId, timestamp>; swept with the follow
// sweep; only used to gate feedback text.
export const resolvedCallIds = new Map<string, number>()

// callIds whose resolution was auto-answered by the client: the feedback route
// records the marker while the ask is live, askHuman consumes it to label the
// resolution `auto-*` instead of `human-*`, and the TTL sweep drops a marker
// whose ask never settled. Never a source of truth for the outcome itself.
export const autoAnsweredCallIds = new Map<string, number>()

// ── approval state registry ───────────────────────────────────────────────
// Every plugin-lifetime callId-keyed approval map, grouped so cleanup can
// never forget a member: /approval reset clears them all through
// clearApprovalState(), and the periodic / post-execute sweeps run from one
// place. The maps stay top-level variables (hot paths read them directly);
// this registry only owns their lifecycle. pendingNotices is deliberately
// NOT a member: it is session-keyed and released by its own session/disposed
// hook, not by the reset or the callId sweeps.
export const approvalState = {
  reviewStates,
  reviewSessions,
  followExpiry,
  reviewVerdicts,
  resolvedCallIds,
  autoAnsweredCallIds,
  timeoutFeedback,
  decisionFeedback,
}

// ── trusted-intent reporting ──────────────────────────────────────────────
/** Last provenance signature reported per session (the event is deduped). */
export const trustedIntentReported = new Map<string, string>()
