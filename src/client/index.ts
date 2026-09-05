import React from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { normalizeTimeoutAction, hasBreakerNote, REVIEWER_SYSTEM, assembleReviewerSystem } from '../auto/decision.js'
import { THRESHOLD_DEFAULTS, DEFAULT_ALLOW_TOOL_GROUPS } from '../auto/constants.js'
import { parseRulesText } from '../auto/rules.js'
import { installAutoPermissionIcon } from './auto-icon.js'
import { zh, en } from './locale.js'
import { computeTextNodeRewrites, createBreakerGuard, formatCountdownSuffix, isLinkDown, parseCountdown } from './approvals/shared.js'
import type { CountdownInfo } from './approvals/shared.js'
import { watchRemoteApprovals } from './approvals/remote.js'
import { buildToolChips, applyChipToList, type ToolChip, type ToolStatsPayload, type ToolStatsEntry } from './tool-chips.js'

export const name = 'dsh-auto-approval-llm'
export const inject = ['slots', 'sessions']

const SETTINGS_ROUTE = '/_dsh/auto-approval-llm/settings'
const HISTORY_ROUTE = '/_dsh/auto-approval-llm/history'
const TOOL_STATS_ROUTE = '/_dsh/auto-approval-llm/tool-stats'
const TEST_ROUTE = '/_dsh/auto-approval-llm/test'
const REVIEWER_CREDENTIAL_ROUTE = '/_dsh/auto-approval-llm/reviewer-credential'
const LEARNING_STORE_ROUTE = '/_dsh/auto-approval-llm/learning-store'
const SESSION_MODE_ROUTE = '/_dsh/auto-approval-llm/session-mode'
const PROVIDERS_ROUTE = '/_dsh/auto-approval-llm/providers'
const LLM_MODELS_ROUTE = '/_dsh/auto-approval-llm/llm-models'
const REASONING_EFFORTS_ROUTE = '/_dsh/auto-approval-llm/reasoning-efforts'
let sessionsRef: any
let breakerAntiHijackMs = THRESHOLD_DEFAULTS.breakerAntiHijackMs
let aiButtonPosition: 'header' | 'floating' = 'header'
const MAX_PANEL_RECORDS = 10
const LOCALE_NS = 'dsh-auto-approval-llm'
// First-use onboarding is one-shot per browser (and per page lifetime after
// the settings card was expanded once): weak guarantee by design — incognito
// or a different browser may see it again, which is acceptable for
// low-sensitivity copy.
const ONBOARDING_SEEN_KEY = 'dsa-onboarding-seen-v1'
let localeService: any = null
let t: any = (key: string, params?: Record<string, unknown>) => {
  let text = (zh as any)[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v))
  return text
}

// Label of the live timeout action for the onboarding copy. The template
// placeholders sit in the locale dictionaries ({timeout}); this mapping picks
// the right language via the active locale snapshot, and it always reads the
// CURRENT setting instead of hardcoding "reject".
function timeoutActionLabel(action: string): string {
  let en = false
  try { en = localeService?.getSnapshot?.()?.active === 'en' } catch { en = false }
  switch (action) {
    case 'allow': return en ? 'auto-allow' : '自动放行'
    case 'low-risk-allow': return en ? 'low-risk auto-allow' : '仅低风险放行'
    default: return en ? 'reject' : '拒绝'
  }
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
  // Breaker anti-hijack guard, held in the shared core factory so the
  // re-arm/restore logic is unit-testable against the compiled lib. The
  // window read is live: 0 (default) makes the guard a complete no-op.
  const breaker = createBreakerGuard(() => breakerAntiHijackMs)

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
    // Frozen display while the wire is down (断线暂停倒计时): capture the
    // last-known remaining once and stop walking the local deadline — the
    // deadline goes stale offline and walking it would show a number we can
    // no longer confirm. Reconnect resumes the normal walk; a stale deadline
    // then expires immediately and restores clean text. Observed behavior at
    // this stage: disconnect unmounts the official panel outright and resume
    // does not bring it back, so the frozen display only surfaces when a
    // panel outlives the outage. Render only: the poller owns answers and is
    // untouched, and the host timer never pauses.
    let frozen: number | undefined
    const renderSuffix = (remaining: number, offline: boolean) => {
      const suffix = formatCountdownSuffix(remaining, offline)
      // Only the button that will auto-execute on timeout carries the
      // countdown; the other button stays clean.
      if (info.action === 'allow') {
        if (allow) allow.textContent = `${originalText(allow)}${suffix}`
      } else if (reject) {
        reject.textContent = `${originalText(reject)}${suffix}`
      }
    }
    const apply = () => {
      if (isLinkDown()) {
        if (frozen === undefined) frozen = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        renderSuffix(frozen, true)
        return
      }
      frozen = undefined
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      renderSuffix(remaining, false)
      if (remaining <= 0) {
        // Expired: stop ticking but KEEP the key registered so a later scan
        // cannot re-arm this panel with the marker's static seconds — the
        // countdown restarted at its full value on every DOM mutation before
        // (R008). The live-keys sweep in scan() releases the key when the
        // panel actually leaves the DOM. Restore the clean button text so the
        // stale "（0s）" suffix does not linger on a panel the host already
        // resolved.
        if (info.action === 'allow' && allow) allow.textContent = originalText(allow)
        else if (reject) reject.textContent = originalText(reject)
        clearInterval(interval)
      }
    }
    interval = setInterval(apply, 200)
    intervals.set(key, interval)
    apply()
  }

  const enablePreLine = (panel: any) => {
    const leaves: any[] = Array.from(panel.querySelectorAll('div')).filter((el: any) =>
      el.children.length === 0 && /评审建议|dsh-auto-approval-llm|auto-mode approval|超时未响应/.test(el.textContent ?? ''),
    )
    for (const el of leaves) el.style.whiteSpace = 'pre-line'
  }

  // ── edit-diff preview ────────────────────────────────────────────────────
  // The host appends a marked line-prefixed block ("[dsh-edit-diff]…[/dsh-edit-diff]")
  // to the ask reason of edit-class approvals. The block is parsed from the
  // panel's plain text and re-rendered as a colored line diff; the raw block
  // text is then removed from the panel so it never double-displays.
  const DIFF_START = '[dsh-edit-diff]'
  const DIFF_END = '[/dsh-edit-diff]'

  const extractDiffBlock = (text: string): { header: string; lines: { kind: string; text: string }[] } | null => {
    const start = text.indexOf(DIFF_START)
    if (start === -1) return null
    const end = text.indexOf(DIFF_END, start)
    if (end === -1) return null
    const body = text.slice(start + DIFF_START.length, end).replace(/^\n/, '')
    const [header = '', ...rawLines] = body.split('\n')
    const lines: { kind: string; text: string }[] = []
    for (const raw of rawLines) {
      if (raw.startsWith('- ')) lines.push({ kind: 'del', text: raw.slice(2) })
      else if (raw.startsWith('+ ')) lines.push({ kind: 'add', text: raw.slice(2) })
      else if (raw.startsWith('· ')) lines.push({ kind: 'ctx', text: raw.slice(2) })
      // Unknown-prefix lines are structural noise and stay ignored.
    }
    return { header, lines }
  }

  const renderDiffBlock = (panel: any, block: { header: string; lines: { kind: string; text: string }[] }) => {
    if (panel.querySelector('[data-dsa-edit-diff]')) return
    const wrap = doc.createElement('div')
    wrap.setAttribute('data-dsa-edit-diff', '1')
    wrap.className = 'dsa-diff'
    const head = doc.createElement('div')
    head.className = 'dsa-diffHead'
    head.textContent = block.header
    wrap.appendChild(head)
    const collapsed = block.lines.length > 4
    const body = doc.createElement('div')
    body.className = 'dsa-diffBody'
    if (collapsed) body.style.display = 'none'
    for (const line of block.lines) {
      const row = doc.createElement('div')
      row.className = `dsa-diffLine dsa-diff${line.kind === 'del' ? 'Del' : line.kind === 'add' ? 'Add' : 'Ctx'}`
      row.textContent = line.text
      body.appendChild(row)
    }
    wrap.appendChild(body)
    if (collapsed) {
      const toggle = doc.createElement('button')
      toggle.type = 'button'
      toggle.className = 'dsa-diffToggle'
      toggle.textContent = t('panel.diffExpand')
      toggle.addEventListener('click', () => {
        const open = body.style.display !== 'none'
        body.style.display = open ? 'none' : 'block'
        toggle.textContent = open ? t('panel.diffExpand') : t('panel.diffCollapse')
      })
      wrap.appendChild(toggle)
    }
    panel.appendChild(wrap)
  }

  // Remove the raw marker block from the panel text (idempotent). Only the
  // deepest element carrying both markers is touched, so sibling text such as
  // the countdown note survives intact. Stripping rewrites TEXT NODES only —
  // rewriting the element's textContent would destroy its child structure
  // (React splits long reasons into spans and the two markers often land in
  // different children, F6).
  const collectTextNodes = (root: any, out: any[]): any[] => {
    for (const node of Array.from(root.childNodes ?? []) as any[]) {
      if (node.nodeType === 3) out.push(node)
      else collectTextNodes(node, out)
    }
    return out
  }

  const applyTextNodeRewrites = (el: any) => {
    const nodes = collectTextNodes(el, [])
    if (!nodes.length) return
    const texts = nodes.map((n: any) => n.data ?? '')
    const rewrites = computeTextNodeRewrites(texts, DIFF_START, DIFF_END)
    for (let i = 0; i < nodes.length; i++) {
      if (rewrites[i] !== texts[i]) nodes[i].data = rewrites[i]
    }
  }

  const hideDiffBlock = (panel: any) => {
    for (const el of Array.from(panel.querySelectorAll('*')) as any[]) {
      const text = el.textContent ?? ''
      if (!text.includes(DIFF_START) || !text.includes(DIFF_END)) continue
      const childCarries = Array.from(el.children).some((c: any) =>
        (c.textContent ?? '').includes(DIFF_START) && (c.textContent ?? '').includes(DIFF_END))
      if (childCarries) continue
      applyTextNodeRewrites(el)
      break
    }
  }

  const scan = () => {
    const panels: any[] = Array.from(doc.querySelectorAll('[data-approval-key]'))
    const liveKeys = new Set<string>()
    for (const panel of panels) {
      const key = panel.getAttribute('data-approval-key')
      if (!key) continue
      liveKeys.add(key)
      enablePreLine(panel)
      // Diff preview first: the raw block is hidden before the countdown is
      // parsed, so a countdown-literal inside preview content can never arm
      // the local auto-answer (host strips it too; this is the second fence).
      const rawText = panel.textContent ?? ''
      const block = extractDiffBlock(rawText)
      if (block) {
        renderDiffBlock(panel, block)
        hideDiffBlock(panel)
      }
      const text = panel.textContent ?? ''
      if (hasBreakerNote(text)) breaker.apply(panel, key)
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
    breaker.prune(liveKeys)
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
    breaker.dispose()
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
  reviewWaitSeconds: string
  safetyPrompt: string
  classifierSource: 'session' | 'preset' | 'endpoint'
  classifierProvider: string
  classifierModel: string
  reviewerSource: 'session' | 'preset' | 'endpoint'
  reviewerProvider: string
  reviewerModel: string
  reviewerMaxTokens: string
  reviewerReasoning: string
  classifierReasoning: string
  endpointUrl: string
  endpointModel: string
  endpointProtocol: 'openai' | 'anthropic'
  allowlist: string
  denyList: string
  humanOnlyList: string
  rulesText: string
  rulesDryRun: 'on' | 'off'
  maxConsecutiveDenials: string
  maxTotalDenials: string
  showSessionPanel: 'on' | 'auto' | 'off'
  onboardingMessageEnabled: 'on' | 'off'
  autoModeNoticeEnabled: 'on' | 'off'
  breakerAntiHijackMs: string
  reviewMaxRetries: string
  aiButtonPosition: 'header' | 'floating'
  directHumanEnabled: 'on' | 'off'
  debug: 'on' | 'off'
  redactResults: 'on' | 'off'
  editDiffPreview: 'on' | 'off'
  rejectGuidance: 'on' | 'off'
  categoryPolicy: Record<string, 'auto' | 'ask' | 'deny'>
  categoryMode: 'standard' | 'aggressive'
  privilegeAutoReview: 'on' | 'off'
  trustedDirs: string[]
  learningEnabled: 'on' | 'off'
  learningThreshold: string
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
    reviewWaitSeconds: String(value?.reviewWaitSeconds ?? THRESHOLD_DEFAULTS.reviewWaitSeconds),
    safetyPrompt: value?.safetyPrompt ?? '',
    reviewerModel: value?.reviewerModel ?? '',
    reviewerMaxTokens: String(value?.reviewerMaxTokens ?? 2048),
    reviewerReasoning: String(value?.reviewerReasoning ?? ''),
    classifierReasoning: String(value?.classifierReasoning ?? ''),
    classifierSource: ['session', 'preset', 'endpoint'].includes(value?.classifierSource) ? value.classifierSource : 'session',
    classifierProvider: value?.classifierProvider ?? '',
    classifierModel: value?.classifierModel ?? '',
    reviewerSource: ['session', 'preset', 'endpoint'].includes(value?.reviewerSource) ? value.reviewerSource : 'session',
    reviewerProvider: value?.reviewerProvider ?? '',
    endpointUrl: value?.endpointUrl ?? '',
    endpointModel: value?.endpointModel ?? '',
    endpointProtocol: ['openai', 'anthropic'].includes(value?.endpointProtocol) ? value.endpointProtocol : 'openai',
    allowlist: (value?.allowlist ?? []).join('\n'),
    denyList: (value?.denyList ?? []).join('\n'),
    humanOnlyList: (value?.humanOnlyList ?? []).join('\n'),
    rulesText: value?.rulesText ?? '',
    rulesDryRun: value?.rulesDryRun === true ? 'on' : 'off',
    maxConsecutiveDenials: String(value?.maxConsecutiveDenials ?? THRESHOLD_DEFAULTS.maxConsecutiveDenials),
    maxTotalDenials: String(value?.maxTotalDenials ?? THRESHOLD_DEFAULTS.maxTotalDenials),
    showSessionPanel: normalizeShowSessionPanel(value?.showSessionPanel ?? 'off'),
    onboardingMessageEnabled: value?.onboardingMessageEnabled === false ? 'off' : 'on',
    autoModeNoticeEnabled: value?.autoModeNoticeEnabled === false ? 'off' : 'on',
    breakerAntiHijackMs: String(value?.breakerAntiHijackMs ?? THRESHOLD_DEFAULTS.breakerAntiHijackMs),
    reviewMaxRetries: String(value?.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries),
    aiButtonPosition: value?.aiButtonPosition === 'floating' ? 'floating' : 'header',
    directHumanEnabled: value?.directHumanEnabled === true ? 'on' : 'off',
    debug: value?.debug === true ? 'on' : 'off',
    redactResults: value?.redactResults === true ? 'on' : 'off',
    editDiffPreview: value?.editDiffPreview === true ? 'on' : 'off',
    rejectGuidance: value?.rejectGuidance === true ? 'on' : 'off',
    categoryPolicy: (typeof value?.categoryPolicy === 'object' && value.categoryPolicy !== null)
      ? { ...value.categoryPolicy }
      : {},
    categoryMode: value?.categoryMode === 'aggressive' ? 'aggressive' : 'standard',
    privilegeAutoReview: value?.privilegeAutoReview === true ? 'on' : 'off',
    trustedDirs: Array.isArray(value?.trustedDirs) ? [...value.trustedDirs] : [],
    learningEnabled: value?.learningEnabled === true ? 'on' : 'off',
    learningThreshold: String(value?.learningThreshold ?? THRESHOLD_DEFAULTS.learningThreshold),
  }
}

