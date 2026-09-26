/**
 * dsh-auto-approval-llm · Auto-session gate decision.
 *
 * Answers one question: which agent (the caller, or a subagent's Auto-session
 * ancestor) owns an execution. Every host touchpoint is injected
 * (`permissionPresets`, `parentAgent`), so the walk is exercisable with plain
 * stand-ins. `LEARNABLE_HOOK_SITES` is the contract table the ask sites are
 * enumerated against.
 */
import { GATED_PRESET } from './constants.js'
import { isGatedSession } from './preset-migration.js'

/**
 * The gate reads the durable raw identity, never current(). current() folds an
 * approval override back to the base policy, so a raw auto-approval session
 * with a never override would derive as danger-full-access and silently skip
 * every plugin gate.
 */
function isAutoPermissionExecution(exec: any, permissionPresets: any, presetNames: readonly string[] = [GATED_PRESET]) {
  return isGatedSession(permissionPresets, exec.agent?.session, presetNames)
}

export function autoPermissionAuthority(exec: any, parentAgent: any, permissionPresets: any, presetNames: readonly string[] = [GATED_PRESET]) {
  if (isAutoPermissionExecution(exec, permissionPresets, presetNames)) return exec.agent
  let session = exec.agent?.session
  const visited = new Set<string>()
  while (session?.header?.origin === 'subagent' && session.header.parentSession !== undefined) {
    const parentSessionId = session.header.parentSession
    const parentKey = String(parentSessionId)
    if (visited.has(parentKey)) return undefined
    visited.add(parentKey)
    const parent = parentAgent(parentSessionId)
    if (parent === undefined) return undefined
    const parentExec = { ...exec, agent: parent }
    if (isAutoPermissionExecution(parentExec, permissionPresets, presetNames)) return parent
    session = parent.session
  }
  return undefined
}

/**
 * The enumerated ask sites that construct a learnable context. This table is
 * the single source for the LP3 contract test: a new learnable hook means one
 * call site carrying its label here plus one entry in this list — the test
 * derives its counts from the table, so neither half can be forgotten.
 * Ordinary status-less asks never construct a learnable context and must not
 * appear here.
 */
export const LEARNABLE_HOOK_SITES: readonly string[] = Object.freeze([
  'direct-human-target',
  'learn-attempt-query',
  'low-countdown',
  'low-llm-countdown',
  'medium-countdown',
  'medium-llm-countdown',
  'high-countdown',
])
