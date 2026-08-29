// Legacy (rc.2) protocol adapter: observes the current session snapshot's
// `pending` entries and adapts each PendingWait approval into an
// ApprovalHandle. On alpha.1 this source is always empty (no `pending` on the
// session snapshot), so the watcher idles naturally. Removal target of 0.0.15.
import {
  canonicalPendingKey,
  forgetAnsweredKeys,
  startReviewPolling,
} from './shared.js'
import type { ApprovalHandle, WatcherOptions } from './shared.js'

export function watchLegacyApprovals(ctx: any, options: WatcherOptions = {}): void {
  const sessions = ctx.get('sessions')
  if (!sessions) return

  const now = options.now ?? (() => Date.now())
  // One active poller per canonical approval key; also serves as the re-arm
  // guard while a detached approval is still visible.
  const active = new Map<string, { dispose: () => void; pollNow: () => void }>()
  // Tombstones: approvals the watcher already detached from (host resolved,
  // follow answered, or host stopped tracking). Prevents check() from
  // re-arming a poller for a stale approval and drops late in-flight poll
  // responses (R004).
  const resolvedKeys = new Set<string>()
  // C2: timestamp of the last event-driven extra poll. Bursty events (fast
  // alt-tab flapping, rapid snapshot pushes) cost at most one extra poll every
  // 500ms, so they can never turn into a poll storm.
  let lastExtraPollAt = 0
  let currentId: string | undefined
  let unsubSession: (() => void) | undefined

  const clearSessionState = (sessionId: string | undefined) => {
    if (!sessionId) return
    const prefix = `${sessionId}:`
    for (const [key, poller] of active) {
      if (key.startsWith(prefix)) {
        poller.dispose()
        active.delete(key)
      }
    }
    for (const key of [...resolvedKeys]) {
      if (key.startsWith(prefix)) resolvedKeys.delete(key)
    }
    forgetAnsweredKeys(sessionId)
  }

  /** Whether an approval with this key is still visible in the session snapshot. */
  const approvalStillPending = (sessionId: string, approval: any): boolean => {
    const binding = sessions.binding?.(sessionId)
    const snapshot = binding?.session?.getSnapshot?.() ?? {}
    return (snapshot.pending ?? []).some((i: any) => i.kind === 'approval' && i.key === approval.key)
  }

  const armApproval = (sessionId: string, approval: any) => {
    const callId = approval.payload?.callId
    const key = canonicalPendingKey(sessionId, callId)
    if (!key) return
    if (active.has(key)) {
      active.get(key)?.dispose()
      active.delete(key)
    }
    const wait: any = approval
    const handle: ApprovalHandle = {
      sessionId,
      key,
      callId,
      respond: async (outcome) => {
        // Preserve the rc.2 PendingWait response shape exactly.
        await wait.respond({
          ok: true,
          value: {
            sessionId,
            approvalId: wait.payload?.approvalId,
            outcome,
          },
        })
      },
    }
    active.set(key, startReviewPolling(handle, () => approvalStillPending(sessionId, approval), {
      pollMs: options.pollMs,
      graceMs: options.graceMs,
      onDetach: (k) => {
        active.delete(k)
        resolvedKeys.add(k)
      },
    }))
  }

  const check = (sessionId: string | undefined) => {
    if (!sessionId) return
    const binding = sessions.binding?.(sessionId)
    const session = binding?.session
    if (!session) return
    const snapshot = session.getSnapshot?.() ?? {}
    const pending = snapshot.pending ?? []
    const approval = pending.find((i: any) => i.kind === 'approval')
    if (!approval) {
      clearSessionState(sessionId)
      return
    }
    const key = canonicalPendingKey(sessionId, approval.payload?.callId)
    if (!key) return
    // Never re-arm an approval we already detached from (tombstone); waiting
    // for it to leave pending is the only path to clear the tombstone.
    if (!active.has(key) && !resolvedKeys.has(key)) armApproval(sessionId, approval)
  }

  // C2: event-driven immediate poll. Non-timer events (visibilitychange /
  // pageshow / resume) are delivered even right after a thaw from Chrome's
  // intensive throttling, so returning to the page closes an already-decided
  // approval panel at once instead of waiting for the next interval tick.
  // Only polls the current session's armed approvals while the tab is
  // visible; debounced so bursty events cost at most one extra poll / 500ms.
  const fireImmediatePoll = () => {
    const g = globalThis as any
    const t = now()
    if (t - lastExtraPollAt < 500) return
    lastExtraPollAt = t
    if (g.document?.visibilityState === 'hidden') return
    if (currentId === undefined) return
    const prefix = `${currentId}:`
    for (const [key, poller] of active) {
      if (key.startsWith(prefix)) void poller.pollNow()
    }
  }

  const onListChange = () => {
    const next = sessions.list?.getSnapshot?.()?.current
    if (next === currentId) {
      check(currentId)
      return
    }
    if (unsubSession) {
      unsubSession()
      unsubSession = undefined
    }
    clearSessionState(currentId)
    currentId = next
    if (currentId) {
      const binding = sessions.binding?.(currentId)
      const session = binding?.session
      if (session) unsubSession = session.subscribe?.(() => {
        check(currentId)
        // A snapshot push right after the tab became visible doubles as a thaw
        // signal (same debounce/visibility guards as fireImmediatePoll).
        fireImmediatePoll()
      })
      check(currentId)
    }
  }

  const unsubList = sessions.list?.subscribe?.(onListChange)
  onListChange()

  // C2: thaw/resume listeners — non-timer events are unaffected by Chrome's
  // intensive throttling, so they fire the moment the user returns to the tab.
  // visibilitychange lives on the document; pageshow/resume on the window.
  const g = globalThis as any
  const doc = g.document
  const win = g.window
  if (doc?.addEventListener) doc.addEventListener('visibilitychange', fireImmediatePoll)
  if (win?.addEventListener) {
    win.addEventListener('pageshow', fireImmediatePoll)
    win.addEventListener('resume', fireImmediatePoll)
  }

  ctx.effect(() => () => {
    unsubList?.()
    unsubSession?.()
    if (doc?.removeEventListener) doc.removeEventListener('visibilitychange', fireImmediatePoll)
    if (win?.removeEventListener) {
      win.removeEventListener('pageshow', fireImmediatePoll)
      win.removeEventListener('resume', fireImmediatePoll)
    }
    for (const [, poller] of active) poller.dispose()
    active.clear()
    resolvedKeys.clear()
    forgetAnsweredKeys(currentId ?? '')
  }, 'dsh-auto-approval-llm: approval watcher (legacy)')
}