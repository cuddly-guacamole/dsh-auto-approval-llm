// Protocol-agnostic approval-responder core.
//
// Consumed by both protocol watchers (legacy rc.2 `snapshot.pending` and
// remote alpha.1 `pendingInteractions`) and by the button hijack in index.ts.
// Depends only on the plugin's own host routes (review-status/feedback) and
// never on any dsh client protocol type — duck-typed structural interfaces
// only — so this file survives the legacy protocol removal (0.0.15) unchanged.

export const FEEDBACK_ROUTE = '/_dsh/auto-approval-llm/feedback'
export const REVIEW_STATUS_ROUTE = '/_dsh/auto-approval-llm/review-status'

// Grace (ms) during which a countdown approval whose host follow is not yet
// observable keeps being watched before the client closes the panel with the
// recorded countdown action. Aligned with the host's follow TTL so the client
// never closes before the host would have swept the follow state.
export const FOLLOW_GRACE_MS = 120_000

export interface CountdownInfo {
  seconds: number
  action: 'allow' | 'reject'
  feedbackText?: string
}

export type ApprovalOutcome = 'allowed-once' | 'rejected'

// Protocol-agnostic identity of one approval ask. Never carries the protocol
// object itself: the watchers adapt their source into this shape.
export interface ApprovalHandle {
  sessionId: string
  /** Canonical identity (`${sessionId}:${callId}`); null for status-less asks. */
  key: string | null
  callId?: string
  respond(outcome: ApprovalOutcome): Promise<void>
}

// The single answer-once guard shared by every watcher/poller instance: an
// approval may be auto-answered by either watcher, the countdown timer, or a
// follow-up responder; only the first responder wins. Session-scoped keys are
// dropped when their session stops being tracked, bounding growth to
// approvals actually seen.
export const answeredApprovals = new Set<string>()

export function forgetAnsweredKeys(sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const key of [...answeredApprovals]) {
    if (key.startsWith(prefix)) answeredApprovals.delete(key)
  }
}

/** Unified dedup/tombstone identity: `${sessionId}:${callId}`; null without callId. */
export function canonicalPendingKey(sessionId: string, callId: string | undefined): string | null {
  if (!callId) return null
  return `${sessionId}:${callId}`
}

export function parseCountdown(reason: string | undefined): CountdownInfo | null {
  if (!reason) return null
  const match = reason.match(/\[dsh-auto-approval-llm\]\s*⏳\s*will auto-(approve|reject) in (\d+)s/)
  if (!match) return null
  return {
    seconds: Math.max(1, Number(match[2])),
    action: match[1] === 'approve' ? 'allow' : 'reject',
  }
}

// Answer exactly once, regardless of who calls: dedup with the shared guard,
// then best-effort host feedback (auto source), then the protocol respond.
// Every rejection is swallowed — a settled approval throwing is expected
// (someone else already answered) and must never surface or retry.
export async function answerOnce(handle: ApprovalHandle, outcome: ApprovalOutcome): Promise<void> {
  const key = canonicalPendingKey(handle.sessionId, handle.callId)
  if (!key) return
  if (answeredApprovals.has(key)) return
  // Add before answering: a settle-race (host resolved, respond throws) must
  // never permit a second answer for the same callId.
  answeredApprovals.add(key)
  try {
    if (handle.callId) {
      // Only the outcome crosses the wire; host generates the notice text.
      const feedback = (globalThis as any).fetch(FEEDBACK_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: handle.callId, outcome, auto: true }),
        credentials: 'same-origin',
      }).catch(() => {
        // The route is best-effort; the approval answer must still happen.
      })
      // Never let a slow/hanging feedback request block the approval answer.
      await Promise.race([feedback, new Promise((resolve) => setTimeout(resolve, 500))])
    }
    await handle.respond(outcome)
  } catch (e) {
    console.error('[dsh-auto-approval-llm] approval respond failed', e)
  }
}

