/**
 * Pure decision layer for the auto-approval rename and session migration.
 *
 * The host owns the permission-preset service; this module never imports it.
 * Every host touchpoint is injected (`permissionPresets`, `approval`, `append`,
 * `audit`, `warn`, `markPluginInitiated`), so migration and enforcement can be
 * exercised without a live harness and no private host module becomes a
 * dependency.
 *
 * Two rules drive the design:
 * - identity is the durable raw `permissionState().preset`; the derived
 *   `current()` folds an approval override away, so it must never be a gate or
 *   idempotency input;
 * - migration writes identity only (`session.append('permission/preset')`).
 *   `permissionPresets.set()` is banned: it short-circuits on `current()` and
 *   silently rewrites knobs, which would silently widen a sandbox.
 */
import { GATED_PRESET, LEGACY_AUTO_PRESET } from './constants.js'

export type HostCapability = 'modern' | 'legacy' | 'unknown'

export interface CapabilityResult {
  capability: HostCapability
  reason: string
}

export interface PermissionStateLike {
  preset?: string | null
  sandbox?: string | null
  approval?: string | null
}

export interface MigrationDecision {
  eligible: boolean
  branch?: 'rescue-dfa-ask'
  reason: string
}

export type MigrationClass = 'candidate' | 'foreign' | 'never' | 'unknown'

export interface MigrationScanCounts {
  candidates: number
  foreign: number
  never: number
  unknown: number
}

export interface MigrationDeps {
  permissionPresets: any
  capability: HostCapability
  approval?: any
  /** Narrows the mutation seam: identity is rewritten through this callback only. */
  append: (session: any, type: string, data: unknown) => void
  audit: (line: string) => void
  warn: (message: string) => void
  /** Marks a session while a plugin-initiated append is in flight. */
  markPluginInitiated?: (session: any) => () => void
  /** Derived diagnostic value, read only for the post-append tie check. */
  current?: (session: any) => string | undefined
  now?: () => number
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? Date.now)()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionIdOf(session: any): string | null {
  const id = session?.id
  return typeof id === 'string' ? id : null
}

/** Call an optional host method, turning a missing method or a throw into undefined. */
function safeMethod(target: any, method: string, ...args: any[]): any {
  if (target === undefined || target === null || typeof target[method] !== 'function') return undefined
  try {
    const value = target[method](...args)
    return value === undefined ? undefined : value
  } catch {
    return undefined
  }
}

/** The target preset spec, or undefined when the composed table does not carry it. */
export function safeResolveSpec(permissionPresets: any, name: string): any {
  return safeMethod(permissionPresets, 'resolve', name)
}

/** The host's private spec lookup, used only as a capability signal. */
function safeSpecOf(permissionPresets: any, name: string): any {
  return safeMethod(permissionPresets, 'specOf', name)
}

/**
 * Multi-signal host capability probe, evaluated once at apply time.
 *
 * `registerAuto` and `catalog` are the two surfaces added in the same host
 * release that reserves `auto`; a mismatch (only one present) is treated as
 * unknown so a mid-prerelease host can never be misclassified into migrating a
 * foreign `auto`. `specOf('auto')` returning the reserved dfa+never shape is
 * auxiliary evidence only: without the two surfaces it means we are looking at
 * legacy shape we do not understand, which is also unknown.
 */
export function detectHostCapability(permissionPresets: any): CapabilityResult {
  if (permissionPresets === undefined || permissionPresets === null || typeof permissionPresets.permissionState !== 'function') {
    return { capability: 'unknown', reason: 'no-permission-state' }
  }
  const hasRegisterAuto = typeof permissionPresets.registerAuto === 'function'
  const hasCatalog = typeof permissionPresets.catalog === 'function'
  const autoSpec = safeSpecOf(permissionPresets, LEGACY_AUTO_PRESET)
  const reservedShape = autoSpec?.sandbox === 'danger-full-access' && autoSpec?.approval === 'never'
  if (hasRegisterAuto !== hasCatalog) {
    return { capability: 'unknown', reason: 'registerAuto/catalog mismatch' }
  }
  if (hasRegisterAuto && hasCatalog) {
    return { capability: 'modern', reason: reservedShape ? 'reserved-shape' : 'catalog+registerAuto' }
  }
  if (reservedShape) {
    return { capability: 'unknown', reason: 'legacy-but-reserved-shape' }
  }
  return { capability: 'legacy', reason: 'rc2-shape' }
}

