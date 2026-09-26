/**
 * dsh-auto-approval-llm · agent-facing notices and rejection guidance.
 *
 * Both surfaces are agent context, never user banners, and neither can change an
 * approval outcome: a notice that fails to land is best-effort by design.
 * `watchNotices` takes its config and gate names as thunks, so the live settings
 * are read at event time and no import back into the entry is needed.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from '../index.js'
import { firstAutoNoticeSeen, rejectGuidanceSeen } from './approval-state.js'
import { CATEGORY_KEYS } from './category.js'
import { debugLog } from './debug-and-decisions.js'
import { PLUGIN_MESSAGE_SOURCE } from './message-source.js'

/**
 * Deliver a settled notice to the agent through its inbox.
 *
 * `agent.inject` — the same call `autoPolicyNotice` already uses — queues
 * model-facing context that the driver claims at the nearest step boundary,
 * so the message can never be seated between an assistant `tool_calls`
 * message and its `tool/result`. A direct `session.append` could: it writes at
 * whatever log position happens to be current, and OpenAI-shaped providers
 * reject that whole history ("An assistant message with 'tool_calls' must be
 * followed by tool messages responding to each 'tool_call_id'"), which then
 * fails every later request in the session because the invalid history is
 * replayed on each one. Timing therefore stops mattering: no flush point can
 * put an injected notice in the wrong place.
 */
