/**
 * Loop guard · the repeat-detection core behind `loopDetectionThreshold`.
 *
 * The loop key is the EXACT call identity (tool name + sanitized-arguments
 * hash) — deliberately wider than the learning signature's bounded skeleton,
 * which returns undefined for exactly the quoted/dynamic/glob forms a stuck
 * loop tends to produce. Two key namespaces, two purposes: the learning
 * signature answers "has a human confirmed this shape before"; the loop key
 * answers "is this the same call again". The streak advances only across
 * gated-site calls and resets on any different key (strict consecutiveness);
 * firing deletes the entry (fire-and-reset: a human allow never buys a
 * permanent exemption).
 *
 * Hashing note: the sanitized arguments carry a per-text 1000-character cap,
 * so two different oversized argument payloads can fold to one key. Folding
 * errs toward asking (fail-safe); it never merges two ordinary calls.
 */
import { sanitizeClassifierArguments } from './classifier.js'

export const LOOP_GUARD_MAX_KEYS = 64

/** FNV-1a 32-bit, hex-encoded — deterministic, cheap, never stores raw arguments. */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** Key-order-independent stringify: one call must always yield one key. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')
  return `{${body}}`
}

export function loopKeyFor(toolName: string, args: unknown): string {
  const body = args === undefined ? '' : stableStringify(sanitizeClassifierArguments(args))
  return fnv1a32(`${toolName}\u0000${body}`)
}

export interface LoopGuardEntry {
  lastSeq: number
  count: number
}

export interface LoopGuardState {
  seq: number
  inner: Map<string, LoopGuardEntry>
}

export function createLoopState(): LoopGuardState {
  return { seq: 0, inner: new Map() }
}

/**
 * One gated-site call. Extends the key's streak only when the previous gated
 * call in this session was the same key; at the threshold the entry is
 * deleted and the caller owns the escalation. The table stays bounded by a
 * FIFO over least-recently-updated keys.
 */
export function recordLoopCall(state: LoopGuardState, key: string, threshold: number): { consecutive: number; fired: boolean } {
  state.seq += 1
  const previous = state.inner.get(key)
  const consecutive = previous !== undefined && previous.lastSeq === state.seq - 1 ? previous.count + 1 : 1
  if (previous !== undefined) state.inner.delete(key)
  if (consecutive >= threshold) return { consecutive, fired: true }
  state.inner.set(key, { lastSeq: state.seq, count: consecutive })
  if (state.inner.size > LOOP_GUARD_MAX_KEYS) {
    const oldest = state.inner.keys().next().value
    if (oldest !== undefined) state.inner.delete(oldest)
  }
  return { consecutive, fired: false }
}

export interface LoopThresholdNormalization {
  value: number
  warned: boolean
}

/**
 * 0 (or anything non-positive/non-numeric) = off. 1 would turn EVERY
 * auto-allowed call into an ask — the whole preset stops being automatic —
 * so it clamps to 2 with a warning instead of being trusted.
 */
export function normalizeLoopThreshold(raw: unknown): LoopThresholdNormalization {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0
  if (value <= 0) return { value: 0, warned: false }
  if (value === 1) return { value: 2, warned: true }
  return { value, warned: false }
}
