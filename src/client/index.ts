import React from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { normalizeTimeoutAction } from '../auto/decision.js'
import { THRESHOLD_DEFAULTS } from '../auto/constants.js'
import { parseRulesText } from '../auto/rules.js'
import { installAutoPermissionIcon } from './auto-icon.js'
import { zh, en } from './locale.js'

export const name = 'dsh-auto-approval-llm'
export const inject = ['slots', 'sessions']

const FEEDBACK_ROUTE = '/_dsh/auto-approval-llm/feedback'
const SETTINGS_ROUTE = '/_dsh/auto-approval-llm/settings'
const HISTORY_ROUTE = '/_dsh/auto-approval-llm/history'
const TEST_ROUTE = '/_dsh/auto-approval-llm/test'
const REVIEWER_CREDENTIAL_ROUTE = '/_dsh/auto-approval-llm/reviewer-credential'
const SESSION_MODE_ROUTE = '/_dsh/auto-approval-llm/session-mode'
const REVIEW_STATUS_ROUTE = '/_dsh/auto-approval-llm/review-status'
let sessionsRef: any
let breakerAntiHijackMs = THRESHOLD_DEFAULTS.breakerAntiHijackMs
let aiButtonPosition: 'header' | 'floating' = 'header'
const MAX_PANEL_RECORDS = 10
// Grace (ms) during which a countdown approval whose host follow is not yet
// observable keeps being watched before the client closes the panel with the
// recorded countdown action. Aligned with the host's follow TTL so the client
// never closes before the host would have swept the follow state.
const FOLLOW_GRACE_MS = 120_000
const LOCALE_NS = 'dsh-auto-approval-llm'
// Answer-once guard: an approval may be auto-answered by the watcher, the
// countdown timer, or a follow-up responder; only the first responder wins.
const answeredApprovals = new Set<string>()
let t: any = (key: string, params?: Record<string, unknown>) => {
  let text = (zh as any)[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v))
  return text
}

interface CountdownInfo {
  seconds: number
  action: 'allow' | 'reject'
  feedbackText?: string
}

function parseCountdown(reason: string | undefined): CountdownInfo | null {
  if (!reason) return null
  const match = reason.match(/\[dsh-auto-approval-llm\]\s*⏳\s*will auto-(approve|reject) in (\d+)s/)
  if (!match) return null
  return {
    seconds: Math.max(1, Number(match[2])),
    action: match[1] === 'approve' ? 'allow' : 'reject',
  }
}

function answerKey(wait: any): string {
  return `${wait.sessionId}:${wait.key ?? wait.payload?.callId ?? '?'}`
}

async function followRespond(wait: any, status: any) {
  const outcome = status.action === 'allow' ? 'allowed-once' : 'rejected'
  const key = answerKey(wait)
  if (answeredApprovals.has(key)) return
  answeredApprovals.add(key)
  try {
    if (wait.payload?.callId) {
      // Only the outcome crosses the wire; host generates the notice text.
      const feedback = (globalThis as any).fetch(FEEDBACK_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: wait.payload.callId, outcome, auto: true }),
        credentials: 'same-origin',
      }).catch(() => {})
      await Promise.race([feedback, new Promise((resolve) => setTimeout(resolve, 500))])
    }
    await wait.respond({
      ok: true,
      value: {
        sessionId: wait.sessionId,
        approvalId: wait.payload?.approvalId,
        outcome,
      },
    })
  } catch (e) {
    console.error('[dsh-auto-approval-llm] follow respond failed', e)
  }
}

async function autoRespond(wait: any, countdown: CountdownInfo) {
  const outcome = countdown.action === 'allow' ? 'allowed-once' : 'rejected'
  const key = answerKey(wait)
  if (answeredApprovals.has(key)) return
  answeredApprovals.add(key)
  try {
    if (wait.payload?.callId) {
      // Only the outcome crosses the wire; host generates the notice text.
      const feedback = (globalThis as any).fetch(FEEDBACK_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: wait.payload.callId, outcome, auto: true }),
        credentials: 'same-origin',
      }).catch(() => {
        // The route is best-effort; the approval answer must still happen.
      })
      // Never let a slow/hanging feedback request block the approval answer.
      await Promise.race([feedback, new Promise((resolve) => setTimeout(resolve, 500))])
    }
    await wait.respond({ ok: true, value: { sessionId: wait.sessionId, approvalId: wait.payload.approvalId, outcome } })
  } catch (e) {
    console.error('[dsh-auto-approval-llm] auto respond failed', e)
  }
}

// ── non-UI watcher ────────────────────────────────────────────────────────
// The auto-answer must not depend on a particular slot being rendered by the
// active skin. This service-level watcher subscribes to the current session's
// snapshot and answers managed approvals on timeout.
function watchApprovals(ctx: any): void {
  const sessions = ctx.get('sessions')
  if (!sessions) return

  const timers = new Map<string, any>()
  const pollers = new Map<string, any>()
  const timerMeta = new Map<string, string>()
  // Tombstones: approvals the watcher already detached from (host resolved,
  // follow answered, or host stopped tracking). Prevents check() from
  // re-arming a poller for a stale approval and drops late in-flight poll
  // responses (R004).
  const resolvedKeys = new Set<string>()
  let currentId: string | undefined
  let unsubSession: (() => void) | undefined

  const clearSessionTimers = (sessionId: string | undefined) => {
    if (!sessionId) return
    const prefix = `${sessionId}:`
    for (const [key, timer] of timers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer)
        timers.delete(key)
      }
    }
    for (const [key, poller] of pollers) {
      if (key.startsWith(prefix)) {
        clearInterval(poller)
        pollers.delete(key)
      }
    }
    for (const key of [...timerMeta.keys()]) {
      if (key.startsWith(prefix)) timerMeta.delete(key)
    }
    for (const key of [...resolvedKeys]) {
      if (key.startsWith(prefix)) resolvedKeys.delete(key)
    }
    for (const key of [...answeredApprovals]) {
      if (key.startsWith(prefix)) answeredApprovals.delete(key)
    }
  }

  /** Stop observing one approval: clear timer/poller/meta and tombstone it. */
  const detach = (timerKey: string) => {
    if (timers.has(timerKey)) {
      clearTimeout(timers.get(timerKey))
      timers.delete(timerKey)
    }
    const poller = pollers.get(timerKey)
    if (poller) {
      clearInterval(poller)
      pollers.delete(timerKey)
    }
    timerMeta.delete(timerKey)
    resolvedKeys.add(timerKey)
  }

  /** Whether an approval with this key is still visible in the session snapshot. */
  const approvalStillPending = (sessionId: string, approvalKey: string): boolean => {
    const binding = sessions.binding?.(sessionId)
    const snapshot = binding?.session?.getSnapshot?.() ?? {}
    return (snapshot.pending ?? []).some((i: any) => i.kind === 'approval' && i.key === approvalKey)
  }

  const applyStatus = (sessionId: string, approval: any, status: any) => {
    const timerKey = `${sessionId}:${approval.key}`
    // Late response for an approval we already detached from: drop it.
    if (resolvedKeys.has(timerKey)) return
    if (status?.phase === 'follow') {
      if (status.source === 'human') {
        // The human already closed the panel; detaching is enough — re-answering
        // would re-respond to a settled approval and mislabel it (R001).
        detach(timerKey)
        return
      }
      // LLM takeover / host timeout: answer with the real follow action so the
      // official panel closes immediately, then detach.
      detach(timerKey)
      void followRespond(approval, status)
      return
    }
    const priorMeta = timerMeta.get(timerKey)
    if (status === undefined && priorMeta?.startsWith('countdown:')) {
      // Host stopped reporting a follow for this countdown approval. Per the
      // DSH contract review-status is never 404 — resolution is signalled by
      // ok:false — so the host resolved and its terminal `follow` may simply
      // arrive one poll later. Keep the watch alive for a bounded grace so a
      // late follow still closes the official panel (A5). We never auto-answer
      // here: if a real follow arrives, the follow branch responds with the
      // host's authoritative action. Only if none arrives within the grace and
      // the approval is still open do we close it with the countdown's recorded
      // action — the only action this approval ever declared. When the approval
      // leaves the pending snapshot, check() clears everything.
      const parts = priorMeta.split(':')
      const recordedAction = parts[1] === 'allow' ? 'allow' : 'reject'
      if (!timers.has(timerKey)) {
        timerMeta.set(timerKey, priorMeta)
        const fallback = setTimeout(() => {
          if (approvalStillPending(sessionId, approval.key)) {
            void autoRespond(approval, { seconds: 0, action: recordedAction })
          }
          detach(timerKey)
        }, FOLLOW_GRACE_MS)
        timers.set(timerKey, fallback)
      }
      return
    }
    if (status?.phase !== 'countdown') {
      // No host-published countdown: never arm an answer from reason text.
      // The marker regex matches free text any command can forge, so reason
      // parsing must not decide outcomes — status-less asks (breaker / manual
      // / human-only) are meant to wait for a human, and every real countdown
      // shows up here as a published review-status within one poll.
      return
    }
    const info: CountdownInfo = { seconds: status.seconds, action: status.action, feedbackText: status.feedback }
    const meta = `countdown:${info.action}:${info.seconds}`
    if (timerMeta.get(timerKey) === meta) return
    // countdown-key: the host countdown is authoritative, so the client only
    // observes (no local timer). The host resolves → publishes follow → the
    // poller sees it within 500ms. A local timer here would fire with the
    // same action but could also answer against a stale direction (R002).
    // Also clear a fallback timer that may have been armed by the grace
    // branch on an earlier observation (status-lag), so a real host countdown
    // always supersedes any locally recorded action.
    if (timers.has(timerKey)) {
      clearTimeout(timers.get(timerKey))
      timers.delete(timerKey)
    }
    timerMeta.set(timerKey, meta)
  }

  const armApproval = (sessionId: string, approval: any) => {
    const timerKey = `${sessionId}:${approval.key}`
    if (pollers.has(timerKey)) clearInterval(pollers.get(timerKey))
    const callId = approval.payload?.callId
    const poll = async () => {
      if (!callId) {
        applyStatus(sessionId, approval, undefined)
        return
      }
      let status: any
      try {
        const res = await (globalThis as any).fetch(REVIEW_STATUS_ROUTE, {
          credentials: 'same-origin',
          // Call id is sent in a header so it never lands in the URL query
          // (devtools/logs/Referer). The host route reads this header.
          headers: { 'x-auto-approval-call-id': String(callId) },
        })
        if (!res.ok) {
          // Transient server error: keep observing; do not treat it as a
          // resolution.
          return
        }
        const data = await res.json()
        status = data?.ok ? data.value : undefined
      } catch {
        // Network error: never treat it as a resolution; keep observing.
        return
      }
      // Drop late responses for approvals we already detached from (R004).
      if (resolvedKeys.has(timerKey)) return
      applyStatus(sessionId, approval, status)
    }
    void poll()
    const interval = setInterval(() => { void poll() }, 500)
    pollers.set(timerKey, interval)
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
      clearSessionTimers(sessionId)
      return
    }
    const timerKey = `${sessionId}:${approval.key}`
    // Never re-arm an approval we already detached from (tombstone); waiting
    // for it to leave pending is the only path to clear the tombstone.
    if (!pollers.has(timerKey) && !resolvedKeys.has(timerKey)) armApproval(sessionId, approval)
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
    clearSessionTimers(currentId)
    currentId = next
    if (currentId) {
      const binding = sessions.binding?.(currentId)
      const session = binding?.session
      if (session) unsubSession = session.subscribe?.(() => check(currentId))
      check(currentId)
    }
  }

  const unsubList = sessions.list?.subscribe?.(onListChange)
  onListChange()

  ctx.effect(() => () => {
    unsubList?.()
    unsubSession?.()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const poller of pollers.values()) clearInterval(poller)
    pollers.clear()
    timerMeta.clear()
    resolvedKeys.clear()
    answeredApprovals.clear()
  }, 'dsh-auto-approval-llm: approval watcher')
}

