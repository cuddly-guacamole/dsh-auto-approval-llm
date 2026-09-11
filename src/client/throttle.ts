/**
 * Trailing throttle for the client's document-level scan loops.
 *
 * The permission-icon observer watches `characterData` + `subtree` on the whole
 * document, so a streaming assistant reply wakes it on every token batch; the
 * decoration pass it runs queries the document several times and cannot be
 * allowed to run at token rate. A microtask merge only collapses a single task's
 * burst — the floor has to hold across tasks, which is what this adds.
 *
 * Contract: the first trigger runs immediately (leading), a burst inside the
 * window runs once, and the LAST trigger inside the window is never dropped
 * (trailing) — decoration must not be missed because the final DOM change landed
 * one frame too early. The clock and the scheduler are injectable so the tests
 * are deterministic.
 */
export interface TrailingThrottleOptions {
  minIntervalMs: number
  now?: () => number
  schedule?: (fn: () => void, ms: number) => any
  cancel?: (handle: any) => void
}

export interface TrailingThrottle {
  trigger(): void
  dispose(): void
}

/**
 * Window for the permission-icon decoration pass. Well below anything a person
 * can perceive on an icon that decorates a permission menu, and far above the
 * token cadence that used to drive it.
 */
export const MIN_DECORATE_INTERVAL_MS = 50

export function createTrailingThrottle(
  run: () => void,
  options: TrailingThrottleOptions,
): TrailingThrottle {
  const minIntervalMs = options.minIntervalMs
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle: any) => clearTimeout(handle))

  let active = true
  let lastRunAt = Number.NEGATIVE_INFINITY
  let pending: any
  let hasPending = false

  const invoke = () => {
    pending = undefined
    hasPending = false
    if (!active) return
    lastRunAt = now()
    run()
  }

  const trigger = () => {
    if (!active) return
    const elapsed = now() - lastRunAt
    if (elapsed >= minIntervalMs) {
      // The window already elapsed: run now and let any scheduled trailing run
      // go (it is superseded by this one).
      if (hasPending) {
        cancel(pending)
        pending = undefined
        hasPending = false
      }
      invoke()
      return
    }
    if (hasPending) return
    hasPending = true
    pending = schedule(invoke, minIntervalMs - elapsed)
  }

  const dispose = () => {
    if (!active) return
    active = false
    if (hasPending) {
      cancel(pending)
      pending = undefined
      hasPending = false
    }
  }

  return { trigger, dispose }
}
