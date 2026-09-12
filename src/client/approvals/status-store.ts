// Client-side approval status store.
//
// One record per ask, published from two sources that both observe the same
// host contract: the approval watcher (a pending exists, with its reason text)
// and the review-status poller (the host's structured phase/revision). The
// header chip and the composer capsule render from this store, so both
// surfaces always agree on what the user is looking at.
//
// Display state only: nothing here answers an approval. The poller keeps the
// answer authority, and the host timer stays authoritative throughout.
//
// The countdown is anchored once when the host publishes it and then walked
// locally; a later publish re-anchors. Above COARSE_COUNTDOWN_SECONDS the chip
// only shows a coarse "about N minutes" value, which is what makes a slow
// update cadence acceptable. Terminal records stay visible for a bounded
// window so the user can read the outcome after the panel closes.

export type ApprovalSource = 'human' | 'llm' | 'timeout' | 'abort'

/** The subset of the host's review-status payload the client renders from. */
export interface HostStatus {
  phase?: 'countdown' | 'follow'
  action?: 'allow' | 'reject'
  seconds?: number
  /** Host-published remaining time, authoritative over `seconds` when present. */
  remainingMs?: number
  /** Monotonic per-ask revision; an older revision never overwrites a newer one. */
  revision?: number
  source?: ApprovalSource
}

export interface ApprovalRecord {
  sessionId: string
  callId: string
  /** The pending exists but the host has published no countdown for it. */
  awaiting: boolean
  /** The ask carries the breaker marker: no countdown will ever settle it. */
  breaker: boolean
  phase: 'countdown' | 'follow'
  action: 'allow' | 'reject'
  seconds: number
  /** Local ms timestamp the countdown was anchored at. */
  anchoredAt: number
  /** Local ms timestamp the countdown expires. */
  deadline: number
  revision: number
  source?: ApprovalSource
  /** Local ms timestamp of the last change; terminal records expire from it. */
  observedAt: number
}

/**
 * How long a settled ask stays visible after the panel is gone. Short by
 * design: the outcome is a glance, then the control returns to its idle label.
 */
export const TERMINAL_TTL_MS = 1_500

/**
 * Ceiling for remembered finished asks. A browser tab outlives many sessions,
 * so the set is FIFO-bounded like the answer tombstones.
 */
export const MAX_TOMBSTONES = 500

/** Above this many seconds the chip shows a coarse value instead of digits. */
export const COARSE_COUNTDOWN_SECONDS = 30

export type ChipState =
  | { kind: 'empty' }
  | { kind: 'countdown'; seconds: number; coarse: boolean; action: 'allow' | 'reject' }
  | { kind: 'imminent'; action: 'allow' | 'reject' }
  | { kind: 'offline'; seconds: number; action: 'allow' | 'reject' }
  | { kind: 'awaiting' }
  | { kind: 'breaker' }
  | { kind: 'allowed'; by: 'llm' | 'host' }
  | { kind: 'rejected'; by: 'llm' | 'host' }
  | { kind: 'timeout'; action: 'allow' | 'reject' }
  | { kind: 'human' }
  | { kind: 'cancelled' }

/**
 * Pure: the single state the chip renders. Precedence is fixed so a record can
 * carry several facts at once without the caller having to pick:
 * breaker > cancel > auto-settle > human > waiting.
 */
