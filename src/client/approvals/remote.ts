// Remote protocol adapter: subscribes to the optional `uiSession`
// service's `pendingInteractions` HostObservable (getSnapshot() =>
// Map<sessionId, PendingApproval>) and answers `kind === 'approval'` entries
// on countdown expiry via `pending.answer(outcome)`. Pure observation — never
// registers for `remote.$on('approval/request')` and never imports an
// @deepseek-ai package; the PendingApproval shape is duck-typed so installs
// without the ui-session service keep working with an idle watcher.
import {
  canonicalPendingKey,
  createSeenSessionTracker,
  forgetAnsweredKeys,
  startReviewPolling,
} from './shared.js'
import type { ApprovalHandle, ApprovalOutcome, WatcherOptions } from './shared.js'

// Structural shape of a PendingApproval as surfaced by
// ui-session.pendingInteractions. Deliberately not an import from any
// @deepseek-ai package: duck-typing keeps the client bundle free of
// unavailable dependencies.
export interface PendingApprovalLike {
  kind: 'approval'
  key: string
  sessionId: string
  callId?: string
  reason?: string
  result?: unknown
  answer(outcome: ApprovalOutcome): Promise<void>
}

// The ui-session service is a browser-side dynamic package that registers
// during the same application batch as this plugin; it may not be
// queryable at plugin-mount time yet. Instead of silently idling forever
// (which turns every official panel into an unclosable ghost), keep probing
// for a bounded window and log when the watcher actually arms or gives up.
const UI_SESSION_RETRY_MS = 500
const UI_SESSION_MAX_RETRIES = 30 // 15s covers the client application batch