export interface ReviewPollingOptions {
  /** Review-status poll interval (default 500ms; injectable for node tests). */
  pollMs?: number
  /** Grace window after the countdown status vanishes (default FOLLOW_GRACE_MS). */
  graceMs?: number
  /** Notifies the watcher that the approval settled; the watcher tombstones the key. */
  onDetach?: (key: string) => void
}

/** Watcher-level options: polling options plus an injectable clock. */
export interface WatcherOptions extends ReviewPollingOptions {
  /** Clock for the legacy watcher's event-driven extra-poll debounce. */
  now?: () => number
}

export interface ReviewPollHandle {
  dispose(): void
  /** Immediate poll for thaw/resume/visibility events; debounced by the caller. */
  pollNow(): void
}

// One armed approval: 500ms review-status observation + the countdown state
// machine + the bounded grace fallback. The returned handle lets the watcher
// detach (approval left pending) and fire immediate polls (C2 thaw events).
export function startReviewPolling(
  handle: ApprovalHandle,
  isStillPending: () => boolean,
  options: ReviewPollingOptions = {},
): ReviewPollHandle {
  const pollMs = options.pollMs ?? 500
  const graceMs = options.graceMs ?? FOLLOW_GRACE_MS
  // Status-less ask (no callId): nothing can ever be published for it and no
  // answer may be derived from marker text — never arm a poller.
  if (!handle.callId) return { dispose: () => {}, pollNow: () => {} }
  const timerKey = canonicalPendingKey(handle.sessionId, handle.callId)!
  const g = globalThis as any

  let settled = false
  // In-flight guard (F4): poll() may be entered by the immediate poll, the
  // interval tick and pollNow() — a response slower than pollMs used to let
  // every later tick stack a second request for the same callId. Only one
  // outstanding review-status fetch per poller instance, ever.
  let inFlight = false
  let interval: any
  let graceTimer: any
  let meta: string | undefined

  const clearGrace = () => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
  }

  // Stop observing one approval: clear poller/timer/meta and tombstone it via
  // the watcher. Idempotent — a late dispose() from the watcher is a no-op.
  const detach = () => {
    if (settled) return
    settled = true
    clearGrace()
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
    options.onDetach?.(timerKey)
  }

  const answerAction = (action: 'allow' | 'reject') => {
    void answerOnce(handle, action === 'allow' ? 'allowed-once' : 'rejected')
  }

  const applyStatus = (status: any) => {
    if (settled) return
    if (status?.phase === 'follow') {
      if (status.source === 'human' || status.source === 'abort') {
        // The human answered the panel / the ask was cancelled: detaching is
        // enough — re-answering would re-respond to a settled approval and
        // mislabel it (R001).
        detach()
        return
      }
      // LLM takeover / host timeout: answer with the real follow action so the
      // official panel closes immediately, then detach.
      detach()
      answerAction(status.action)
      return
    }
    if (status === undefined && meta?.startsWith('countdown:')) {
      // Host stopped reporting a follow for this countdown approval. Per the
      // DSH contract review-status is never 404 — resolution is signalled by
      // ok:false — so the host resolved and its terminal `follow` may simply
      // arrive one poll later. Keep the watch alive for a bounded grace so a
      // late follow still closes the official panel (A5). We never auto-answer
      // here: if a real follow arrives, the follow branch responds with the
      // host's authoritative action. Only if none arrives within the grace and
      // the approval is still open do we close it with the countdown's
      // recorded action — the only action this approval ever declared. When
      // the approval leaves pending, the watcher disposes this poller.
      const parts = meta.split(':')
      const recordedAction = parts[1] === 'allow' ? 'allow' : 'reject'
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = undefined
          if (isStillPending()) {
            answerAction(recordedAction)
          }
          detach()
        }, graceMs)
      }
      return
    }
    if (status?.phase !== 'countdown') {
      // No host-published countdown: never arm an answer from reason text.
      // The marker regex matches free text any command can forge, so reason
      // parsing must not decide outcomes — status-less asks (breaker / manual
      // / human-only) are meant to wait for a human, and every real countdown
      // shows up here as a published review-status within one poll.
      return
    }
    const next = `countdown:${status.action}:${status.seconds}`
    // A published countdown always supersedes any grace armed on an earlier
    // observation (R002) — cancel FIRST, also when the same value is
    // re-published: the grace may have been armed while the status window was
    // briefly empty (status-lag), and leaving it armed would let a stale
    // recorded action close the panel mid-countdown.
    clearGrace()
    if (meta === next) return
    meta = next
  }

  const poll = async () => {
    if (settled || inFlight) return
    inFlight = true
    let status: any
    try {
      const res = await g.fetch(REVIEW_STATUS_ROUTE, {
        credentials: 'same-origin',
        // Call id travels in a header so it never lands in the URL query
        // (devtools/logs/Referer). The host route reads this header.
        headers: { 'x-auto-approval-call-id': String(handle.callId) },
      })
      if (!res.ok) {
        // Transient server error: keep observing; never treat it as a
        // resolution.
        return
      }
      const data = await res.json()
      status = data?.ok ? data.value : undefined
    } catch {
      // Network error: never treat it as a resolution; keep observing.
      return
    } finally {
      inFlight = false
    }
    // Drop late responses for approvals already detached from (R004).
    if (settled) return
    applyStatus(status)
  }

  void poll()
  interval = setInterval(() => { void poll() }, pollMs)

  return {
    dispose: detach,
    pollNow: () => { void poll() },
  }
}