export function chipState(record: ApprovalRecord | undefined, now: number, offline: boolean): ChipState {
  if (!record) return { kind: 'empty' }
  if (record.phase === 'follow') {
    if (record.source === 'abort') return { kind: 'cancelled' }
    if (record.source === 'human') return { kind: 'human' }
    if (record.source === 'timeout') return { kind: 'timeout', action: record.action }
    if (record.source === 'llm') {
      return record.action === 'allow' ? { kind: 'allowed', by: 'llm' } : { kind: 'rejected', by: 'llm' }
    }
    return record.action === 'allow' ? { kind: 'allowed', by: 'host' } : { kind: 'rejected', by: 'host' }
  }
  if (record.breaker) return { kind: 'breaker' }
  if (record.awaiting) return { kind: 'awaiting' }
  // Offline freezes the last confirmed remaining instead of walking a deadline
  // the host can no longer corroborate.
  if (offline) {
    return {
      kind: 'offline',
      seconds: Math.max(0, Math.ceil((record.deadline - record.observedAt) / 1000)),
      action: record.action,
    }
  }
  const remainingMs = record.deadline - now
  if (remainingMs <= 0) return { kind: 'imminent', action: record.action }
  const seconds = Math.ceil(remainingMs / 1000)
  return { kind: 'countdown', seconds, coarse: seconds > COARSE_COUNTDOWN_SECONDS, action: record.action }
}

/** Pure: coarse minutes for a countdown above the fine-grained threshold. */
export function coarseMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60))
}

export interface ApprovalStatusStore {
  /** The watcher armed a pending; the host has published nothing yet. */
  observePending(sessionId: string, callId: string, breaker?: boolean): void
  /** A poll confirmed the host has no countdown for this ask. */
  confirmAwaiting(sessionId: string, callId: string): void
  /** Apply a host review-status payload. */
  publishStatus(sessionId: string, callId: string, status: HostStatus): void
  /** Record a settled ask (the panel is closing or closed). */
  resolve(sessionId: string, callId: string, source: ApprovalSource | undefined, action: 'allow' | 'reject'): void
  /** The pending left the snapshot without a settled record. */
  dropPending(sessionId: string, callId: string): void
  clearSession(sessionId: string): void
  /** The record to display for one session, after pruning expired entries. */
  activeFor(sessionId: string, now: number): ApprovalRecord | undefined
  recordsFor(sessionId: string, now: number): ApprovalRecord[]
  subscribe(listener: () => void): () => void
}

function recordKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`
}

export function createApprovalStatusStore(now: () => number = Date.now): ApprovalStatusStore {
  const records = new Map<string, ApprovalRecord>()
  // Keys whose terminal window has already been shown. The host keeps a
  // settled ask in its session list for its own retention window, so without a
  // tombstone every later discovery poll would revive the finished chip for
  // another window — the same outcome would blink for minutes.
  const tombstones = new Set<string>()
  const tombstoneOrder: string[] = []
  const listeners = new Set<() => void>()

  const rememberTombstone = (key: string) => {
    if (tombstones.has(key)) return
    tombstones.add(key)
    tombstoneOrder.push(key)
    while (tombstoneOrder.length > MAX_TOMBSTONES) {
      const oldest = tombstoneOrder.shift()
      if (oldest !== undefined) tombstones.delete(oldest)
    }
  }

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A render listener must never break the publish path.
      }
    }
  }

  const prune = (at: number) => {
    for (const [key, record] of records) {
      if (record.phase !== 'follow') continue
      if (at - record.observedAt <= TERMINAL_TTL_MS) continue
      records.delete(key)
      rememberTombstone(key)
    }
  }

  const resolveRecord = (
    sessionId: string,
    callId: string,
    source: ApprovalSource | undefined,
    action: 'allow' | 'reject',
  ) => {
    const key = recordKey(sessionId, callId)
    if (tombstones.has(key)) return
    const existing = records.get(key)
    if (existing && existing.phase === 'follow') return
    const at = now()
    records.set(key, {
      sessionId,
      callId,
      awaiting: false,
      breaker: false,
      phase: 'follow',
      action,
      seconds: existing?.seconds ?? 0,
      anchoredAt: existing?.anchoredAt ?? at,
      deadline: existing?.deadline ?? at,
      revision: (existing?.revision ?? -1) + 1,
      source,
      observedAt: at,
    })
    notify()
  }

  return {
    observePending(sessionId, callId, breaker = false) {
      const key = recordKey(sessionId, callId)
      if (tombstones.has(key)) return
      const existing = records.get(key)
      if (existing && existing.phase === 'follow') return
      // A published countdown is stronger evidence than "a pending exists": the
      // per-approval watcher re-observes the same ask when its panel finally
      // appears, and that must not downgrade a running countdown to "waiting for
      // a human" (observed live as a one-poll flicker).
      if (existing && existing.seconds > 0) {
        if (breaker && !existing.breaker) {
          existing.breaker = breaker
          notify()
        }
        return
      }
      const at = now()
      records.set(key, {
        sessionId,
        callId,
        awaiting: true,
        breaker,
        phase: 'countdown',
        action: 'allow',
        seconds: 0,
        anchoredAt: at,
        deadline: at,
        revision: existing?.revision ?? -1,
        observedAt: at,
      })
      notify()
    },

    confirmAwaiting(sessionId, callId) {
      const record = records.get(recordKey(sessionId, callId))
      if (!record || record.phase === 'follow' || record.awaiting) return
      // A countdown was already published for this ask: one poll that briefly
      // misses the status (the host window between publishes) must not repaint
      // a running countdown as "waiting for a human" and back again.
      if (record.seconds > 0) return
      record.awaiting = true
      record.observedAt = now()
      notify()
    },

    publishStatus(sessionId, callId, status) {
      const key = recordKey(sessionId, callId)
      if (tombstones.has(key)) return
      const existing = records.get(key)
      const at = now()
      if (status.phase === 'follow') {
        resolveRecord(sessionId, callId, status.source, status.action ?? 'reject')
        return
      }
      if (status.phase !== 'countdown') return
      const revision = status.revision ?? 0
      // A replayed or out-of-order payload must not rewind a newer countdown.
      if (existing && existing.phase === 'countdown' && revision < existing.revision) return
      const seconds = Math.max(1, Math.round(status.seconds ?? 1))
      const remainingMs = status.remainingMs !== undefined ? Math.max(0, status.remainingMs) : seconds * 1000
      records.set(key, {
        sessionId,
        callId,
        awaiting: false,
        breaker: existing?.breaker ?? false,
        phase: 'countdown',
        action: status.action ?? 'allow',
        seconds,
        anchoredAt: at,
        deadline: at + remainingMs,
        revision,
        observedAt: at,
      })
      notify()
    },

    resolve(sessionId, callId, source, action) {
      resolveRecord(sessionId, callId, source, action)
    },

    dropPending(sessionId, callId) {
      const key = recordKey(sessionId, callId)
      const record = records.get(key)
      if (!record) return
      if (record.phase === 'follow') return
      records.delete(key)
      notify()
    },

    clearSession(sessionId) {
      let changed = false
      for (const [key, record] of records) {
        if (record.sessionId !== sessionId) continue
        records.delete(key)
        changed = true
      }
      // Finished-ask memory deliberately survives leaving the session: the host
      // keeps listing a settled ask for its own window, so clearing it here let
      // the same outcome light up again when the reader came back within that
      // window. The set stays FIFO-bounded, and ask ids are unique.
      if (changed) notify()
    },

    activeFor(sessionId, at) {
      prune(at)
      let best: ApprovalRecord | undefined
      for (const record of records.values()) {
        if (record.sessionId !== sessionId) continue
        if (!best) {
          best = record
          continue
        }
        const bestLive = best.phase === 'countdown'
        const nextLive = record.phase === 'countdown'
        if (nextLive !== bestLive) {
          if (nextLive) best = record
          continue
        }
        if (record.observedAt > best.observedAt) best = record
      }
      return best
    },

    recordsFor(sessionId, at) {
      prune(at)
      return [...records.values()].filter((record) => record.sessionId === sessionId)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Store shared by the chip and the capsule inside the client bundle. */
export const approvalStatusStore = createApprovalStatusStore()