function valueOf(draft: Draft): any {
  const list = (raw: string) => raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const intOr = (raw: string, fallback: number) => {
    const n = Math.round(Number(raw))
    return Number.isFinite(n) ? n : fallback
  }
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
    reviewWaitSeconds: Math.min(10, Math.max(1, Number(draft.reviewWaitSeconds) || THRESHOLD_DEFAULTS.reviewWaitSeconds)),
    safetyPrompt: draft.safetyPrompt,
    allowlist: list(draft.allowlist),
    denyList: list(draft.denyList),
    humanOnlyList: list(draft.humanOnlyList),
    rulesText: draft.rulesText,
    rulesDryRun: draft.rulesDryRun === 'on',
    maxConsecutiveDenials: Math.max(0, Number(draft.maxConsecutiveDenials) || 0),
    maxTotalDenials: Math.max(0, Number(draft.maxTotalDenials) || 0),
    showSessionPanel: draft.showSessionPanel,
    onboardingMessageEnabled: draft.onboardingMessageEnabled === 'off' ? false : true,
    autoModeNoticeEnabled: draft.autoModeNoticeEnabled === 'off' ? false : true,
    breakerAntiHijackMs: Math.max(0, Number(draft.breakerAntiHijackMs) || 0),
    reviewMaxRetries: Math.max(0, Math.min(2, Number(draft.reviewMaxRetries) || 0)),
    aiButtonPosition: draft.aiButtonPosition,
    directHumanEnabled: draft.directHumanEnabled === 'on',
    debug: draft.debug === 'on',
    redactResults: draft.redactResults === 'on',
    editDiffPreview: draft.editDiffPreview === 'on',
    rejectGuidance: draft.rejectGuidance === 'on',
    categoryPolicy: draft.categoryPolicy,
    categoryMode: draft.categoryMode,
    privilegeAutoReview: draft.privilegeAutoReview === 'on',
    trustedDirs: draft.trustedDirs,
    learningEnabled: draft.learningEnabled === 'on',
    learningThreshold: Math.max(2, Math.min(10, intOr(draft.learningThreshold, THRESHOLD_DEFAULTS.learningThreshold))),
  }
  // Model sources (2026-09-05 llm-channel-unify): the source switches always
  // persist (schema default 'session'); preset pairs and the shared endpoint
  // config persist only while non-empty. resolveConfig normalizes leftover
  // values away when a source is 'session', so stale values cannot silently
  // reactivate.
  value.classifierSource = ['session', 'preset', 'endpoint'].includes(draft.classifierSource) ? draft.classifierSource : 'session'
  if (draft.classifierProvider.trim()) value.classifierProvider = draft.classifierProvider.trim()
  if (draft.classifierModel.trim()) value.classifierModel = draft.classifierModel.trim()
  value.reviewerSource = ['session', 'preset', 'endpoint'].includes(draft.reviewerSource) ? draft.reviewerSource : 'session'
  if (draft.reviewerProvider.trim()) value.reviewerProvider = draft.reviewerProvider.trim()
  if (draft.reviewerModel.trim()) value.reviewerModel = draft.reviewerModel.trim()
  value.reviewerMaxTokens = Math.max(256, Math.min(16384, Math.round(Number(draft.reviewerMaxTokens) || 2048)))
  const REASONING_VALUES = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  value.reviewerReasoning = REASONING_VALUES.includes(draft.reviewerReasoning) ? draft.reviewerReasoning : ''
  value.classifierReasoning = REASONING_VALUES.includes(draft.classifierReasoning) ? draft.classifierReasoning : ''
  if (draft.endpointUrl.trim()) value.endpointUrl = draft.endpointUrl.trim()
  if (draft.endpointModel.trim()) value.endpointModel = draft.endpointModel.trim()
  if (draft.endpointProtocol === 'openai' || draft.endpointProtocol === 'anthropic') value.endpointProtocol = draft.endpointProtocol
  return value
}

type CapsuleOption = { value: string; label: string }

function normalizeShowSessionPanel(value: any): 'on' | 'auto' | 'off' {
  if (value === true) return 'auto'
  if (value === false) return 'off'
  if (value === 'on' || value === 'auto' || value === 'off') return value
  return 'off'
}

/**
 * Single source of truth for session-panel visibility, shared by the header
 * button (React branch) and the floating button (DOM branch) — both must
 * evaluate the same flags or the two modes drift apart. Pure; the behavior
 * is pinned by the compiled-client anchor below.
 */