export function watchRemoteApprovals(ctx: any, options: WatcherOptions = {}): void {
  // Injectable for node contract tests (M1, 2026-09-03); defaults keep the
  // 15s probe window of the original alpha.4 wiring.
  const retryMs = options.retryMs ?? UI_SESSION_RETRY_MS
  const maxRetries = options.maxRetries ?? UI_SESSION_MAX_RETRIES
  const g = globalThis as any
  const active = new Map<string, { dispose: () => void; pollNow: () => void }>()
  // Tombstones: approvals the watcher already detached from (host resolved,
  // follow answered). Prevents check() from re-arming a stale approval
  // (R004); cleared when the item leaves the snapshot.
  const resolvedKeys = new Set<string>()
  // Session ids that ever showed an approval, bounded FIFO (R007): dispose
  // clears their answered-key tombstones. Without the cap a long-lived
  // browser tab grows this set with every historical session.
  const seenSessions = createSeenSessionTracker()
  let unsub: (() => void) | undefined
  let pendingInteractions: any
  let disposed = false
  let retryTimer: any
  // Whether the bounded probe window elapsed without uiSession. Guards the
  // visibility re-probe: only a watcher that actually gave up may re-arm.
  let gaveUp = false
  let detachVisibilityProbe: (() => void) | undefined

  const stillVisible = (item: PendingApprovalLike): boolean => {
    try {
      const snapshot = pendingInteractions?.getSnapshot()
      const pending = snapshot?.get?.(item.sessionId)
      return !!pending && pending.kind === 'approval' && pending.callId === item.callId
    } catch {
      return false
    }
  }

  const check = () => {
    if (disposed || pendingInteractions === undefined) return
    let snapshot: any
    try {
      snapshot = pendingInteractions.getSnapshot()
    } catch {
      return
    }
    if (!snapshot || typeof snapshot.values !== 'function') return
    const seen = new Set<string>()
    // Per-entry arming: the snapshot holds the latest entry per sessionId
    // (precedence overshadows older pending), so each kind==='approval' item
    // is matched by the callId it carries — never by map.get(sessionId).
    for (const pending of snapshot.values()) {
      if (!pending || pending.kind !== 'approval') continue
      const item: PendingApprovalLike = pending
      const callId = item.callId
      const key = canonicalPendingKey(item.sessionId, callId)
      if (!key) continue
      seen.add(key)
      if (active.has(key) || resolvedKeys.has(key)) continue
      seenSessions.add(item.sessionId)
      const handle: ApprovalHandle = {
        sessionId: item.sessionId,
        key,
        callId,
        respond: async (outcome: ApprovalOutcome) => {
          try {
            // #settled: someone else already answered — silent detach.
            await pending.answer(outcome)
          } catch {
            // benign: the interaction settled before our answer landed
          }
        },
      }
      active.set(key, startReviewPolling(handle, () => stillVisible(item), {
        pollMs: options.pollMs,
        graceMs: options.graceMs,
        onDetach: (k) => {
          active.delete(k)
          resolvedKeys.add(k)
        },
      }))
    }
    // Drop what is no longer in the snapshot (host removed the interaction);
    // clearing its tombstone lets a fresh re-add re-arm.
    for (const [key, poller] of active) {
      if (!seen.has(key)) {
        poller.dispose()
        active.delete(key)
        resolvedKeys.delete(key)
      }
    }
    for (const key of [...resolvedKeys]) {
      if (!seen.has(key)) resolvedKeys.delete(key)
    }
  }

  // Probe-and-arm: link the watcher to ui-session.pendingInteractions once it
  // is observable. Returns true when armed, false when still unavailable.
  const armOnce = (): boolean => {
    const pi = ctx.get('uiSession')?.pendingInteractions
    if (
      disposed ||
      pi === undefined ||
      typeof pi.getSnapshot !== 'function' ||
      typeof pi.subscribe !== 'function'
    ) {
      return false
    }
    pendingInteractions = pi
    unsub = pi.subscribe?.(check)
    check()
    return true
  }

  // ── connection-resume resync ────────────────────────────────────────────
  // The official client exposes ctx.connection.state (connecting /
  // disconnected / connected, with getSnapshot+subscribe). While the stream
  // is down, review-status polls keep failing benignly, countdown UI ticks
  // against a stale local deadline, and the snapshot may churn unseen. On a
  // disconnected→connected transition, resync every armed poller now (fresh
  // review-status → countdown realigned / follow panels closed) and re-run
  // the snapshot reconcile so approvals the host already dropped are closed.
  // Mirrors the official ConnectionIndicator recovery semantics (alpha.4).
  const resyncAll = () => {
    if (disposed) return
    for (const [, poller] of active) poller.pollNow()
    check()
  }

  let lastConnectionState: unknown
  let unsubConnection: (() => void) | undefined

  const armConnectionWatcher = (): boolean => {
    const conn = ctx.get('connection')
    const state = conn?.state
    if (
      disposed ||
      state === undefined ||
      typeof state.getSnapshot !== 'function' ||
      typeof state.subscribe !== 'function'
    ) {
      return false
    }
    lastConnectionState = state.getSnapshot()
    unsubConnection = state.subscribe((next: unknown) => {
      const prev = lastConnectionState
      lastConnectionState = next
      // Only a real recovery from a down/connecting state triggers a resync;
      // steady-state connected or first connect must not. Official recovery
      // confirmation uses the same previous-state rule.
      if ((prev === 'disconnected' || prev === 'connecting') && next === 'connected') {
        console.warn('[dsh-auto-approval-llm] approval watcher (remote): connection resumed; resyncing approvals')
        resyncAll()
      }
    })
    return true
  }

  if (!armConnectionWatcher()) {
    // connection is a wire-root service normally present at mount; if it is
    // missing (unusual), the resume resync silently stays a no-op — warn-级
    // silence is not needed here because uiSession absence already has its
    // own probe/announce chain, and doubling warns would confuse the
    // contract tests that count them.
  }

  if (armOnce()) {
    // armed at mount (pre-alpha.4 ordering)
  } else {
    console.warn('[dsh-auto-approval-llm] approval watcher (remote): uiSession.pendingInteractions unavailable at mount; probing')
    startProbing()
  }

  // Probe loop. Gives up after `maxRetries` attempts so an install without
  // the ui-session service does not probe forever, then hands over to the
  // visibility re-probe below.
  function startProbing(): void {
    // A visibility-triggered restart must never stack a second probe interval
    // over a live one: the two would race their independent retry counters,
    // and the first to give up would clearProbeTimer() the OTHER interval
    // (retryTimer is a shared slot), terminating the probe early (F1,
    // 2026-09-03 audit).
    if (retryTimer !== undefined) return
    let retries = 0
    retryTimer = setInterval(() => {
      if (disposed) {
        clearProbeTimer()
        return
      }
      retries += 1
      if (armOnce()) {
        clearProbeTimer()
        console.warn(`[dsh-auto-approval-llm] approval watcher (remote): armed after ${retries * retryMs}ms`)
        return
      }
      if (retries >= maxRetries) {
        clearProbeTimer()
        gaveUp = true
        console.warn(`[dsh-auto-approval-llm] approval watcher (remote): uiSession.pendingInteractions unavailable after ${retries * retryMs}ms; approval auto-close disabled (offline panel)`)
        armVisibilityProbe()
      }
    }, retryMs)
  }

  const clearProbeTimer = () => {
    if (retryTimer !== undefined) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
  }

  // A slow-starting tab (cold VM, LAN debug, deep backgrounding) may expose
  // uiSession after the probe window, and HMR is not guaranteed to rebuild the
  // bundle. Re-arm on the next visibility restore; if the service is still
  // missing, restart the bounded probe window instead of staying dead until
  // the plugin is reloaded (F1, 2026-09-03 audit).
  function armVisibilityProbe(): void {
    const doc = g.document
    if (!doc || typeof doc.addEventListener !== 'function') return
    detachVisibilityProbe?.()
    let removed = false
    const detach = () => {
      if (removed) return
      removed = true
      doc.removeEventListener?.('visibilitychange', onVisible)
    }
    const onVisible = () => {
      if (disposed || !gaveUp) return
      if (doc.visibilityState !== undefined && doc.visibilityState !== 'visible') return
      if (armOnce()) {
        gaveUp = false
        detach()
        console.warn('[dsh-auto-approval-llm] approval watcher (remote): armed via visibility re-probe')
        return
      }
      startProbing()
    }
    doc.addEventListener('visibilitychange', onVisible)
    detachVisibilityProbe = detach
  }

  ctx.effect(() => () => {
    disposed = true
    clearProbeTimer()
    detachVisibilityProbe?.()
    unsub?.()
    unsubConnection?.()
    for (const [, poller] of active) poller.dispose()
    active.clear()
    resolvedKeys.clear()
    for (const sessionId of seenSessions.seen) forgetAnsweredKeys(sessionId)
  }, 'dsh-auto-approval-llm: approval watcher (remote)')
}