function watchSessionModeChanges(ctx: any): void {
  const sessions = ctx.get('sessions')
  if (!sessions) return
  let currentId: string | undefined
  let unsubSession: (() => void) | undefined
  const notify = () => {
    const g = globalThis as any
    if (typeof g.CustomEvent === 'function') {
      g.dispatchEvent(new g.CustomEvent('dsh-auto-approval-llm:session-changed'))
    }
  }
  const onListChange = () => {
    const next = sessions.list?.getSnapshot?.()?.current
    if (next === currentId) return
    if (unsubSession) { unsubSession(); unsubSession = undefined }
    currentId = next
    if (currentId) {
      const binding = sessions.binding?.(currentId)
      const session = binding?.session
      if (session) unsubSession = session.subscribe?.(notify)
    }
  }
  const unsubList = sessions.list?.subscribe?.(onListChange)
  onListChange()
  ctx.effect(() => () => {
    unsubList?.()
    unsubSession?.()
  }, 'dsh-auto-approval-llm: session mode watcher')
}

// ── button hijack ─────────────────────────────────────────────────────────
// The official ApprovalPanel owns its buttons, but we can still update their
// visible labels from outside React. This makes the countdown visible directly
// on "拒绝/允许一次" while the user is about to click.
function hijackApprovalButtons(): () => void {
  const g = globalThis as any
  if (!g.document || !g.MutationObserver) return () => {}
  const doc = g.document
  const originals = new Map<any, string>()
  const intervals = new Map<string, any>()
  const breakerTimers = new Map<string, any>()

  const originalText = (btn: any): string => {
    if (!originals.has(btn)) originals.set(btn, btn.textContent ?? '')
    return originals.get(btn) ?? ''
  }

  const updatePanel = (panel: any, key: string, info: CountdownInfo) => {
    if (intervals.has(key)) return
    const buttons: any[] = Array.from(panel.querySelectorAll('button'))
    const reject: any = buttons.find((b: any) => /^(拒绝|Reject)$/i.test((b.textContent ?? '').trim()))
    const allow: any = buttons.find((b: any) => /^(允许一次|Allow once)$/i.test((b.textContent ?? '').trim()))
    if (!reject && !allow) return
    const deadline = Date.now() + info.seconds * 1000
    let interval: any
    const apply = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      const suffix = `（${remaining}s）`
      // Only the button that will auto-execute on timeout carries the
      // countdown; the other button stays clean.
      if (info.action === 'allow') {
        if (allow) allow.textContent = `${originalText(allow)}${suffix}`
      } else if (reject) {
        reject.textContent = `${originalText(reject)}${suffix}`
      }
      if (remaining <= 0) {
        clearInterval(interval)
        intervals.delete(key)
      }
    }
    interval = setInterval(apply, 200)
    intervals.set(key, interval)
    apply()
  }

  const applyBreakerGuard = (panel: any, key: string) => {
    if (!breakerAntiHijackMs || breakerTimers.has(key)) return
    const buttons: any[] = Array.from(panel.querySelectorAll('button'))
    const reject: any = buttons.find((b: any) => /^(拒绝|Reject)$/i.test((b.textContent ?? '').trim()))
    const allow: any = buttons.find((b: any) => /^(允许一次|Allow once)$/i.test((b.textContent ?? '').trim()))
    if (!reject && !allow) return
    const rejectDisabled = reject.disabled
    const allowDisabled = allow.disabled
    reject.disabled = true
    allow.disabled = true
    const timer = setTimeout(() => {
      breakerTimers.delete(key)
      if (reject.isConnected) reject.disabled = rejectDisabled
      if (allow.isConnected) allow.disabled = allowDisabled
    }, breakerAntiHijackMs)
    breakerTimers.set(key, timer)
  }

  const enablePreLine = (panel: any) => {
    const leaves: any[] = Array.from(panel.querySelectorAll('div')).filter((el: any) =>
      el.children.length === 0 && /评审建议|dsh-auto-approval-llm|auto-mode approval|超时未响应/.test(el.textContent ?? ''),
    )
    for (const el of leaves) el.style.whiteSpace = 'pre-line'
  }

  const scan = () => {
    const panels: any[] = Array.from(doc.querySelectorAll('[data-approval-key]'))
    const liveKeys = new Set<string>()
    for (const panel of panels) {
      const key = panel.getAttribute('data-approval-key')
      if (!key) continue
      liveKeys.add(key)
      enablePreLine(panel)
      const text = panel.textContent ?? ''
      if (/熔断/.test(text)) applyBreakerGuard(panel, key)
      const info = parseCountdown(text)
      if (!info) continue
      updatePanel(panel, key, info)
    }
    for (const key of [...intervals.keys()]) {
      if (!liveKeys.has(key)) {
        clearInterval(intervals.get(key))
        intervals.delete(key)
      }
    }
    for (const key of [...breakerTimers.keys()]) {
      if (!liveKeys.has(key)) {
        clearTimeout(breakerTimers.get(key))
        breakerTimers.delete(key)
      }
    }
    // The `originals` cache is keyed by button nodes React re-creates per
    // approval; pruning disconnected nodes here (rather than only at dispose)
    // stops a long-lived SPA from accumulating stale button strong-refs.
    for (const [btn] of originals) {
      if (btn != null && btn.isConnected === false) originals.delete(btn)
    }
  }

  const observer = new g.MutationObserver(scan)
  observer.observe(doc.body, { childList: true, subtree: true })
  scan()

  return () => {
    observer.disconnect()
    for (const timer of intervals.values()) clearInterval(timer)
    intervals.clear()
    for (const timer of breakerTimers.values()) clearTimeout(timer)
    breakerTimers.clear()
    originals.clear()
  }
}

// ── settings section ──────────────────────────────────────────────────────
interface SettingsSnapshot {
  value: any
  revision: number
  writable: boolean
  applies: string
}

interface Draft {
  enabled: 'on' | 'off'
  autoSwitchPolicyToAsk: 'on' | 'off'
  timeoutAction: string
  llmReviewScope: 'low-or-above' | 'medium-or-above' | 'high'
  llmTakeoverScope: 'low' | 'medium-or-below' | 'high-or-below'
  defaultReviewMode: 'manual' | 'smart' | 'unattended'
  lowRiskSeconds: string
  mediumRiskSeconds: string
  highRiskSeconds: string
  safetyPrompt: string
  reviewerProvider: string
  reviewerModel: string
  reviewerProtocol: string
  reviewerBaseUrl: string
  allowlist: string
  denyList: string
  humanOnlyList: string
  rulesText: string
  rulesDryRun: 'on' | 'off'
  maxConsecutiveDenials: string
  maxTotalDenials: string
  showSessionPanel: 'on' | 'auto' | 'off'
  breakerAntiHijackMs: string
  aiButtonPosition: 'header' | 'floating'
  debug: 'on' | 'off'
}

function draftOf(value: any): Draft {
  return {
    enabled: value?.enabled === false ? 'off' : 'on',
    autoSwitchPolicyToAsk: value?.autoSwitchPolicyToAsk === true ? 'on' : 'off',
    timeoutAction: normalizeTimeoutAction(value?.timeoutAction),
    llmReviewScope: value?.llmReviewScope ?? 'low-or-above',
    llmTakeoverScope: value?.llmTakeoverScope ?? 'medium-or-below',
    defaultReviewMode: ['manual', 'smart', 'unattended'].includes(value?.defaultReviewMode) ? value.defaultReviewMode : 'smart',
    lowRiskSeconds: String(value?.lowRiskSeconds ?? THRESHOLD_DEFAULTS.lowRiskSeconds),
    mediumRiskSeconds: String(value?.mediumRiskSeconds ?? THRESHOLD_DEFAULTS.mediumRiskSeconds),
    highRiskSeconds: String(value?.highRiskSeconds ?? THRESHOLD_DEFAULTS.highRiskSeconds),
    safetyPrompt: value?.safetyPrompt ?? '',
    reviewerProvider: value?.reviewerProvider ?? '',
    reviewerModel: value?.reviewerModel ?? '',
    reviewerProtocol: ['openai', 'anthropic'].includes(value?.reviewerProtocol) ? value.reviewerProtocol : 'openai',
    reviewerBaseUrl: value?.reviewerBaseUrl ?? '',
    allowlist: (value?.allowlist ?? []).join('\n'),
    denyList: (value?.denyList ?? []).join('\n'),
    humanOnlyList: (value?.humanOnlyList ?? []).join('\n'),
    rulesText: value?.rulesText ?? '',
    rulesDryRun: value?.rulesDryRun === true ? 'on' : 'off',
    maxConsecutiveDenials: String(value?.maxConsecutiveDenials ?? THRESHOLD_DEFAULTS.maxConsecutiveDenials),
    maxTotalDenials: String(value?.maxTotalDenials ?? THRESHOLD_DEFAULTS.maxTotalDenials),
    showSessionPanel: normalizeShowSessionPanel(value?.showSessionPanel ?? 'off'),
    breakerAntiHijackMs: String(value?.breakerAntiHijackMs ?? THRESHOLD_DEFAULTS.breakerAntiHijackMs),
    aiButtonPosition: value?.aiButtonPosition === 'floating' ? 'floating' : 'header',
    debug: value?.debug === true ? 'on' : 'off',
  }
}