/** Gate name set per capability: `auto` is an alias on legacy hosts only. */
export function gatePresetNames(capability: HostCapability): readonly string[] {
  if (capability === 'legacy') return [GATED_PRESET, LEGACY_AUTO_PRESET]
  return [GATED_PRESET]
}

/** Raw durable permission state; a throw or a missing projection reads as undefined (fail-closed). */
export function rawStateOf(permissionPresets: any, session: any): PermissionStateLike | undefined {
  if (session === undefined || session === null) return undefined
  if (typeof permissionPresets?.permissionState !== 'function') return undefined
  try {
    const state = permissionPresets.permissionState(session)
    if (state === undefined || state === null || typeof state !== 'object') return undefined
    return state as PermissionStateLike
  } catch {
    return undefined
  }
}

/** Raw durable identity, never the derived `current()` value. */
export function rawPresetOf(permissionPresets: any, session: any): string | undefined {
  const preset = rawStateOf(permissionPresets, session)?.preset
  return typeof preset === 'string' ? preset : undefined
}

export function isGatedRawPreset(gateNames: readonly string[], rawPreset: string | undefined): boolean {
  return rawPreset !== undefined && gateNames.includes(rawPreset)
}

/**
 * The raw-identity gate predicate. A throw from permissionState reads as
 * not-gated (fail-closed: the official panel or the never policy decides).
 */
export function isGatedSession(permissionPresets: any, session: any, gateNames: readonly string[] = [GATED_PRESET]): boolean {
  return isGatedRawPreset(gateNames, rawPresetOf(permissionPresets, session))
}

/**
 * Root session id of the parent chain, used to key the breaker, audit and
 * history. Injected parentAgent keeps the walk pure and testable; a broken
 * parent link stops at the last resolvable node and a cycle is cut by the
 * visited set.
 */
export function rootAuthoritySessionId(exec: any, parentAgent: (id: any) => any): string | undefined {
  let session = exec?.agent?.session
  let rootId = session?.id
  const visited = new Set<string>()
  while (session?.header?.origin === 'subagent' && session.header.parentSession != null) {
    const parentSessionId = session.header.parentSession
    const parentKey = String(parentSessionId)
    if (visited.has(parentKey)) break
    visited.add(parentKey)
    const parent = parentAgent(parentSessionId)
    if (parent?.session?.id == null) break
    session = parent.session
    rootId = session.id
  }
  return typeof rootId === 'string' ? rootId : undefined
}

/** Same-signature gate: only raw `auto` + danger-full-access + ask is migrated. */
export function migrationDecision(rawState: PermissionStateLike | undefined): MigrationDecision {
  if (rawState === undefined || rawState.preset !== LEGACY_AUTO_PRESET) {
    return { eligible: false, reason: 'not-auto' }
  }
  if (rawState.sandbox !== 'danger-full-access' || rawState.approval !== 'ask') {
    return { eligible: false, reason: 'non-signature' }
  }
  return { eligible: true, branch: 'rescue-dfa-ask', reason: 'signature' }
}

export function isUsableTargetSpec(spec: any): boolean {
  return spec?.sandbox === 'danger-full-access' && spec?.approval === 'ask'
}

/** Effective never: an explicit override, or a null override over a never base policy. */
export function effectiveApprovalNever(state: PermissionStateLike | undefined, approval: any): boolean {
  if (state?.approval === 'never') return true
  if ((state?.approval === null || state?.approval === undefined) && approval?.config?.policy === 'never') return true
  return false
}

/**
 * Classify a raw state for the apply-time scan audit:
 * candidate = migratable signature, never = an auto session that would run
 * silently, foreign = any other preset/knob combination, unknown = no state.
 */
export function classifyForMigration(rawState: PermissionStateLike | undefined, approval?: any): MigrationClass {
  if (rawState === undefined || rawState.preset === undefined) return 'unknown'
  if (rawState.preset !== LEGACY_AUTO_PRESET) return 'foreign'
  if (effectiveApprovalNever(rawState, approval)) return 'never'
  return migrationDecision(rawState).eligible ? 'candidate' : 'foreign'
}

export interface MigrationAuditInput {
  ok: boolean
  sessionId?: string | null
  stage?: string
  reason?: string
  branch?: string
  from?: string
  to?: string
  knobs?: { sandbox?: string | null; approval?: string | null }
  at?: number
}

