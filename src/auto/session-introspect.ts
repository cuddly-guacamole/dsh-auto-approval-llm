/**
 * dsh-auto-approval-llm · read-only session introspection + countdown action.
 *
 * These helpers take live host objects (`session`, `permissionPresets`, `tools`)
 * but never store them and never mutate them: each call derives a value from
 * the session's recorded events or from the host permission service and returns
 * it. No module state, no filesystem, no audit side channel — the cluster is a
 * pure read layer, so it can be exercised with plain object stand-ins.
 */

// The action the host countdown takes when nobody responds, per risk tier and
// the configured timeoutAction ('reject' | 'allow' | 'low-risk-allow'). Only
// LOW is auto-approved by 'low-risk-allow'; MEDIUM/HIGH stay fail-closed.
export function riskTimedOutAction(risk: 'LOW' | 'MEDIUM' | 'HIGH', action: string, unattended: boolean): 'allow' | 'reject' {
  if (unattended) return risk === 'HIGH' ? 'reject' : 'allow'
  if (action === 'allow') return 'allow'
  if (action === 'low-risk-allow') return risk === 'LOW' ? 'allow' : 'reject'
  return 'reject'
}

function isModelRouteConfig(cfg: any): cfg is { provider: string; model: string } {
  return typeof cfg?.provider === 'string' && cfg.provider.length > 0 &&
    typeof cfg?.model === 'string' && cfg.model.length > 0
}

// One normalized "all session events" view: rc.1 (0.1.2+) removed the
// `Session.events` getter in favor of `snapshotEvents()` (commit 27bf1039).
// The rc.2 fallback was dropped; snapshotEvents is the only source.
export function sessionEventList(session: any): readonly any[] {
  if (session === undefined || session === null) return []
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : []
  }
  return []
}

// Resolve the effective permission preset: rc.1 `current(session)` reads the
// session's folded knob state directly. The rc.2 `current(events)` variant
// was removed alongside Session.events.
export function currentPreset(permissionPresets: any, session: any): string | undefined {
  if (permissionPresets === undefined || permissionPresets?.current == null) return undefined
  if (session === undefined || session === null) return undefined
  return permissionPresets.current(session)
}

// Single resolver for "which provider/model is this session talking through":
// the live request header first, then the newest recorded header event.
export function sessionModelRoute(session: any): { provider: string; model: string } | undefined {
  const live = session?.requestHeader?.()?.config
  if (isModelRouteConfig(live)) return { provider: live.provider, model: live.model }
  const events = sessionEventList(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const cfg = event.data?.header?.config
    if (isModelRouteConfig(cfg)) return { provider: cfg.provider, model: cfg.model }
  }
  return undefined
}

// Agent-level resolution: session route first, then explicit agent options.
export function resolveModelRoute(agent: any): { provider: string; model: string } | undefined {
  const fromSession = sessionModelRoute(agent?.session)
  if (fromSession) return fromSession
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  return isModelRouteConfig({ provider, model }) ? { provider, model } : undefined
}

export function findToolCallArguments(session: any, callId: string | undefined, maxChars: number): string | undefined {
  if (!callId) return undefined
  const events = sessionEventList(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'tool/call' || event.data?.callId !== callId) continue
    const raw = event.data?.arguments
    if (typeof raw !== 'string') return undefined
    return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}\n…[truncated]`
  }
  return undefined
}

export function findToolDescription(tools: any, toolName: string): string | undefined {
  return tools?.schemas().find((schema: any) => schema.name === toolName)?.description
}
