/**
 * dsh-auto-approval-llm · permission-plane change observation.
 *
 * The host appends `permission/preset`, `sandbox/mode` and `approval/policy`
 * whenever a session's permission plane moves. A switch to a `never` approval
 * policy takes this plugin out of the loop entirely — the official pipeline
 * settles before the approval waterfall — and a person who reaches for that
 * switch is often reacting to something the pipeline just blocked. So each
 * real move leaves one durable, decision-free audit line together with
 * pointers to the most recent rejections, and the two can be read side by side.
 *
 * Two shapes must NOT be reported as user switches:
 *  - the creation pin. `pinInitialPermission` appends all three planes back to
 *    back on a fresh session; with a full-access default one of them is
 *    `approval/policy: never`, i.e. exactly the signal this module exists to
 *    catch, fabricated on every new session.
 *  - this plugin's own counter-move, which appends `approval/policy: ask` from
 *    inside `ensureAsk`.
 * Both are handled by keeping a per-plane baseline: the host only appends a
 * plane event when that plane actually changes (`apply` compares first), and
 * the creation pin is the first value a session ever shows, so the first value
 * seen per plane is a baseline rather than a switch. The baseline comes from
 * the host's own `permissionPresets.permissionState(session)` when available,
 * which also covers a session restored from disk.
 *
 * Observation only: nothing here reads approval state, changes a verdict, or
 * reaches the review prompts. The rejections themselves stay owned by the audit
 * trail; this module records ids, never copies.
 */

export type PermissionScope = 'preset' | 'sandbox' | 'policy'

export interface PermissionChange {
  scope: PermissionScope
  to: string
}

/** The last value seen per permission plane for one session. */
export interface PermissionState {
  preset?: string
  sandbox?: string
  policy?: string
}

/** Pointers kept per change; the audit owns the records they name. */
export const RECENT_REJECTION_CAP = 5

/** The session-event families that carry a permission-plane change. */
const CHANGE_EVENTS: readonly { type: string; scope: PermissionScope; field: string }[] = [
  { type: 'permission/preset', scope: 'preset', field: 'preset' },
  { type: 'sandbox/mode', scope: 'sandbox', field: 'mode' },
  { type: 'approval/policy', scope: 'policy', field: 'policy' },
]

const STATE_FIELD: Record<PermissionScope, keyof PermissionState> = {
  preset: 'preset',
  sandbox: 'sandbox',
  policy: 'policy',
}

/** Read one permission-plane change out of a session event, or undefined. */
export function permissionChangeFromEvent(event: unknown): PermissionChange | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const candidate = event as { type?: unknown; data?: unknown }
  if (typeof candidate.type !== 'string') return undefined
  const spec = CHANGE_EVENTS.find((entry) => entry.type === candidate.type)
  if (spec === undefined) return undefined
  if (candidate.data === null || typeof candidate.data !== 'object') return undefined
  const value = (candidate.data as Record<string, unknown>)[spec.field]
  if (typeof value !== 'string' || value === '') return undefined
  return { scope: spec.scope, to: value }
}

/**
 * Baseline from the host's own view of a session:
 * `permissionPresets.permissionState(session)` reports
 * `{ preset, sandbox, approval, seeded }`. Folding it before the events arrive
 * is what turns a creation seed — or a restored session's history — into the
 * baseline instead of into a user switch.
 */
export function baselineFromPermissionState(state: unknown): PermissionState {
  if (state === null || typeof state !== 'object') return {}
  const source = state as Record<string, unknown>
  const baseline: PermissionState = {}
  if (typeof source.preset === 'string') baseline.preset = source.preset
  if (typeof source.sandbox === 'string') baseline.sandbox = source.sandbox
  if (typeof source.approval === 'string') baseline.policy = source.approval
  return baseline
}

/**
 * Fold one observed change into a session's baseline and decide whether it is
 * worth a record. The first value seen for a plane is never a record (it is
 * the seed or the restored state), a value equal to the baseline is not a
 * record either, and the plugin's own counter-move updates the baseline
 * silently because it writes its own line.
 */
export function observePermissionChange(
  baseline: PermissionState | undefined,
  change: PermissionChange,
  options: { pluginInitiated?: boolean } = {},
): { baseline: PermissionState; record: boolean } {
  const next: PermissionState = { ...baseline }
  const field = STATE_FIELD[change.scope]
  const previous = next[field]
  next[field] = change.to
  const record = options.pluginInitiated !== true && previous !== undefined && previous !== change.to
  return { baseline: next, record }
}

/**
 * Pointers to the most recent rejected decisions, newest first. The window is
 * the in-memory approval history, which spans sessions on purpose: a person who
 * flips a permission plane at the start of the next session is usually still
 * reacting to what the previous one blocked.
 */
export function recentRejectionPointers(
  records: readonly { id?: unknown; outcome?: unknown }[],
  cap: number = RECENT_REJECTION_CAP,
): string[] {
  const ids: string[] = []
  for (let index = records.length - 1; index >= 0 && ids.length < cap; index -= 1) {
    const record = records[index]
    if (record === null || typeof record !== 'object') continue
    if (record.outcome !== 'rejected') continue
    if (typeof record.id !== 'string' || record.id === '') continue
    ids.push(record.id)
  }
  return ids
}
