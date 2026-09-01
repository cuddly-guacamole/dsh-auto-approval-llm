// Remote (alpha.1) protocol adapter: subscribes to the optional `uiSession`
// service's `pendingInteractions` HostObservable (getSnapshot() =>
// Map<sessionId, PendingApproval>) and answers `kind === 'approval'` entries
// on countdown expiry via `pending.answer(outcome)`. Pure observation — never
// registers for `remote.$on('approval/request')` and never imports an
// alpha.1 package; the PendingApproval shape is duck-typed so rc.2 installs
// (no ui-session service) keep working with an idle watcher.
import {
  canonicalPendingKey,
  forgetAnsweredKeys,
  startReviewPolling,
} from './shared.js'
import type { ApprovalHandle, ApprovalOutcome, WatcherOptions } from './shared.js'

// Structural shape of an alpha.1 PendingApproval as surfaced by
// ui-session.pendingInteractions. Deliberately not an import from any
// @deepseek-ai package: alpha.1 is not on npm, and duck-typing keeps the
// rc.2 bundle free of unavailable dependencies.
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
// during the same application batch as this plugin; on alpha.4 it may not be
// queryable at plugin-mount time yet. Instead of silently idling forever
// (which turns every official panel into an unclosable ghost), keep probing
// for a bounded window and log when the watcher actually arms or gives up.
// rc.2 installs simply keep the watcher idle after the probe window.
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
  const seenSessions = new Set<string>()
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

  if (armOnce()) {
    // armed at mount (pre-alpha.4 ordering)
  } else {
    console.warn('[dsh-auto-approval-llm] approval watcher (remote): uiSession.pendingInteractions unavailable at mount; probing')
    startProbing()
  }

  // Probe loop. Gives up after `maxRetries` attempts so a rc.2 install (no
  // ui-session service) does not probe forever, then hands over to the
  // visibility re-probe below.
  function startProbing(): void {
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
        console.warn(`[dsh-auto-approval-llm] approval watcher (remote): uiSession.pendingInteractions unavailable after ${retries * retryMs}ms; approval auto-close disabled (rc.2 install? offline panel)`)
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
    for (const [, poller] of active) poller.dispose()
    active.clear()
    resolvedKeys.clear()
    for (const sessionId of seenSessions) forgetAnsweredKeys(sessionId)
  }, 'dsh-auto-approval-llm: approval watcher (remote)')
}