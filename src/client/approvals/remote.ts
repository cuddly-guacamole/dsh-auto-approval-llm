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
  setLinkDown,
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

// `uiSession` is a declared dependency of this client (see the entry's
// `inject`), so cordis holds the plugin pending until the service exists and
// the watcher can subscribe at its first apply. The former bounded probe
// window is retired; only the "service absent at all" protocol mismatch still
// warns, because silence there would turn every official panel into an
// unclosable ghost.
export function watchRemoteApprovals(ctx: any, options: WatcherOptions = {}): void {
  const active = new Map<string, { dispose: () => void; pollNow: () => void }>()
  // Tombstones: approvals the watcher already detached from (host resolved,
  // follow answered). Prevents check() from re-arming a stale approval;
  // cleared when the item leaves the snapshot.
  const resolvedKeys = new Set<string>()
  // Session ids that ever showed an approval, bounded FIFO: dispose
  // clears their answered-key tombstones. Without the cap a long-lived
  // browser tab grows this set with every historical session.
  const seenSessions = createSeenSessionTracker()
  let unsub: (() => void) | undefined
  let pendingInteractions: any
  let disposed = false

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

  // Declarative arm: bind the watcher to uiSession.pendingInteractions. The
  // service is a declared inject dependency, so this normally succeeds on the
  // first apply; `false` means the served client protocol has no such service.
  const arm = (): boolean => {
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
  // is down, review-status polls keep failing benignly, the countdown render
  // freezes on its last-known value (断线暂停倒计时 — local display only,
  // the host timer never pauses), and the snapshot may churn unseen. Observed
  // behavior at this stage: disconnect unmounts the official panel outright
  // and resume does not bring it back (one-shot remote frames), so the freeze
  // only shows on panels that outlive the outage. On a
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
    // Publish the wire state for render paths (countdown freeze while down).
    // Per-tab local only — never sent to the host.
    setLinkDown(lastConnectionState === 'disconnected' || lastConnectionState === 'connecting')
    unsubConnection = state.subscribe((next: unknown) => {
      const prev = lastConnectionState
      lastConnectionState = next
      setLinkDown(next === 'disconnected' || next === 'connecting')
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
    // missing (unusual), the resume resync silently stays a no-op — the
    // uiSession warning below already breaks the silence for a real protocol
    // mismatch, and a second warn would only double-count it in tests.
  }

  if (!arm()) {
    // A protocol mismatch (host serves no uiSession) is the only remaining
    // cause: warn once so the failure is visible instead of every official
    // panel silently becoming an unclosable ghost.
    console.warn('[dsh-auto-approval-llm] approval watcher (remote): uiSession.pendingInteractions unavailable; approval auto-close disabled (offline panel)')
  }

  ctx.effect(() => () => {
    disposed = true
    unsub?.()
    unsubConnection?.()
    for (const [, poller] of active) poller.dispose()
    active.clear()
    resolvedKeys.clear()
    for (const sessionId of seenSessions.seen) forgetAnsweredKeys(sessionId)
  }, 'dsh-auto-approval-llm: approval watcher (remote)')
}