// ── breaker anti-hijack guard (button disable window) ──────────────────────
// The official ApprovalPanel disables its own buttons during a breaker
// countdown vote, but only after the host published a review-status. The
// hijack guard closes the pre-vote window by disabling 拒绝/允许一次 as soon
// as the breaker text appears. Button nodes are duck-typed ({textContent,
// disabled, isConnected}) so the guard runs under the unit test's fake DOM.

/** One guard slot: a button node captured at arm time + its pre-guard state. */
export interface BreakerSlot {
  node: any
  disabled: boolean
}

/** Per-key breaker state: the disable window plus the last-seen button nodes. */
export interface BreakerEntry {
  timer: any
  deadline: number
  reject: BreakerSlot | null
  allow: BreakerSlot | null
}

export interface BreakerGuard {
  /** Disable the panel's buttons for the window (re-applying to CURRENT nodes). */
  apply(panel: any, key: string): void
  /** Drop guard state for keys that left the live panel set. */
  prune(liveKeys: ReadonlySet<string>): void
  /** Release every pending window (clear all timers/state). */
  dispose(): void
}

/**
 * Breaker anti-hijack guard. `getWindowMs` is read per apply(): returning 0
 * makes the guard a complete no-op (default). The window is re-applied on
 * every apply while it is open: a React re-render swaps the button nodes
 * mid-window, so each scan re-captures the CURRENT nodes (keeping them
 * disabled) and expiry restores whichever nodes are in the DOM then (F5).
 */