function injectNotice(session: any, agent: any, text: string): void {
  try {
    if (!agent || typeof agent.inject !== 'function') {
      debugLog({ ev: 'notice-inject', sessionId: session?.id ?? null, ok: false, error: 'agent-unavailable' })
      return
    }
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: PLUGIN_MESSAGE_SOURCE,
    }))
    debugLog({ ev: 'notice-inject', sessionId: session?.id ?? null, ok: true })
  } catch (error) {
    // Notification is best-effort; never changes the approval outcome.
    debugLog({ ev: 'notice-inject', sessionId: session?.id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// ── first-use onboarding notice ───────────────────────────────────────────
// A process-lifetime one-shot greeting for a fresh AUTO session: the very
// first tool call of each root session queues the notice once through the
// safe notice queue above (never a bare append). The marker lives only in
// memory and never touches disk, so a restart may greet the same session
// again — an accepted semantic (documented in HANDOFF).

/** True exactly once per root session key per process lifetime. */
export function markFirstAutoSessionNotice(sessionKey: string): boolean {
  if (firstAutoNoticeSeen.has(sessionKey)) return false
  firstAutoNoticeSeen.add(sessionKey)
  return true
}

/** Localized label of the live timeout action (never a literal "reject"). */
export function onboardingTimeoutLabel(timeoutAction: string, lang: 'zh' | 'en' = 'zh'): string {
  switch (timeoutAction) {
    case 'allow': return lang === 'en' ? 'auto-allow' : '自动放行'
    case 'low-risk-allow': return lang === 'en' ? 'low-risk auto-allow' : '仅低风险放行'
    default: return lang === 'en' ? 'reject' : '拒绝'
  }
}

/** Shared English behavior summary for both the onboarding notice and the
 * auto-mode enter/exit announcements — one wording source so the agent never
 * sees contradictory descriptions. The timeout slot carries the live label.
 * "Low-risk" here means the automated safety check passed; an uncertain call
 * still shows a countdown prompt, so nothing is auto-allowed sight unseen. */
function autoApprovalSummary(timeoutAction: string): string {
  return `calls the automated safety check considers low-risk pass after that check; uncertain ones show a countdown prompt; no response applies the configured timeout action (currently "${onboardingTimeoutLabel(timeoutAction, 'en')}")`
}

/** First-use notice body; the timeout slot always carries the live label. */
export function onboardingNoticeText(timeoutAction: string, lang: 'zh' | 'en' = 'zh'): string {
  const label = onboardingTimeoutLabel(timeoutAction, lang)
  if (lang === 'en') {
    return `(Auto-approval) is active: ${autoApprovalSummary(timeoutAction)}. Reasons for denials are recorded in "recent approvals".`
  }
  return `（自动审批）已生效：被自动安全检查判定为低风险的调用在该检查通过后放行；拿不准的会弹出倒计时询问你，没人回答则按设置处理（当前为「${label}」）。被拒的原因会写进「最近审批记录」。`
}

// ── approval notice queue ────────────────────────────────────────────────
// Message-sequence safety is no longer this queue's job — `injectNotice`
// hands the notice to the agent inbox, which can only land it at a step
// boundary. What remains is the one thing delivery cannot decide on its own:
// whether the tool the notice talks about actually ran. The entry is marked
// seen when the matching tool/result lands, and the step/end flush settles
// whatever is still pending; an unseen notice is never delivered to the model
// (the call was rejected or cancelled, so "approved X" would be a lie).
// The originating agent travels with the entry: it is the exact agent whose
// turn the notice belongs to, and both flush points hold only the session.
// A callId carries a LIST of notices, not one: the first-auto-session
// onboarding queues under the same callId the pre-execute decision may then
// deny with reject-guidance — one-entry-per-callId let the guidance overwrite
// the onboarding and it was never delivered.
const pendingNotices = new Map<string, Map<string, Array<{ text: string; seen: boolean; agent: any }>>>()

export function queueNotice(agent: any, callId: string, text: string): void {
  const session = agent?.session
  if (!session?.id) return
  let byCall = pendingNotices.get(session.id)
  if (!byCall) {
    byCall = new Map()
    pendingNotices.set(session.id, byCall)
  }
  const list = byCall.get(callId)
  if (list) list.push({ text, seen: false, agent })
  else byCall.set(callId, [{ text, seen: false, agent }])
}

// ── rejectGuidance: short whitelist-only guidance injected on rejection ──
// The agent-inbox text is a user-role message (higher authority than tool
// results), so the payload is frozen to enum constants: a known source and an
// optional category key. Tool names, reviewer reasons and any free text NEVER
// enter it (prompt-injection surface). Dedup per (session, callId); global
// sliding window of 5 per 60s so a denial loop cannot flood the context.
const REJECT_GUIDANCE_KNOWN_SOURCES = ['rule', 'denyList', 'category', 'policy', 'llm', 'timeout', 'human']
const REJECT_GUIDANCE_MAX_PER_MINUTE = 5
// Bounded the same way as firstAutoNoticeSeen: keys are (sessionId, callId)
// and would otherwise grow without limit in a long-lived process. The cap is
// a simple insert-order FIFO (Set iteration follows insertion order), and
// session/disposed drops a session's prefix wholesale (see apply()).
const REJECT_GUIDANCE_SEEN_CAP = 4096
let rejectGuidanceWindow: number[] = []

export function buildRejectGuidanceText(source: string, category?: string): string {
  const src = REJECT_GUIDANCE_KNOWN_SOURCES.includes(source) ? source : 'policy'
  const cat = category !== undefined && CATEGORY_KEYS.includes(category as (typeof CATEGORY_KEYS)[number]) ? ` (category: ${category})` : ''
  return `[reject-guidance] Tool call denied by ${src} policy${cat}. Do not repeat, reword, or switch tools to evade the decision; ask the user if the denial seems wrong.`
}

export const OFFICIAL_REJECT_GUIDANCE_TEXT =
  '[reject-guidance] The user rejected this tool call through the official approval channel. Do not retry the same operation; ask the user how to proceed.'

/**
 * Whether a finished tool result carries the official "user rejected tool"
 * denial. The official executioner builds it as a structured isError result
 * (content text "Error: the user rejected tool ..." plus error.message), so a
 * naive String() of the result object would yield "[object Object]" and never
 * match. Only the structured denial shape counts: error.message present, an
 * isError flag set, or the official "Error: the user rejected tool" text
 * prefix. Successful tool payloads (file reads, grep output, command output)
 * may legitimately carry the bare phrase and must NOT match on their own.
 * Pure; contract-tested.
 */
export function officialRejectionIn(result: unknown): boolean {
  if (typeof result === 'string') return /^Error: the user rejected tool/i.test(result)
  const res = result as { content?: unknown; error?: { message?: unknown }; isError?: unknown } | null | undefined
  const candidates: string[] = []
  if (typeof res?.error?.message === 'string') candidates.push(res.error.message)
  const structured = res?.isError === true || typeof res?.error?.message === 'string'
  if (Array.isArray(res?.content)) {
    for (const block of res.content) {
      const b = block as { type?: string; text?: string }
      if (b?.type === 'text' && typeof b.text === 'string') {
        // Content text is only evidence inside a structured error result; a
        // successful payload (file read / grep / command output) may contain
        // the bare phrase and must never trigger on its own.
        if (structured || /^Error: the user rejected tool/i.test(b.text)) candidates.push(b.text)
      }
    }
  }
  return candidates.some((text) => /user rejected tool/i.test(text))
}

/**
 * Pull a bounded, alert-worthy summary out of an online-reviewer probe error
 * (429/4xx/5xx handler). The provider body is user-typed-endpoint output, so
 * it is capped and flattened to a single line before it can reach the
 * settings card; the API key is never part of the body and never echoed.
 * Pure; contract-tested.
 */
export function extractProbeErrorSummary(status: number, bodyText: unknown): string {
  const prefix = `HTTP ${status}`
  const raw = typeof bodyText === 'string' ? bodyText : ''
  const trimmed = raw.trim()
  if (trimmed === '') return prefix
  let candidate = trimmed
  try {
    const parsed = JSON.parse(trimmed)
    const pick = (v: any): string | undefined => {
      if (typeof v !== 'object' || v === null) return undefined
      if (typeof v.type === 'string' && typeof v.message === 'string') return `${v.type}: ${v.message}`
      if (typeof v.error?.message === 'string') return v.error.message
      if (typeof v.error === 'string') return v.error
      if (typeof v.message === 'string') return v.message
      if (typeof v.detail === 'string') return v.detail
      return undefined
    }
    const picked = pick(parsed) ?? (typeof parsed === 'string' ? parsed : undefined)
    if (picked !== undefined) candidate = picked
  } catch {
    // not JSON: use the raw body (already capped below)
  }
  const flat = candidate.replace(/\s+/g, ' ').trim()
  const capped = flat.length > 400 ? `${flat.slice(0, 397)}…` : flat
  return `${prefix}: ${capped}`
}

export function maybeInjectRejectGuidance(agent: unknown, callId: unknown, config: { rejectGuidance?: boolean }, text: string): void {
  if (!config?.rejectGuidance || !agent || typeof callId !== 'string') return
  const sessionId = (agent as any)?.session?.id ?? ''
  const key = `${sessionId}:${callId}`
  if (rejectGuidanceSeen.has(key)) return
  const now = Date.now()
  rejectGuidanceWindow = rejectGuidanceWindow.filter((t) => now - t < 60_000)
  if (rejectGuidanceWindow.length >= REJECT_GUIDANCE_MAX_PER_MINUTE) return
  try {
    // Insert-order FIFO cap: evict the oldest key when the set is full so a
    // long-lived process never grows rejectGuidanceSeen without bound.
    if (rejectGuidanceSeen.size >= REJECT_GUIDANCE_SEEN_CAP) {
      const oldest = rejectGuidanceSeen.values().next().value
      if (oldest !== undefined) rejectGuidanceSeen.delete(oldest)
    }
    rejectGuidanceSeen.add(key)
    rejectGuidanceWindow.push(now)
    queueNotice(agent, callId, text)
  } catch {
    // fail-closed: guidance is best-effort; never disturb the approval path.
  }
}

/**
 * Dequeue and settle ONE pending notice by its own callId. Parallel tool
 * executions each land a `tools/result`; flushing the whole session map on the
 * first result would drop the notices still waiting for their own results
 * (seen=false → console-only), so result delivery settles only the matched
 * callId and leaves the rest queued for their own result or the step/end
 * flush.
 */
function flushNotice(session: any, callId: string): void {
  const byCall = pendingNotices.get(session.id)
  if (!byCall) return
  const entries = byCall.get(callId)
  if (entries === undefined) return
  byCall.delete(callId)
  for (const entry of entries) {
    if (!entry.seen) {
      // The tool never produced a result (rejected/cancelled): a notice about
      // a call that never ran would only mislead the model, so it stays on the
      // console and never reaches the conversation.
      console.log(`[dsh-auto-approval-llm] (工具未执行，仅控制台通知) ${entry.text}`)
      continue
    }
    injectNotice(session, entry.agent, entry.text)
  }
}

function flushNotices(session: any): void {
  const byCall = pendingNotices.get(session.id)
  if (!byCall) {
    debugLog({ ev: 'onboarding-flush', sessionId: session?.id ?? null, queued: 0, reason: 'no-pending' })
    return
  }
  pendingNotices.delete(session.id)
  const queued = [...byCall.values()].flat()
  debugLog({ ev: 'onboarding-flush', sessionId: session?.id ?? null, queued: queued.length, seen: queued.filter((e) => e.seen).length, dropped: queued.filter((e) => !e.seen).length })
  for (const { text, seen, agent } of queued) {
    if (!seen) {
      // The tool never produced a result (rejected/cancelled): a notice about
      // a call that never ran would only mislead the model, so it stays on
      // the console and never reaches the conversation.
      console.log(`[dsh-auto-approval-llm] (工具未执行，仅控制台通知) ${text}`)
      continue
    }
    injectNotice(session, agent, text)
  }
}

export function watchNotices(ctx: any, getConfig: () => Config, getGateNames: () => readonly string[]): void {
  // One telemetry map per session tracking the last raw permission identity so
  // a mode switch into/out of the plugin's gated set can announce itself to
  // the agent (mirrors the official user-approval policy-change notice, in
  // English like the onboarding notice — agent context, not a user banner).
  const sessionPreset = new Map<string, string>()
  const autoPolicyNotice = (session: any, active: boolean): void => {
    if (getConfig().autoModeNoticeEnabled === false) return
    const agent = ctx.get('agents')?.get?.(session.id)
    if (!agent || typeof agent.inject !== 'function') return
    agent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: active
          ? `(Auto-approval) is now ACTIVE for this session: ${autoApprovalSummary(getConfig().timeoutAction)}.`
          : '(Auto-approval) is now INACTIVE for this session: the official approval flow applies again.',
      }],
      source: PLUGIN_MESSAGE_SOURCE,
    }))
    debugLog({ ev: 'auto-mode-notice', sessionId: session?.id ?? null, active })
  }
  // Reliable settle point: `tools/result` — its scope carrier keys on
  // exec.agent, the same chain `tools/pre-execute` proves to reach plugin
  // contexts. A `session/event` subscription may be filtered away for plugin
  // contexts (probes: injection fired, flush never did). It fires when tool
  // EXECUTION finishes, i.e. before the agent appends the `tool/result`
  // session event — which is why it may only decide THAT a notice is due, and
  // never where the message lands; the inbox handles the seating.
  ctx.on('tools/result', (exec: any, result: any) => {
    // rejectGuidance: the official approval channel translates user declines
    // into a bare denial ("the user rejected tool ...") with no rationale;
    // spot that shape and hand the agent a whitelist-only guidance note.
    // The official dispatch calls observers with (exec, result): the finished
    // tool outcome arrives as the second argument and does not ride on exec.
    if (getConfig().rejectGuidance && officialRejectionIn(result ?? exec?.result)) {
      maybeInjectRejectGuidance(exec?.agent, exec?.callId, getConfig(), OFFICIAL_REJECT_GUIDANCE_TEXT)
    }
    const session = exec?.agent?.session
    const callId = exec?.callId
    if (!session || !callId) return
    const byCall = pendingNotices.get(session.id)
    if (!byCall) return
    const entries = byCall.get(callId)
    if (entries) for (const entry of entries) entry.seen = true
    debugLog({ ev: 'onboarding-event', via: 'tools/result', sessionId: session.id, callId, found: !!entries, pending: byCall.size })
    flushNotice(session, callId)
  })
  ctx.on('session/event', (session: any, event: any) => {
    // Diagnostic: does the scope carrier actually reach plugin contexts?
    debugLog({ ev: 'onboarding-event', via: 'session/event', sessionId: session?.id ?? null, type: event?.type ?? null })
    if (event?.type === 'permission/preset' && session?.id) {
      // Announce gated-set entry/exit to the agent (one direction only:
      // switching away from a preset we never saw as gated is not an exit).
      const preset = event.data?.preset ?? ''
      const gateNames = getGateNames()
      const active = gateNames.includes(preset)
      const last = sessionPreset.get(session.id)
      const wasActive = last !== undefined && gateNames.includes(last)
      sessionPreset.set(session.id, preset)
      if (active && !wasActive) autoPolicyNotice(session, true)
      else if (!active && wasActive) autoPolicyNotice(session, false)
      return
    }
    if (!pendingNotices.has(session?.id)) return
    if (event?.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      const entries = pendingNotices.get(session.id)?.get(callId)
      if (entries) for (const entry of entries) entry.seen = true
      // Same parallel-safe dequeue as the tools/result branch: only this
      // result's notice leaves the queue; siblings wait for their own results.
      if (typeof callId === 'string') flushNotice(session, callId)
    } else if (event?.type === 'step/end') {
      flushNotices(session)
    }
  })
  ctx.on('session/disposed', (session: any) => {
    pendingNotices.delete(session?.id)
    sessionPreset.delete(session?.id)
  })
}