function computePanelVisible(panelMode: 'on' | 'auto' | 'off', sessionMode: string | undefined): boolean {
  if (panelMode === 'off') return false
  if (panelMode === 'auto' && sessionMode !== 'auto') return false
  return true
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

// One-decision LLM wall-clock for the history line: sub-second stays in
// milliseconds, longer reads as seconds (one decimal).
function formatTookMs(ms: number | null): string {
  if (ms === null || ms === undefined) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// ── invalid-config detection (mirrors the host Config schema) ──────────────
// Flags stored values that are present but violate the schema (wrong type,
// unknown enum, out-of-range number). The settings card shows a red banner and
// offers to delete those keys so the schema defaults recover.
const INVALID_CONFIG_TYPES: Record<string, string> = {
  enabled: 'boolean', autoSwitchPolicyToAsk: 'boolean', rulesDryRun: 'boolean', notifyUser: 'boolean', debug: 'boolean', redactResults: 'boolean', editDiffPreview: 'boolean', rejectGuidance: 'boolean', learningEnabled: 'boolean',
  lowRiskSeconds: 'number', mediumRiskSeconds: 'number', highRiskSeconds: 'number', learningThreshold: 'number',
  maxConsecutiveDenials: 'number', maxTotalDenials: 'number', breakerAntiHijackMs: 'number', reviewMaxRetries: 'number',
  maxArgsChars: 'number', classifierTimeoutMs: 'number', classifierMaxOutputTokens: 'number',
  workspaceRoot: 'string', dshHome: 'string', safetyPrompt: 'string', rulesText: 'string',
  reviewerModel: 'string', timeoutAction: 'string',
  reviewerReasoning: 'string', classifierReasoning: 'string',
  reviewerMaxTokens: 'number',
  classifierProvider: 'string', classifierModel: 'string',
  reviewerProvider: 'string',
  endpointUrl: 'string', endpointModel: 'string',
  allowlist: 'array', denyList: 'array', humanOnlyList: 'array', tempRoots: 'array',
  categoryPolicy: 'object', categoryMode: 'string', trustedDirs: 'array',
}
const REASONING_OPTIONS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const INVALID_CONFIG_ENUMS: Record<string, string[]> = {
  timeoutAction: ['reject', 'allow', 'low-risk-allow'],
  llmReviewScope: ['low-or-above', 'medium-or-above', 'high'],
  llmTakeoverScope: ['low', 'medium-or-below', 'high-or-below'],
  defaultReviewMode: ['manual', 'smart', 'unattended'],
  showSessionPanel: ['on', 'auto', 'off'],
  aiButtonPosition: ['header', 'floating'],
  endpointProtocol: ['openai', 'anthropic'],
  categoryMode: ['standard', 'aggressive'],
  classifierSource: ['session', 'preset', 'endpoint'],
  reviewerSource: ['session', 'preset', 'endpoint'],
  reviewerReasoning: REASONING_OPTIONS,
  classifierReasoning: REASONING_OPTIONS,
}
const INVALID_CONFIG_RANGES: Record<string, [number, number]> = {
  lowRiskSeconds: [1, Infinity], mediumRiskSeconds: [1, Infinity], highRiskSeconds: [1, Infinity],
  maxConsecutiveDenials: [0, Infinity], maxTotalDenials: [0, Infinity], breakerAntiHijackMs: [0, Infinity],
  reviewMaxRetries: [0, 2],
  maxArgsChars: [1, Infinity], classifierTimeoutMs: [100, 60000], classifierMaxOutputTokens: [64, 4096],
  reviewerMaxTokens: [256, 16384],
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

// Scope presets pair the review/takeover keys into one-click profiles. Each
// entry pins the exact enum values written on selection; a stored combination
// outside this table falls back to the display-only custom entry, which never
// writes config.
const SCOPE_PRESETS: { id: string; review: 'low-or-above' | 'medium-or-above' | 'high'; takeover: 'low' | 'medium-or-below' | 'high-or-below' }[] = [
  { id: 'standard', review: 'low-or-above', takeover: 'medium-or-below' },
  { id: 'relaxed', review: 'medium-or-above', takeover: 'medium-or-below' },
  { id: 'steady', review: 'low-or-above', takeover: 'low' },
  { id: 'strict', review: 'high', takeover: 'low' },
]

function scopePresetOptions(): CapsuleOption[] {
  return [
    ...SCOPE_PRESETS.map((p) => ({ value: p.id, label: t(`option.scopePreset.${p.id}`) })),
    { value: 'custom', label: t('option.scopePreset.custom') },
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

// Reasoning-effort choices for both LLM lanes. '' = follow the model's default
// (byte-identical to pre-switch); the rest map to the dsh reasoningEffort /
// endpoint reasoning_effort values — a model that does not support a value
// fails that call loudly, never silently.
function reasoningOptions(): CapsuleOption[] {
  return [
    { value: '', label: t('option.reasoning.default') },
    { value: 'off', label: 'off' },
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'xhigh', label: 'xhigh' },
    { value: 'max', label: 'max' },
  ]
}

function categoryModeOptions(): CapsuleOption[] {
  return [
    { value: 'standard', label: t('option.category.mode.standard') },
    { value: 'aggressive', label: t('option.category.mode.aggressive') },
  ]
}

// Category card model: the 11 tri-state keys and the locked subset (only
// "ask" is configurable there). Mirrors the host category module constants.
const CATEGORY_KEY_LIST = ['fileEdit', 'gitLocal', 'build', 'readOnly', 'delete', 'protected', 'privilege', 'networkExec', 'gitPush', 'publish', 'disk']
const CATEGORY_LOCKED_LIST = ['delete', 'protected', 'privilege', 'disk']

const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'

// Check glyph mirrored from the official dsh-web-frontend icon set (the plugin
// UI follows the official aesthetic), 16x16 viewBox like the source component.
const CHECK_PATH = 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z'

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
  const label = current?.label ?? (props.value && props.value !== '' ? props.value : props.options[0]?.label ?? '')
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
          ? React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', className: 'dsa-menuCheck' },
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
  // First-use onboarding: read the one-shot flag lazily at mount. The flag is
  // persisted when the card is collapsed (expanded-and-seen implies done), so
  // the block appears at most until the first collapse, never again.
  const [onboardingDismissed, setOnboardingDismissed] = React.useState<boolean>(() => {
    try { return (globalThis as any).localStorage?.getItem(ONBOARDING_SEEN_KEY) === '1' } catch { return false }
  })
  const toggleCard = () => {
    const next = !open
    if (open && !next) {
      setOnboardingDismissed(true)
      try { (globalThis as any).localStorage?.setItem(ONBOARDING_SEEN_KEY, '1') } catch {}
    }
    setOpen(next)
  }
  const [history, setHistory] = React.useState<any[]>([])
  const [llmLatency, setLlmLatency] = React.useState<any>(null)
  // Latency split by lane (2026-09-05): reviewer (deep review) and classifier
  // (fast decision) summaries arrive alongside the merged view.
  const [llmLatencyClassifier, setLlmLatencyClassifier] = React.useState<any>(null)
  const [llmLatencyAll, setLlmLatencyAll] = React.useState<any>(null)
  const [historyError, setHistoryError] = React.useState('')
  const [testResult, setTestResult] = React.useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [credentialConfigured, setCredentialConfigured] = React.useState(false)
  const [credentialWritable, setCredentialWritable] = React.useState(false)
  const [reviewerApiKey, setReviewerApiKey] = React.useState('')
  // Sub-cards are collapsible and start collapsed; their data (history records,
  // reviewer-credential describe) is fetched lazily on first expand.
  const [openTimers, setOpenTimers] = React.useState(false)
  const [openReview, setOpenReview] = React.useState(false)
  const [openSecurity, setOpenSecurity] = React.useState(false)
  // Whether the「评审模型会看到什么？」read-only preview is expanded. The
  // preview is a live assembly of the CURRENT draft (REVIEWER_SYSTEM + safety
  // prompt + rules summary), so it needs no saved state and never touches the
  // editor below it.
  const [showReviewerPreview, setShowReviewerPreview] = React.useState(false)
  const [openHistory, setOpenHistory] = React.useState(false)
  const [openCategory, setOpenCategory] = React.useState(false)
  const [openLearning, setOpenLearning] = React.useState(false)
  const [openUtility, setOpenUtility] = React.useState(false)
  const [learningEntries, setLearningEntries] = React.useState<any[]>([])
  const [learningEntriesError, setLearningEntriesError] = React.useState('')
  // Issue #5 model-source pickers: the registered providers and the full
  // preset-model list (every provider's discovered models, flattened as
  // `provider/model` entries), fetched from the host catalog routes once the
  // review card opens. The source menu offers 跟随会话 / 自定义 / each preset;
  // picking a preset fills the pair directly (no input row), picking 自定义
  // reveals the provider/model inputs. Catalog failures degrade to the two
  // built-in options — never a blocking banner.
  const [llmProviders, setLlmProviders] = React.useState<{ id: string; name: string }[] | null>(null)
  const [llmPresetModels, setLlmPresetModels] = React.useState<{ provider: string; id: string; name: string }[] | null>(null)
  // Reasoning-effort catalog for each preset lane, fetched from the host
  // resolveModelInfo route for the lane's CURRENT provider/model pair (2026-09-06,
  // dynamic picker). null = not loaded / no preset pair; [] = the model has no
  // declared efforts (default-only picker). The stale guard below discards any
  // response for a pair the user already switched away from, so the cached
  // catalog always belongs to the current pair once the latest fetch lands.
  const [laneEfforts, setLaneEfforts] = React.useState<{
    classifier: { pair: string; efforts: { id: string; name: string }[] } | null
    reviewer: { pair: string; efforts: { id: string; name: string }[] } | null
  }>({ classifier: null, reviewer: null })
  // Latest requested pair per lane, so a slow effort response for a pair the
  // user already switched away from is discarded instead of mislabeling the
  // current model's options (stale-catalog guard, 2026-09-06).
  const latestEffortPair = React.useRef<{ classifier: string; reviewer: string }>({ classifier: '', reviewer: '' })
  // In-card feedback: the most recent ok/error text for each sub-card, shown
  // inside that card's footer (not piled at the bottom of the plugin body).
  const [cardStatus, setCardStatus] = React.useState<{ id: string; kind: 'ok' | 'err'; text: string } | null>(null)
  // Restoring defaults must enable Save even when the stored values already
  // equal the defaults; otherwise the "please click save" hint is a dead end.
  const [securityForcedDirty, setSecurityForcedDirty] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [page, setPage] = React.useState(0)
  const PAGE_SIZE = 10
  // Which exact-list textarea the segmented tabs currently show.
  const [listTab, setListTab] = React.useState<'allow' | 'deny' | 'human'>('allow')
  // Whether the「默认放行工具」reference list is expanded under the exact-list
  // field (pure display of the policy's unconditional-allow catalog).
  const [showDefaultAllow, setShowDefaultAllow] = React.useState(false)
  // Recent-tool chips: raw stats from the host route + the edited-list-derived
  // candidate chips for the ACTIVE tab. Fetched lazily once on first render of
  // the security card (chips are advisory — the list stays the source of truth).
  const [toolStats, setToolStats] = React.useState<ToolStatsPayload | null>(null)
  const [toolStatsError, setToolStatsError] = React.useState('')
  // How many chips are shown for each tab before the "[…]" revealer (paged
  // 10 at a time). Reset whenever the active tab changes.
  const [chipLimit, setChipLimit] = React.useState(10)
  const CHIP_PAGE = 10

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

  // Re-sync the snapshot after a failed save: a revision mismatch (another
  // tab, or a save racing an instant capsule) must not wedge every later
  // save — the stored revision has moved on, so the baseline has to be
  // re-read before the next attempt. The local draft is kept: unsaved card
  // edits are user intent, and each save overlays its own card's keys on the
  // fresh baseline anyway.
  const refreshSnapshot = async () => {
    try {
      const res = await (globalThis as any).fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
      const data = await res.json()
      if (data?.ok) setSnapshot(data.value)
    } catch {
      // best-effort: the next failed save retries the refresh
    }
  }

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
        setLlmLatencyClassifier(data.value.llmLatencyClassifier ?? null)
        setLlmLatencyAll(data.value.llmLatencyAll ?? null)
      })
      .catch((e: any) => {
        if (!disposed) setHistoryError(String(e))
      })
    return () => { disposed = true }
  }, [openHistory])

  // Recent-tool chips data: fetched once the security card is first expanded
  // (the body is lazy). No settings write happens here — the route is read-only.
  React.useEffect(() => {
    if (!openSecurity) return
    if (toolStats !== null) return
    let disposed = false
    setToolStatsError('')
    ;(globalThis as any).fetch(TOOL_STATS_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        setToolStats(data.value?.stats ?? null)
      })
      .catch((e: any) => {
        if (!disposed) setToolStatsError(String(e))
      })
    return () => { disposed = true }
  }, [openSecurity, toolStats])

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

  // Issue #5: fetch the host provider/model catalog once when the review card
  // opens. listProviders is sync-host-side; listModels is fetched separately
  // when a custom provider is actually selected (see loadModelsFor). Catalog
  // failures degrade to free text, never a blocking banner.
  React.useEffect(() => {
    if (!openReview) return
    let disposed = false
    const loadPresets = async () => {
      try {
        const r = await (globalThis as any).fetch(PROVIDERS_ROUTE, { credentials: 'same-origin' })
        const data = await r.json()
        if (disposed || !data?.ok) return
        const providers: { id: string; name: string }[] = data.value?.providers ?? []
        setLlmProviders(providers)
        // Flatten every provider's discovered models into one preset list.
        const all: { provider: string; id: string; name: string }[] = []
        await Promise.all(providers.map(async (p) => {
          try {
            const mr = await (globalThis as any).fetch(`${LLM_MODELS_ROUTE}?provider=${encodeURIComponent(p.id)}`, { credentials: 'same-origin' })
            const md = await mr.json()
            if (md?.ok) {
              for (const m of md.value?.models ?? []) {
                all.push({ provider: p.id, id: m.id, name: m.name ?? m.id })
              }
            }
          } catch { /* skip this provider's models */ }
        }))
        if (!disposed) setLlmPresetModels(all)
      } catch { /* degrade to built-in options */ }
    }
    void loadPresets()
    return () => { disposed = true }
  }, [openReview])

  // Dynamic reasoning-effort catalog (2026-09-06): while the review card is
  // open, refetch each preset lane's adapter-declared efforts whenever its
  // provider/model pair changes (choosePreset / manual input). A lane that is
  // not on a concrete preset pair keeps null → the picker falls back to the
  // full vocabulary; a model without declared efforts yields [] → the picker
  // offers the default entry only. latestEffortPair drops a response for a
  // pair the user already switched away from.
  React.useEffect(() => {
    if (!openReview || !draft) return
    const fetchEfforts = async (lane: 'classifier' | 'reviewer', provider: string, model: string) => {
      const pair = `${provider}/${model}`
      latestEffortPair.current[lane] = pair
      try {
        const r = await (globalThis as any).fetch(`${REASONING_EFFORTS_ROUTE}?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`, { credentials: 'same-origin' })
        const data = await r.json()
        if (latestEffortPair.current[lane] !== pair) return
        setLaneEfforts((prev) => ({ ...prev, [lane]: { pair, efforts: data?.ok ? (data.value?.efforts ?? []) : [] } }))
      } catch {
        if (latestEffortPair.current[lane] !== pair) return
        setLaneEfforts((prev) => ({ ...prev, [lane]: { pair, efforts: [] } }))
      }
    }
    if (draft.reviewerSource === 'preset' && draft.reviewerProvider && draft.reviewerModel) {
      void fetchEfforts('reviewer', draft.reviewerProvider, draft.reviewerModel)
    }
    if (draft.classifierSource === 'preset' && draft.classifierProvider && draft.classifierModel) {
      void fetchEfforts('classifier', draft.classifierProvider, draft.classifierModel)
    }
  }, [openReview, draft?.reviewerSource, draft?.reviewerProvider, draft?.reviewerModel, draft?.classifierSource, draft?.classifierProvider, draft?.classifierModel])

  React.useEffect(() => {
    if (!openLearning) return
    let disposed = false
    setLearningEntriesError('')
    ;(globalThis as any).fetch(LEARNING_STORE_ROUTE, { credentials: 'same-origin' })
      .then((r: any) => r.json())
      .then((data: any) => {
        if (disposed || !data?.ok) return
        setLearningEntries(data.value.entries ?? [])
      })
      .catch((e: any) => {
        if (!disposed) setLearningEntriesError(String(e))
      })
    return () => { disposed = true }
  }, [openLearning])

  if (!snapshot || !draft) {
    return React.createElement('div', { style: { padding: 12 } }, t('settings.loading'))
  }

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch })
  }

  // Model-source picker model (2026-09-05 llm-channel-unify): each lane has a
  // direct 3-value source switch — 'session' (follow the session model),
  // 'preset' (host DSH model from the catalog, pair filled from the menu) and
  // 'endpoint' (shared custom endpoint config, marked legacy). The preset
  // catalog menu fills the lane's provider/model; choosing session clears the
  // lane pair. The shared endpoint config is edited once below both lanes.
  const laneDraft = (lane: 'classifier' | 'reviewer') => {
    if (lane === 'classifier') {
      return { source: draft.classifierSource, provider: draft.classifierProvider, model: draft.classifierModel }
    }
    return { source: draft.reviewerSource, provider: draft.reviewerProvider, model: draft.reviewerModel }
  }
  const laneUpdate = (lane: 'classifier' | 'reviewer', next: { source?: 'session' | 'preset' | 'endpoint'; provider?: string; model?: string }) => {
    if (lane === 'classifier') {
      const patch: Partial<Draft> = {}
      if (next.source !== undefined) patch.classifierSource = next.source
      if (next.provider !== undefined) patch.classifierProvider = next.provider
      if (next.model !== undefined) patch.classifierModel = next.model
      update(patch)
    } else {
      const patch: Partial<Draft> = {}
      if (next.source !== undefined) patch.reviewerSource = next.source
      if (next.provider !== undefined) patch.reviewerProvider = next.provider
      if (next.model !== undefined) patch.reviewerModel = next.model
      update(patch)
    }
  }
  const presetLabel = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`
  // Choosing a preset catalog entry fills the lane pair and sets source=preset.
  const choosePreset = (lane: 'classifier' | 'reviewer', pair: string) => {
    const slash = pair.indexOf('/')
    if (slash <= 0) return
    laneUpdate(lane, { source: 'preset', provider: pair.slice(0, slash), model: pair.slice(slash + 1) })
  }
  const setLaneSource = (lane: 'classifier' | 'reviewer', source: 'session' | 'preset' | 'endpoint') => {
    if (source === 'session') {
      // Leaving the preset lane clears the pair so a later return starts blank.
      laneUpdate(lane, { source: 'session', provider: '', model: '' })
    } else if (source === 'preset') {
      laneUpdate(lane, { source: 'preset' })
    } else {
      laneUpdate(lane, { source: 'endpoint' })
    }
  }

  // Per-card ownership: saving a card only persists the fields it owns,
  // overlaid on the last-saved baseline; other cards' unsaved edits are left
  // in the local draft and never accidentally persisted by another card.
  const TOP_KEYS = ['enabled', 'autoSwitchPolicyToAsk', 'timeoutAction', 'llmReviewScope', 'llmTakeoverScope', 'defaultReviewMode', 'showSessionPanel', 'aiButtonPosition', 'autoModeNoticeEnabled']
  const TIMER_KEYS = ['breakerAntiHijackMs', 'lowRiskSeconds', 'mediumRiskSeconds', 'highRiskSeconds', 'maxConsecutiveDenials', 'maxTotalDenials', 'reviewWaitSeconds', 'directHumanEnabled']
  const REVIEW_KEYS = ['classifierSource', 'classifierProvider', 'classifierModel', 'reviewerSource', 'reviewerProvider', 'reviewerModel', 'reviewerMaxTokens', 'reviewerReasoning', 'classifierReasoning', 'endpointUrl', 'endpointModel', 'endpointProtocol', 'reviewMaxRetries']
  const SECURITY_KEYS = ['safetyPrompt', 'allowlist', 'denyList', 'humanOnlyList', 'rulesText', 'rulesDryRun']
  const UTILITY_KEYS = ['onboardingMessageEnabled', 'redactResults', 'editDiffPreview', 'rejectGuidance']
  const LEARNING_KEYS = ['learningEnabled', 'learningThreshold']
  const pick = (keys: string[], from: Draft): Partial<Draft> => {
    const out: any = {}
    for (const k of keys) out[k] = (from as any)[k]
    return out
  }
  const sliceValueOf = (keys: string[]): any => valueOf({ ...draftOf(snapshot.value), ...pick(keys, draft) })
  const sliceWithKeys = (patch: Record<string, unknown>): any => {
    const base = draftOf(snapshot.value) as any
    Object.assign(base, patch)
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
  const baseDraft = draftOf(snapshot.value) as any
  const categoryDirty =
    JSON.stringify(draft.categoryPolicy) !== JSON.stringify(baseDraft.categoryPolicy ?? {})
    || draft.categoryMode !== baseDraft.categoryMode
    || draft.privilegeAutoReview !== baseDraft.privilegeAutoReview
  const learningDirty = cardDirty(LEARNING_KEYS)
  const utilityDirty = cardDirty(UTILITY_KEYS)
  const invalidKeys = findInvalidConfigKeys(snapshot.value)
  const configError = (snapshot as any)?.configError ?? null
  const bannerMessage = configError
    ? t('settings.pluginConfigError', { error: String(configError) })
    : invalidKeys.length > 0
      ? t('settings.invalidConfig', { keys: invalidKeys.join(', ') })
      : null
  const anyDirty = timerDirty || reviewDirty || securityDirtyEff || categoryDirty || learningDirty

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
        setSecurityForcedDirty(false)
      }
    } catch (e) {
      setCardStatus({ id: cardId, kind: 'err', text: e instanceof Error ? e.message : String(e) })
      void refreshSnapshot()
    } finally {
      setSaving(false)
    }
  }

  const discardCard = (keys: string[], cardId: string) => {
    setDraft({ ...draft, ...pick(keys, draftOf(snapshot.value)) })
    setCardStatus({ id: cardId, kind: 'ok', text: '' })
    if (cardId === 'security') setSecurityForcedDirty(false)
  }

  // Derived preset id: matches a profile only for the exact stored pair;
  // anything else renders as the inert custom entry.
  const scopePresetId = SCOPE_PRESETS.find((p) => p.review === draft.llmReviewScope && p.takeover === draft.llmTakeoverScope)?.id ?? 'custom'
  // Top-level capsule toggles save immediately (original behavior). Only the
  // toggled key is committed on the saved baseline, so unsaved edits inside the
  // other cards are never persisted or lost; the local draft keeps them.
  // Instant-save accepts a multi-key patch so one control can commit several
  // keys atomically (single POST, single expectedRevision check).
  const instantSaveKeys = async (patch: Record<string, unknown>) => {
    const prevDraft = draft
    setDraft({ ...draft, ...(patch as Partial<Draft>) })
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const res = await (globalThis as any).fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: snapshot.revision, value: sliceWithKeys(patch) }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('settings.saveFailed'))
      broadcastSettings(data.value)
      setSnapshot(data.value)
    } catch (e) {
      // The optimistic draft patch did not persist — roll it back so the
      // control reflects the stored value, and re-sync the revision.
      setDraft(prevDraft)
      void refreshSnapshot()
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Single-key convenience wrapper kept for the existing toggle rows.
  const instantSaveKey = (key: string, value: unknown) => instantSaveKeys({ [key]: value })

  const resetCard = () => {
    setDraft({ ...draft, ...pick(SECURITY_KEYS, draftOf({})) })
    setCardStatus({ id: 'security', kind: 'ok', text: t('settings.defaultsRestored') })
    setSecurityForcedDirty(true)
    setError('')
  }

  const resetTimerCard = () => {
    setDraft({
      ...draft,
      lowRiskSeconds: String(THRESHOLD_DEFAULTS.lowRiskSeconds),
      mediumRiskSeconds: String(THRESHOLD_DEFAULTS.mediumRiskSeconds),
      highRiskSeconds: String(THRESHOLD_DEFAULTS.highRiskSeconds),
      reviewWaitSeconds: String(THRESHOLD_DEFAULTS.reviewWaitSeconds),
      // breakerAntiHijackMs is deliberately NOT reset: the card default is 0
      // (guard no-op), so resetting would silently close an anti-hijack
      // window the user configured only through YAML — the key has no control
      // on this card to set it back.
      maxConsecutiveDenials: String(THRESHOLD_DEFAULTS.maxConsecutiveDenials),
      maxTotalDenials: String(THRESHOLD_DEFAULTS.maxTotalDenials),
      directHumanEnabled: 'off',
    })
  }

  const resetReviewerCard = async () => {
    // One-tap factory reset of the model card: default both lanes back to the
    // session source and clear the shared endpoint config, persist, and clear
    // the endpoint API key (credential store + file fallback) so no secret
    // survives the reset.
    const reset: Partial<Draft> = {
      classifierSource: 'session', classifierProvider: '', classifierModel: '',
      reviewerSource: 'session', reviewerProvider: '', reviewerModel: '',
      reviewerMaxTokens: '2048', reviewerReasoning: '', classifierReasoning: '',
      endpointUrl: '', endpointModel: '', endpointProtocol: 'openai',
    }
    const merged = { ...draftOf(snapshot.value), ...reset }
    setDraft({ ...draft, ...reset })
    setSaving(true); setError(''); setMessage('')
    setCardStatus(null)
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
      const del = await (globalThis as any).fetch(REVIEWER_CREDENTIAL_ROUTE, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      })
      const delData = await del.json().catch(() => ({}))
      if (!del?.ok || delData?.ok === false) throw new Error(delData?.error ?? t('settings.reviewResetFailed'))
      // In-card feedback, left of the restore button (statusLine('review')).
      setCardStatus({ id: 'review', kind: 'ok', text: t('settings.reviewResetDone') })
    } catch (e: any) {
      setCardStatus({ id: 'review', kind: 'err', text: String(e?.message ?? e) })
      void refreshSnapshot()
    } finally {
      setSaving(false)
    }
  }

  const restoreTopDefaults = async () => {
    const base = draftOf(snapshot.value)
    // autoSwitchPolicyToAsk is deliberately NOT restored: it has no UI
    // control, so "restore defaults" flipping it would silently change a
    // guard the user cannot see or undo from this card (its value is a
    // host-level fact — the patch pins it true at install time).
    const defaults: Partial<Draft> = { enabled: 'on', timeoutAction: 'reject', llmReviewScope: 'low-or-above', llmTakeoverScope: 'medium-or-below', defaultReviewMode: 'smart', showSessionPanel: 'off', aiButtonPosition: 'header' }
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
      void refreshSnapshot()
    } finally {
      setSaving(false)
    }
  }

  // Direct-channel completeness precheck, mirroring the host-side snapshot
  // A lane whose source is 'preset' must carry a complete provider/model pair;
  // an 'endpoint' source needs the shared endpoint URL + model. Surface the
  // missing pieces instead of letting the save persist a half-configuration
  // (the host fails such lanes loudly at review time).
  const sourceMissing = (lane: 'classifier' | 'reviewer'): string[] | null => {
    const { source, provider, model } = laneDraft(lane)
    if (source !== 'preset' && source !== 'endpoint') return null
    if (source === 'preset') {
      const missing: string[] = []
      if (!provider.trim()) missing.push(t('settings.reviewer.source.provider'))
      if (!model.trim()) missing.push(t('settings.reviewer.source.model'))
      return missing.length > 0 ? missing : null
    }
    const missing: string[] = []
    if (!draft.endpointUrl.trim()) missing.push(t('settings.reviewer.baseUrl'))
    if (!draft.endpointModel.trim()) missing.push(t('settings.reviewer.modelName'))
    return missing.length > 0 ? missing : null
  }

  const testOnline = async () => {
    const baseUrl = draft.endpointUrl.trim()
    const model = draft.endpointModel.trim()
    if (!baseUrl || !model) {
      setTestResult({ kind: 'info', text: t('test.enterProviderModel') })
      return
    }
    setTestResult({ kind: 'info', text: t('test.onlineTesting') })
    try {
      const res = await (globalThis as any).fetch(TEST_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          online: true,
          protocol: draft.endpointProtocol,
          baseUrl,
          model,
          apiKey: reviewerApiKey.trim(),
        }),
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (!data?.ok) throw new Error(data?.error ?? t('test.failed'))
      setTestResult({ kind: 'ok', text: t('test.onlineOk') })
    } catch (e) {
      setTestResult({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
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
    // A 'preset'/'endpoint' lane with an incomplete configuration would persist
    // a half-configuration the host fails loudly on at review time; tell the
    // user instead of saving a lie.
    for (const lane of ['classifier', 'reviewer'] as const) {
      const missing = sourceMissing(lane)
      if (missing) {
        setCardStatus({ id: 'review', kind: 'err', text: t('settings.reviewer.source.incompleteSource', { missing: missing.join(', ') }) })
        return
      }
    }
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
      void refreshSnapshot()
    } finally {
      setSaving(false)
    }
  }

  const filteredHistory = history.filter((r: any) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    const haystack = [r.toolName, r.source, r.outcome, r.reason, r.llmReason, ...(r.breakerReasons ?? [])].join(' ').toLowerCase()
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
  // `titleExtra` renders on the same line as the title (right-aligned), for
  // compact actions like the reviewer-preview toggle.
  const field = (label: string, children: React.ReactNode, hint?: string, titleExtra?: React.ReactNode) =>
    React.createElement('div', { className: 'dsa-field' },
      React.createElement('div', { className: 'dsa-titleRow' },
        React.createElement('span', { className: 'dsa-title' }, label),
        titleExtra ? React.createElement('span', { className: 'dsa-titleExtra' }, titleExtra) : null,
      ),
      children,
      hint ? React.createElement('small', { className: 'dsa-desc' }, hint) : null,
    )

  // Segmented pill that picks which exact-list textarea is visible.
  const listTabButton = (id: 'allow' | 'deny' | 'human', label: string) =>
    React.createElement('button', {
      type: 'button',
      className: listTab === id ? 'dsa-segBtn dsa-segBtnActive' : 'dsa-segBtn',
      onClick: () => { setListTab(id); setChipLimit(CHIP_PAGE) },
    }, label)

  // Active-tab list draft read/write — the chips append into the SAME string
  // the textarea edits, so a chip click is just another edit of the list.
  const currentListText = (): string => {
    if (listTab === 'allow') return draft.allowlist
    if (listTab === 'deny') return draft.denyList
    return draft.humanOnlyList
  }
  const setCurrentListText = (next: string) => {
    if (listTab === 'allow') update({ allowlist: next })
    else if (listTab === 'deny') update({ denyList: next })
    else update({ humanOnlyList: next })
  }
  const currentListEntries = (): string[] =>
    currentListText().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  // Candidate chips for the active tab (pure; re-derives whenever the draft or
  // the fetched stats change — the rendered list below stays in sync).
  const activeStats = (): ToolStatsEntry[] => {
    if (!toolStats) return []
    return toolStats[listTab] ?? []
  }
  const chipsForActiveTab: ToolChip[] = toolStats
    ? buildToolChips(activeStats(), toolStats.humanDenied ?? [], currentListEntries())
    : []

  const handleChipClick = (chip: ToolChip) => {
    setCurrentListText(applyChipToList(currentListText(), chip))
  }

  const moreChips = () => setChipLimit((n) => n + CHIP_PAGE)

  const chipNodes = (): React.ReactNode[] => {
    const visible = chipsForActiveTab.slice(0, chipLimit)
    const hidden = chipsForActiveTab.length - visible.length
    const nodes = visible.map((chip) => React.createElement('button', {
      key: chip.value,
      type: 'button',
      className: chip.collapsed ? 'dsa-chip dsa-chipClass' : 'dsa-chip',
      onClick: () => handleChipClick(chip),
    }, chip.value))
    if (hidden > 0) {
      nodes.push(React.createElement('button', {
        key: '__more',
        type: 'button',
        className: 'dsa-chip dsa-chipMore',
        onClick: moreChips,
      }, t('settings.rules.chipsMore')))
    }
    return nodes
  }

  // ── cards ────────────────────────────────────────────────────────────────
  // Four sub-cards inside the plugin card, each with its own save/discard
  // (and, for the safety list, a restore-defaults action). The UI borrows the
  // DSH design tokens (--dsw-alias-*) and the native Button/Input primitives.
  const subcard = (
    title: string, open: boolean, cardDirty: boolean, onToggle: () => void,
    buildBody: () => React.ReactNode, buildFooter?: () => React.ReactNode,
    badge?: React.ReactNode, group?: string,
  ) =>
    React.createElement('div', { className: 'dsa-subcard' },
      React.createElement('button', {
        type: 'button',
        className: 'dsa-subcardHeader',
        'aria-expanded': open,
        onClick: onToggle,
      },
        React.createElement('span', { className: 'dsa-subcardTitle' },
          group ? React.createElement('span', { className: 'dsa-groupTag' }, group) : null,
          title,
        ),
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
  const topLevelBody = React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    row(t('settings.enable'), React.createElement(CapsuleSelect, {
      value: draft.enabled,
      options: onOffOptions(),
      onChange: (v: string) => { void instantSaveKey('enabled', v as 'on' | 'off') },
    }), t('settings.enableHint')),
    row(t('settings.timeoutAction'), React.createElement(CapsuleSelect, {
      value: draft.timeoutAction,
      options: timeoutOptions(),
      onChange: (v: string) => { void instantSaveKey('timeoutAction', v as string) },
    }), t('settings.timeoutActionHint')),
    row(t('settings.llmScope.preset'), React.createElement(CapsuleSelect, {
      value: scopePresetId,
      options: scopePresetOptions(),
      onChange: (v: string) => {
        const preset = SCOPE_PRESETS.find((p) => p.id === v)
        if (!preset) return
        void instantSaveKeys({ llmReviewScope: preset.review, llmTakeoverScope: preset.takeover })
      },
    }), t(`settings.llmScope.hint.${scopePresetId}`)),
    row(t('settings.defaultReviewMode'), React.createElement(CapsuleSelect, {
      value: draft.defaultReviewMode,
      options: reviewModeOptions(),
      onChange: (v: string) => { void instantSaveKey('defaultReviewMode', v as any) },
    }), t('settings.defaultReviewModeHint')),
    row(t('settings.autoSwitchPolicy'), React.createElement(CapsuleSelect, {
      value: draft.autoSwitchPolicyToAsk,
      options: onOffOptions(),
      onChange: (v: string) => { void instantSaveKey('autoSwitchPolicyToAsk', v as 'on' | 'off') },
    }), t('settings.autoSwitchPolicyHint')),
    row(t('settings.autoModeNotice'), React.createElement(CapsuleSelect, {
      value: draft.autoModeNoticeEnabled,
      options: onOffOptions(),
      onChange: (v: string) => { void instantSaveKey('autoModeNoticeEnabled', v as 'on' | 'off') },
    }), t('settings.autoModeNoticeHint')),
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
  const buildTimerBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    row(t('settings.riskSeconds'), React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
      React.createElement('span', { className: 'dsa-inlineTag' }, t('option.risk.low')),
      React.createElement('input', {
        type: 'number',
        min: 1,
        value: draft.lowRiskSeconds,
        onChange: (e: any) => update({ lowRiskSeconds: e.target.value }),
        className: 'dsa-input',
        style: { width: 80 },
      }),
      React.createElement('span', { className: 'dsa-inlineTag' }, t('option.risk.medium')),
      React.createElement('input', {
        type: 'number',
        min: 1,
        value: draft.mediumRiskSeconds,
        onChange: (e: any) => update({ mediumRiskSeconds: e.target.value }),
        className: 'dsa-input',
        style: { width: 80 },
      }),
      React.createElement('span', { className: 'dsa-inlineTag' }, t('option.risk.high')),
      React.createElement('input', {
        type: 'number',
        min: 1,
        value: draft.highRiskSeconds,
        onChange: (e: any) => update({ highRiskSeconds: e.target.value }),
        className: 'dsa-input',
        style: { width: 80 },
      }),
    )),
    row(t('settings.reviewWaitSeconds'), React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      React.createElement('input', {
        type: 'number',
        min: 1,
        max: 10,
        value: draft.reviewWaitSeconds,
        onChange: (e: any) => update({ reviewWaitSeconds: e.target.value }),
        className: 'dsa-input',
        style: { width: 80 },
      }),
    )),
    row(t('settings.denialBreaker'), React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
      React.createElement('span', { className: 'dsa-inlineTag' }, t('option.breaker.consecutive')),
      React.createElement('input', {
        type: 'number',
        min: 0,
        value: draft.maxConsecutiveDenials,
        onChange: (e: any) => update({ maxConsecutiveDenials: e.target.value }),
        className: 'dsa-input',
        style: { width: 80 },
      }),
      React.createElement('span', { className: 'dsa-inlineTag' }, t('option.breaker.cumulative')),
      React.createElement('input', {
        type: 'number',
        min: 0,
        value: draft.maxTotalDenials,
        onChange: (e: any) => update({ maxTotalDenials: e.target.value }),
        className: 'dsa-input',
        style: { width: 80 },
      }),
    ), t('settings.denialBreakerHint')),
    row(t('settings.breakerAntiHijack'), React.createElement('input', {
      type: 'number',
      min: 0,
      value: draft.breakerAntiHijackMs,
      onChange: (e: any) => update({ breakerAntiHijackMs: e.target.value }),
      className: 'dsa-input',
      style: { width: 110 },
    }), t('settings.breakerAntiHijackHint')),
    row(t('settings.directHuman.title'), React.createElement(CapsuleSelect, {
      value: draft.directHumanEnabled,
      options: onOffOptions(),
      onChange: (v: string) => update({ directHumanEnabled: v as 'on' | 'off' }),
    }), t('settings.directHuman.desc')),
  )

  // Test-result line: level-coded colors so a failed probe is unmistakable —
  // a leading "HTTP <code>" is rendered red, the provider's error detail white;
  // success is green, transient/info states stay secondary (2026-09-03 UX).
  const renderTestResult = (r: { kind: 'ok' | 'err' | 'info'; text: string }) => {
    if (r.kind === 'ok') {
      return React.createElement('span', { className: 'dsa-success', role: 'status' }, r.text)
    }
    if (r.kind === 'err') {
      const m = r.text.match(/^(HTTP \d+)(?::\s*)?(.*)$/s)
      if (m) {
        return React.createElement('span', { role: 'status', style: { fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
          React.createElement('strong', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, m[1]),
          m[2] ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, m[2]) : null,
        )
      }
      return React.createElement('span', { className: 'dsa-failed', role: 'status' }, r.text)
    }
    return React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, r.text)
  }

  // One model-source section for a lane (快速判断/深度评审). The source menu
  // lists the three sources directly (session / preset / endpoint): session
  // follows the conversation, preset rides a host DSH model (catalog choices
  // fill the pair, free text allowed), endpoint marks the legacy shared custom
  // endpoint (configured once below both lanes).
  const sourceSection = (lane: 'classifier' | 'reviewer') => {
    const title = lane === 'classifier'
      ? t('settings.reviewer.source.classifier')
      : t('settings.reviewer.source.reviewer')
    const hint = lane === 'classifier'
      ? t('settings.reviewer.source.classifierHint')
      : t('settings.reviewer.source.reviewerHint')
    const { source, provider, model } = laneDraft(lane)
    const menuOptions: CapsuleOption[] = [
      { value: 'session', label: t('option.modelSource.session') },
      { value: 'preset', label: t('option.modelSource.preset') },
      { value: 'endpoint', label: t('option.modelSource.endpoint') },
    ]
    return React.createElement('div', { className: 'dsa-subSection', style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))', paddingTop: 10 } },
      React.createElement('div', { className: 'dsa-titleRow' },
        React.createElement('span', { className: 'dsa-title' }, title),
      ),
      React.createElement('p', { className: 'dsa-hint', style: { margin: '4px 0 8px' } }, hint),
      row(t('settings.reviewer.source.label'), React.createElement(CapsuleSelect, {
        value: source,
        options: menuOptions,
        onChange: (v: string) => setLaneSource(lane, v as 'session' | 'preset' | 'endpoint'),
      })),
      source === 'preset'
        ? React.createElement('div', { style: { display: 'grid', gap: 6 } },
            row(t('settings.reviewer.source.provider'), React.createElement(Input, {
              value: provider,
              onChange: (e: any) => laneUpdate(lane, { provider: e.target.value }),
              placeholder: t('settings.reviewer.source.providerPlaceholder'),
              className: 'dsa-input',
            })),
            row(t('settings.reviewer.source.model'), React.createElement(Input, {
              value: model,
              onChange: (e: any) => laneUpdate(lane, { model: e.target.value }),
              placeholder: t('settings.reviewer.source.modelPlaceholder'),
              className: 'dsa-input',
            })),
            llmPresetModels && llmPresetModels.length > 0
              ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  llmPresetModels.slice(0, 30).map((m: any) => React.createElement('button', {
                    key: presetLabel(m),
                    type: 'button',
                    className: provider === m.provider && model === m.id ? 'dsa-chip dsa-chipActive' : 'dsa-chip',
                    onClick: () => choosePreset(lane, presetLabel(m)),
                  }, presetLabel(m))),
                )
              : null,
          )
        : null,
      source === 'endpoint'
        ? React.createElement('p', { className: 'dsa-hint', style: { margin: '8px 0 0' } }, t('settings.reviewer.source.endpointSharedHint'))
        : React.createElement('p', { className: 'dsa-hint', style: { margin: '8px 0 0' } }, t('settings.reviewer.source.hint')),
    )
  }

  // Reasoning-effort options for one lane. With a concrete preset pair whose
  // adapter-declared catalog is loaded, the picker offers exactly that model's
  // efforts (plus the '' default); the stored value is kept visible even when
  // it is not in the catalog, so a configured-but-unsupported effort is never
  // silently hidden. Without a catalog (session/endpoint source, empty pair,
  // load failure) the full vocabulary is offered — the host accepts every
  // value and an unsupported one fails that call loudly, never silently.
  const laneReasoningOptions = (lane: 'classifier' | 'reviewer'): CapsuleOption[] => {
    const current = lane === 'classifier' ? (draft.classifierReasoning ?? '') : (draft.reviewerReasoning ?? '')
    const loaded = laneEfforts[lane]
    if (!loaded || loaded.efforts.length === 0) return reasoningOptions()
    const options: CapsuleOption[] = [{ value: '', label: t('option.reasoning.default') }]
    for (const e of loaded.efforts) {
      if (e.id === '') continue
      options.push({ value: e.id, label: e.name || e.id })
    }
    if (current !== '' && !options.some((o) => o.value === current)) {
      options.push({ value: current, label: current })
    }
    return options
  }

  const buildReviewBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.reviewer.description')),
    sourceSection('classifier'),
    sourceSection('reviewer'),
    React.createElement('div', { className: 'dsa-subSection', style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))', paddingTop: 10 } },
      React.createElement('div', { className: 'dsa-titleRow' },
        React.createElement('span', { className: 'dsa-title' }, t('settings.reviewer.paramsTitle')),
      ),
      React.createElement('p', { className: 'dsa-hint', style: { margin: '4px 0 8px' } }, t('settings.reviewer.paramsHint')),
      row(t('settings.reviewer.reviewerReasoning'), React.createElement(CapsuleSelect, {
        value: draft.reviewerReasoning ?? '',
        options: laneReasoningOptions('reviewer'),
        onChange: (v: string) => update({ reviewerReasoning: v }),
      }), t('settings.reviewer.reasoningHint')),
      row(t('settings.reviewer.classifierReasoning'), React.createElement(CapsuleSelect, {
        value: draft.classifierReasoning ?? '',
        options: laneReasoningOptions('classifier'),
        onChange: (v: string) => update({ classifierReasoning: v }),
      }), t('settings.reviewer.reasoningHint')),
      row(t('settings.reviewer.reviewerMaxTokens'), React.createElement('input', {
        type: 'number',
        min: 256,
        max: 16384,
        step: 256,
        value: draft.reviewerMaxTokens,
        onChange: (e: any) => update({ reviewerMaxTokens: e.target.value }),
        className: 'dsa-input',
        style: { width: 110 },
      }), t('settings.reviewer.maxTokensHint')),
    ),
    React.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))', paddingTop: 10 } },
    React.createElement('div', { className: 'dsa-titleRow' },
      React.createElement('span', { className: 'dsa-title' }, t('settings.reviewer.endpointTitle')),
      React.createElement('span', { className: 'dsa-titleBadge', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('settings.reviewer.endpointLegacy')),
    ),
    React.createElement('p', { className: 'dsa-hint', style: { margin: '4px 0 8px' } }, t('settings.reviewer.endpointHint')),
    row(t('settings.reviewer.protocol'), React.createElement(CapsuleSelect, {
      value: draft.endpointProtocol,
      options: protocolOptions(),
      onChange: (v: string) => update({ endpointProtocol: v as 'openai' | 'anthropic' }),
    })),
    row(t('settings.reviewer.baseUrl'), React.createElement(Input, {
      value: draft.endpointUrl,
      onChange: (e: any) => update({ endpointUrl: e.target.value }),
      placeholder: t('settings.reviewer.baseUrlPlaceholder'),
      className: 'dsa-input',
    })),
    row(t('settings.reviewer.modelName'), React.createElement(Input, {
      value: draft.endpointModel,
      onChange: (e: any) => update({ endpointModel: e.target.value }),
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
    row(t('settings.reviewer.maxRetries'), React.createElement('input', {
      type: 'number',
      min: 0,
      max: 2,
      value: draft.reviewMaxRetries,
      onChange: (e: any) => update({ reviewMaxRetries: e.target.value }),
      className: 'dsa-input',
      style: { width: 80 },
    }), t('settings.reviewer.maxRetriesHint')),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      React.createElement(Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: testOnline }, t('settings.reviewer.test')),
      credentialConfigured && credentialWritable
        ? React.createElement(Button, { variant: 'outline', size: 'sm', disabled: saving, onClick: clearReviewerCredential }, t('settings.reviewer.clearKey'))
        : null,
      testResult ? renderTestResult(testResult) : null,
    ),
    ),
  )

  const buildSecurityBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    field(t('settings.rules.safetyPrompt'),
      React.createElement(React.Fragment, null,
        React.createElement('textarea', {
          value: draft.safetyPrompt,
          onChange: (e: any) => update({ safetyPrompt: e.target.value }),
          rows: 5,
          placeholder: t('settings.rules.safetyPromptPlaceholder'),
          className: 'dsa-textarea',
        }),
        // Read-only preview of exactly what the review model receives as its
        // system prompt: REVIEWER_SYSTEM + this safety prompt + the declared
        // rules summary, assembled live from the CURRENT draft. Purely
        // informational — never edits the field above and needs no save.
        showReviewerPreview
          ? React.createElement('div', { className: 'dsa-reviewerPreview' },
              React.createElement('div', { className: 'dsa-reviewerPreviewHead' },
                React.createElement('span', null, t('settings.rules.previewDesc')),
              ),
              React.createElement('pre', { className: 'dsa-reviewerPreviewBody' },
                assembleReviewerSystem(draft.safetyPrompt, draft.rulesText),
              ),
            )
          : null,
      ),
      undefined,
      React.createElement('button', {
        type: 'button',
        className: showReviewerPreview ? 'dsa-segBtn dsa-segBtnActive' : 'dsa-segBtn',
        onClick: () => setShowReviewerPreview((v) => !v),
      }, showReviewerPreview ? t('settings.rules.previewBack') : t('settings.rules.previewShow')),
    ),
    field(t('settings.rules.lists'),
      React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dsa-segRow' },
          listTabButton('allow', t('settings.rules.listAllow')),
          listTabButton('deny', t('settings.rules.listDeny')),
          listTabButton('human', t('settings.rules.listHuman')),
        ),
        React.createElement('textarea', {
          value: listTab === 'allow' ? draft.allowlist : listTab === 'deny' ? draft.denyList : draft.humanOnlyList,
          onChange: (e: any) => update(
            listTab === 'allow' ? { allowlist: e.target.value }
              : listTab === 'deny' ? { denyList: e.target.value }
                : { humanOnlyList: e.target.value },
          ),
          rows: 4,
          className: 'dsa-textarea',
        }),
        // Recent-tool chips (advisory candidates for the active list): fetched
        // from the host once the card opens; clicking one edits the textarea
        // above through the normal draft path (保存 still applies it).
        toolStatsError
          ? React.createElement('p', { className: 'dsa-chipDesc', style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('settings.rules.chipsError'))
          : toolStats
            ? React.createElement(React.Fragment, null,
                chipsForActiveTab.length > 0
                  ? React.createElement(React.Fragment, null,
                      React.createElement('p', { className: 'dsa-chipDesc' }, t(`settings.rules.chipsHint.${listTab}`)),
                      React.createElement('div', { className: 'dsa-chipRow' }, ...chipNodes()),
                    )
                  : React.createElement('p', { className: 'dsa-chipDesc' }, t('settings.rules.chipsEmpty')),
              )
            : React.createElement('p', { className: 'dsa-chipDesc' }, t('settings.rules.chipsLoading')),
        React.createElement('small', { className: 'dsa-desc', style: { display: 'block' } }, t('settings.rules.listsHint')),
        // Reference: which tools the policy allows unconditionally (pure
        // display of the constants catalog — these never need to be listed).
        React.createElement('div', { className: 'dsa-chipRow', style: { marginTop: 2 } },
          React.createElement('button', {
            type: 'button',
            className: showDefaultAllow ? 'dsa-segBtn dsa-segBtnActive' : 'dsa-segBtn',
            onClick: () => setShowDefaultAllow((v) => !v),
          }, showDefaultAllow ? t('settings.rules.defaultAllowHide') : t('settings.rules.defaultAllowShow')),
        ),
        showDefaultAllow
          ? React.createElement('div', { className: 'dsa-defaultAllow' },
              React.createElement('p', { className: 'dsa-chipDesc' }, t('settings.rules.defaultAllowDesc')),
              ...DEFAULT_ALLOW_TOOL_GROUPS.map((group) =>
                React.createElement('div', { key: group.label, className: 'dsa-defaultAllowGroup' },
                  React.createElement('div', { className: 'dsa-defaultAllowGroupLabel' }, t(`settings.rules.allowGroup.${group.label}`)),
                  React.createElement('div', { className: 'dsa-defaultAllowTools' },
                    ...group.tools.map((tool) => React.createElement('code', { key: tool, className: 'dsa-defaultAllowTool' }, tool)),
                  ),
                ),
              ),
            )
          : null,
      ),
    ),
    field(t('settings.rules.rulesText'), React.createElement('textarea', {
      value: draft.rulesText,
      onChange: (e: any) => update({ rulesText: e.target.value }),
      rows: 5,
      placeholder: '# Claude 式声明规则（每行一条）\nbash,git(^git\\s+push\\b) | deny | arguments\n(?i)rm\\s+(-[a-z]+\\s+)*/ | human | arguments\nwrite,edit\\(.*://.*\\) | deny | arguments',
      className: 'dsa-textarea dsa-code',
    }), t('settings.rules.rulesTextHint')),
    row(t('settings.rulesDryRun'), React.createElement(CapsuleSelect, {
      value: draft.rulesDryRun,
      options: onOffOptions(),
      onChange: (v: string) => update({ rulesDryRun: v as 'on' | 'off' }),
    }), t('settings.rulesDryRunHint')),
    ...(parseRulesText(draft.rulesText).errors.map((er) => React.createElement('p', {
      key: er.line,
      style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '2px 0 0' },
    }, `L${er.line}: ${er.message}`))),
    ...(parseRulesText(draft.rulesText).errors.length > 0
      ? [React.createElement('p', {
          key: 'rules-blocked',
          style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '2px 0 0' },
        }, t('settings.rules.rulesTextBlocked'))]
      : []),
  )

  const buildCategoryBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    row(t('settings.category.mode'), React.createElement(CapsuleSelect, {
      value: draft.categoryMode,
      options: categoryModeOptions(),
      onChange: (v: string) => update({ categoryMode: v as 'standard' | 'aggressive' }),
    }), t('settings.category.modeHint')),
    row(t('settings.category.privilegeAutoReview'), React.createElement(CapsuleSelect, {
      value: draft.privilegeAutoReview,
      options: onOffOptions(),
      onChange: (v: any) => update({ privilegeAutoReview: v as 'on' | 'off' }),
    }), t('settings.category.privilegeAutoReviewHint')),
    draft.categoryMode === 'aggressive'
      ? React.createElement('p', { className: 'dsa-hint', style: { margin: 0, color: 'var(--dsw-alias-state-warn-primary)' } }, t('settings.category.aggressiveNotice'))
      : null,
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.category.policyHint')),
    ...CATEGORY_KEY_LIST.map((key) => {
      const locked = CATEGORY_LOCKED_LIST.includes(key) && !(key === 'privilege' && draft.privilegeAutoReview === 'on')
      const options: CapsuleOption[] = [
        { value: '', label: t('settings.category.inherit') },
        { value: 'auto', label: t('option.category.value.auto') },
        { value: 'ask', label: t('option.category.value.ask') },
        { value: 'deny', label: t('option.category.value.deny') },
      ]
      return row(t(`category.${key}` as any),
        React.createElement(CapsuleSelect, {
          value: draft.categoryPolicy[key] ?? '',
          options: locked ? options.filter((o) => o.value === '' || o.value === 'ask') : options,
          onChange: (v: string) => {
            const next = { ...draft.categoryPolicy }
            if (v === '') delete next[key]
            else next[key] = v as 'auto' | 'ask' | 'deny'
            update({ categoryPolicy: next })
          },
        }),
        locked ? t('settings.category.lockedHint') : undefined,
      )
    }),
  )

  const buildCategoryFooter = () => React.createElement(React.Fragment, null,
    statusLine('category'),
    React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      disabled: saving || !snapshot.writable,
      onClick: () => {
        setDraft({ ...draft, categoryPolicy: baseDraft.categoryPolicy ?? {}, categoryMode: baseDraft.categoryMode ?? 'standard', privilegeAutoReview: baseDraft.privilegeAutoReview ?? 'off' })
        setCardStatus({ id: 'category', kind: 'ok', text: '' })
      },
    }, t('settings.discard')),
    React.createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: saving || !snapshot.writable || !categoryDirty,
      onClick: () => saveCard(['categoryPolicy', 'categoryMode', 'privilegeAutoReview'], 'category'),
    }, saving ? t('settings.saving') : t('settings.save')),
  )

  const buildUtilityBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    row(t('settings.onboardingMessage'), React.createElement(CapsuleSelect, {
      value: draft.onboardingMessageEnabled,
      options: [{ label: t('option.off'), value: 'off' }, { label: t('option.on'), value: 'on' }],
      onChange: (v: any) => update({ onboardingMessageEnabled: v as 'on' | 'off' }),
    }), t('settings.onboardingMessageHint')),
    row(t('settings.rules.redactResults'), React.createElement(CapsuleSelect, {
      value: draft.redactResults,
      options: onOffOptions(),
      onChange: (v: any) => update({ redactResults: v as 'on' | 'off' }),
    }), t('settings.rules.redactResultsHint')),
    row(t('settings.rules.editDiffPreview'), React.createElement(CapsuleSelect, {
      value: draft.editDiffPreview,
      options: onOffOptions(),
      onChange: (v: any) => update({ editDiffPreview: v as 'on' | 'off' }),
    }), t('settings.rules.editDiffPreviewHint')),
    row(t('settings.utility.rejectGuidance'), React.createElement(CapsuleSelect, {
      value: draft.rejectGuidance,
      options: onOffOptions(),
      onChange: (v: any) => update({ rejectGuidance: v as 'on' | 'off' }),
    }), t('settings.utility.rejectGuidanceHint')),
  )

  const buildLearningBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    row(t('settings.learning.enabled'), React.createElement(CapsuleSelect, {
      value: draft.learningEnabled,
      options: onOffOptions(),
      onChange: (v: string) => update({ learningEnabled: v as 'on' | 'off' }),
    }), t('settings.learning.enabledHint')),
    draft.learningEnabled === 'on' ? row(t('settings.learning.threshold'), React.createElement('input', {
      type: 'number',
      min: 2,
      max: 10,
      step: 1,
      value: draft.learningThreshold,
      onChange: (e: any) => update({ learningThreshold: e.target.value }),
      className: 'dsa-input',
    }), t('settings.learning.thresholdHint')) : null,
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.howItWorks')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.safetyNote')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.fallbackNote')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.scopeNote')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.capNote')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.ttlNote')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.denyResetNote')),
    React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.entriesTitle')),
    learningEntriesError
      ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: 0 } }, learningEntriesError)
      : null,
    learningEntries.length === 0
      ? React.createElement('p', { className: 'dsa-hint', style: { margin: 0 } }, t('settings.learning.entriesEmpty'))
      : React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 } },
          ...learningEntries.map((e: any) => React.createElement('div', {
            key: e.key,
            style: {
              padding: '6px 8px',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              fontSize: 12,
              background: 'var(--dsw-alias-bg-layer-1)',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            },
          },
            React.createElement('span', { style: { flex: 1, fontFamily: 'var(--ds-font-family-code, monospace)', color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.skeleton),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none' } }, t('settings.learning.entryMeta', { count: e.count })),
            React.createElement(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: saving || !snapshot.writable,
              onClick: () => {
                void (async () => {
                  setCardStatus({ id: 'learning', kind: 'ok', text: '' })
                  const res = await (globalThis as any).fetch(LEARNING_STORE_ROUTE, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: e.key }),
                    credentials: 'same-origin',
                  })
                  const data = await res.json()
                  if (!data?.ok) {
                    setCardStatus({ id: 'learning', kind: 'err', text: t('settings.learning.revokeFailed') })
                    return
                  }
                  setLearningEntries(learningEntries.filter((x: any) => x.key !== e.key))
                  setCardStatus({ id: 'learning', kind: 'ok', text: t('settings.learning.revoked') })
                })()
              },
            }, t('settings.learning.revoke')))),
          ),
  )

  // One latency summary line for a lane. Empty lanes render their localized
  // hint (still counted when both lanes are empty, e.g. pre-first-call).
  const latencyLine = (label: string, stat: any) => {
    if (stat === null || stat === undefined) return null
    if ((stat.count ?? 0) === 0 && (stat.abortedCount ?? 0) === 0) return null
    if ((stat.count ?? 0) === 0) {
      return React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0' } },
        React.createElement('span', null, label),
        React.createElement('span', null, t('settings.history.llmLatencyEmpty')),
      )
    }
    return React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0', flexWrap: 'wrap' } },
      React.createElement('span', null, label),
      React.createElement('span', null, t('settings.history.llmLatency', {
        count: String(stat.count),
        min: formatLatencySeconds(stat.minMs),
        avg: formatLatencySeconds(stat.avgMs),
        max: formatLatencySeconds(stat.maxMs),
        aborted: String(stat.abortedCount ?? 0),
      })),
    )
  }

  const buildHistoryBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 } },
    historyError ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: 0 } }, historyError) : null,
    // Latency lines by lane: deep review (llmLatency, backward compatible) and
    // fast decision (llmLatencyClassifier). A lane with no samples shows its
    // empty hint instead of a blank row.
    latencyLine(t('settings.history.llmLatencyReviewer'), llmLatency),
    latencyLine(t('settings.history.llmLatencyClassifier'), llmLatencyClassifier),
    React.createElement('input', {
      placeholder: t('settings.history.searchPlaceholder'),
      value: search,
      onChange: (e: any) => { setSearch(e.target.value); setPage(0) },
      className: 'dsa-input',
    }),
    filteredHistory.length === 0
      ? React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 } }, t('settings.history.empty'))
      : React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 } },
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
              (((r.reason ?? r.llmReason) ? ` — ${r.reason ?? r.llmReason}` : '')) +
              ((r.llmTookMs ? ` · LLM ${formatTookMs(r.llmTookMs)}` : '')) +
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
    // First-use onboarding block: rendered above the sub-card list, only until
    // the once-per-browser flag is persisted (first collapse marks it seen).
    // The timeout sentence always renders the LIVE timeoutAction label.
    open && !onboardingDismissed
      ? React.createElement('div', { className: 'dsa-onboarding' },
          React.createElement('div', { className: 'dsa-onboardingCard' },
            React.createElement('div', { className: 'dsa-onboardingTitle' }, t('settings.onboarding.title')),
            React.createElement('ul', { className: 'dsa-onboardingList' },
              React.createElement('li', { className: 'dsa-onboardingItem' }, t('settings.onboarding.item1')),
              React.createElement('li', { className: 'dsa-onboardingItem' }, t('settings.onboarding.item2', { timeout: timeoutActionLabel(draft.timeoutAction) })),
              React.createElement('li', { className: 'dsa-onboardingItem' }, t('settings.onboarding.item3')),
            ),
            React.createElement('p', { className: 'dsa-onboardingTip' }, t('settings.onboarding.tip')),
          ),
        )
      : null,
    subcard(t('settings.timers.title'), openTimers, timerDirty, () => setOpenTimers((o) => !o), buildTimerBody, buildTimerFooter, undefined, t('settings.group.safetyBase')),
    subcard(t('settings.rules.title'), openSecurity, securityDirtyEff, () => setOpenSecurity((o) => !o), buildSecurityBody, buildSecurityFooter,
      securityDirtyEff
        ? React.createElement('span', { className: 'dsa-pending' }, t('settings.unsaved'))
        : null, t('settings.group.safetyBase')),
    subcard(t('settings.category.title'), openCategory, categoryDirty, () => setOpenCategory((o) => !o), buildCategoryBody, buildCategoryFooter, undefined, t('settings.group.safetyBase')),
    subcard(t('settings.learning.title'), openLearning, learningDirty, () => setOpenLearning((o) => !o), buildLearningBody, () => cardFooter(LEARNING_KEYS, 'learning', learningDirty), undefined, t('settings.group.safetyBase')),
    subcard(t('settings.utility.title'), openUtility, utilityDirty, () => setOpenUtility((o) => !o), buildUtilityBody, () => cardFooter(UTILITY_KEYS, 'utility', utilityDirty)),
    subcard(t('settings.reviewer.title'), openReview, reviewDirty, () => setOpenReview((o) => !o), buildReviewBody, buildReviewFooter),
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
    error ? React.createElement('p', { className: 'dsa-failed', role: 'status' }, error) : null,
  );
  return React.createElement('li', { className: open ? 'dsa-card dsa-cardOpen' : 'dsa-card' },
    React.createElement('button', {
      type: 'button',
      className: 'dsa-header',
      'aria-expanded': open,
      onClick: toggleCard,
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
    ;(globalThis as any).fetch(SESSION_MODE_ROUTE, {
      credentials: 'same-origin',
      // Session id travels in a request header, never the URL query (the same
      // discipline as the review-status call-id header), so it cannot leak
      // into devtools/logs/Referer.
      headers: { 'x-auto-approval-session-id': sessionId },
    })
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
      g.fetch(SESSION_MODE_ROUTE, {
        credentials: 'same-origin',
        headers: { 'x-auto-approval-session-id': sessionId },
      })
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
  if (!computePanelVisible(panelMode, sessionMode)) return null

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
        : React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 } },
            records.slice(0, MAX_PANEL_RECORDS).map((r: any) => React.createElement('div', {
              key: r.id,
              className: 'dsa-recordClamp',
              style: { padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' },
            },
              t('record.line', { time: formatShortDateTime(r.at), toolName: r.toolName, source: r.source, outcome: r.outcome }) +
              (((r.reason ?? r.llmReason) ? ` — ${r.reason ?? r.llmReason}` : '')) +
              ((r.llmTookMs ? ` · LLM ${formatTookMs(r.llmTookMs)}` : '')) +
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
          (((r.reason ?? r.llmReason) ? ` — ${r.reason ?? r.llmReason}` : '')) +
          ((r.llmTookMs ? ` · LLM ${formatTookMs(r.llmTookMs)}` : '')) +
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
        const res = await g.fetch(SESSION_MODE_ROUTE, {
          credentials: 'same-origin',
          headers: { 'x-auto-approval-session-id': currentSessionId },
        })
        const data = await res.json()
        sessionMode = data?.ok ? data.value.mode : undefined
      } catch {
        sessionMode = undefined
      }
    } else {
      sessionMode = undefined
    }
    const visible = buttonPosition === 'floating' && computePanelVisible(panelMode, sessionMode)
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
.dsa-failed{min-width:0;color:var(--dsw-alias-state-error-primary);flex:1;margin:0;font-size:12px;line-height:1.5}
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
.dsa-segRow{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dsa-segBtn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 12px;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.dsa-segBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsa-segBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsa-segBtnActive,.dsa-segBtnActive:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsa-chipDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.dsa-chipRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsa-chip{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px 10px;font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,monospace)}
.dsa-chip:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}
.dsa-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsa-chipClass{border-style:dashed;color:var(--dsw-alias-brand-primary)}
.dsa-chipMore{border-color:transparent;color:var(--dsw-alias-label-tertiary);background:transparent}
.dsa-defaultAllow{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:grid;gap:8px}
.dsa-defaultAllowGroup{display:grid;gap:4px}
.dsa-defaultAllowGroupLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.dsa-defaultAllowTools{display:flex;flex-wrap:wrap;gap:4px}
.dsa-defaultAllowTool{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap}
.dsa-inlineTag{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
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
.dsa-menu{box-sizing:border-box;padding:4px;display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);position:absolute;top:calc(100% + 4px);left:auto;right:0;z-index:100;min-width:218px;max-width:360px;max-height:min(56vh,360px);overflow-y:auto}
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
.dsa-subcardBody{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:4px 16px 14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-subcardFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-badgeOk,.dsa-badgeMuted{white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;border:1px solid var(--dsw-alias-border-l1);flex:none}
.dsa-badgeOk{color:var(--dsw-alias-state-success-primary);background:rgba(var(--dsw-alias-state-success-primary-rgb,34 197 94),0.08)}
.dsa-badgeMuted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}
.dsa-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0}
.dsa-row+.dsa-row{border-top:1px solid var(--dsw-alias-border-l2)}
.dsa-rowText{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.dsa-titleRow{display:flex;align-items:center;gap:8px;min-width:0}
.dsa-titleRow .dsa-title{flex:none}
.dsa-titleExtra{margin-left:auto;flex:none;display:inline-flex;align-items:center}
.dsa-reviewerPreview{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dsa-reviewerPreviewHead{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dsa-reviewerPreviewBody{margin:0;padding:10px;font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;color:var(--dsw-alias-label-primary);user-select:text}
.dsa-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dsa-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.dsa-control{flex:none;display:flex;align-items:center;gap:8px}
.dsa-control .dsa-input{width:240px;min-width:0}
.dsa-alert{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.5}
.dsa-alertError{color:var(--dsw-alias-state-error-primary);background:rgba(var(--dsw-alias-state-error-primary-rgb,236 19 19),0.08);border:1px solid var(--dsw-alias-state-error-primary)}
.dsa-alertText{flex:1;min-width:0;overflow-wrap:anywhere}
.dsa-resetButton{border-radius:8px!important;height:auto!important;padding:5px 14px!important}
.dsa-diff{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);margin:8px 0;padding:6px 10px;font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:1.6;max-height:280px;overflow:auto}
.dsa-diffHead{color:var(--dsw-alias-label-primary);font-weight:600;padding:2px 0 4px;white-space:pre-line}
.dsa-diffBody{display:grid}
.dsa-diffLine{white-space:pre-wrap;word-break:break-word;padding:0 6px;border-left:3px solid transparent}
.dsa-diffLine::before{display:inline-block;width:1.4em;margin-left:-6px;color:var(--dsw-alias-label-tertiary)}
.dsa-diffDel{color:var(--dsw-alias-label-secondary);background:rgba(var(--dsw-alias-state-error-primary-rgb,236 19 19),0.10);border-left-color:var(--dsw-alias-state-error-primary)}
.dsa-diffDel::before{content:'−';color:var(--dsw-alias-state-error-primary)}
.dsa-diffAdd{color:var(--dsw-alias-label-secondary);background:rgba(var(--dsw-alias-state-success-primary-rgb,34 197 94),0.10);border-left-color:var(--dsw-alias-state-success-primary)}
.dsa-diffAdd::before{content:'+';color:var(--dsw-alias-state-success-primary)}
.dsa-diffCtx{color:var(--dsw-alias-label-tertiary)}
.dsa-diffCtx::before{content:'·'}
.dsa-diffToggle{appearance:none;background:transparent;border:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:3px 6px;border-radius:6px}
.dsa-diffToggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsa-onboardingCard{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.dsa-onboardingTitle{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px;line-height:1.5}
.dsa-onboardingList{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsa-onboardingTip{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:0}
.dsa-groupTag{flex:none;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
`
  g.document.head.appendChild(style)
  return () => { style.remove() }
}

export function apply(ctx: any): void {
  sessionsRef = ctx.get('sessions')
  const locale = ctx.get('locale')
  localeService = locale
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
  ctx.effect(() => watchRemoteApprovals(ctx), 'dsh-auto-approval-llm: approval watcher (remote)')
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