/** One durable JSON line per migration attempt. */
export function migrationAuditLine(input: MigrationAuditInput): string {
  const line: Record<string, unknown> = {
    type: 'preset-migration',
    at: input.at ?? Date.now(),
    sessionId: input.sessionId ?? null,
    ok: input.ok,
  }
  if (input.stage !== undefined) line.stage = input.stage
  if (input.reason !== undefined) line.reason = input.reason
  if (input.branch !== undefined) line.branch = input.branch
  if (input.from !== undefined) line.from = input.from
  if (input.to !== undefined) line.to = input.to
  if (input.knobs !== undefined) line.knobs = input.knobs
  return JSON.stringify(line)
}

/** One durable JSON line per apply-time scan, with the raw-signature counts. */
export function scanAuditLine(counts: MigrationScanCounts, at: number = Date.now()): string {
  return JSON.stringify({
    type: 'preset-migration-scan',
    at,
    candidates: counts.candidates,
    foreign: counts.foreign,
    never: counts.never,
    unknown: counts.unknown,
    unmigrated: counts.foreign + counts.never + counts.unknown,
  })
}

function auditRestoreFailure(session: any, deps: MigrationDeps, error: unknown): void {
  deps.audit(JSON.stringify({
    type: 'preset-spec-restore',
    at: nowOf(deps),
    sessionId: sessionIdOf(session),
    from: 'never',
    to: 'ask',
    preset: GATED_PRESET,
    reason: 'effective-never',
    ok: false,
    error: messageOf(error),
  }))
}

/**
 * Restore this plugin's own spec: a raw `auto-approval` session whose effective
 * approval policy is never is normalized back to ask. A raw `auto` session is
 * foreign (upstream on modern hosts) and is never touched here.
 */
export function enforceOwnSpec(session: any, deps: MigrationDeps): 'restored' | 'ok' | 'skip-foreign' | 'unknown' | 'failed' {
  const state = rawStateOf(deps.permissionPresets, session)
  if (state === undefined) return 'unknown'
  if (state.preset !== GATED_PRESET) return 'skip-foreign'
  if (!effectiveApprovalNever(state, deps.approval)) return 'ok'
  const release = deps.markPluginInitiated?.(session) ?? (() => {})
  try {
    deps.append(session, 'approval/policy', { policy: 'ask' })
  } catch (error) {
    deps.warn(`preset-spec-restore failed for session ${sessionIdOf(session) ?? 'unknown'}: ${messageOf(error)}`)
    auditRestoreFailure(session, deps, error)
    return 'failed'
  } finally {
    release()
  }
  deps.audit(JSON.stringify({
    type: 'preset-spec-restore',
    at: nowOf(deps),
    sessionId: sessionIdOf(session),
    from: 'never',
    to: 'ask',
    preset: GATED_PRESET,
    reason: 'effective-never',
  }))
  return 'restored'
}

/**
 * Fail-closed degradation after a failed migration: a live, ungated session
 * that would run silently under danger-full-access + never is downgraded to the
 * official ask panel. Covered sessions are left to the host pin or the raw gate.
 */
export function degradeAfterFailedMigration(session: any, deps: MigrationDeps): 'covered' | 'degraded-ask' | 'ungated' | 'unknown' {
  const state = rawStateOf(deps.permissionPresets, session)
  if (state === undefined) return 'unknown'
  const gateNames = gatePresetNames(deps.capability)
  const raw = typeof state.preset === 'string' ? state.preset : undefined
  const gated = isGatedRawPreset(gateNames, raw)
  const upstreamCovered = deps.capability === 'modern' && raw === LEGACY_AUTO_PRESET
  if (gated || upstreamCovered) return 'covered'
  if (state.sandbox === 'danger-full-access' && effectiveApprovalNever(state, deps.approval)) {
    const release = deps.markPluginInitiated?.(session) ?? (() => {})
    try {
      deps.append(session, 'approval/policy', { policy: 'ask' })
    } catch (error) {
      deps.warn(`preset-migration degraded-ask failed for session ${sessionIdOf(session) ?? 'unknown'}: ${messageOf(error)}`)
      deps.audit(migrationAuditLine({ ok: false, sessionId: sessionIdOf(session), stage: 'degraded-ask', reason: messageOf(error), at: nowOf(deps) }))
      return 'ungated'
    } finally {
      release()
    }
    deps.audit(migrationAuditLine({ ok: false, sessionId: sessionIdOf(session), stage: 'degraded-ask', reason: 'effective-never', at: nowOf(deps) }))
    deps.warn(`preset-migration could not rewrite the legacy auto identity for session ${sessionIdOf(session) ?? 'unknown'}; approval was degraded to ask`)
    return 'degraded-ask'
  }
  deps.audit(migrationAuditLine({ ok: false, sessionId: sessionIdOf(session), stage: 'ungated', reason: 'no-gate-no-effective-never', at: nowOf(deps) }))
  return 'ungated'
}