export function createBreakerGuard(getWindowMs: () => number): BreakerGuard {
  const breakerTimers = new Map<string, BreakerEntry>()

  const restoreNode = (slot: BreakerSlot | null) => {
    if (slot && slot.node != null && slot.node.isConnected) slot.node.disabled = slot.disabled
  }

  const armNode = (entry: BreakerEntry, button: any, slot: 'reject' | 'allow') => {
    const rec = entry[slot]
    if (rec && rec.node === button) return // same node still in DOM: state already captured
    const disabled = button.disabled
    button.disabled = true
    entry[slot] = { node: button, disabled }
  }

  const apply = (panel: any, key: string) => {
    const windowMs = getWindowMs()
    if (!windowMs) return
    const entry = breakerTimers.get(key)
    if (entry && entry.deadline <= Date.now()) {
      // Window over: restore the nodes recorded at the last apply (the
      // re-rendered ones if any) and disarm; the next apply with the breaker
      // text still visible arms a fresh window (rolling, as before).
      clearTimeout(entry.timer)
      restoreNode(entry.reject)
      restoreNode(entry.allow)
      breakerTimers.delete(key)
    }
    const buttons: any[] = Array.from(panel.querySelectorAll('button'))
    const reject: any = buttons.find((b: any) => /^(拒绝|Reject)$/i.test((b.textContent ?? '').trim()))
    const allow: any = buttons.find((b: any) => /^(允许一次|Allow once)$/i.test((b.textContent ?? '').trim()))
    if (!reject && !allow) return
    const current = breakerTimers.get(key)
    if (current) {
      // Window still open: re-apply to the CURRENT nodes. A React re-render
      // mid-window swaps the button nodes; without re-arming here the new
      // buttons would stay enabled for the rest of the window (F5).
      armNode(current, reject, 'reject')
      armNode(current, allow, 'allow')
      return
    }
    const fresh: BreakerEntry = {
      timer: undefined,
      deadline: Date.now() + windowMs,
      reject: null,
      allow: null,
    }
    armNode(fresh, reject, 'reject')
    armNode(fresh, allow, 'allow')
    fresh.timer = setTimeout(() => {
      // Expiry: restore whatever is recorded (the last-seen nodes; nodes that
      // left the DOM are skipped by the isConnected check).
      const expired = breakerTimers.get(key)
      if (!expired) return
      restoreNode(expired.reject)
      restoreNode(expired.allow)
      breakerTimers.delete(key)
    }, windowMs)
    breakerTimers.set(key, fresh)
  }

  const prune = (liveKeys: ReadonlySet<string>) => {
    for (const key of [...breakerTimers.keys()]) {
      if (!liveKeys.has(key)) {
        const entry = breakerTimers.get(key)
        if (entry) clearTimeout(entry.timer)
        breakerTimers.delete(key)
      }
    }
  }

  const dispose = () => {
    for (const entry of breakerTimers.values()) clearTimeout(entry.timer)
    breakerTimers.clear()
  }

  return { apply, prune, dispose }
}

// ── edit-diff marker stripping ─────────────────────────────────────────────
// The host appends "[dsh-edit-diff]…[/dsh-edit-diff]" to the reason text of
// edit-class approvals; the client renders a colored preview from the block
// and must remove the raw marker text from the panel. Stripping rewrites TEXT
// NODES only — never `el.textContent = …`, which would destroy the
// React-rendered child structure (spans can split the two markers apart, so
// the element carrying both markers is usually a container, F6).

/**
 * Compute per-text-node rewrites that strip the first complete marker pair
 * (`start` … `end`) from the joined text. Nodes are given in document order
 * (depth-first); each output string keeps everything outside the removed
 * span, so element structure is untouched. Without a COMPLETE pair the inputs
 * are returned unchanged — forged or half markers in command text must not
 * consume anything. Trailing newlines on the element's final text are
 * trimmed, matching the legacy `textContent` rewrite behaviour. Idempotent:
 * applying the result again is a no-op.
 */
export function computeTextNodeRewrites(texts: readonly string[], startMarker: string, endMarker: string): string[] {
  const joined = texts.join('')
  const startIdx = joined.indexOf(startMarker)
  const endIdx = startIdx === -1 ? -1 : joined.indexOf(endMarker, startIdx)
  if (startIdx === -1 || endIdx === -1) return [...texts]
  const removeFrom = startIdx
  const removeTo = endIdx + endMarker.length
  let cursor = 0
  const out: string[] = []
  for (const text of texts) {
    const from = cursor
    const to = cursor + text.length
    cursor = to
    if (to <= removeFrom || from >= removeTo) {
      out.push(text)
      continue
    }
    let rewritten = ''
    if (removeFrom > from) rewritten += text.slice(0, removeFrom - from)
    if (removeTo < to) rewritten += text.slice(removeTo - from)
    out.push(rewritten)
  }
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].length > 0) {
      out[i] = out[i].replace(/\n+$/, '')
      break
    }
  }
  return out
}