function valueOf(draft: Draft): any {
  const list = (raw: string) => raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const value: any = {
    enabled: draft.enabled === 'on',
    autoSwitchPolicyToAsk: draft.autoSwitchPolicyToAsk === 'on',
    timeoutAction: draft.timeoutAction,
    llmReviewScope: draft.llmReviewScope,
    llmTakeoverScope: draft.llmTakeoverScope,
    defaultReviewMode: draft.defaultReviewMode,
    lowRiskSeconds: Math.max(1, Number(draft.lowRiskSeconds) || THRESHOLD_DEFAULTS.lowRiskSeconds),
    mediumRiskSeconds: Math.max(1, Number(draft.mediumRiskSeconds) || THRESHOLD_DEFAULTS.mediumRiskSeconds),
    highRiskSeconds: Math.max(1, Number(draft.highRiskSeconds) || THRESHOLD_DEFAULTS.highRiskSeconds),
    safetyPrompt: draft.safetyPrompt,
    allowlist: list(draft.allowlist),
    denyList: list(draft.denyList),
    humanOnlyList: list(draft.humanOnlyList),
    rulesText: draft.rulesText,
    rulesDryRun: draft.rulesDryRun === 'on',
    maxConsecutiveDenials: Math.max(0, Number(draft.maxConsecutiveDenials) || 0),
    maxTotalDenials: Math.max(0, Number(draft.maxTotalDenials) || 0),
    showSessionPanel: draft.showSessionPanel,
    breakerAntiHijackMs: Math.max(0, Number(draft.breakerAntiHijackMs) || 0),
    aiButtonPosition: draft.aiButtonPosition,
    debug: draft.debug === 'on',
  }
  if (draft.reviewerProvider.trim()) value.reviewerProvider = draft.reviewerProvider.trim()
  if (draft.reviewerModel.trim()) value.reviewerModel = draft.reviewerModel.trim()
  if (draft.reviewerProtocol === 'openai' || draft.reviewerProtocol === 'anthropic') value.reviewerProtocol = draft.reviewerProtocol
  if (draft.reviewerBaseUrl.trim()) value.reviewerBaseUrl = draft.reviewerBaseUrl.trim()
  return value
}

type CapsuleOption = { value: string; label: string }

function normalizeShowSessionPanel(value: any): 'on' | 'auto' | 'off' {
  if (value === true) return 'auto'
  if (value === false) return 'off'
  if (value === 'on' || value === 'auto' || value === 'off') return value
  return 'off'
}

function formatShortDateTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Render a millisecond latency as seconds with one decimal ("1.2s"). */
function formatLatencySeconds(ms: number | null): string {
  return ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`
}

// ── invalid-config detection (mirrors the host Config schema) ──────────────
// Flags stored values that are present but violate the schema (wrong type,
// unknown enum, out-of-range number). The settings card shows a red banner and
// offers to delete those keys so the schema defaults recover.
const INVALID_CONFIG_TYPES: Record<string, string> = {
  enabled: 'boolean', autoSwitchPolicyToAsk: 'boolean', rulesDryRun: 'boolean', notifyUser: 'boolean', debug: 'boolean',
  lowRiskSeconds: 'number', mediumRiskSeconds: 'number', highRiskSeconds: 'number',
  maxConsecutiveDenials: 'number', maxTotalDenials: 'number', breakerAntiHijackMs: 'number',
  maxArgsChars: 'number', classifierTimeoutMs: 'number', classifierMaxOutputTokens: 'number',
  workspaceRoot: 'string', dshHome: 'string', safetyPrompt: 'string', rulesText: 'string',
  reviewerProvider: 'string', reviewerModel: 'string', reviewerBaseUrl: 'string', timeoutAction: 'string',
  allowlist: 'array', denyList: 'array', humanOnlyList: 'array', tempRoots: 'array',
}
const INVALID_CONFIG_ENUMS: Record<string, string[]> = {
  timeoutAction: ['reject', 'allow', 'low-risk-allow'],
  llmReviewScope: ['low-or-above', 'medium-or-above', 'high'],
  llmTakeoverScope: ['low', 'medium-or-below', 'high-or-below'],
  defaultReviewMode: ['manual', 'smart', 'unattended'],
  showSessionPanel: ['on', 'auto', 'off'],
  aiButtonPosition: ['header', 'floating'],
  reviewerProtocol: ['openai', 'anthropic'],
}
const INVALID_CONFIG_RANGES: Record<string, [number, number]> = {
  lowRiskSeconds: [1, Infinity], mediumRiskSeconds: [1, Infinity], highRiskSeconds: [1, Infinity],
  maxConsecutiveDenials: [0, Infinity], maxTotalDenials: [0, Infinity], breakerAntiHijackMs: [0, Infinity],
  maxArgsChars: [1, Infinity], classifierTimeoutMs: [100, 60000], classifierMaxOutputTokens: [64, 4096],
}

function findInvalidConfigKeys(value: any): string[] {
  if (!value || typeof value !== 'object') return []
  const bad = new Set<string>()
  for (const key of Object.keys(value)) {
    const v = value[key]
    if (v === undefined || v === null) continue
    const type = INVALID_CONFIG_TYPES[key]
    const okType = !type || (type === 'array' ? Array.isArray(v) : typeof v === type)
    if (!okType) {
      bad.add(key)
      continue
    }
    const enums = INVALID_CONFIG_ENUMS[key]
    if (enums && !enums.includes(v)) {
      bad.add(key)
      continue
    }
    if (type === 'number') {
      const range = INVALID_CONFIG_RANGES[key]
      if (range && (Number(v) < range[0] || Number(v) > range[1])) bad.add(key)
    }
  }
  // reviewerProvider / reviewerModel must be configured together.
  const hasProvider = Object.prototype.hasOwnProperty.call(value, 'reviewerProvider')
  const hasModel = Object.prototype.hasOwnProperty.call(value, 'reviewerModel')
  if (hasProvider !== hasModel) {
    bad.add('reviewerProvider')
    bad.add('reviewerModel')
  }
  return [...bad]
}

function showPanelOptions(): CapsuleOption[] {
  return [
    { value: 'off', label: t('common.off') },

    { value: 'auto', label: t('option.autoOnly') },
    { value: 'on', label: t('common.on') },
  ]
}

function onOffOptions(): CapsuleOption[] {
  return [
    { value: 'on', label: t('common.on') },
    { value: 'off', label: t('common.off') },
  ]
}

function buttonPositionOptions(): CapsuleOption[] {
  return [
    { value: 'header', label: t('option.header') },
    { value: 'floating', label: t('option.floating') },
  ]
}

function timeoutOptions(): CapsuleOption[] {
  return [
    { value: 'reject', label: t('option.reject') },
    { value: 'low-risk-allow', label: t('option.timeout.lowRiskAllow') },
    { value: 'allow', label: t('option.allow') },
  ]
}

function llmReviewOptions(): CapsuleOption[] {
  return [
    { value: 'low-or-above', label: t('option.llmReview.lowOrAbove') },
    { value: 'medium-or-above', label: t('option.llmReview.mediumOrAbove') },
    { value: 'high', label: t('option.llmReview.high') },
  ]
}

function llmTakeoverOptions(): CapsuleOption[] {
  return [
    { value: 'low', label: t('option.llmTakeover.low') },
    { value: 'medium-or-below', label: t('option.llmTakeover.mediumOrBelow') },
    { value: 'high-or-below', label: t('option.llmTakeover.highOrBelow') },
  ]
}

function reviewModeOptions(): CapsuleOption[] {
  return [
    { value: 'manual', label: t('option.mode.manual') },
    { value: 'smart', label: t('option.mode.smart') },
    { value: 'unattended', label: t('option.mode.unattended') },
  ]
}

function protocolOptions(): CapsuleOption[] {
  return [
    { value: 'openai', label: t('option.protocol.openai') },
    { value: 'anthropic', label: t('option.protocol.anthropic') },
  ]
}

const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'

const CHECK_PATH = 'M11.5635 4.58984L7.61426 9.07715C7.35154 9.37561 7.11346 9.64812 6.89453 9.84668C6.66593 10.054 6.38519 10.2506 6.01465 10.3164C5.82079 10.3508 5.62207 10.3529 5.42773 10.3213C5.0561 10.2609 4.77266 10.0674 4.54102 9.86328C4.31926 9.66791 4.07752 9.39911 3.81055 9.10449L2.44531 7.59863L3.55664 6.59082L4.92188 8.09766C5.21256 8.41844 5.38878 8.61191 5.53223 8.73828C5.61022 8.80699 5.65253 8.83192 5.66895 8.83984C5.69648 8.84429 5.72449 8.84467 5.75195 8.83984C5.72657 8.84451 5.75564 8.85422 5.88672 8.73535C6.02833 8.60692 6.20225 8.41088 6.48828 8.08594L10.4385 3.59961L11.5635 4.58984Z'

const CLOSE_PATH = 'M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z'

function CapsuleSelect(props: { value: string; options: CapsuleOption[]; onChange: (value: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<any>(null)
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: any) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: any) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const doc = (globalThis as any).document
    doc.addEventListener('pointerdown', onPointerDown)
    doc.addEventListener('keydown', onKeyDown)
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown)
      doc.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  const current = props.options.find((o) => o.value === props.value)
  const label = current?.label ?? props.options[0]?.label ?? ''
  return React.createElement('span', { ref: rootRef, className: 'dsa-capsuleRoot' },
    React.createElement('button', {
      type: 'button',
      className: 'dsa-capsule',
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => setOpen((o) => !o),
    },
      React.createElement('span', { className: 'dsa-capsuleLabel' }, label),
      React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', className: 'dsa-capsuleChevron' },
        React.createElement('path', { d: CHEVRON_PATH, fill: 'currentColor' }),
      ),
    ),
    open ? React.createElement('div', { className: 'dsa-menu', role: 'menu' },
      props.options.map((opt) => React.createElement('button', {
        key: opt.value,
        type: 'button',
        role: 'menuitem',
        className: opt.value === props.value ? 'dsa-menuItem dsa-menuItemSelected' : 'dsa-menuItem',
        onClick: () => { props.onChange(opt.value); setOpen(false) },
      },
        React.createElement('span', { className: 'dsa-menuLabel' }, opt.label),
        opt.value === props.value
          ? React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', className: 'dsa-menuCheck' },
              React.createElement('path', { d: CHECK_PATH, fill: 'currentColor' }),
            )
          : null,
      )),
    ) : null,
  )
}

function SettingsSection() {
  const [snapshot, setSnapshot] = React.useState<SettingsSnapshot | null>(null)
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [history, setHistory] = React.useState<any[]>([])
  const [llmLatency, setLlmLatency] = React.useState<any>(null)
  const [historyError, setHistoryError] = React.useState('')
  const [testResult, setTestResult] = React.useState('')
  const [credentialConfigured, setCredentialConfigured] = React.useState(false)
  const [credentialWritable, setCredentialWritable] = React.useState(false)
  const [reviewerApiKey, setReviewerApiKey] = React.useState('')
  // Sub-cards are collapsible and start collapsed; their data (history records,
  // reviewer-credential describe) is fetched lazily on first expand.
  const [openTimers, setOpenTimers] = React.useState(false)
  const [openReview, setOpenReview] = React.useState(false)
  const [openSecurity, setOpenSecurity] = React.useState(false)
  const [openHistory, setOpenHistory] = React.useState(false)
  // In-card feedback: the most recent ok/error text for each sub-card, shown
  // inside that card's footer (not piled at the bottom of the plugin body).
  const [cardStatus, setCardStatus] = React.useState<{ id: string; kind: 'ok' | 'err'; text: string } | null>(null)
  // Whether the security card was edited/saved in this session (drives the
  //「未生效」badge; a never-touched card shows no badge).
  const [securityActive, setSecurityActive] = React.useState(false)
  // Restoring defaults must enable Save even when the stored values already
  // equal the defaults; otherwise the "please click save" hint is a dead end.
  const [securityForcedDirty, setSecurityForcedDirty] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [page, setPage] = React.useState(0)
  const PAGE_SIZE = 10

  React.useEffect(() => {
    let disposed = false
    ;(globalThis as any).fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        setSnapshot(data.value)
        setDraft(draftOf(data.value.value))
      })
      .catch((e: any) => {
        if (!disposed) setError(String(e))
      })
    return () => { disposed = true }
  }, [])

  React.useEffect(() => {
    if (!openHistory) return
    let disposed = false
    setHistoryError('')
    ;(globalThis as any).fetch(HISTORY_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        setHistory(data.value.records ?? [])
        setLlmLatency(data.value.llmLatency ?? null)
      })
      .catch((e: any) => {
        if (!disposed) setHistoryError(String(e))
      })
    return () => { disposed = true }
  }, [openHistory])

  const refreshCredential = React.useCallback(() => {
    let disposed = false
    ;(globalThis as any).fetch(REVIEWER_CREDENTIAL_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        setCredentialConfigured(data.value?.configured === true)
        setCredentialWritable(data.value?.writable === true)
      })
      .catch(() => {})
    return () => { disposed = true }
  }, [])

  React.useEffect(() => {
    if (!openReview) return
    return refreshCredential()
  }, [openReview, refreshCredential])

  if (!snapshot || !draft) {
    return React.createElement('div', { style: { padding: 12 } }, t('settings.loading'))
  }

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch })
    if (Object.keys(patch).some((k) => SECURITY_KEYS.includes(k))) setSecurityActive(true)
  }

  // Per-card ownership: saving a card only persists the fields it owns,
  // overlaid on the last-saved baseline; other cards' unsaved edits are left
  // in the local draft and never accidentally persisted by another card.
  const TOP_KEYS = ['enabled', 'autoSwitchPolicyToAsk', 'timeoutAction', 'llmReviewScope', 'llmTakeoverScope', 'defaultReviewMode', 'showSessionPanel', 'aiButtonPosition']
  const TIMER_KEYS = ['breakerAntiHijackMs', 'lowRiskSeconds', 'mediumRiskSeconds', 'highRiskSeconds', 'maxConsecutiveDenials', 'maxTotalDenials']
  const REVIEW_KEYS = ['reviewerProtocol', 'reviewerBaseUrl', 'reviewerModel']
  const SECURITY_KEYS = ['safetyPrompt', 'allowlist', 'denyList', 'humanOnlyList', 'rulesText', 'rulesDryRun']
  const pick = (keys: string[], from: Draft): Partial<Draft> => {
    const out: any = {}
    for (const k of keys) out[k] = (from as any)[k]
    return out
  }
  const sliceValueOf = (keys: string[]): any => valueOf({ ...draftOf(snapshot.value), ...pick(keys, draft) })
  const sliceWith = (key: string, value: any): any => {
    const base = draftOf(snapshot.value) as any
    base[key] = value
    return valueOf(base)
  }
  const cardDirty = (keys: string[]): boolean => {
    const base = draftOf(snapshot.value) as any
    return keys.some((k) => String((draft as any)[k] ?? '') !== String(base[k] ?? ''))
  }
  const timerDirty = cardDirty(TIMER_KEYS)
  const reviewDirty = cardDirty(REVIEW_KEYS) || reviewerApiKey.trim().length > 0
  const securityDirty = cardDirty(SECURITY_KEYS)
  const securityDirtyEff = securityDirty || securityForcedDirty
  const invalidKeys = findInvalidConfigKeys(snapshot.value)
  const configError = (snapshot as any)?.configError ?? null
  const bannerMessage = configError
    ? t('settings.pluginConfigError', { error: String(configError) })
    : invalidKeys.length > 0
      ? t('settings.invalidConfig', { keys: invalidKeys.join(', ') })
      : null
  const anyDirty = timerDirty || reviewDirty || securityDirtyEff

  const broadcastSettings = (saved: any) => {
    breakerAntiHijackMs = saved?.value?.breakerAntiHijackMs ?? THRESHOLD_DEFAULTS.breakerAntiHijackMs
    aiButtonPosition = saved?.value?.aiButtonPosition === 'floating' ? 'floating' : 'header'
    const g = globalThis as any
    if (typeof g.CustomEvent === 'function') {
      g.dispatchEvent(new g.CustomEvent('dsh-auto-approval-llm:settings-changed'))
    }
  }

  // In-card feedback line (shown at the left of the matching card's footer).
  const statusLine = (id: string) =>
    cardStatus && cardStatus.id === id && cardStatus.text
      ? React.createElement('span', {
          className: cardStatus.kind === 'err' ? 'dsa-failed' : 'dsa-success',
          style: { flex: 1 },
          role: 'status',
        }, cardStatus.text)
      : null

  const saveCard = async (keys: string[], cardId: string) => {
    setSaving(true)
    setError('')
    try {
      const res = await (globalThis as any).fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: snapshot.revision, value: sliceValueOf(keys) }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('settings.saveFailed'))
      broadcastSettings(data.value)
      setSnapshot(data.value)
      // Per-card ownership: only the just-saved keys are refreshed from the
      // server baseline; unsaved edits held in other cards' local drafts are
      // preserved instead of being wiped by a full draft replacement.
      setDraft({ ...draft, ...pick(keys, draftOf(data.value.value)) })
      setCardStatus({ id: cardId, kind: 'ok', text: t('settings.saved') })
      if (cardId === 'security') {
        setSecurityActive(true)
        setSecurityForcedDirty(false)
      }
    } catch (e) {
      setCardStatus({ id: cardId, kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const discardCard = (keys: string[], cardId: string) => {
    setDraft({ ...draft, ...pick(keys, draftOf(snapshot.value)) })
    setCardStatus({ id: cardId, kind: 'ok', text: '' })
    if (cardId === 'security') setSecurityForcedDirty(false)
  }

  // Top-level capsule toggles save immediately (original behavior). Only the
  // toggled key is committed on the saved baseline, so unsaved edits inside the
  // other cards are never persisted or lost; the local draft keeps them.
  const instantSaveKey = async (key: string, value: any) => {
    setDraft({ ...draft, [key]: value })
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const res = await (globalThis as any).fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: snapshot.revision, value: sliceWith(key, value) }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('settings.saveFailed'))
      broadcastSettings(data.value)
      setSnapshot(data.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const resetCard = () => {
    setDraft({ ...draft, ...pick(SECURITY_KEYS, draftOf({})) })
    setCardStatus({ id: 'security', kind: 'ok', text: t('settings.defaultsRestored') })
    setSecurityActive(true)
    setSecurityForcedDirty(true)
    setError('')
  }

  const resetTimerCard = () => {
    setDraft({
      ...draft,
      lowRiskSeconds: String(THRESHOLD_DEFAULTS.lowRiskSeconds),
      mediumRiskSeconds: String(THRESHOLD_DEFAULTS.mediumRiskSeconds),
      highRiskSeconds: String(THRESHOLD_DEFAULTS.highRiskSeconds),
      breakerAntiHijackMs: String(THRESHOLD_DEFAULTS.breakerAntiHijackMs),
      maxConsecutiveDenials: String(THRESHOLD_DEFAULTS.maxConsecutiveDenials),
      maxTotalDenials: String(THRESHOLD_DEFAULTS.maxTotalDenials),
    })
  }

  const resetReviewerCard = () => {
    setDraft({ ...draft, reviewerProtocol: 'openai', reviewerBaseUrl: '', reviewerModel: '' })
  }

  const restoreTopDefaults = async () => {
    const base = draftOf(snapshot.value)
    const defaults: Partial<Draft> = { enabled: 'on', autoSwitchPolicyToAsk: 'on', timeoutAction: 'reject', llmReviewScope: 'low-or-above', llmTakeoverScope: 'medium-or-below', defaultReviewMode: 'smart', showSessionPanel: 'off', aiButtonPosition: 'header' }
    const merged = { ...base, ...defaults }
    setDraft({ ...draft, ...defaults })
    setSaving(true); setError(''); setMessage('')
    try {
      const res = await (globalThis as any).fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: snapshot.revision, value: valueOf(merged) }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('settings.saveFailed'))
      broadcastSettings(data.value)
      setSnapshot(data.value)
      setDraft(draftOf(data.value.value))
      setMessage(t('settings.defaultsRestoredInstant'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const testOnline = async () => {
    const baseUrl = draft.reviewerBaseUrl.trim()
    const model = draft.reviewerModel.trim()
    if (!baseUrl || !model) {
      setTestResult(t('test.enterProviderModel'))
      return
    }
    setTestResult(t('test.onlineTesting'))
    try {
      const res = await (globalThis as any).fetch(TEST_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          online: true,
          protocol: draft.reviewerProtocol,
          baseUrl,
          model,
          apiKey: reviewerApiKey.trim(),
        }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('test.failed'))
      setTestResult(t('test.onlineOk'))
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e))
    }
  }

  const saveReviewerCredential = async () => {
    const apiKey = reviewerApiKey.trim()
    if (!apiKey) return
    try {
      const res = await (globalThis as any).fetch(REVIEWER_CREDENTIAL_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('settings.saveFailed'))
      setReviewerApiKey('')
      setCredentialConfigured(true)
      setCardStatus({ id: 'review', kind: 'ok', text: t('settings.reviewer.apiKeySaved') })
    } catch (e) {
      setCardStatus({ id: 'review', kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  const clearReviewerCredential = async () => {
    try {
      // fetch resolves on HTTP errors too; only a verified ok:true response
      // may claim the key was cleared, otherwise the badge would lie while the
      // credential stays live.
      const res = await (globalThis as any).fetch(REVIEWER_CREDENTIAL_ROUTE, { method: 'DELETE', credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json().catch(() => null)
      if (data?.ok !== true) throw new Error(String(data?.error ?? 'credential clear failed'))
      setCredentialConfigured(false)
      setCardStatus({ id: 'review', kind: 'ok', text: t('settings.reviewer.apiKeyCleared') })
    } catch (e) {
      setCardStatus({ id: 'review', kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  const saveReviewCard = async () => {
    await saveCard(REVIEW_KEYS, 'review')
    if (reviewerApiKey.trim()) await saveReviewerCredential()
  }

  const clearHistory = async () => {
    if (!(globalThis as any).confirm?.(t('confirm.clearHistory'))) return
    try {
      // fetch resolves on HTTP errors too; only a verified ok:true response
      // may claim the history was cleared (same discipline as
      // clearReviewerCredential), otherwise the card would lie while the
      // server-side records stay.
      const res = await (globalThis as any).fetch(HISTORY_ROUTE, { method: 'DELETE', credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json().catch(() => null)
      if (data?.ok !== true) throw new Error(String(data?.error ?? 'history clear failed'))
      setHistory([])
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e))
    }
  }

  // Remove stored keys that violate the schema so the defaults recover; POST a
  // sanitized value (missing keys get their schema default on the next read).
  const clearInvalidKeys = async () => {
    if (!snapshot) return
    const bad = findInvalidConfigKeys(snapshot.value)
    if (bad.length === 0) return
    setSaving(true)
    try {
      const sanitized: any = {}
      for (const key of Object.keys(snapshot.value)) {
        if (!bad.includes(key)) sanitized[key] = snapshot.value[key]
      }
      const res = await (globalThis as any).fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: snapshot.revision, value: sanitized }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('settings.saveFailed'))
      broadcastSettings(data.value)
      setSnapshot(data.value)
      setDraft(draftOf(data.value.value))
      setMessage(t('settings.invalidCleared'))
    } catch (e) {
      setMessage('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const filteredHistory = history.filter((r: any) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    const haystack = [r.toolName, r.source, r.outcome, r.llmReason, ...(r.breakerReasons ?? [])].join(' ').toLowerCase()
    return haystack.includes(q)
  })
  const pageCount = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visibleHistory = filteredHistory.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  // Official DSH settings-row pattern: `row` = title+desc block on the left,
  // compact control (capsule/number/input) on the right. Mirrors the native
  // "Agent 预设" row (row / rowText(title+desc) / selector).
  const row = (label: string, control: React.ReactNode, hint?: string, titleBadge?: React.ReactNode) =>
    React.createElement('div', { className: 'dsa-row' },
      React.createElement('div', { className: 'dsa-rowText' },
        React.createElement('div', { className: 'dsa-titleRow' },
          React.createElement('span', { className: 'dsa-title' }, label),
          titleBadge,
        ),
        hint ? React.createElement('div', { className: 'dsa-desc' }, hint) : null,
      ),
      React.createElement('div', { className: 'dsa-control' }, control),
    )

  // Textarea-style field: title block on top, control full width below.
  const field = (label: string, children: React.ReactNode, hint?: string) =>
    React.createElement('div', { className: 'dsa-field' },
      React.createElement('div', { className: 'dsa-title' }, label),
      children,
      hint ? React.createElement('small', { className: 'dsa-desc' }, hint) : null,
    )

  // ── cards ────────────────────────────────────────────────────────────────
  // Four sub-cards inside the plugin card, each with its own save/discard
  // (and, for the safety list, a restore-defaults action). The UI borrows the
  // DSH design tokens (--dsw-alias-*) and the native Button/Input primitives.
  const subcard = (
    title: string, open: boolean, cardDirty: boolean, onToggle: () => void,
    buildBody: () => React.ReactNode, buildFooter?: () => React.ReactNode,
    badge?: React.ReactNode,
  ) =>
    React.createElement('div', { className: 'dsa-subcard' },
      React.createElement('button', {
        type: 'button',
        className: 'dsa-subcardHeader',
        'aria-expanded': open,
        onClick: onToggle,
      },
        React.createElement('span', { className: 'dsa-subcardTitle' }, title),
        badge ?? (cardDirty ? React.createElement('span', { className: 'dsa-pending' }, t('settings.unsaved')) : null),
        React.createElement('span', { className: open ? 'dsa-chevron dsa-chevronOpen' : 'dsa-chevron' },
          React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
            React.createElement('path', { d: CHEVRON_PATH, fill: 'currentColor' }),
          ),
        ),
      ),
      // Lazy: the body (and its costly construction / data fetch) only runs
      // once the card has actually been expanded.
      open ? React.createElement('div', { className: 'dsa-subcardBody' }, buildBody()) : null,
      open && buildFooter ? React.createElement('div', { className: 'dsa-subcardFooter' }, buildFooter()) : null,
    )

  const cardFooter = (keys: string[], cardId: string, cardDirty: boolean, extra?: React.ReactNode): React.ReactNode =>
    React.createElement(React.Fragment, null,
      statusLine(cardId),
      extra,
      React.createElement(Button, {
        variant: 'outline',
        size: 'sm',
        disabled: saving || !snapshot.writable || !cardDirty,
        onClick: () => discardCard(keys, cardId),
      }, t('settings.discard')),
      React.createElement(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: saving || !snapshot.writable || !cardDirty,
        onClick: () => saveCard(keys, cardId),
      }, saving ? t('settings.saving') : t('settings.save')),
    )

  // Top-level toggle rows (not inside a card): instant-save on change.
  const topLevelBody = React.createElement('div', { style: { display: 'grid', gap: 10 } },
    row(t('settings.enable'), React.createElement(CapsuleSelect, {
      value: draft.enabled,
      options: onOffOptions(),
      onChange: (v: string) => { void instantSaveKey('enabled', v as 'on' | 'off') },
    })),
    row(t('settings.autoSwitchPolicyToAsk'), React.createElement(CapsuleSelect, {
      value: draft.autoSwitchPolicyToAsk,
      options: onOffOptions(),
      onChange: (v: string) => { void instantSaveKey('autoSwitchPolicyToAsk', v as 'on' | 'off') },
    })),
    row(t('settings.timeoutAction'), React.createElement(CapsuleSelect, {
      value: draft.timeoutAction,
      options: timeoutOptions(),
      onChange: (v: string) => { void instantSaveKey('timeoutAction', v as string) },
    }), t('settings.timeoutActionHint')),
    row(t('settings.llmReviewScope'), React.createElement(CapsuleSelect, {
      value: draft.llmReviewScope,
      options: llmReviewOptions(),
      onChange: (v: string) => { void instantSaveKey('llmReviewScope', v as any) },
    }), t('settings.llmReviewScopeHint')),
    row(t('settings.llmTakeoverScope'), React.createElement(CapsuleSelect, {
      value: draft.llmTakeoverScope,
      options: llmTakeoverOptions(),
      onChange: (v: string) => { void instantSaveKey('llmTakeoverScope', v as any) },
    }), t('settings.llmTakeoverScopeHint')),
    row(t('settings.defaultReviewMode'), React.createElement(CapsuleSelect, {
      value: draft.defaultReviewMode,
      options: reviewModeOptions(),
      onChange: (v: string) => { void instantSaveKey('defaultReviewMode', v as any) },
    }), t('settings.defaultReviewModeHint')),
    row(t('settings.showSessionPanel'), React.createElement(CapsuleSelect, {
      value: draft.showSessionPanel,
      options: showPanelOptions(),
      onChange: (v: string) => { void instantSaveKey('showSessionPanel', v as any) },
    })),
    draft.showSessionPanel !== 'off' ? row(t('settings.buttonPosition'), React.createElement(CapsuleSelect, {
      value: draft.aiButtonPosition,
      options: buttonPositionOptions(),
      onChange: (v: string) => { void instantSaveKey('aiButtonPosition', v as any) },
    })) : null,
  )

  // Timers & breaker card body (the numeric/dangerous group).
  const buildTimerBody = () => React.createElement('div', { style: { display: 'grid', gap: 10 } },
    row(t('settings.lowRiskSeconds'), React.createElement('input', {
      type: 'number',
      min: 1,
      value: draft.lowRiskSeconds,
      onChange: (e: any) => update({ lowRiskSeconds: e.target.value }),
      className: 'dsa-input',
    })),
    row(t('settings.mediumRiskSeconds'), React.createElement('input', {
      type: 'number',
      min: 1,
      value: draft.mediumRiskSeconds,
      onChange: (e: any) => update({ mediumRiskSeconds: e.target.value }),
      className: 'dsa-input',
    })),
    row(t('settings.highRiskSeconds'), React.createElement('input', {
      type: 'number',
      min: 1,
      value: draft.highRiskSeconds,
      onChange: (e: any) => update({ highRiskSeconds: e.target.value }),
      className: 'dsa-input',
    })),
    row(t('settings.breakerAntiHijackMs'), React.createElement('input', {
      type: 'number',
      min: 0,
      value: draft.breakerAntiHijackMs,
      onChange: (e: any) => update({ breakerAntiHijackMs: e.target.value }),
      className: 'dsa-input',
    }), t('settings.breakerAntiHijackMsHint')),
    row(t('settings.maxConsecutiveDenials'), React.createElement('input', {
      type: 'number',
      min: 0,
      value: draft.maxConsecutiveDenials,
      onChange: (e: any) => update({ maxConsecutiveDenials: e.target.value }),
      className: 'dsa-input',
    })),
    row(t('settings.maxTotalDenials'), React.createElement('input', {
      type: 'number',
      min: 0,
      value: draft.maxTotalDenials,
      onChange: (e: any) => update({ maxTotalDenials: e.target.value }),
      className: 'dsa-input',
    })),
  )

  const buildReviewBody = () => React.createElement('div', { style: { display: 'grid', gap: 10 } },
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.reviewer.description')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.reviewer.fallbackHint')),
    row(t('settings.reviewer.protocol'), React.createElement(CapsuleSelect, {
      value: draft.reviewerProtocol,
      options: protocolOptions(),
      onChange: (v: string) => update({ reviewerProtocol: v }),
    })),
    row(t('settings.reviewer.baseUrl'), React.createElement(Input, {
      value: draft.reviewerBaseUrl,
      onChange: (e: any) => update({ reviewerBaseUrl: e.target.value }),
      placeholder: t('settings.reviewer.baseUrlPlaceholder'),
      className: 'dsa-input',
    })),
    row(t('settings.reviewer.modelName'), React.createElement(Input, {
      value: draft.reviewerModel,
      onChange: (e: any) => update({ reviewerModel: e.target.value }),
      placeholder: t('settings.reviewer.modelNamePlaceholder'),
      className: 'dsa-input',
    })),
    row(t('settings.reviewer.apiKey'),
      React.createElement(Input, {
        type: 'password',
        autoComplete: 'new-password',
        value: reviewerApiKey,
        onChange: (e: any) => setReviewerApiKey(e.target.value),
        placeholder: credentialConfigured
          ? t('settings.reviewer.apiKeyPlaceholderConfigured')
          : t('settings.reviewer.apiKeyPlaceholderMissing'),
        className: 'dsa-input',
      }),
      t('settings.reviewer.apiKeyHint'),
      React.createElement('span', { className: credentialConfigured ? 'dsa-badgeOk' : 'dsa-badgeMuted' },
        credentialConfigured ? t('settings.reviewer.credentialConfigured') : t('settings.reviewer.credentialMissing')),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      React.createElement(Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: testOnline }, t('settings.reviewer.test')),
      credentialConfigured && credentialWritable
        ? React.createElement(Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: clearReviewerCredential }, t('settings.reviewer.clearKey'))
        : null,
      testResult ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, testResult) : null,
    ),
  )

  const buildSecurityBody = () => React.createElement('div', { style: { display: 'grid', gap: 10 } },
    field(t('settings.rules.safetyPrompt'), React.createElement('textarea', {
      value: draft.safetyPrompt,
      onChange: (e: any) => update({ safetyPrompt: e.target.value }),
      rows: 5,
      placeholder: t('settings.rules.safetyPromptPlaceholder'),
      className: 'dsa-textarea',
    })),
    field(t('settings.rules.allowlist'), React.createElement('textarea', {
      value: draft.allowlist,
      onChange: (e: any) => update({ allowlist: e.target.value }),
      rows: 3,
      className: 'dsa-textarea',
    })),
    field(t('settings.rules.denyList'), React.createElement('textarea', {
      value: draft.denyList,
      onChange: (e: any) => update({ denyList: e.target.value }),
      rows: 3,
      className: 'dsa-textarea',
    })),
    field(t('settings.rules.humanOnlyList'), React.createElement('textarea', {
      value: draft.humanOnlyList,
      onChange: (e: any) => update({ humanOnlyList: e.target.value }),
      rows: 3,
      className: 'dsa-textarea',
    })),
    row(t('settings.rules.dryRun'), React.createElement(CapsuleSelect, {
      value: draft.rulesDryRun,
      options: onOffOptions(),
      onChange: (v: any) => update({ rulesDryRun: v as 'on' | 'off' }),
    }), t('settings.rules.dryRunHint')),
    field(t('settings.rules.rulesText'), React.createElement('textarea', {
      value: draft.rulesText,
      onChange: (e: any) => update({ rulesText: e.target.value }),
      rows: 5,
      placeholder: '# Claude 式声明规则（每行一条）\nbash,git(^git\\s+push\\b) | deny | arguments\n(?i)rm\\s+(-[a-z]+\\s+)*/ | human | arguments\nwrite,edit\\(.*://.*\\) | deny | arguments',
      className: 'dsa-textarea dsa-code',
    }), t('settings.rules.rulesTextHint')),
    ...(parseRulesText(draft.rulesText).errors.map((er) => React.createElement('p', {
      key: er.line,
      style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '2px 0 0' },
    }, `L${er.line}: ${er.message}`))),
  )

  const buildHistoryBody = () => React.createElement('div', { style: { display: 'grid', gap: 8 } },
    historyError ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: 0 } }, historyError) : null,
    llmLatency === null || (llmLatency.count ?? 0) === 0
      ? React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0' } },
          React.createElement('span', null, t('settings.history.llmLatencyEmpty')),
        )
      : React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0', flexWrap: 'wrap' } },
          React.createElement('span', null, t('settings.history.llmLatency', {
            count: String(llmLatency.count),
            min: formatLatencySeconds(llmLatency.minMs),
            avg: formatLatencySeconds(llmLatency.avgMs),
            max: formatLatencySeconds(llmLatency.maxMs),
            aborted: String(llmLatency.abortedCount ?? 0),
          })),
        ),
    React.createElement('input', {
      placeholder: t('settings.history.searchPlaceholder'),
      value: search,
      onChange: (e: any) => { setSearch(e.target.value); setPage(0) },
      className: 'dsa-input',
    }),
    filteredHistory.length === 0
      ? React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 } }, t('settings.history.empty'))
      : React.createElement('div', { style: { display: 'grid', gap: 4 } },
          visibleHistory.map((r: any) => React.createElement('div', {
            key: r.id,
            style: {
              padding: '6px 8px',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              fontSize: 12,
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
            React.createElement('div', null,
              t('record.line', { time: formatShortDateTime(r.at), toolName: r.toolName, source: r.source, outcome: r.outcome }) +
              (r.llmReason ? ` — ${r.llmReason}` : '') +
              (r.breaker ? ' ' + t('record.breaker') : ''),
            ),
            r.breakerReasons?.length ? React.createElement('div', { style: { marginTop: 4, color: 'var(--dsw-alias-state-warn-primary)', whiteSpace: 'pre-line' } },
              r.breakerReasons.map((reason: string, i: number) => React.createElement('div', { key: i }, reason)),
            ) : null,
          )),
        ),
    filteredHistory.length > 0 ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' } },
      React.createElement('button', {
        type: 'button',
        disabled: safePage === 0,
        onClick: () => setPage(0),
        className: 'dsa-btn dsa-pageBtn',
        title: t('settings.history.first'),
      }, t('settings.history.first')),
      React.createElement('button', {
        type: 'button',
        disabled: safePage === 0,
        onClick: () => setPage(Math.max(0, safePage - 1)),
        className: 'dsa-btn dsa-pageBtn',
        title: t('settings.history.previous'),
      }, React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', style: { transform: 'rotate(90deg)', display: 'block' } },
        React.createElement('path', { d: CHEVRON_PATH, fill: 'currentColor' }),
      )),
      React.createElement('span', { style: { fontSize: 12, minWidth: 48, textAlign: 'center' } }, `${safePage + 1} / ${pageCount}`),
      React.createElement('button', {
        type: 'button',
        disabled: safePage >= pageCount - 1,
        onClick: () => setPage(Math.min(pageCount - 1, safePage + 1)),
        className: 'dsa-btn dsa-pageBtn',
        title: t('settings.history.next'),
      }, React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', style: { transform: 'rotate(-90deg)', display: 'block' } },
        React.createElement('path', { d: CHEVRON_PATH, fill: 'currentColor' }),
      )),
      React.createElement('button', {
        type: 'button',
        disabled: safePage >= pageCount - 1,
        onClick: () => setPage(pageCount - 1),
        className: 'dsa-btn dsa-pageBtn',
        title: t('settings.history.last'),
      }, t('settings.history.last')),
    ) : null,
  )

  const buildReviewFooter = () => React.createElement(React.Fragment, null,
    statusLine('review'),
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: saving || !snapshot.writable,
      onClick: resetReviewerCard,
    }, t('settings.reset')),
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: saving || !snapshot.writable || !reviewDirty,
      onClick: () => discardCard(REVIEW_KEYS, 'review'),
    }, t('settings.discard')),
    React.createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: saving || !snapshot.writable || !reviewDirty,
      onClick: saveReviewCard,
    }, saving ? t('settings.saving') : t('settings.save')),
  )

  const buildSecurityFooter = () => React.createElement(React.Fragment, null,
    statusLine('security'),
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: saving || !snapshot.writable,
      onClick: resetCard,
    }, t('settings.reset')),
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: saving || !snapshot.writable || !securityDirtyEff,
      onClick: () => discardCard(SECURITY_KEYS, 'security'),
    }, t('settings.discard')),
    React.createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: saving || !snapshot.writable || !securityDirtyEff,
      onClick: () => saveCard(SECURITY_KEYS, 'security'),
    }, saving ? t('settings.saving') : t('settings.save')),
  )

  const buildHistoryFooter = () => React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: history.length === 0,
      onClick: clearHistory,
    }, t('settings.history.clear')),
  )

  const buildTimerFooter = () => React.createElement(React.Fragment, null,
    statusLine('timers'),
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: saving || !snapshot.writable,
      onClick: resetTimerCard,
    }, t('settings.reset')),
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: saving || !snapshot.writable || !timerDirty,
      onClick: () => discardCard(TIMER_KEYS, 'timers'),
    }, t('settings.discard')),
    React.createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: saving || !snapshot.writable || !timerDirty,
      onClick: () => saveCard(TIMER_KEYS, 'timers'),
    }, saving ? t('settings.saving') : t('settings.save')),
  )

  const content = React.createElement('div', { style: { display: 'grid', gap: 14, maxWidth: 720, padding: '0 2px' } },
    bannerMessage
      ? React.createElement('div', { className: 'dsa-alert dsa-alertError', role: 'alert' },
          React.createElement('span', { className: 'dsa-alertText' }, bannerMessage),
          React.createElement(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: saving,
            onClick: () => { void clearInvalidKeys() },
          }, t('settings.clearInvalid')),
        )
      : null,
    draft.debug === 'on'
      ? React.createElement('div', { className: 'dsa-alert dsa-alertError', role: 'alert' },
          React.createElement('span', { className: 'dsa-alertText' }, t('settings.debugBanner')),
          React.createElement(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: saving,
            onClick: () => { void instantSaveKey('debug', 'off') },
          }, t('settings.debugOff')),
        )
      : null,
    topLevelBody,
    subcard(t('settings.timers.title'), openTimers, timerDirty, () => setOpenTimers((o) => !o), buildTimerBody, buildTimerFooter),
    subcard(t('settings.reviewer.title'), openReview, reviewDirty, () => setOpenReview((o) => !o), buildReviewBody, buildReviewFooter),
    subcard(t('settings.rules.title'), openSecurity, securityDirtyEff, () => setOpenSecurity((o) => !o), buildSecurityBody, buildSecurityFooter,
      securityDirtyEff
        ? React.createElement('span', { className: 'dsa-pending' }, t('settings.unsaved'))
        : securityActive
          ? React.createElement('span', { className: 'dsa-pending', title: t('settings.notYetEffectiveHint') }, t('settings.notYetEffective'))
          : null),
    subcard(t('settings.history.title'), openHistory, false, () => setOpenHistory((o) => !o), buildHistoryBody, buildHistoryFooter),
    React.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: 4 } },
      row(t('settings.debug'), React.createElement(CapsuleSelect, {
        value: draft.debug,
        options: onOffOptions(),
        onChange: (v: string) => { void instantSaveKey('debug', v as 'on' | 'off') },
      }), t('settings.debugHint')),
    ),
    React.createElement('div', { className: 'dsa-subcardFooter', style: { borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: 4 } },
      message ? React.createElement('span', { className: 'dsa-success', role: 'status', style: { flex: 1 } }, message) : null,
      React.createElement(Button, {
        variant: 'outline',
        size: 'sm',
        className: 'dsa-resetButton',
        disabled: saving || !snapshot.writable,
        onClick: restoreTopDefaults,
      }, t('settings.reset')),
    ),
    snapshot.applies === 'restart' ? React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 } }, t('settings.restartHint')) : null,
    error ? React.createElement('p', { className: 'dsa-failed', role: 'status' }, error) : null,
  );
  return React.createElement('li', { className: open ? 'dsa-card dsa-cardOpen' : 'dsa-card' },
    React.createElement('button', {
      type: 'button',
      className: 'dsa-header',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    },
      React.createElement('span', { className: 'dsa-headText' },
        React.createElement('span', { className: 'dsa-name' }, t('plugin.name')),
        React.createElement('span', { className: 'dsa-description' }, t('plugin.description')),
      ),
      anyDirty ? React.createElement('span', { className: 'dsa-pending' }, t('settings.unsaved')) : null,
      React.createElement('span', { className: open ? 'dsa-chevron dsa-chevronOpen' : 'dsa-chevron' },
        React.createElement('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 14 14',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
        }, React.createElement('path', {
          d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
          fill: 'currentColor',
        }),
      ),
    ),
  ),
  open ? React.createElement('div', { className: 'dsa-body' }, content) : null,
  )
}


function SessionApprovalPanel(props: any) {
  const [open, setOpen] = React.useState(false)
  const [records, setRecords] = React.useState<any[]>([])
  const [panelMode, setPanelMode] = React.useState<'on' | 'auto' | 'off'>('off')
  const [buttonPosition, setButtonPosition] = React.useState<'header' | 'floating'>('header')
  const [sessionMode, setSessionMode] = React.useState<string | undefined>()
  const sessionId = props.sessionId
  const rootRef = React.useRef<any>(null)

  React.useEffect(() => {
    let disposed = false
    ;(globalThis as any).fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        setPanelMode(normalizeShowSessionPanel(data.value.value?.showSessionPanel ?? 'off'))
        setButtonPosition(data.value.value?.aiButtonPosition === 'floating' ? 'floating' : 'header')
      })
      .catch(() => {})
    return () => { disposed = true }
  }, [])

  React.useEffect(() => {
    const g = globalThis as any
    const onSettingsChanged = () => {
      g.fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
        .then((r: any) => r.json())
        .then((data: any) => {
          if (!data?.ok) return
          setPanelMode(normalizeShowSessionPanel(data.value.value?.showSessionPanel ?? 'off'))
          setButtonPosition(data.value.value?.aiButtonPosition === 'floating' ? 'floating' : 'header')
        })
        .catch(() => {})
    }
    g.addEventListener?.('dsh-auto-approval-llm:settings-changed', onSettingsChanged)
    return () => g.removeEventListener?.('dsh-auto-approval-llm:settings-changed', onSettingsChanged)
  }, [])

  React.useEffect(() => {
    if (!sessionId) return
    let disposed = false
    ;(globalThis as any).fetch(`${SESSION_MODE_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        setSessionMode(data.value.mode)
      })
      .catch(() => {})
    return () => { disposed = true }
  }, [sessionId])

  React.useEffect(() => {
    const g = globalThis as any
    const onSessionChanged = () => {
      if (!sessionId) return
      g.fetch(`${SESSION_MODE_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
        .then((r: any) => r.json())
        .then((data: any) => {
          if (data?.ok) setSessionMode(data.value.mode)
        })
        .catch(() => {})
    }
    g.addEventListener?.('dsh-auto-approval-llm:session-changed', onSessionChanged)
    return () => g.removeEventListener?.('dsh-auto-approval-llm:session-changed', onSessionChanged)
  }, [sessionId])

  React.useEffect(() => {
    return watchSettingsOverlay((isOpen) => { if (isOpen) setOpen(false) })
  }, [])

  React.useEffect(() => {
    if (!open) return
    let disposed = false
    ;(globalThis as any).fetch(HISTORY_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        const all = data.value.records ?? []
        setRecords(all.filter((r: any) => r.sessionId === sessionId).slice(0, 50))
      })
      .catch(() => {})
    return () => { disposed = true }
  }, [open, sessionId])

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (e: any) => {
      if (!rootRef.current || !rootRef.current.contains(e.target)) setOpen(false)
    }
    const doc = (globalThis as any).document
    doc?.addEventListener?.('mousedown', onPointerDown)
    return () => doc?.removeEventListener?.('mousedown', onPointerDown)
  }, [open])

  if (buttonPosition !== 'header') return null
  if (panelMode === 'off') return null
  if (panelMode === 'auto' && sessionMode !== 'auto') return null

  const total = records.length
  const allow = records.filter((r: any) => r.outcome === 'allowed-once').length
  const deny = records.filter((r: any) => r.outcome === 'rejected').length
  const timeout = records.filter((r: any) => (r.source ?? '').startsWith('timeout')).length
  const breaker = records.filter((r: any) => r.breaker).length

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 64,
    right: 20,
    zIndex: 1000,
    width: 360,
    maxHeight: 480,
    overflow: 'auto',
    padding: 14,
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 14,
    background: 'var(--dsw-alias-bg-layer-1)',
    boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,0.12))',
    display: 'grid',
    gap: 8,
    fontSize: 12,
  }

  return React.createElement('div', { style: { display: 'contents' }, ref: rootRef },
    React.createElement('button', {
      type: 'button',
      className: 'dsa-sessionButton',
      onClick: () => setOpen(!open),
    }, React.createElement('span', null, t('panel.button'))),
    open ? React.createElement('div', { style: overlayStyle },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 14 } }, t('panel.title')),
        React.createElement('button', {
          type: 'button',
          className: 'dsa-closeBtn',
          onClick: () => setOpen(false),
          'aria-label': t('panel.close'),
          title: t('panel.close'),
        }, React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
          React.createElement('path', { d: CLOSE_PATH, fill: 'currentColor' }),
        )),
      ),
      React.createElement('div', null, t('panel.stats', { total, allow, deny, timeout, breaker })),
      records.length === 0
        ? React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', margin: 0 } }, t('panel.empty'))
        : React.createElement('div', { style: { display: 'grid', gap: 4 } },
            records.slice(0, MAX_PANEL_RECORDS).map((r: any) => React.createElement('div', {
              key: r.id,
              className: 'dsa-recordClamp',
              style: { padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' },
            },
              t('record.line', { time: formatShortDateTime(r.at), toolName: r.toolName, source: r.source, outcome: r.outcome }) +
              (r.llmReason ? ` — ${r.llmReason}` : '') +
              (r.breaker ? ' ' + t('record.breaker') : ''),
            )),
            total > MAX_PANEL_RECORDS
              ? React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, margin: 0, textAlign: 'center' } }, t('panel.more'))
              : null,
          ),
    ) : null,
  )
}

function watchSettingsOverlay(onChange: (open: boolean) => void): () => void {
  const g = globalThis as any
  const doc = g.document
  if (!doc || !g.MutationObserver) return () => {}
  const check = () => {
    const overlay = doc.querySelector('.VOzbGW_overlay')
    onChange(!!overlay)
  }
  const observer = new g.MutationObserver(check)
  observer.observe(doc.body, { childList: true, subtree: true })
  check()
  return () => observer.disconnect()
}

function installFloatingApprovalButton(ctx: any): () => void {
  const g = globalThis as any
  if (!g.document) return () => {}
  const doc = g.document
  let panelMode: 'on' | 'auto' | 'off' = 'off'
  let buttonPosition: 'header' | 'floating' = 'header'
  let sessionMode: string | undefined
  let currentSessionId: string | undefined
  let open = false
  let settingsOpen = false

  const btn = doc.createElement('button')
  btn.className = 'dsa-sessionButton'
  btn.textContent = t('panel.button')
  Object.assign(btn.style, {
    position: 'fixed',
    top: '64px',
    right: '20px',
    zIndex: 1000,
  })
  btn.style.display = 'none'
  doc.body.appendChild(btn)

  const popup = doc.createElement('div')
  Object.assign(popup.style, {
    position: 'fixed',
    top: '104px',
    right: '20px',
    zIndex: 1000,
    width: '360px',
    maxHeight: '480px',
    overflow: 'auto',
    padding: '14px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '14px',
    background: 'var(--dsw-alias-bg-layer-1)',
    boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,0.12))',
    display: 'none',
    fontSize: '12px',
  })
  doc.body.appendChild(popup)

  const stopWatchOverlay = watchSettingsOverlay((isOpen) => {
    settingsOpen = isOpen
    if (isOpen) {
      open = false
      popup.style.display = 'none'
      btn.style.display = 'none'
    } else {
      void update()
    }
  })

  const onDocPointerDown = (e: any) => {
    if (!open || settingsOpen) return
    if (btn.contains(e.target) || popup.contains(e.target)) return
    open = false
    popup.style.display = 'none'
  }
  doc.addEventListener('mousedown', onDocPointerDown)

  const renderPopup = async () => {
    let records: any[] = []
    try {
      const res = await g.fetch(HISTORY_ROUTE, { credentials: 'same-origin' })
      const data = await res.json()
      if (data?.ok) records = (data.value.records ?? []).filter((r: any) => r.sessionId === currentSessionId).slice(0, 50)
    } catch {}
    const total = records.length
    const allow = records.filter((r: any) => r.outcome === 'allowed-once').length
    const deny = records.filter((r: any) => r.outcome === 'rejected').length
    const timeout = records.filter((r: any) => (r.source ?? '').startsWith('timeout')).length
    const breaker = records.filter((r: any) => r.breaker).length
    popup.innerHTML = ''
    const header = doc.createElement('div')
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px'
    const title = doc.createElement('div')
    title.textContent = t('panel.title')
    title.style.fontWeight = '600'
    title.style.fontSize = '14px'
    const closeBtn = doc.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'dsa-closeBtn'
    closeBtn.setAttribute('aria-label', t('panel.close'))
    closeBtn.title = t('panel.close')
    closeBtn.addEventListener('click', () => {
      open = false
      popup.style.display = 'none'
    })
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="' + CLOSE_PATH + '" fill="currentColor"/></svg>'
    header.appendChild(title)
    header.appendChild(closeBtn)
    popup.appendChild(header)
    const stats = doc.createElement('div')
    stats.textContent = t('panel.stats', { total, allow, deny, timeout, breaker })
    popup.appendChild(stats)
    if (records.length === 0) {
      const p = doc.createElement('p')
      p.textContent = t('panel.empty')
      p.style.color = 'var(--dsw-alias-label-tertiary)'
      popup.appendChild(p)
    } else {
      for (const r of records.slice(0, MAX_PANEL_RECORDS)) {
        const d = doc.createElement('div')
        d.className = 'dsa-recordClamp'
        d.style.cssText = 'padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin-top:4px'
        d.textContent = t('record.line', { time: formatShortDateTime(r.at), toolName: r.toolName, source: r.source, outcome: r.outcome }) +
          (r.llmReason ? ` — ${r.llmReason}` : '') +
          (r.breaker ? ' ' + t('record.breaker') : '')
        popup.appendChild(d)
      }
      if (total > MAX_PANEL_RECORDS) {
        const more = doc.createElement('p')
        more.textContent = t('panel.more')
        more.style.cssText = 'color:var(--dsw-alias-label-tertiary);font-size:11px;margin:4px 0 0;text-align:center'
        popup.appendChild(more)
      }
    }
  }

  const unsubscribeLocale = ctx?.get?.('locale')?.subscribe?.(() => {
    btn.textContent = t('panel.button')
    if (open) void renderPopup()
  })
  btn.textContent = t('panel.button')

  async function update() {
    if (settingsOpen) {
      btn.style.display = 'none'
      popup.style.display = 'none'
      open = false
      return
    }
    const list = sessionsRef?.list?.getSnapshot?.()
    currentSessionId = list?.current
    if (currentSessionId) {
      try {
        const res = await g.fetch(`${SESSION_MODE_ROUTE}?sessionId=${encodeURIComponent(currentSessionId)}`, { credentials: 'same-origin' })
        const data = await res.json()
        sessionMode = data?.ok ? data.value.mode : undefined
      } catch {
        sessionMode = undefined
      }
    } else {
      sessionMode = undefined
    }
    const visible = buttonPosition === 'floating' && panelMode !== 'off' && (panelMode === 'on' || sessionMode === 'auto')
    btn.style.display = visible ? '' : 'none'
    if (!visible) {
      popup.style.display = 'none'
      open = false
    } else if (open) {
      await renderPopup()
    }
  }

  btn.addEventListener('click', async () => {
    open = !open
    popup.style.display = open ? '' : 'none'
    if (open) await renderPopup()
  })

  g.fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
    .then((r: any) => r.json())
    .then((data: any) => {
      if (data?.ok) {
        panelMode = normalizeShowSessionPanel(data.value.value?.showSessionPanel ?? 'off')
        buttonPosition = data.value.value?.aiButtonPosition === 'floating' ? 'floating' : 'header'
      }
      void update()
    })
    .catch(() => {})

  const onSettingsChanged = () => {
    g.fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (data?.ok) {
          panelMode = normalizeShowSessionPanel(data.value.value?.showSessionPanel ?? 'off')
          buttonPosition = data.value.value?.aiButtonPosition === 'floating' ? 'floating' : 'header'
        }
        void update()
      })
      .catch(() => {})
  }
  g.addEventListener?.('dsh-auto-approval-llm:settings-changed', onSettingsChanged)

  let unsub: any
  if (sessionsRef?.list?.subscribe) {
    unsub = sessionsRef.list.subscribe(() => { void update() })
  }
  void update()

  return () => {
    if (unsub) unsub()
    unsubscribeLocale?.()
    stopWatchOverlay()
    doc.removeEventListener?.('mousedown', onDocPointerDown)
    g.removeEventListener?.('dsh-auto-approval-llm:settings-changed', onSettingsChanged)
    btn.remove()
    popup.remove()
  }
}

function installSettingsCardStyles(): () => void {
  const g = globalThis as any
  if (!g.document) return () => {}
  const id = 'dsh-auto-approval-llm-settings-card'
  if (g.document.querySelector(`style[data-plugin-css="${id}"]`)) return () => {}
  const style = g.document.createElement('style')
  style.dataset.plugin = 'dsh-auto-approval-llm'
  style.dataset.pluginCss = id
  style.textContent = `
.dsa-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsa-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsa-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsa-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsa-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsa-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsa-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dsa-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dsa-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dsa-chevronOpen{transform:rotate(180deg)}
.dsa-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px}
.dsa-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dsa-field+.dsa-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dsa-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dsa-input,.dsa-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.dsa-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.5;resize:vertical}
.dsa-code{font-family:var(--ds-font-family-code, monospace)}
.dsa-input:focus-visible,.dsa-select:focus-visible,.dsa-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsa-input:disabled,.dsa-select:disabled,.dsa-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dsa-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dsa-success{min-width:0;color:var(--dsw-alias-state-success-primary);flex:1;margin:0;font-size:12px;line-height:1.5}
.dsa-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dsa-save,.dsa-discard{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsa-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dsa-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsa-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsa-discard:disabled,.dsa-save:disabled{opacity:.4;cursor:default}
.dsa-discard:focus-visible,.dsa-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsa-btn{appearance:none;font:inherit;cursor:pointer;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;font-size:12px;line-height:1.5}
.dsa-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}
.dsa-btn:disabled{opacity:.4;cursor:default}
.dsa-pageBtn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;padding:4px 6px}
.dsa-pageBtn svg{display:block}
.dsa-recordClamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsa-closeBtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsa-closeBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsa-closeBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsa-sessionButton{border:1px solid var(--dsw-alias-border-l2);min-width:111px;height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex}
.dsa-sessionButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsa-sessionButton:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dsa-sessionButton span{flex:none;white-space:nowrap}
.dsa-capsuleRoot{position:relative;display:inline-flex}
.dsa-capsule{appearance:none;border:none;background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}
.dsa-capsule:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsa-capsule:disabled{cursor:default}
.dsa-capsuleLabel{white-space:nowrap}
.dsa-capsuleChevron{flex:none}
.dsa-menu{box-sizing:border-box;padding:4px;display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);position:absolute;top:calc(100% + 4px);left:auto;right:0;z-index:100;min-width:218px;max-width:360px}
.dsa-menuItem{appearance:none;display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);text-align:left;font:inherit}
.dsa-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsa-menuItem:disabled{cursor:default;color:var(--dsw-alias-label-dimmed)}
.dsa-menuLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-menuCheck{flex:none;color:var(--dsw-alias-label-primary)}
.dsa-fieldRow{flex-direction:row;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;flex-wrap:wrap}
.dsa-fieldRow .dsa-label{flex:1;min-width:0}
.dsa-fieldRow .dsa-hint{flex-basis:100%;margin:0}
.dsa-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dsa-nestedCard{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden}
.dsa-nestedHeader{appearance:none;display:flex;align-items:center;gap:8px;width:100%;padding:14px 16px;background:0 0;border:0;cursor:pointer;font:inherit;color:inherit;text-align:left}
.dsa-nestedHeader:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-nestedTitle{flex:1;min-width:0;font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary)}
.dsa-nestedBody{display:grid;gap:12px;padding:0 16px 14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-subcard{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden}
.dsa-subcardHeader{appearance:none;display:flex;align-items:center;gap:8px;width:100%;padding:14px 16px;background:var(--dsw-alias-bg-layer-2);border:0;cursor:pointer;font:inherit;color:inherit;text-align:left}
.dsa-subcardHeader:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-subcardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsa-subcardTitle{flex:1;min-width:0;font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary)}
.dsa-subcardBody{display:grid;gap:12px;padding:4px 16px 14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-subcardFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-badgeOk,.dsa-badgeMuted{white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;border:1px solid var(--dsw-alias-border-l1);flex:none}
.dsa-badgeOk{color:var(--dsw-alias-state-success-primary);background:rgba(var(--dsw-alias-state-success-rgb,0),0.08)}
.dsa-badgeMuted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}
.dsa-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0}
.dsa-row+.dsa-row{border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-rowText{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.dsa-titleRow{display:flex;align-items:center;gap:8px;min-width:0}
.dsa-titleRow .dsa-title{flex:none}
.dsa-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dsa-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.dsa-control{flex:none;display:flex;align-items:center;gap:8px}
.dsa-control .dsa-input{width:240px;min-width:0}
.dsa-alert{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.5}
.dsa-alertError{color:var(--dsw-alias-state-error-primary);background:rgba(var(--dsw-alias-state-error-primary,229 72 77),0.08);border:1px solid var(--dsw-alias-state-error-primary)}
.dsa-alertText{flex:1;min-width:0;overflow-wrap:anywhere}
.dsa-resetButton{border-radius:8px!important;height:auto!important;padding:5px 14px!important}
`
  g.document.head.appendChild(style)
  return () => { style.remove() }
}

export function apply(ctx: any): void {
  sessionsRef = ctx.get('sessions')
  const locale = ctx.get('locale')
  if (locale) {
    const disposeLocale = locale.register(LOCALE_NS, { zh, en })
    t = locale.bind(LOCALE_NS)
    ctx.effect(() => disposeLocale, 'dsh-auto-approval-llm: locale')
  }
  ;(globalThis as any).fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
    .then((r: any) => r.json())
    .then((data: any) => {
      if (data?.ok) {
        breakerAntiHijackMs = data.value.value?.breakerAntiHijackMs ?? THRESHOLD_DEFAULTS.breakerAntiHijackMs
        aiButtonPosition = data.value.value?.aiButtonPosition === 'floating' ? 'floating' : 'header'
      }
    })
    .catch(() => {})
  ctx.effect(() => hijackApprovalButtons(), 'dsh-auto-approval-llm: button hijack')
  ctx.effect(() => installAutoPermissionIcon((globalThis as any).document), 'dsh-auto-approval-llm: auto permission icon')
  ctx.effect(() => installFloatingApprovalButton(ctx), 'dsh-auto-approval-llm: floating button')
  ctx.effect(installSettingsCardStyles, 'dsh-auto-approval-llm: settings card styles')
  watchApprovals(ctx)
  watchSessionModeChanges(ctx)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'auto-approval-llm-card',
    key: 'auto-approval-llm',
    order: 30,
    label: () => t('plugin.name'),
    locale: LOCALE_NS,
  }, SettingsSection))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'auto-approval-llm-session-panel',
    order: -10,
    label: () => t('plugin.name'),
    locale: LOCALE_NS,
  }, SessionApprovalPanel))
}