function migrationFailed(session: any, deps: MigrationDeps, stage: string, reason: string, error?: unknown): 'failed' {
  deps.audit(migrationAuditLine({
    ok: false,
    sessionId: sessionIdOf(session),
    stage,
    reason: error === undefined ? reason : `${reason}: ${messageOf(error)}`,
    at: nowOf(deps),
  }))
  deps.warn(`preset-migration failed (${stage}) for session ${sessionIdOf(session) ?? 'unknown'}: ${reason}${error === undefined ? '' : `: ${messageOf(error)}`}`)
  degradeAfterFailedMigration(session, deps)
  return 'failed'
}

/**
 * Migrate one live session from the legacy `auto` identity to `auto-approval`.
 *
 * Idempotent on the raw identity; the same-signature gate applies to every
 * capability. A failed attempt never throws: the caller owns the announce
 * boundary, and the raw gate / host pin remain the fail-closed backstop.
 */
export function runPresetMigration(session: any, deps: MigrationDeps): 'migrated' | 'skipped' | 'failed' {
  const state = rawStateOf(deps.permissionPresets, session)
  if (state === undefined) return 'skipped'
  if (state.preset !== LEGACY_AUTO_PRESET) return 'skipped'
  if (deps.capability === 'unknown') {
    if (state.sandbox === 'danger-full-access' && effectiveApprovalNever(state, deps.approval)) {
      deps.audit(migrationAuditLine({
        ok: false,
        sessionId: sessionIdOf(session),
        stage: 'ungated-never',
        reason: 'capability-unknown',
        at: nowOf(deps),
      }))
      deps.warn(`preset-migration: legacy auto session ${sessionIdOf(session) ?? 'unknown'} has effective-never approval on a host whose capability is inconsistent; leaving it untouched (ungated)`)
    }
    return 'skipped'
  }
  const decision = migrationDecision(state)
  if (!decision.eligible) {
    deps.audit(migrationAuditLine({
      ok: false,
      sessionId: sessionIdOf(session),
      stage: 'skip',
      reason: decision.reason,
      at: nowOf(deps),
    }))
    return 'skipped'
  }
  const targetSpec = safeResolveSpec(deps.permissionPresets, GATED_PRESET)
  if (!isUsableTargetSpec(targetSpec)) {
    return migrationFailed(session, deps, 'resolve', 'target-missing-or-mismatch')
  }
  const before = rawStateOf(deps.permissionPresets, session)
  if (before === undefined || before.preset !== LEGACY_AUTO_PRESET || before.sandbox !== 'danger-full-access' || before.approval !== 'ask') {
    return 'skipped'
  }
  const release = deps.markPluginInitiated?.(session) ?? (() => {})
  try {
    deps.append(session, 'permission/preset', { preset: GATED_PRESET })
  } catch (error) {
    release()
    return migrationFailed(session, deps, 'append', 'append-threw', error)
  }
  release()
  const after = rawStateOf(deps.permissionPresets, session)
  if (after?.preset !== GATED_PRESET || after.sandbox !== 'danger-full-access' || after.approval !== 'ask') {
    return migrationFailed(session, deps, 'verify-raw', 'identity-knob-diverged')
  }
  const current = deps.current !== undefined ? deps.current(session) : safeMethod(deps.permissionPresets, 'current', session)
  if (current !== GATED_PRESET) {
    return migrationFailed(session, deps, 'verify-current', 'spec-tie-or-mismatch')
  }
  deps.audit(migrationAuditLine({
    ok: true,
    sessionId: sessionIdOf(session),
    from: LEGACY_AUTO_PRESET,
    to: GATED_PRESET,
    branch: decision.branch,
    knobs: { sandbox: after.sandbox, approval: after.approval },
    at: nowOf(deps),
  }))
  return 'migrated'
}
