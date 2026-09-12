// Session-scoped approval discovery.
//
// The official panel is held back for `panelDelayMs`, and the client's
// per-approval watcher only arms once the panel (and its pending interaction)
// exists. This watcher covers that gap: it follows the session the reader is
// looking at and mirrors every ask the host currently holds for it into the
// display store, so the countdown is visible before any panel appears.
//
// Display only: the per-approval poller still owns the auto-answer decision.
import { SESSION_REVIEW_STATUS_ROUTE, REVIEW_WAIT_MS } from './shared.js'
import { approvalStatusStore } from './status-store.js'

/** Fallback cadence between discovery requests (long poll handles the rest). */
export const SESSION_WATCH_POLL_MS = 1_000

export interface SessionWatchOptions {
  /** Hold budget for one discovery request (default REVIEW_WAIT_MS). */
  waitMs?: number
  /** Cadence between discovery requests (default SESSION_WATCH_POLL_MS). */
  pollMs?: number
}

export function watchSessionApprovals(ctx: any, options: SessionWatchOptions = {}): void {
  const g = globalThis as any
  const sessions = ctx.get('sessions')
  const waitMs = options.waitMs ?? REVIEW_WAIT_MS
  const pollMs = options.pollMs ?? SESSION_WATCH_POLL_MS
  let current: string | undefined
  let timer: any
  let inFlight = false
  let disposed = false
  let unsubList: (() => void) | undefined
  // Asks this watcher has already mirrored for the current session, so a
  // resolve that drops out of the host's list leaves the chip at the same time.
  let live = new Set<string>()

  const poll = async () => {
    if (disposed || inFlight || current === undefined) return
    const sessionId = current
    inFlight = true
    let reviews: any[] | undefined
    try {
      const res = await g.fetch(SESSION_REVIEW_STATUS_ROUTE, {
        headers: {
          'x-auto-approval-session-id': sessionId,
          'x-auto-approval-wait-ms': String(waitMs),
        },
        credentials: 'same-origin',
      })
      if (!res.ok) return
      const data = await res.json()
      reviews = data?.ok ? data.value?.reviews : undefined
    } catch {
      // Transient: keep the last known records and retry on the next tick.
      return
    } finally {
      inFlight = false
    }
    if (disposed || sessionId !== current || !Array.isArray(reviews)) return
    const seen = new Set<string>()
    for (const review of reviews) {
      const callId = typeof review?.callId === 'string' ? review.callId : undefined
      if (!callId) continue
      seen.add(callId)
      live.add(callId)
      if (review.phase === 'follow') {
        approvalStatusStore.resolve(sessionId, callId, review.source, review.action ?? 'reject')
      } else {
        approvalStatusStore.publishStatus(sessionId, callId, review)
      }
    }
    for (const callId of [...live]) {
      if (seen.has(callId)) continue
      live.delete(callId)
      approvalStatusStore.dropPending(sessionId, callId)
    }
  }

  const setSession = (next: string | undefined) => {
    if (next === current) return
    if (current !== undefined) approvalStatusStore.clearSession(current)
    current = next
    live = new Set()
    void poll()
  }

  const onListChange = () => setSession(sessions?.list?.getSnapshot?.()?.current)
  unsubList = sessions?.list?.subscribe?.(onListChange)
  onListChange()
  timer = setInterval(() => { void poll() }, pollMs)

  ctx.effect(() => () => {
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    unsubList?.()
  }, 'dsh-auto-approval-llm: session approval watcher')
}
