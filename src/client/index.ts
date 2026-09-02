import React from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { normalizeTimeoutAction, hasBreakerNote } from '../auto/decision.js'
import { THRESHOLD_DEFAULTS } from '../auto/constants.js'
import { parseRulesText } from '../auto/rules.js'
import { installAutoPermissionIcon } from './auto-icon.js'
import { zh, en } from './locale.js'
import { computeTextNodeRewrites, createBreakerGuard, parseCountdown } from './approvals/shared.js'
import type { CountdownInfo } from './approvals/shared.js'
import { watchLegacyApprovals } from './approvals/legacy.js'
import { watchRemoteApprovals } from './approvals/remote.js'

export const name = 'dsh-auto-approval-llm'
export const inject = ['slots', 'sessions']

const SETTINGS_ROUTE = '/_dsh/auto-approval-llm/settings'
const HISTORY_ROUTE = '/_dsh/auto-approval-llm/history'
const TEST_ROUTE = '/_dsh/auto-approval-llm/test'
const REVIEWER_CREDENTIAL_ROUTE = '/_dsh/auto-approval-llm/reviewer-credential'
const LEARNING_STORE_ROUTE = '/_dsh/auto-approval-llm/learning-store'
const SESSION_MODE_ROUTE = '/_dsh/auto-approval-llm/session-mode'
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
  onboardingMessageEnabled: 'on' | 'off'
  autoModeNoticeEnabled: 'on' | 'off'
  breakerAntiHijackMs: string
  aiButtonPosition: 'header' | 'floating'
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
    onboardingMessageEnabled: value?.onboardingMessageEnabled === false ? 'off' : 'on',
    autoModeNoticeEnabled: value?.autoModeNoticeEnabled === false ? 'off' : 'on',
    breakerAntiHijackMs: String(value?.breakerAntiHijackMs ?? THRESHOLD_DEFAULTS.breakerAntiHijackMs),
    aiButtonPosition: value?.aiButtonPosition === 'floating' ? 'floating' : 'header',
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
    aiButtonPosition: draft.aiButtonPosition,
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
  enabled: 'boolean', autoSwitchPolicyToAsk: 'boolean', rulesDryRun: 'boolean', notifyUser: 'boolean', debug: 'boolean', redactResults: 'boolean', editDiffPreview: 'boolean', rejectGuidance: 'boolean', learningEnabled: 'boolean',
  lowRiskSeconds: 'number', mediumRiskSeconds: 'number', highRiskSeconds: 'number', learningThreshold: 'number',
  maxConsecutiveDenials: 'number', maxTotalDenials: 'number', breakerAntiHijackMs: 'number',
  maxArgsChars: 'number', classifierTimeoutMs: 'number', classifierMaxOutputTokens: 'number',
  workspaceRoot: 'string', dshHome: 'string', safetyPrompt: 'string', rulesText: 'string',
  reviewerModel: 'string', reviewerBaseUrl: 'string', timeoutAction: 'string',
  allowlist: 'array', denyList: 'array', humanOnlyList: 'array', tempRoots: 'array',
  categoryPolicy: 'object', categoryMode: 'string', trustedDirs: 'array',
}
const INVALID_CONFIG_ENUMS: Record<string, string[]> = {
  timeoutAction: ['reject', 'allow', 'low-risk-allow'],
  llmReviewScope: ['low-or-above', 'medium-or-above', 'high'],
  llmTakeoverScope: ['low', 'medium-or-below', 'high-or-below'],
  defaultReviewMode: ['manual', 'smart', 'unattended'],
  showSessionPanel: ['on', 'auto', 'off'],
  aiButtonPosition: ['header', 'floating'],
  reviewerProtocol: ['openai', 'anthropic'],
  categoryMode: ['standard', 'aggressive'],
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
  const [openCategory, setOpenCategory] = React.useState(false)
  const [openLearning, setOpenLearning] = React.useState(false)
  const [openUtility, setOpenUtility] = React.useState(false)
  const [learningEntries, setLearningEntries] = React.useState<any[]>([])
  const [learningEntriesError, setLearningEntriesError] = React.useState('')
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
  // Which exact-list textarea the segmented tabs currently show.
  const [listTab, setListTab] = React.useState<'allow' | 'deny' | 'human'>('allow')

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
    if (Object.keys(patch).some((k) => SECURITY_KEYS.includes(k))) setSecurityActive(true)
  }

  // Per-card ownership: saving a card only persists the fields it owns,
  // overlaid on the last-saved baseline; other cards' unsaved edits are left
  // in the local draft and never accidentally persisted by another card.
  const TOP_KEYS = ['enabled', 'autoSwitchPolicyToAsk', 'timeoutAction', 'llmReviewScope', 'llmTakeoverScope', 'defaultReviewMode', 'showSessionPanel', 'aiButtonPosition', 'autoModeNoticeEnabled']
  const TIMER_KEYS = ['breakerAntiHijackMs', 'lowRiskSeconds', 'mediumRiskSeconds', 'highRiskSeconds', 'maxConsecutiveDenials', 'maxTotalDenials', 'reviewWaitSeconds']
  const REVIEW_KEYS = ['reviewerProtocol', 'reviewerBaseUrl', 'reviewerModel']
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

  // Derived preset id: matches a profile only for the exact stored pair;
  // anything else renders as the inert custom entry.
  const scopePresetId = SCOPE_PRESETS.find((p) => p.review === draft.llmReviewScope && p.takeover === draft.llmTakeoverScope)?.id ?? 'custom'
  // Top-level capsule toggles save immediately (original behavior). Only the
  // toggled key is committed on the saved baseline, so unsaved edits inside the
  // other cards are never persisted or lost; the local draft keeps them.
  // Instant-save accepts a multi-key patch so one control can commit several
  // keys atomically (single POST, single expectedRevision check).
  const instantSaveKeys = async (patch: Record<string, unknown>) => {
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
      reviewWaitSeconds: String(THRESHOLD_DEFAULTS.reviewWaitSeconds),
      breakerAntiHijackMs: String(THRESHOLD_DEFAULTS.breakerAntiHijackMs),
      maxConsecutiveDenials: String(THRESHOLD_DEFAULTS.maxConsecutiveDenials),
      maxTotalDenials: String(THRESHOLD_DEFAULTS.maxTotalDenials),
    })
  }

  const resetReviewerCard = async () => {
    // One-tap factory reset of the online-reviewer card: default the three
    // config keys, persist them, and clear the reviewer API key (credential
    // store + file fallback) so no secret survives the reset.
    const merged = { ...draftOf(snapshot.value), reviewerProtocol: 'openai', reviewerBaseUrl: '', reviewerModel: '' }
    setDraft({ ...draft, reviewerProtocol: 'openai', reviewerBaseUrl: '', reviewerModel: '' })
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
    } finally {
      setSaving(false)
    }
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

  // Direct-channel completeness precheck, mirroring the host-side snapshot
  // rule: a base URL only enables the online reviewer together with a model
  // name and an API key (already configured in the store, or freshly typed
  // into the key field — saving persists it). Returns the localized missing
  // pieces for the banner, or null when the channel is complete/unused.
  const reviewerDirectMissing = (): string[] | null => {
    if (!draft.reviewerBaseUrl.trim()) return null
    const missing: string[] = []
    if (!draft.reviewerModel.trim()) missing.push(t('settings.reviewer.missingModel'))
    if (!credentialConfigured && !reviewerApiKey.trim()) missing.push(t('settings.reviewer.missingKey'))
    return missing.length > 0 ? missing : null
  }

  const testOnline = async () => {
    const incomplete = reviewerDirectMissing()
    if (incomplete) {
      setTestResult(t('settings.reviewer.incompleteDirect', { missing: incomplete.join(', ') }))
      return
    }
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
    // Block the whole save when the direct trio is incomplete: persisting a
    // half-configured base URL would only demote reviews to the session model
    // host-side, so the user gets the missing pieces listed instead.
    const incomplete = reviewerDirectMissing()
    if (incomplete) {
      setCardStatus({ id: 'review', kind: 'err', text: t('settings.reviewer.incompleteDirect', { missing: incomplete.join(', ') }) })
      return
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
  const field = (label: string, children: React.ReactNode, hint?: string) =>
    React.createElement('div', { className: 'dsa-field' },
      React.createElement('div', { className: 'dsa-title' }, label),
      children,
      hint ? React.createElement('small', { className: 'dsa-desc' }, hint) : null,
    )

  // Segmented pill that picks which exact-list textarea is visible.
  const listTabButton = (id: 'allow' | 'deny' | 'human', label: string) =>
    React.createElement('button', {
      type: 'button',
      className: listTab === id ? 'dsa-segBtn dsa-segBtnActive' : 'dsa-segBtn',
      onClick: () => setListTab(id),
    }, label)

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
    })),
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
  )

  const buildReviewBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
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

  const buildSecurityBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 } },
    field(t('settings.rules.safetyPrompt'), React.createElement('textarea', {
      value: draft.safetyPrompt,
      onChange: (e: any) => update({ safetyPrompt: e.target.value }),
      rows: 5,
      placeholder: t('settings.rules.safetyPromptPlaceholder'),
      className: 'dsa-textarea',
    })),
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
      ),
      t('settings.rules.listsHint'),
    ),
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

  const buildHistoryBody = () => React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 } },
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
        : securityActive
          ? React.createElement('span', { className: 'dsa-pending', title: t('settings.notYetEffectiveHint') }, t('settings.notYetEffective'))
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
    snapshot.applies === 'restart' ? React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 } }, t('settings.restartHint')) : null,
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
        : React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 } },
            records.slice(0, MAX_PANEL_RECORDS).map((r: any) => React.createElement('div', {
              key: r.id,
              className: 'dsa-recordClamp',
              style: { padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' },
            },
              t('record.line', { time: formatShortDateTime(r.at), toolName: r.toolName, source: r.source, outcome: r.outcome }) +
              (((r.reason ?? r.llmReason) ? ` — ${r.reason ?? r.llmReason}` : '')) +
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
  ctx.effect(() => watchLegacyApprovals(ctx), 'dsh-auto-approval-llm: approval watcher (legacy)')
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
