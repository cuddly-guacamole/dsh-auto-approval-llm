/**
 * dsh-auto-approval-llm
 *
 * LLM-assisted approval with a human countdown fallback for DeepSeek Harness.
 *
 * Design (revised after expert review):
 * - Complements dsh-auto-mode: it only claims `approval/request` asks from
 *   sessions whose permission preset is `auto`.
 * - It is registered with `prepend: true`, so it acts as the single terminal
 *   answerer for the asks it handles and never opens a second approval popup.
 * - It runs its own second-model review (arguments recovered from the session
 *   log by callId), then asks the human through `ctx.userQuestions.ask()` with
 *   a bounded countdown. On timeout it applies `timeoutAction`; the default is
 *   fail-closed `reject`.
 * - If `autoSwitchPolicyToAsk` is enabled it only switches sessions that are
 *   already in the `auto` preset and whose approval override is `never`.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtifactRegistry } from './auto/artifacts.js'
import { appendAuditLine, recordAuditClear } from './auto/audit.js'
import { AGGRESSIVE_BUILTIN, applyCategoryDirective, CATEGORY_KEYS, categoryDirectiveFor, type CategoryKey, LOCKED_CATEGORIES, realpathCriticalReason, sensitiveBasenameAt } from './auto/category.js'
import { sanitizeClassifierArguments, sanitizeClassifierText, sanitizeReviewReason } from './auto/classifier.js'
import { THRESHOLD_DEFAULTS } from './auto/constants.js'
import { createDshClassifier } from './auto/dsh-classifier.js'
import { type RaceHumanHandle, type ReviewResult, type StaticRisk, REVIEW_TIMEOUT_NOTICE, applyBreaker, approvalSource, assembleReviewerSystem, breakerTripped, createKeyedMutex, extractToolPath, followResolution, formatDenyFeedback, frameReviewerInput, lowRiskReviewOutcome, parseReview, preserveHostKeys, raceHumanDecision, reviewSuggestionNote, reviewerAutoAllowBlocked, riskFromAssessment, staticListDecision, type ContextSummary } from './auto/decision.js'
import { loadLatencySamples, pushLatencySample, summarizeLatency, type LatencySample } from './auto/latency.js'
import { buildAskReason, buildEditDiff, buildEditDiffText, EDIT_DIFF_ARGS_MAX_CHARS, EDIT_DIFF_TOOLS } from './auto/editdiff.js'
import {
  clampLearningThreshold,
  confirmActionFor,
  LEARNING_SIG_VERSION,
  learningCapState,
  learningKey,
  learnDecision,
  learnGateEligible,
  loadLearning,
  persistLearning,
  recordConfirm,
  resetConfirmation,
  signatureFor,
  type LearningKind,
  type LearningStore,
} from './auto/learning.js'
import { isWithin, isCriticalPath, normalizePath, resolveRoots, runtimeStateTargetInZone, isProtectedProjectPath } from './auto/paths.js'
import { assessTool, hardDenyReason, symlinkGuardTargets } from './auto/policy.js'
import { probeTargetFacts } from './auto/probe.js'
import { RISK_NAME_PATTERN, RISK_REASON_PATTERN } from './auto/risk-tokens.js'
import { redactResultValue } from './auto/redact.js'
import { agentKind, evaluateRules, parseRulesText } from './auto/rules.js'
import { isReviewRetryable, retryAfterMs, retryReviewLoop, toLlmFailure, type RetryAttempt, type ReviewFailure } from './auto/retry.js'
import { type ReviewMode, loadReviewModes, normalizeReviewMode, persistReviewModes } from './auto/review-mode.js'
import { runtimeStateReadHits } from './auto/shell.js'
import { isLoopbackHostname, isTrustedRequest, validateReviewerBaseUrl } from './auto/trust.js'

export const name = 'dsh-auto-approval-llm'
export const inject = ['approval', 'permissionPresets', 'tools', 'llm', 'agents', 'webServer', 'settings', 'commands']

export interface Config {
  enabled: boolean
  autoSwitchPolicyToAsk: boolean
  reviewerProvider?: string
  reviewerModel?: string
  reviewerProtocol: 'openai' | 'anthropic'
  reviewerBaseUrl: string
  timeoutAction: string
  llmReviewScope: 'low-or-above' | 'medium-or-above' | 'high'
  llmTakeoverScope: 'low' | 'medium-or-below' | 'high-or-below'
  defaultReviewMode: 'manual' | 'smart' | 'unattended'
  lowRiskSeconds: number
  mediumRiskSeconds: number
  highRiskSeconds: number
  safetyPrompt?: string
  allowlist: string[]
  denyList: string[]
  humanOnlyList: string[]
  rulesText: string
  rulesDryRun: boolean
  maxConsecutiveDenials: number
  maxTotalDenials: number
  maxArgsChars: number
  notifyUser: boolean
  showSessionPanel: 'on' | 'auto' | 'off'
  breakerAntiHijackMs: number
  aiButtonPosition: 'header' | 'floating'
  workspaceRoot?: string
  dshHome?: string
  tempRoots?: string[]
  classifierTimeoutMs?: number
  classifierMaxOutputTokens?: number
  /** Extra LLM review attempts after the first (0 = single-shot, 1 = default). */
  reviewMaxRetries?: number
  /** Seconds one reviewer attempt may wait (per-attempt timeout). */
  reviewWaitSeconds?: number
  debug: boolean
  /** Mask credential-shaped material in successful tool results. */
  redactResults: boolean
  /** Attach structured workspace facts (existence/kind/size, recent creates) to the review input. */
  reviewerContextFacts: boolean
  /** Show a line-level diff preview of edit-class targets on the human approval panel. */
  editDiffPreview: boolean
  /** Per-category tri-state override; empty = inherit current behavior. */
  categoryPolicy: Record<string, 'auto' | 'ask' | 'deny'>
  /** Position-gate mode: 'standard' (current) | 'aggressive' (location-unrestricted, hardened). */
  categoryMode: 'standard' | 'aggressive'
  /** Extra trusted directories for Standard mode (host-only, absolute paths). */
  trustedDirs: string[]
  /** Confirmation learning master switch: off by default (zero behavior change). */
  learningEnabled: boolean
  /** Human confirmations before a same-signature ask may auto-allow; clamped to [2,10]. */
  learningThreshold: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  autoSwitchPolicyToAsk: z.boolean().default(false),
  debug: z.boolean().default(false),
  reviewerProvider: z.string().default(''),
  reviewerModel: z.string().default(''),
  reviewerProtocol: z.union(['openai', 'anthropic'] as const).default('openai'),
  reviewerBaseUrl: z.string().default(''),
  timeoutAction: z.string().default('reject'),
  llmReviewScope: z.union(['low-or-above', 'medium-or-above', 'high'] as const).default('low-or-above'),
  llmTakeoverScope: z.union(['low', 'medium-or-below', 'high-or-below'] as const).default('medium-or-below'),
  defaultReviewMode: z.union(['manual', 'smart', 'unattended'] as const).default('smart'),
  lowRiskSeconds: z.number().default(THRESHOLD_DEFAULTS.lowRiskSeconds).min(1),
  mediumRiskSeconds: z.number().default(THRESHOLD_DEFAULTS.mediumRiskSeconds).min(1),
  highRiskSeconds: z.number().default(THRESHOLD_DEFAULTS.highRiskSeconds).min(1),
  safetyPrompt: z.string().default(''),
  allowlist: z.array(z.string()).default([]),
  denyList: z.array(z.string()).default([]),
  humanOnlyList: z.array(z.string()).default([]),
  rulesText: z.string().default(''),
  rulesDryRun: z.boolean().default(false),
  maxConsecutiveDenials: z.number().default(THRESHOLD_DEFAULTS.maxConsecutiveDenials).min(0),
  maxTotalDenials: z.number().default(THRESHOLD_DEFAULTS.maxTotalDenials).min(0),
  maxArgsChars: z.number().default(THRESHOLD_DEFAULTS.maxArgsChars).min(1),
  notifyUser: z.boolean().default(true),
  showSessionPanel: z.union(['on', 'auto', 'off'] as const).default('off'),
  breakerAntiHijackMs: z.number().default(0).min(0),
  aiButtonPosition: z.union(['header', 'floating'] as const).default('header'),
  workspaceRoot: z.string().default(''),
  dshHome: z.string().default(''),
  tempRoots: z.array(z.string()).default([]),
  classifierTimeoutMs: z.number().default(8_000).min(100).max(60_000),
  classifierMaxOutputTokens: z.number().default(1_024).min(64).max(4_096),
  // Extra LLM review attempts after the first (0 = off, matching the old
  // single-shot behavior). Calibrated against measured review latency (p95 ≈
  // 3.06s): the rolling budget keeps 1 retry affordable on every risk path.
  reviewMaxRetries: z.number().default(THRESHOLD_DEFAULTS.reviewMaxRetries).min(0).max(2),
  // Seconds one reviewer attempt may wait for a response before giving up
  // (per-attempt timeout). Calibrated to direct DeepSeek official TTFB
  // (266ms-4.9s); keep it below the LOW countdown so a healthy review still
  // lands inside the window.
  reviewWaitSeconds: z.number().default(THRESHOLD_DEFAULTS.reviewWaitSeconds).min(1).max(10),
  // Result-side credential masking: off until the first-day value/content
  // read-path measurements are in (fail-closed default; opt-in per deployment).
  redactResults: z.boolean().default(false),
  // Structured workspace-facts injection for the reviewer input (off by
  // default so the default review payload stays byte-identical).
  reviewerContextFacts: z.boolean().default(false),
  // Line-level diff preview for edit-class approvals: display-only, fail-closed
  // (any read/diff failure omits the block), never part of the review payload.
  // Off by default (fail-closed): enable explicitly to see the panel diff.
  editDiffPreview: z.boolean().default(false),
  // Per-category tri-state override: a dict accepts any key but resolveConfig
  // clamps unknown/LOCKED keys (see resolveConfig); empty = inherit.
  categoryPolicy: z.dict(z.union(['auto', 'ask', 'deny'] as const), z.string()).default({}),
  categoryMode: z.union(['standard', 'aggressive'] as const).default('standard'),
  trustedDirs: z.array(z.string()).default([]),
  // Confirmation learning: fail-closed default (off). The threshold accepts a
  // wide numeric range here; resolveConfig warns and clamps into [2,10]
  // instead of throwing, mirroring the categoryPolicy schema/decision split.
  learningEnabled: z.boolean().default(false),
  learningThreshold: z.number().default(THRESHOLD_DEFAULTS.learningThreshold),
})

const AUTO_PRESET = 'auto'

export function resolveConfig(raw: Config): Config {
  if (raw.reviewerProvider === undefined !== (raw.reviewerModel === undefined)) {
    throw new Error('dsh-auto-approval-llm: reviewerProvider and reviewerModel must be configured together')
  }
  let timeoutAction = raw.timeoutAction
  if (!['reject', 'allow', 'low-risk-allow'].includes(timeoutAction)) {
    if (timeoutAction === 'llm-low-risk-only') {
      // Legacy value: the LOW branch already implies "low-risk-only", so the
      // distinct timeout action was dead semantics. Migrate fail-closed.
      console.warn('[dsh-auto-approval-llm] migrating legacy timeoutAction "llm-low-risk-only" → "reject"')
      timeoutAction = 'reject'
    } else {
      throw new Error(`dsh-auto-approval-llm: unknown timeoutAction "${timeoutAction}"`)
    }
  }
  // Category policy clamp: unknown keys (including 'unknown'/'harnessInternal'
  // and spelling drift) are warned and dropped, so no category key can ever
  // become 'auto' by accident; LOCKED categories accept only 'ask' (auto/deny
  // are warned and dropped = inherit). Mirrors the timeoutAction migration
  // pattern: warn + normalize, never throw.
  const categoryPolicy: Record<string, 'auto' | 'ask' | 'deny'> = {}
  for (const [key, value] of Object.entries(raw.categoryPolicy ?? {})) {
    if (!CATEGORY_KEYS.includes(key as (typeof CATEGORY_KEYS)[number])) {
      console.warn(`[dsh-auto-approval-llm] ignoring unknown categoryPolicy key "${key}"`)
      continue
    }
    // Value-level clamp too: the settings schema enforces the tri-state union
    // on its own validation flow, but resolveConfig also consumes plain
    // objects (patch defaults, hand-edited storage) that never passed the
    // schema, so a non-tri-state value is warned and dropped here = inherit.
    if (value !== 'auto' && value !== 'ask' && value !== 'deny') {
      console.warn(`[dsh-auto-approval-llm] ignoring ${key}=${String(value)}: expected "auto" | "ask" | "deny"`)
      continue
    }
    if (LOCKED_CATEGORIES.includes(key as (typeof LOCKED_CATEGORIES)[number]) && value !== 'ask') {
      console.warn(`[dsh-auto-approval-llm] ignoring ${key}=${String(value)}: locked categories accept only "ask"`)
      continue
    }
    categoryPolicy[key] = value
  }
  // Trusted-directory clamp: only absolute paths (win32 drive/UNC, posix '/');
  // relative / '~' / environment-variable spellings, empties, and directories
  // inside the user home / DSH_HOME / a critical tree are warned and dropped.
  // Stored normalized so later containment checks use one spelling.
  const trustedDirs: string[] = []
  const home = homedir()
  const dshHome = (process.env.DSH_HOME?.trim() || join(home, '.dsh'))
  // A trusted directory must never sit inside (or itself be) a credential or
  // home-relative sensitive tree — checked independent of the real home so a
  // spelling under any user profile is caught too.
  const SENSITIVE_TRUST_SEGMENTS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube']
  for (const dir of raw.trustedDirs ?? []) {
    if (typeof dir !== 'string' || dir.trim() === '' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(dir)) {
      console.warn(`[dsh-auto-approval-llm] ignoring non-absolute trustedDir "${String(dir)}"`)
      continue
    }
    const normalized = normalizePath(dir, dir, home)
    const parts: string[] = normalized.split(/[\\/]/).filter(Boolean)
    if (parts.some((part) => SENSITIVE_TRUST_SEGMENTS.includes(part))) {
      console.warn(`[dsh-auto-approval-llm] ignoring trustedDir in a credential tree: ${normalized}`)
      continue
    }
    const roots = { workspace: normalized, home, dshHome }
    if (isWithin(home, normalized) || isWithin(dshHome, normalized) || isCriticalPath(normalized, roots)) {
      console.warn(`[dsh-auto-approval-llm] ignoring trustedDir inside a protected tree: ${normalized}`)
      continue
    }
    trustedDirs.push(normalized)
  }
  // Learning-threshold clamp: warn + clamp, never throw and never drop — a
  // wild value keeps the magnitude of the user's intent (mirrors the
  // categoryPolicy warn+normalize pattern, but numeric instead of tri-state).
  const learningThreshold = clampLearningThreshold(
    raw.learningThreshold,
    THRESHOLD_DEFAULTS.learningThreshold,
  )
  if (
    typeof raw.learningThreshold !== 'number' ||
    !Number.isInteger(raw.learningThreshold) ||
    raw.learningThreshold < 2 ||
    raw.learningThreshold > 10
  ) {
    console.warn(`[dsh-auto-approval-llm] clamping learningThreshold ${String(raw.learningThreshold)} to ${learningThreshold} (valid range: integer 2..10)`)
  }
  // Half-configured direct endpoint advisory: reviewerBaseUrl without
  // reviewerModel no longer produces a doomed online attempt — the snapshot
  // treats the incomplete trio as unconfigured and review follows the session
  // model. Warn at resolve time; the stored values themselves stay untouched.
  if (String(raw.reviewerBaseUrl ?? '').trim().length > 0 && String(raw.reviewerModel ?? '').trim().length === 0) {
    console.warn('[dsh-auto-approval-llm] reviewerBaseUrl set without reviewerModel: direct review needs base URL + model name + API key, so this combination counts as unconfigured and review follows the session model')
  }
  return {
    ...raw,
    timeoutAction,
    categoryPolicy,
    categoryMode: raw.categoryMode === 'aggressive' ? 'aggressive' : 'standard',
    trustedDirs,
    // Default-off (fail-closed): only an explicit true enables learning.
    learningEnabled: raw.learningEnabled === true,
    learningThreshold,
    llmReviewScope: raw.llmReviewScope ?? 'low-or-above',
    llmTakeoverScope: raw.llmTakeoverScope ?? 'medium-or-below',
    lowRiskSeconds: raw.lowRiskSeconds ?? THRESHOLD_DEFAULTS.lowRiskSeconds,
    mediumRiskSeconds: raw.mediumRiskSeconds ?? THRESHOLD_DEFAULTS.mediumRiskSeconds,
    highRiskSeconds: raw.highRiskSeconds ?? THRESHOLD_DEFAULTS.highRiskSeconds,
    redactResults: raw.redactResults === true,
    reviewerContextFacts: raw.reviewerContextFacts === true,
    reviewWaitSeconds: raw.reviewWaitSeconds ?? THRESHOLD_DEFAULTS.reviewWaitSeconds,
    // Default-off (fail-closed): only an explicit true enables the preview.
    editDiffPreview: raw.editDiffPreview === true,
  }
}

// The action the host countdown takes when nobody responds, per risk tier and
// the configured timeoutAction ('reject' | 'allow' | 'low-risk-allow'). Only
// LOW is auto-approved by 'low-risk-allow'; MEDIUM/HIGH stay fail-closed.
function riskTimedOutAction(risk: 'LOW' | 'MEDIUM' | 'HIGH', action: string, unattended: boolean): 'allow' | 'reject' {
  if (unattended) return risk === 'HIGH' ? 'reject' : 'allow'
  if (action === 'allow') return 'allow'
  if (action === 'low-risk-allow') return risk === 'LOW' ? 'allow' : 'reject'
  return 'reject'
}

function isModelRouteConfig(cfg: any): cfg is { provider: string; model: string } {
  return typeof cfg?.provider === 'string' && cfg.provider.length > 0 &&
    typeof cfg?.model === 'string' && cfg.model.length > 0
}

// Single resolver for "which provider/model is this session talking through":
// the live request header first, then the newest recorded header event.
export function sessionModelRoute(session: any): { provider: string; model: string } | undefined {
  const live = session?.requestHeader?.()?.config
  if (isModelRouteConfig(live)) return { provider: live.provider, model: live.model }
  const events = session?.events ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const cfg = event.data?.header?.config
    if (isModelRouteConfig(cfg)) return { provider: cfg.provider, model: cfg.model }
  }
  return undefined
}

// Agent-level resolution: session route first, then explicit agent options.
function resolveModelRoute(agent: any): { provider: string; model: string } | undefined {
  const fromSession = sessionModelRoute(agent?.session)
  if (fromSession) return fromSession
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  return isModelRouteConfig({ provider, model }) ? { provider, model } : undefined
}

function findToolCallArguments(session: any, callId: string | undefined, maxChars: number): string | undefined {
  if (!callId) return undefined
  const events = session?.events ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'tool/call' || event.data?.callId !== callId) continue
    const raw = event.data?.arguments
    if (typeof raw !== 'string') return undefined
    return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}\n…[truncated]`
  }
  return undefined
}

function findToolDescription(tools: any, toolName: string): string | undefined {
  return tools?.schemas().find((schema: any) => schema.name === toolName)?.description
}

/**
 * Retry calibration history: the original 3.5s fit the 2026-08-23
 * mock/opencode latency profile (p95 ≈ 3.06s); direct DeepSeek official
 * review latency measured 2026-08-26 spans 266ms–4.9s, so the per-attempt
 * timeout became a user setting (`reviewWaitSeconds`, default 5, schema-clamped
 * 1..10). It should stay at or below the LOW countdown so a healthy review
 * still lands inside the window.
 */
const REVIEW_RETRY_BACKOFF_MS = 500
const REVIEW_RETRY_GUARD_MS = 1_500

/**
 * Frozen review context. Route/baseUrl/protocol/model/system/payload and the
 * API key are resolved ONCE before the first attempt; every retry reuses the
 * snapshot so a credential rotation or settings change mid-review can never
 * steer a retry toward a different endpoint or key.
 */
interface ReviewSnapshot {
  online: boolean
  payload: string
  system: string
  route?: { provider: string; model: string }
  baseUrl?: string
  protocol?: 'openai' | 'anthropic'
  apiKey?: string
}

export async function buildReviewSnapshot(
  credentials: any, tools: any, session: any, req: any, config: Config,
  opts: {
    userMessages?: string[]
    workspaceRoot?: string
    home?: string
    /** Context-fact sources, consumed only while `reviewerContextFacts` is on. */
    contextFacts?: { artifacts: ArtifactRegistry; owner?: unknown }
  },
): Promise<ReviewSnapshot | { failure: string }> {
  // Reasoning-blind payload: tool identity + sanitized args + bounded direct
  // user messages + workspace facts only. req.reason (which can carry model
  // prose / the classifier's own words) is deliberately NOT forwarded.
  const rawArgs = findToolCallArguments(session, req.callId, config.maxArgsChars)
  let targetRelative: string | null | undefined
  let inWorkspace: boolean | null | undefined
  const target = extractToolPath(rawArgs)
  if (target !== undefined && opts.workspaceRoot) {
    const normalized = normalizePath(target, opts.workspaceRoot, opts.home ?? opts.workspaceRoot)
    inWorkspace = isWithin(opts.workspaceRoot, normalized)
    targetRelative = normalized
  }
  // Structured facts channel: deterministic metadata only, assembled after the
  // normalized target is known. Any probe/list failure omits the whole summary
  // (fail closed); the flag gate keeps the default payload unchanged.
  let contextSummary: ContextSummary | undefined
  if (config.reviewerContextFacts === true && typeof targetRelative === 'string'
    && opts.workspaceRoot && opts.contextFacts !== undefined) {
    const facts = probeTargetFacts(targetRelative, opts.workspaceRoot)
    if (facts !== undefined) {
      contextSummary = {
        ...facts,
        recentCreates: opts.contextFacts.artifacts.list(opts.contextFacts.owner, {
          workspace: opts.workspaceRoot,
          home: opts.home ?? opts.workspaceRoot,
        }),
      }
    }
  }
  const payload = frameReviewerInput({
    toolName: req.toolName,
    description: findToolDescription(tools, req.toolName),
    rawArguments: rawArgs,
    trustedUserMessages: opts.userMessages ?? [],
    workspaceRoot: opts.workspaceRoot ?? undefined,
    targetRelative,
    inWorkspace,
    contextSummary,
  })
  // system = REVIEWER_SYSTEM + safetyPrompt + sanitized/bounded rules
  // summary (rules are constraints only; they can never authorize).
  const system = assembleReviewerSystem(config.safetyPrompt, config.rulesText)

  // Online reviewer: a direct HTTP call to the configured OpenAI-compatible
  // (chat/completions) or Anthropic (messages) endpoint. The API key is
  // resolved once into the snapshot (never cached beyond one review).
  if (String(config.reviewerBaseUrl ?? '').trim().length > 0) {
    const validated = validateReviewerBaseUrl(config.reviewerBaseUrl ?? '')
    if (!validated.ok) {
      console.warn(`[dsh-auto-approval-llm] ${validated.reason}`)
      return { failure: validated.reason }
    }
    let apiKey: string | undefined
    try {
      const resolved = await credentials?.resolve?.(REVIEWER_CREDENTIAL_REF)
      apiKey = resolved?.value
    } catch {
      apiKey = undefined
    }
    // Fallback when the reviewer key did not resolve from the credentials
    // service (service unreachable, scope-filtered, or ref simply unset):
    // read the shared DSH credential file. Disable with
    // DSH_AUTO_APPROVAL_READ_CRED_FILE=0 (keeps contract tests isolated from
    // the host machine's credential file).
    if (!apiKey && process.env.DSH_AUTO_APPROVAL_READ_CRED_FILE !== '0') {
      apiKey = reviewerKeyFromCredentialFile()
    }
    // The direct channel exists only when all three pieces are configured:
    // base URL + model name + a resolved API key. A half-configured endpoint
    // can only produce a doomed request (empty model → INVALID_REQUEST, no
    // key → AUTH), so an incomplete trio is treated as unconfigured: log what
    // is missing and fall through to session-model review below. A malformed
    // URL above is different — that is wrong configuration, not half of one.
    const missing: string[] = []
    if (String(config.reviewerModel ?? '').trim().length === 0) missing.push('model')
    if (!apiKey) missing.push('key')
    if (missing.length === 0) {
      return {
        online: true,
        payload,
        system,
        baseUrl: validated.baseUrl,
        protocol: config.reviewerProtocol === 'anthropic' ? 'anthropic' : 'openai',
        apiKey,
      }
    }
    debugLog({ ev: 'reviewer-incomplete', callId: req.callId, baseUrl: validated.baseUrl, missing })
  }

  const route = config.reviewerProvider && config.reviewerModel
    ? { provider: config.reviewerProvider, model: config.reviewerModel }
    : sessionModelRoute(session)
  if (!route) return { failure: 'no reviewer route' }
  return { online: false, payload, system, route }
}

/** Map a non-2xx HTTP status to a stable review failure code. */
function httpStatusFailure(status: number, message: string, response: any): ReviewFailure {
  const code =
    status === 429 ? 'RATE_LIMIT'
      : status >= 500 ? 'SERVER'
        : status === 401 || status === 403 ? 'AUTH'
          : status === 400 || status === 413 ? 'INVALID_REQUEST'
            : `HTTP_${status}`
  const providerRetryAfterMs = retryAfterMs(response?.headers?.get?.('retry-after') ?? null)
  return {
    code,
    message,
    status,
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
  }
}

/** One single-shot review attempt; throws a `ReviewFailure`-shaped error on failure. */
async function runReviewAttempt(
  snapshot: ReviewSnapshot, llm: any, session: any, req: any, config: Config, signal: AbortSignal,
): Promise<ReviewResult> {
  if (!snapshot.online) {
    const route = snapshot.route!
    const prepared = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 256 }, signal)
    const messages = [createUserMessage({
      content: [{ type: 'text', text: snapshot.payload }],
      source: { kind: 'plugin', plugin: 'dsh-auto-approval-llm' },
    })]
    const assembler = new BlockAssembler()
    // The stream options must match the prepared call's resolved config field
    // for field (provider/model/reasoningEffort/temperature/maxTokens/stop —
    // callConfigEquals), otherwise the adapter rejects the dispatch with
    // INVALID_PREPARED_CALL. Spreading prepared.config guarantees equality
    // even when adapter defaults filled optional fields.
    for await (const chunk of prepared.stream({
      ...(prepared.config as any),
      messages,
      system: snapshot.system,
      sessionId: session.id,
      signal,
    })) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const text = assembler.blocks()
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join(' ')
    return parseReviewTextOrThrow(text)
  }

  // Online (custom endpoint): raw fetch with redirect:'error' keeping the
  // loopback fence honest — a 302 must not steer this request (and its
  // credential headers) toward some other host.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let text = ''
  if (snapshot.protocol === 'anthropic') {
    if (snapshot.apiKey) headers['x-api-key'] = snapshot.apiKey
    const res = await fetch(`${snapshot.baseUrl}/messages`, {
      method: 'POST',
      headers,
      signal,
      redirect: 'error',
      body: JSON.stringify({
        model: config.reviewerModel || undefined,
        max_tokens: 256,
        system: snapshot.system,
        messages: [{ role: 'user', content: snapshot.payload }],
      }),
    })
    if (!res.ok) throw httpStatusFailure(res.status, `HTTP ${res.status}`, res)
    const json: any = await res.json()
    const content = json?.content
    text = Array.isArray(content)
      ? content.map((block: any) => (block?.type === 'text' ? block.text ?? '' : '')).join('')
      : ''
  } else {
    if (snapshot.apiKey) headers.Authorization = `Bearer ${snapshot.apiKey}`
    const res = await fetch(`${snapshot.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      redirect: 'error',
      body: JSON.stringify({
        model: config.reviewerModel || undefined,
        max_tokens: 256,
        messages: [
          { role: 'system', content: snapshot.system },
          { role: 'user', content: snapshot.payload },
        ],
      }),
    })
    if (!res.ok) throw httpStatusFailure(res.status, `HTTP ${res.status}`, res)
    const json: any = await res.json()
    text = json?.choices?.[0]?.message?.content ?? ''
  }
  return parseReviewTextOrThrow(text)
}

/** Parse review JSON; empty output = EMPTY_RESPONSE, malformed = BAD_RESPONSE (not retried). */
function parseReviewTextOrThrow(text: string): ReviewResult {
  if (text.trim() === '') {
    throw { code: 'EMPTY_RESPONSE', message: 'reviewer returned no text' }
  }
  try {
    return parseReview(text)
  } catch (error) {
    throw { code: 'BAD_RESPONSE', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run the review with a bounded retry loop. Returns the settled review plus
 * the per-attempt failure trail. Retry policy: whitelisted transient codes
 * only, rolling-remainder budget, per-attempt timeout (gateway timeouts are
 * the retryable scenario; user cancellation aborts the loop immediately).
 */
async function reviewWithLLM(
  credentials: any, llm: any, tools: any, session: any, req: any, config: Config,
  timeoutMs = 5_000,
  opts: {
    userMessages?: string[]
    workspaceRoot?: string
    home?: string
    contextFacts?: { artifacts: ArtifactRegistry; owner?: unknown }
  } = {},
  retry: { maxRetries: number; budgetMs: number; asyncPath: boolean } = { maxRetries: 0, budgetMs: 5_000, asyncPath: false },
): Promise<{ review: ReviewResult; attempts: RetryAttempt[] }> {
  const snapshot = await buildReviewSnapshot(credentials, tools, session, req, config, opts)
  if ('failure' in snapshot) {
    return { review: { decision: 'ESCALATE', failure: snapshot.failure }, attempts: [] }
  }
  const outcome = await retryReviewLoop({
    budgetMs: retry.budgetMs,
    maxRetries: retry.maxRetries,
    attemptTimeoutMs: Math.min(10_000, Math.max(1_000, (config.reviewWaitSeconds ?? THRESHOLD_DEFAULTS.reviewWaitSeconds) * 1000)),
    backoffMs: REVIEW_RETRY_BACKOFF_MS,
    guardMs: REVIEW_RETRY_GUARD_MS,
    userSignal: req?.signal,
    retryable: (failure) => isReviewRetryable(failure, { asyncPath: retry.asyncPath }),
    onRetry: (info) => debugLog({
      ev: 'review-retry', callId: req.callId,
      attempt: info.n, code: info.code, delayMs: info.delayMs, remainingMs: info.remainingMs,
    }),
    attempt: (signal) => runReviewAttempt(snapshot, llm, session, req, config, signal),
  })
  if (outcome.ok) return { review: outcome.value, attempts: outcome.attempts }
  return {
    review: { decision: 'ESCALATE', failure: outcome.failure.message, attempts: outcome.attempts },
    attempts: outcome.attempts,
  }
}

function appendNotice(session: any, text: string): void {
  try {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-auto-approval-llm' },
    }), { surfaceOp: 'append' })
    debugLog({ ev: 'onboarding-append', sessionId: session?.id ?? null, ok: true })
  } catch (error) {
    // Notification is best-effort; never changes the approval outcome.
    debugLog({ ev: 'onboarding-append', sessionId: session?.id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// ── first-use onboarding notice ───────────────────────────────────────────
// A process-lifetime one-shot greeting for a fresh AUTO session: the very
// first tool call of each root session queues the notice once through the
// safe notice queue above (never a bare append). The marker lives only in
// memory and never touches disk, so a restart may greet the same session
// again — an accepted semantic (documented in HANDOFF).
const firstAutoNoticeSeen = new Set<string>()

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

/** First-use notice body; the timeout slot always carries the live label. */
export function onboardingNoticeText(timeoutAction: string, lang: 'zh' | 'en' = 'zh'): string {
  const label = onboardingTimeoutLabel(timeoutAction, lang)
  if (lang === 'en') {
    return `(Auto-approval) is active: low-risk actions pass automatically; uncertain ones will show a countdown prompt; no response applies the configured timeout action (currently "${label}"). Reasons for denials are recorded in "recent approvals".`
  }
  return `（自动审批）已生效：低风险自动通过；拿不准的操作会弹出倒计时询问你，没人回答则按设置处理（当前为「${label}」）。被拒的原因会写进「最近审批记录」。`
}

// ── approval notice queue ────────────────────────────────────────────────
// Appending a user message between an assistant tool-calls message and its
// tool result breaks the OpenAI-compatible message sequence (400
// invalid_request_error). Queue the notice, mark it seen when the matching
// tool/result lands, and flush at step/end — after every tool result of the
// step, where an extra user message is legal.
const pendingNotices = new Map<string, Map<string, { text: string; seen: boolean }>>()

function queueNotice(session: any, callId: string, text: string): void {
  let byCall = pendingNotices.get(session.id)
  if (!byCall) {
    byCall = new Map()
    pendingNotices.set(session.id, byCall)
  }
  byCall.set(callId, { text, seen: false })
}

function flushNotices(session: any): void {
  const byCall = pendingNotices.get(session.id)
  if (!byCall) {
    debugLog({ ev: 'onboarding-flush', sessionId: session?.id ?? null, queued: 0, reason: 'no-pending' })
    return
  }
  pendingNotices.delete(session.id)
  const queued = [...byCall.values()]
  debugLog({ ev: 'onboarding-flush', sessionId: session?.id ?? null, queued: queued.length, seen: queued.filter((e) => e.seen).length, dropped: queued.filter((e) => !e.seen).length })
  for (const { text, seen } of byCall.values()) {
    if (!seen) {
      // The tool never produced a result (rejected/cancelled): inserting a
      // user message there would still break the tool-calls sequence, so keep
      // it out of the session log.
      console.log(`[dsh-auto-approval-llm] (工具未执行，仅控制台通知) ${text}`)
      continue
    }
    appendNotice(session, text)
  }
}

function watchNotices(ctx: any): void {
  // Reliable flush point: `tools/result` — its scope carrier keys on
  // exec.agent, the same chain `tools/pre-execute` proves to reach plugin
  // contexts. A `session/event` subscription may be filtered away for plugin
  // contexts (probes: injection fired, flush never did).
  ctx.on('tools/result', (exec: any) => {
    const session = exec?.agent?.session
    const callId = exec?.callId
    if (!session || !callId) return
    const byCall = pendingNotices.get(session.id)
    if (!byCall) return
    const entry = byCall.get(callId)
    if (entry) entry.seen = true
    debugLog({ ev: 'onboarding-event', via: 'tools/result', sessionId: session.id, callId, found: !!entry, pending: byCall.size })
    flushNotices(session)
  })
  ctx.on('session/event', (session: any, event: any) => {
    // Diagnostic: does the scope carrier actually reach plugin contexts?
    debugLog({ ev: 'onboarding-event', via: 'session/event', sessionId: session?.id ?? null, type: event?.type ?? null })
    if (!pendingNotices.has(session?.id)) return
    if (event?.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      const entry = pendingNotices.get(session.id)?.get(callId)
      if (entry) entry.seen = true
    } else if (event?.type === 'step/end') {
      flushNotices(session)
    }
  })
  ctx.on('session/disposed', (session: any) => {
    pendingNotices.delete(session?.id)
  })
}

// ── timeout feedback ──────────────────────────────────────────────────────
// When the human countdown expires we still must return `'rejected'` (the
// approval vocabulary has no timeout outcome), but the agent should be able to
// tell a timeout apart from a deliberate user denial. Record a marker and let
// `tools/post-execute` inject it into the denied tool result.
const timeoutFeedback = new Map<string, { text: string; at: number }>()

function recordTimeoutFeedback(callId: string | undefined, text: string): void {
  if (!callId) return
  timeoutFeedback.set(callId, { text, at: Date.now() })
}

const decisionFeedback = new Map<string, { text: string; at: number }>()

function recordDecisionFeedback(callId: string | undefined, text: string): void {
  if (!callId) return
  decisionFeedback.set(callId, { text, at: Date.now() })
}

// Result-masking audit (reuses audit.jsonl's type envelope; never
// records any masked material, only the event facts).
function auditRedact(callId: string | undefined, toolName: string | undefined): void {
  appendAuditLine(JSON.stringify({ type: 'result-redacted', at: Date.now(), callId: callId ?? null, toolName: toolName ?? null }))
}

function auditMaskFailed(callId: string | undefined, toolName: string | undefined): void {
  appendAuditLine(JSON.stringify({ type: 'mask-failed', at: Date.now(), callId: callId ?? null, toolName: toolName ?? null }))
}

// Bound both feedback maps so a stuck/broken approval chain can never grow
// them without limit. Expired entries (older than ttlMs) are dropped first;
// if still over maxEntries the oldest by `at` are evicted (FIFO).
function sweepFeedback(
  map: Map<string, { text: string; at: number }>,
  opts: { ttlMs: number; maxEntries: number },
): void {
  const now = Date.now()
  for (const [key, entry] of map) {
    if (now - entry.at > opts.ttlMs) map.delete(key)
  }
  if (map.size > opts.maxEntries) {
    const overflow = map.size - opts.maxEntries
    const oldest = [...map.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, overflow)
    for (const [key] of oldest) map.delete(key)
  }
}

// ── approval history ──────────────────────────────────────────────────────
export interface HistoryRecord {
  id: string
  at: number
  sessionId: string
  toolName: string
  outcome: string
  source: string
  llmDecision?: string
  llmRisk?: string
  llmReason?: string
  /** Per-attempt failure trail when the review was retried (1-based `n`). */
  attempts?: RetryAttempt[]
  breaker?: boolean
  breakerReasons?: string[]
  /** Category-layer decisions carry their label/decision/mode for the audit. */
  category?: string
  categoryDecision?: string
  mode?: string
}

const approvalHistory: HistoryRecord[] = []
const HISTORY_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'history.jsonl')
const DEBUG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'approval-debug.jsonl')

// Gated by the settings「调试」switch (`config.debug`); off by default so the
// debug trail is only written while diagnosing.
let debugOn = false

// Latest config-init/update error (illegal persisted value, failing
// describe/register). Surfaced to the settings card as a red banner so the
// user can see why the plugin is running on fallback defaults and clear it.
let configError: string | null = null

// Debug trail for the reviewer/approval timeline (append-only, size-capped).
// Lets a human inspect whether/when the LLM reviewed, what it said and how
// long it took — useful to tell "LLM too slow" from a wrongful timeout label.
function debugLog(entry: Record<string, unknown>): void {
  if (!debugOn) return
  try {
    if (existsSync(DEBUG_FILE) && statSync(DEBUG_FILE).size > 1_048_576) {
      const lines = readFileSync(DEBUG_FILE, 'utf8').split('\n').filter(Boolean)
      writeFileSync(DEBUG_FILE, `${lines.slice(-2000).join('\n')}\n`)
    }
    appendFileSync(DEBUG_FILE, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  } catch {
    // Debug is best-effort; never affects the approval outcome.
  }
}

function loadHistory(): void {
  try {
    if (!existsSync(HISTORY_FILE)) return
    const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      const record = JSON.parse(line) as HistoryRecord
      if (record && typeof record.id === 'string') approvalHistory.push(record)
    }
    if (approvalHistory.length > 200) approvalHistory.splice(0, approvalHistory.length - 200)
  } catch {
    // Corrupt or unreadable history is non-fatal.
  }
}

function pushHistory(entry: Omit<HistoryRecord, 'id' | 'at'>): void {
  if (entry.llmReason !== undefined) {
    entry = { ...entry, llmReason: sanitizeReviewReason(entry.llmReason) }
  }
  const record: HistoryRecord = {
    ...entry,
    id: `h${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
  }
  approvalHistory.push(record)
  if (approvalHistory.length > 200) approvalHistory.shift()
  try {
    appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`)
    // Rotate the on-disk log once it grows past 1 MB so it cannot grow without
    // bound (the in-memory window is already capped at 200 records).
    if (statSync(HISTORY_FILE).size > 1_048_576) {
      writeFileSync(HISTORY_FILE, `${approvalHistory.map((r) => JSON.stringify(r)).join('\n')}\n`)
    }
  } catch {
    // History persistence is best-effort.
  }
  // Durable append-only audit (B2): same decision, additionally persisted with
  // a type marker; clearing history leaves a tombstone here, never an erase.
  appendAuditLine(JSON.stringify({ type: 'decision', ...record }))
}

loadHistory()

// ── LLM review latency telemetry ──────────────────────────────────────────
// Independent of approval history: history records adjudicated facts, latency
// records how long each reviewer call actually took. Every attempt is sampled
// (including aborted ones and late responses that lost the countdown race),
// so the recent-100 min/avg/max cannot suffer survivor bias. Persisted in
// llm-latency.jsonl (same append+rotate pattern as history.jsonl); clear
// history intentionally leaves it alone — telemetry is not an approval record.
const llmLatency: LatencySample[] = loadLatencySamples()

// ── confirmation-learning store ───────────────────────────────────────────
// Loaded once per process like history/latency; every mutation happens under
// the per-signature keyed mutex with a synchronous persist, so the on-disk
// snapshot can trail by at most one finished critical section. Corrupt or
// poisoned files degrade to an empty store = everything stays with a human.
const LEARNING_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'learning.json')
const learningStore: LearningStore = loadLearning(LEARNING_FILE)

// ── same-origin feedback route ────────────────────────────────────────────
// The browser client cannot use `host.call` here (this is a static bundle, not
// a dynamic Cordis Package). Instead it POSTs the timeout marker to this route
// immediately before answering the approval, so `tools/post-execute` can tell
// an automatic timeout apart from a deliberate user rejection.
const FEEDBACK_ROUTE = '/_dsh/auto-approval-llm/feedback'
const SETTINGS_ROUTE = '/_dsh/auto-approval-llm/settings'
const REVIEWER_CREDENTIAL_ROUTE = '/_dsh/auto-approval-llm/reviewer-credential'
const HISTORY_ROUTE = '/_dsh/auto-approval-llm/history'
const HISTORY_EXPORT_ROUTE = '/_dsh/auto-approval-llm/history/export'
const MODELS_ROUTE = '/_dsh/auto-approval-llm/models'
const TEST_ROUTE = '/_dsh/auto-approval-llm/test'
const SESSION_MODE_ROUTE = '/_dsh/auto-approval-llm/session-mode'
const REVIEW_STATUS_ROUTE = '/_dsh/auto-approval-llm/review-status'
const STATS_ROUTE = '/_dsh/auto-approval-llm/stats'
const SETTINGS_NS = 'auto-approval-llm' as any

// The online-reviewer API key lives in the DSH credential store (env-var
// reference name), never in the settings value — the UI only ever sees
// `configured`, never the secret. Resolved per operation, not cached.
const REVIEWER_CREDENTIAL_REF = 'DSH_AUTO_APPROVAL_REVIEWER_API_KEY'

/** Best-effort fallback: read the reviewer key from the shared DSH credential
 * file (`~/.dsh/.credentials.yaml`) when the credentials service is not
 * reachable from the plugin scope. Never throws; returns undefined if absent. */
function reviewerKeyFromCredentialFile(): string | undefined {
  try {
    // The credentials file lives under the DSH home; the runtime may or may
    // not export DSH_HOME, so probe both the env value and homedir()/.dsh.
    const candidates = [
      process.env.DSH_HOME ? join(process.env.DSH_HOME, '.credentials.yaml') : '',
      join(homedir(), '.dsh', '.credentials.yaml'),
    ]
    for (const file of candidates) {
      if (!file) continue
      try {
        const text = readFileSync(file, 'utf8')
        const match = text.match(new RegExp(`^\\s*${REVIEWER_CREDENTIAL_REF}\\s*:\\s*(sk-[^\\s]+)`, 'm'))
        if (match) return match[1]
      } catch {
        // try the next candidate
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Best-effort removal of the reviewer key line from the shared credential
 * file, mirroring the fallback probe paths. Used by the credential DELETE so
 * "restore defaults" really clears the reviewer key in every source. Never
 * touches any other ref line. */
function clearReviewerKeyFromCredentialFile(): boolean {
  try {
    const candidates = [
      process.env.DSH_HOME ? join(process.env.DSH_HOME, '.credentials.yaml') : '',
      join(homedir(), '.dsh', '.credentials.yaml'),
    ]
    for (const file of candidates) {
      if (!file) continue
      try {
        const text = readFileSync(file, 'utf8')
        const pattern = new RegExp(`^\\s*${REVIEWER_CREDENTIAL_REF}\\s*:.*$`, 'm')
        if (!pattern.test(text)) continue
        const cleaned = text.replace(pattern, '')
        writeFileSync(file, cleaned)
        return true
      } catch {
        // try the next candidate
      }
    }
    return false
  } catch {
    return false
  }
}

interface ReviewStatus {
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  phase: 'countdown' | 'follow'
  action: 'reject' | 'allow'
  seconds: number
  note?: string
  feedback?: string
  /** Resolution origin, set on follow-phase statuses so the client can skip
   * re-answering approvals the human already settled. 'abort' labels a
   * cancelled/aborted ask (no human and no LLM decided) so it is never
   * misread as a human answer. */
  source?: 'human' | 'llm' | 'timeout' | 'abort'
}

const reviewStates = new Map<string, ReviewStatus>()

// Follow-phase statuses are retained briefly after the host resolution so the
// client's poll can observe the follow and close the official panel with the
// real outcome. Swept by FOLLOW_STATE_TTL_MS; released earlier on client ACK.
// 120s covers Chrome's background-tab intensive throttling (≥1 min between
// timer firings after 5 min hidden), so a throttled client still observes the
// follow instead of falling back to a stale countdown action.
const FOLLOW_STATE_TTL_MS = 120_000
const followExpiry = new Map<string, number>()

// Latest reviewer verdict per callId (covers both decisive MEDIUM takeovers
// and advisory MEDIUM/HIGH opinions). askHuman emits it into history so the
// LLM's review is always visible, even when it did not take over.
const reviewVerdicts = new Map<string, ReviewResult>()

// callIds answered by the plugin's own client auto-answer (autoRespond /
// followRespond). Map<callId, timestamp> with a TTL sweep so a late ACK can
// never grow it without bound (RISK-05); askHuman reads/clears it to label
// history source as 'auto-*'.
const autoAnswered = new Map<string, number>()
const AUTO_ANSWERED_TTL_MS = 60_000

// callIds whose approval/request has already been settled by the host (any
// resolution path). The client's follow ACK (FEEDBACK POST with auto:true)
// arrives AFTER askHuman finished, so without this set the ACK would relabel a
// resolved ask as "no response: auto-*" and re-add the callId to autoAnswered
// forever. Map<callId, timestamp>; swept with the follow sweep; only used to
// gate feedback text.
const resolvedCallIds = new Map<string, number>()
const RESOLVED_TTL_MS = 30_000

// ── approval state registry ───────────────────────────────────────────────
// Every plugin-lifetime callId-keyed approval map, grouped so cleanup can
// never forget a member: /approval reset clears them all through
// clearApprovalState(), and the periodic / post-execute sweeps run from one
// place. The maps stay top-level variables (hot paths read them directly);
// this registry only owns their lifecycle. pendingNotices is deliberately
// NOT a member: it is session-keyed and released by its own session/disposed
// hook, not by the reset or the callId sweeps.
const approvalState = {
  reviewStates,
  followExpiry,
  reviewVerdicts,
  autoAnswered,
  resolvedCallIds,
  timeoutFeedback,
  decisionFeedback,
}

function clearApprovalState(): void {
  for (const map of Object.values(approvalState)) map.clear()
}

function sweepFollowPhase(now = Date.now()): void {
  for (const [callId, expiry] of followExpiry) {
    if (expiry <= now) {
      followExpiry.delete(callId)
      reviewStates.delete(callId)
    }
  }
  for (const [callId, at] of resolvedCallIds) {
    if (now - at > RESOLVED_TTL_MS) resolvedCallIds.delete(callId)
  }
  for (const [callId, at] of autoAnswered) {
    if (now - at > AUTO_ANSWERED_TTL_MS) autoAnswered.delete(callId)
  }
}

function sweepFeedbackMaps(): void {
  sweepFeedback(timeoutFeedback, { ttlMs: 60_000, maxEntries: 256 })
  sweepFeedback(decisionFeedback, { ttlMs: 60_000, maxEntries: 256 })
}

// Trusted Host authorities for web-route fencing (RISK-01/02); resolved once
// at apply() from webRuntime / --trusted-host / LAN enumeration.
let trustedHosts: string[] = []

function responseJson(res: any, status: number, body: any): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(status)
  res.end(bytes)
}

async function readJsonBody(req: any, maxBytes = 64 * 1024): Promise<any> {
  const contentType = req.headers?.['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ── web request trust (RISK-01/RISK-02) ────────────────────────────────────
// Mirrors the official dsh-client-connection `isTrustedApiRequest`: a Host
// loopback/LAN-whitelist fence against DNS rebinding, plus same-origin
// enforcement when an Origin header is present. Unlike the old
// `isSameOriginPost`, the Host authority is validated against a whitelist
// (loopback ∪ trusted LAN), so `Host: attacker.com` can never pass even when
// Origin matches it. The settings / reviewer-credential domains are treated as
// a privileged configuration plane and restricted to loopback-same-origin
// only, matching the official PRIVILEGED_METHODS precedent.

/** Resolve the trusted Host authorities: webRuntime service → argv → LAN IPv4. */
function resolveTrustedHosts(ctx: any): string[] {
  const webRuntime = ctx?.get?.('webRuntime') as { trustedHosts?: string[] } | undefined
  const fromRuntime = webRuntime?.trustedHosts
  if (Array.isArray(fromRuntime) && fromRuntime.length > 0) return [...fromRuntime]
  const argvTrusted: string[] = []
  const args = process.argv
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--trusted-host' && args[index + 1] !== undefined) argvTrusted.push(args[index + 1])
    else if (arg.startsWith('--trusted-host=')) argvTrusted.push(arg.slice('--trusted-host='.length))
  }
  if (argvTrusted.length > 0) return argvTrusted
  const bindHost = (ctx?.get?.('webServer') as { host?: string } | undefined)?.host
  if (bindHost === '0.0.0.0') {
    const lan: string[] = []
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) lan.push(iface.address)
      }
    }
    return lan
  }
  return []
}

function installFeedbackRoute(ctx: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: FEEDBACK_ROUTE,
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!isTrustedRequest(req, trustedHosts)) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      try {
        const body = await readJsonBody(req)
        if (typeof body?.callId !== 'string') throw new TypeError('callId is required')
        // The client may only confirm the outcome it is about to answer with;
        // the notice text is always generated host-side so a compromised page
        // can never inject text into the denied tool result (main chain).
        let outcome = body?.outcome
        if (outcome !== 'allowed-once' && outcome !== 'rejected') outcome = 'rejected'
        const actionText = outcome === 'allowed-once' ? 'approved' : 'rejected'
        // A decision feedback (e.g. the model already denied) takes precedence;
        // never let a time/auto marker mislabel it as "no response". Also skip
        // the timeout label when the ask was already resolved by the host (the
        // ACK landed after askHuman finished — relabeling it "no response"
        // would be wrong for both a human answer and an LLM takeover).
        if (!decisionFeedback.has(body.callId) && !resolvedCallIds.has(body.callId)) {
          recordTimeoutFeedback(body.callId, `[dsh-auto-approval-llm] no response: auto-${actionText}`)
        }
        // Client auto-answer marker (autoRespond/followRespond): remember it so
        // history can say 'auto-*' rather than implying a human clicked. Only
        // when the host has NOT already resolved: otherwise the ACK would
        // re-add a callId that askHuman already cleaned up, leaking it forever.
        if (body.auto === true && !resolvedCallIds.has(body.callId)) autoAnswered.set(body.callId, Date.now())
        // The client has seen the follow phase and is answering: release the
        // follow state early instead of waiting for the TTL sweep.
        if (reviewStates.get(body.callId)?.phase === 'follow') {
          reviewStates.delete(body.callId)
          followExpiry.delete(body.callId)
        }
        responseJson(res, 200, { ok: true })
      } catch (error) {
        responseJson(res, error instanceof RangeError ? 413 : 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'dsh-auto-approval-llm: feedback route')
}

function installSettingsRoute(ctx: any, settings: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer || !settings) return

  // Tolerant snapshot: if a stored value fails schema validation, settings.describe
  // may throw — never let that make GET 400 forever. Fall back to the raw stored
  // value so the settings card can still render it and offer to clear the bad keys.
  const describeSettings = (): { value: any; revision: number; writable: boolean; applies: string; configError: string | null } => {
    try {
      const desc = settings.describe().find((row: any) => row.ns === SETTINGS_NS)
      return {
        value: desc?.value ?? settings.get(SETTINGS_NS),
        revision: desc?.revision ?? 0,
        writable: settings.writable,
        applies: desc?.applies ?? 'restart',
        configError: configError ?? null,
      }
    } catch (error) {
      console.error('[dsh-auto-approval-llm] settings.describe failed, falling back to raw value', error)
      let raw: any = {}
      try {
        raw = settings.get(SETTINGS_NS) ?? {}
      } catch {
        raw = {}
      }
      return {
        value: raw,
        revision: 0,
        writable: settings.writable,
        applies: 'live',
        configError: configError ?? (error instanceof Error ? error.message : String(error)),
      }
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_ROUTE,
    handler: async (req: any, res: any) => {
      // Configuration plane: loopback-same-origin only (privileged domain,
      // mirroring the official settings/credentials fence).
      if (!isTrustedRequest(req, [])) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      try {
        if (req.method === 'GET') {
          responseJson(res, 200, { ok: true, value: describeSettings() })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST')
          responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const body = await readJsonBody(req)
        if (typeof body?.value !== 'object' || body.value === null) {
          throw new TypeError('value is required')
        }
        // Optimistic concurrency is mandatory: an omitted expectedRevision
        // would silently degrade the save to last-write-wins and lose a
        // concurrent editor's changes.
        if (typeof body?.expectedRevision !== 'number') {
          throw new TypeError('expectedRevision is required')
        }
        const value = preserveHostKeys(settings.get(SETTINGS_NS) ?? {}, body.value)
        await settings.replace(SETTINGS_NS, value, body.expectedRevision)
        responseJson(res, 200, { ok: true, value: describeSettings() })
      } catch (error) {
        responseJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'dsh-auto-approval-llm: settings route')
}

function installReviewerCredentialRoute(ctx: any, credentials: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: REVIEWER_CREDENTIAL_ROUTE,
    handler: async (req: any, res: any) => {
      // Credential plane: loopback-same-origin only (privileged domain).
      if (!isTrustedRequest(req, [])) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      try {
        if (req.method === 'GET') {
          if (!credentials) {
            responseJson(res, 200, { ok: true, value: { configured: false, source: undefined, writable: false } })
            return
          }
          const info = await credentials.describe(REVIEWER_CREDENTIAL_REF)
          responseJson(res, 200, {
            ok: true,
            value: {
              configured: info?.configured === true,
              source: info?.source ?? undefined,
              writable: info?.writable === true,
            },
          })
          return
        }
        if (req.method === 'DELETE') {
          // DELETEs carry no body, so this branch must run before the JSON
          // body reader (which requires a JSON content type).
          // Never report a cleared credential unless the store actually
          // dropped it: an unset failure (read-only store, backend error)
          // must surface to the settings card instead of a silent ok:true
          // that leaves the API key live and still being sent (M3).
          if (credentials) {
            const cleared = await credentials.unset(REVIEWER_CREDENTIAL_REF).then(() => true).catch(() => false)
            if (!cleared) {
              responseJson(res, 400, { ok: false, error: 'credential clear failed on the store' })
              return
            }
          }
          // Also drop the shared-file fallback source (the line this plugin
          // appended earlier): a cleared reviewer key must not resurrect from
          // the credential file on the next review. Best-effort only.
          clearReviewerKeyFromCredentialFile()
          responseJson(res, 200, { ok: true })
          return
        }
        const body = await readJsonBody(req)
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST, DELETE')
          responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!credentials) {
          responseJson(res, 400, { ok: false, error: 'credential service unavailable' })
          return
        }
        const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey) throw new TypeError('apiKey is required')
        await credentials.set(REVIEWER_CREDENTIAL_REF, apiKey)
        responseJson(res, 200, { ok: true })
      } catch (error) {
        responseJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'dsh-auto-approval-llm: reviewer credential route')
}

function installHistoryRoute(ctx: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: HISTORY_ROUTE,
    handler: async (req: any, res: any) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method === 'GET') {
        responseJson(res, 200, { ok: true, value: { records: [...approvalHistory].reverse(), llmLatency: summarizeLatency(llmLatency) } })
        return
      }
      if (req.method === 'DELETE') {
        const clearedCount = approvalHistory.length
        approvalHistory.length = 0
        try {
          writeFileSync(HISTORY_FILE, '')
        } catch {
          // Best-effort clear.
        }
        // Clear leaves a recoverable audit trail (never a silent erase).
        recordAuditClear(clearedCount)
        responseJson(res, 200, { ok: true, value: { records: [] } })
        return
      }
      res.setHeader('Allow', 'GET, DELETE')
      responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
    },
  }), 'dsh-auto-approval-llm: history route')
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: HISTORY_EXPORT_ROUTE,
    handler: async (req: any, res: any) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const body = JSON.stringify([...approvalHistory].reverse(), null, 2)
      const bytes = Buffer.from(body)
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="approval-history.json"')
      res.setHeader('Content-Length', String(bytes.length))
      res.writeHead(200)
      res.end(bytes)
    },
  }), 'dsh-auto-approval-llm: history export route')
}

function installReviewStatusRoute(ctx: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: REVIEW_STATUS_ROUTE,
    handler: async (req: any, res: any) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      // Call id travels in a request header (not the URL query) so it does not
      // leak into devtools/logs/Referer. Same-origin + loopback-trusted plan.
      const callId = String(req.headers?.['x-auto-approval-call-id'] ?? '').trim()
      const status = callId ? reviewStates.get(callId) : undefined
      responseJson(res, 200, status ? { ok: true, value: status } : { ok: false, error: 'not-found' })
    },
  }), 'dsh-auto-approval-llm: review status route')
}

function installModelsRoute(ctx: any, llm: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer || !llm?.listModels) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: MODELS_ROUTE,
    handler: async (req: any, res: any) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const provider = url.searchParams.get('provider') ?? ''
      if (!provider) {
        responseJson(res, 400, { ok: false, error: 'provider is required' })
        return
      }
      try {
        const models = await llm.listModels(provider)
        responseJson(res, 200, {
          ok: true,
          value: { models: models.map((m: any) => ({ id: m.id, name: m.name ?? m.id })) },
        })
      } catch (error) {
        responseJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'dsh-auto-approval-llm: models route')
}

function installTestRoute(ctx: any, llm: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: TEST_ROUTE,
    handler: async (req: any, res: any) => {
      // The online branch performs a server-side HTTP request driven by
      // request-body settings, so it must sit on the same trust plane as the
      // settings/credential routes: loopback-same-origin only. Otherwise any
      // LAN peer that passes `trustedHosts` (when the web server binds
      // 0.0.0.0) could turn the host process into an SSRF-to-loopback probe.
      if (!isTrustedRequest(req, [])) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const body = await readJsonBody(req)

        // Online-reviewer mode: hit the endpoint directly with the typed
        // (not-yet-saved) key and model from the draft. The key is never
        // logged or returned. Loopback-only: unlike the configured reviewer
        // BaseUrl (admin-controlled), this value comes straight from the
        // request body, so an https target must not become an SSRF probe
        // surface (RISK-03).
        if (body?.online) {
          const protocol = body.protocol === 'anthropic' ? 'anthropic' : 'openai'
          const validated = validateReviewerBaseUrl(body.baseUrl ?? '')
          if (!validated.ok) throw new TypeError(validated.reason)
          const baseUrl = validated.baseUrl
          const model = String(body.model ?? '').trim()
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (!baseUrl || !model) throw new TypeError('API 地址和模型名称是必填项')
          let probeUrl: URL
          try {
            probeUrl = new URL(baseUrl)
          } catch {
            throw new TypeError('API 地址不是合法 URL')
          }
          if (!isLoopbackHostname(probeUrl.hostname)) {
            throw new TypeError('在线评审测试仅支持本机回环地址（127.0.0.1 / localhost / [::1]）')
          }
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (apiKey) {
            if (protocol === 'anthropic') headers['x-api-key'] = apiKey
            else headers.Authorization = `Bearer ${apiKey}`
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8_000)
          try {
            if (protocol === 'anthropic') {
              const r = await fetch(`${baseUrl}/messages`, {
                method: 'POST',
                headers,
                signal: controller.signal,
                // Same redirect fence as the configured reviewer: the probe
                // must not follow a 302 into the broader network.
                redirect: 'error',
                body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
              })
              if (!r.ok) throw new Error(`HTTP ${r.status}`)
            } else {
              const r = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                signal: controller.signal,
                redirect: 'error',
                body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
              })
              if (!r.ok) throw new Error(`HTTP ${r.status}`)
            }
            responseJson(res, 200, { ok: true, value: { reachable: true, modelFound: true } })
          } finally {
            clearTimeout(timer)
          }
          return
        }

        const provider = body?.provider
        const model = body?.model
        if (!provider || !model) {
          throw new TypeError('provider and model are required')
        }
        const models = await llm.listModels(provider)
        const found = models.some((m: any) => m.id === model || m.name === model)
        responseJson(res, 200, {
          ok: true,
          value: { reachable: true, modelFound: found, count: models.length },
        })
      } catch (error) {
        responseJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'dsh-auto-approval-llm: test route')
}

function installSessionModeRoute(ctx: any): void {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SESSION_MODE_ROUTE,
    handler: async (req: any, res: any) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        responseJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!sessionId) {
        responseJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const agents = ctx.get('agents')
      const permissionPresets = ctx.get('permissionPresets')
      const agent = agents?.get?.(sessionId)
      if (!agent?.session) {
        responseJson(res, 404, { ok: false, error: 'agent not found' })
        return
      }
      const mode = permissionPresets?.current?.(agent.session.events)
      responseJson(res, 200, { ok: true, value: { mode: mode ?? null } })
    },
  }), 'dsh-auto-approval-llm: session mode route')
}

function trustedUserMessages(authority: any) {
  if (authority === undefined) return []
  const messages: string[] = []
  let remaining = 4_000
  for (let index = authority.session.events.length - 1; index >= 0 && messages.length < 4 && remaining > 0; index -= 1) {
    const event = authority.session.events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    const sanitized = sanitizeClassifierText(text).slice(0, remaining)
    messages.push(sanitized)
    remaining -= sanitized.length
  }
  return messages.reverse()
}

function isAutoPermissionExecution(exec: any, permissionPresets: any, presetName = AUTO_PRESET) {
  const events = exec.agent?.session.events
  return events !== undefined && permissionPresets?.current?.(events) === presetName
}

function autoPermissionAuthority(exec: any, parentAgent: any, permissionPresets: any, presetName = AUTO_PRESET) {
  if (isAutoPermissionExecution(exec, permissionPresets, presetName)) return exec.agent
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
    if (isAutoPermissionExecution(parentExec, permissionPresets, presetName)) return parent
    session = parent.session
  }
  return undefined
}

export function apply(ctx: Context, rawConfig: Config): void {
  const anyCtx = ctx as any
  const approval = anyCtx.get('approval')
  const permissionPresets = anyCtx.get('permissionPresets')
  const tools = anyCtx.get('tools')
  const llm = anyCtx.get('llm')
  const settings = anyCtx.get('settings')
  // Optional: DSH credential store for the online-reviewer API key (present
  // in the web profile). Absent → online reviewer degrades to ESCALATE and
  // the credential UI reports "unavailable".
  const credentials = anyCtx.get('credentials')

  let config: Config
  // Never hard-crash apply() because of a bad config: every risky step is
  // isolated, we fall back to the (valid) patch defaults, and the error is
  // surfaced to the settings banner. A failed plugin fiber would only lose the
  // approval features; running on safe defaults + a visible error is better.
  try {
    if (settings) {
      // Stale registrations from earlier builds may carry an invalid `applies`
      // value ('immediate' was never legal; the settings schema only accepts
      // 'live' | 'restart'). Normalize such a registration in place so a hot
      // reload fixes a broken running process instead of re-breaking on the
      // next `settings.describe()`. Mutating applies needs no re-resolve and
      // creates no register disposer race.
      const stale = (settings as any).registrations?.get?.(SETTINGS_NS)
      if (stale !== undefined) {
        const VALID_APPLIES = ['live', 'restart']
        if (!VALID_APPLIES.includes(stale.applies)) stale.applies = 'live'
      }
      try {
        const registered = settings.describe().some((row: any) => row.ns === SETTINGS_NS)
        if (!registered) settings.register(SETTINGS_NS, Config, { base: rawConfig, applies: 'live' })
      } catch (error) {
        // describe/register failed (e.g. a stored value breaks schema parse):
        // attempt a fresh register so the namespace still exists, and never
        // hard-fail apply.
        console.error('[dsh-auto-approval-llm] settings describe/register failed, trying to re-register', error)
        configError = error instanceof Error ? error.message : String(error)
        try {
          settings.register(SETTINGS_NS, Config, { base: rawConfig, applies: 'live' })
        } catch (e2) {
          configError = e2 instanceof Error ? e2.message : String(e2)
        }
      }
      try {
        config = resolveConfig(settings.get(SETTINGS_NS))
        configError = null
      } catch (error) {
        // Illegal persisted value: run on safe defaults and surface the error
        // so the settings card can offer to clear the offending keys.
        console.error('[dsh-auto-approval-llm] persisted config invalid, running defaults', error)
        configError = error instanceof Error ? error.message : String(error)
        config = resolveConfig(rawConfig)
      }
    } else {
      config = resolveConfig(rawConfig)
    }
  } catch (error) {
    console.error('[dsh-auto-approval-llm] settings init failed, fallback to rawConfig', error)
    config = resolveConfig(rawConfig)
  }
  debugOn = config.debug

  // Reviewer provider/model and classifier knobs are read at construction
  // time, so the classifier must be rebuilt whenever (live) settings change;
  // otherwise reviewerProvider edits would only take effect after a restart.
  // The override pair must be complete: a lone reviewerModel (or provider)
  // would throw inside the classifier once-during construction and take the
  // whole plugin down at boot (seen 2026-08-26: half-configured reviewer
  // settings crashed dsh). Single-sided values are ignored defensively.
  const classifierPair = config.reviewerProvider && config.reviewerModel
    ? { provider: config.reviewerProvider, model: config.reviewerModel }
    : {}
  let classifier = createDshClassifier(llm, {
    timeoutMs: config.classifierTimeoutMs ?? THRESHOLD_DEFAULTS.classifierTimeoutMs,
    maxOutputTokens: config.classifierMaxOutputTokens ?? THRESHOLD_DEFAULTS.classifierMaxOutputTokens,
    ...classifierPair,
  })
  const rebuildClassifier = () => {
    const pair = config.reviewerProvider && config.reviewerModel
      ? { provider: config.reviewerProvider, model: config.reviewerModel }
      : {}
    classifier = createDshClassifier(llm, {
      timeoutMs: config.classifierTimeoutMs ?? THRESHOLD_DEFAULTS.classifierTimeoutMs,
      maxOutputTokens: config.classifierMaxOutputTokens ?? THRESHOLD_DEFAULTS.classifierMaxOutputTokens,
      ...pair,
    })
  }

  if (settings) {
    anyCtx.on('settings/updated', (ns: string, next: any) => {
      if (ns !== SETTINGS_NS) return
      try {
        // Host-only keys (workspaceRoot/dshHome/tempRoots/trustedDirs/…) are
        // preserved by the settings route itself (preserveHostKeys). A second
        // construction-snapshot overwrite here against other plugins writing the
        // same namespace directly is tracked as backlog, not implemented yet.
        config = resolveConfig(next)
        configError = null
        debugOn = config.debug
        rebuildClassifier()
        console.log('[dsh-auto-approval-llm] settings updated, applied live')
      } catch (error) {
        console.error('[dsh-auto-approval-llm] live settings update failed', error)
        configError = error instanceof Error ? error.message : String(error)
      }
    })
  }

  // ── ported auto-mode policy (replaces @nanmicoder/dsh-auto-mode) ────────
  const artifacts = new ArtifactRegistry()
  const rootOptions = {
    ...(config.workspaceRoot ? { workspaceRoot: config.workspaceRoot } : {}),
    ...(config.dshHome ? { dshHome: config.dshHome } : {}),
    ...(config.tempRoots ? { tempRoots: config.tempRoots } : {}),
  }
  const parentAgent = (sessionId: any) => anyCtx.get('agents')?.get(sessionId)
  // Every roots consumer re-reads mode/trustedDirs from the LIVE config (G4):
  // neither key enters the frozen rootOptions, so a settings/updated hot swap
  // is reflected by the very next call into policy/shell/category.
  const rootsFor = (exec: any) => {
    const roots = resolveRoots(exec.agent?.session.header.cwd, rootOptions) as {
      workspace: string
      home: string
      dshHome: string
      tempRoots?: string[]
      allowedDshSubpaths?: string[]
      mode?: 'standard' | 'aggressive'
      trustedDirs?: string[]
    }
    roots.allowedDshSubpaths = [normalizePath(join(roots.dshHome, 'plugins', 'dsh-auto-approval-llm'), roots.workspace, roots.home)]
    roots.mode = config.categoryMode
    roots.trustedDirs = (config.trustedDirs ?? []).map((dir) => normalizePath(dir, roots.workspace, roots.home))
    return roots
  }
  const authorityFor = (exec: any) => autoPermissionAuthority(exec, parentAgent, permissionPresets, AUTO_PRESET)
  const isAutoExecution = (exec: any) => authorityFor(exec) !== undefined
  // Root authority session (walks the parent chain for subagents that inherit
  // Auto): the preset gate, breaker counter, and history are all keyed on this
  // so switching/creating a subagent can never reset the breaker.
  const authorityKeyFor = (exec: any): string =>
    (authorityFor(exec) ?? exec.agent)?.session?.id ?? 'unknown'

  const classifyStaticRisk = (req: any, args: any): { risk: StaticRisk; reason?: string; assessment?: any; category?: string; directive?: string; mode?: string } => {
    // Approval args come from the session log as a JSON string; parse them so
    // policy sees the real shape (external-write/destructive tools → HIGH)
    // instead of degrading every string arg to MEDIUM. Parse failure keeps the
    // current fail-safe behavior (undefined ≈ lost signal, never enhanced).
    let parsedArgs: unknown = args
    if (typeof args === 'string') {
      try {
        parsedArgs = JSON.parse(args)
      } catch {
        parsedArgs = undefined
      }
    }
    const exec = { name: req.toolName, agent: req.agent, arguments: parsedArgs }
    const roots = rootsFor(exec)
    const assessment = assessTool(exec, roots, artifacts)
    // Category layer: recomputed from scratch at this wiring point (no state
    // crosses over from pre-execute). auto ≡ LOW tier, and only for an
    // ask-classified, classifier-eligible call; HIGH and DENY stay put.
    // directive + category come from the same classification (no re-derivation).
    const { directive, category } = categoryDirectiveFor(exec, roots, config)
    let risk = riskFromAssessment(assessment, req.toolName)
    const applied = applyCategoryDirective(risk, directive, assessment)
    if (applied !== 'DENY' && applied !== 'ask-human') risk = applied
    debugLog({ ev: 'category', callId: req.callId ?? null, toolName: req.toolName, category, decision: directive, mode: config.categoryMode })
    // Carry the policy reason out for the policy-deny feedback; the
    // public riskFromAssessment / StaticRisk contract stays untouched.
    return { risk, reason: assessment.reason, assessment, category, directive, mode: config.categoryMode }
  }

  // ── confirmation-learning helpers ───────────────────────────────────────
  // The ONLY producer of a learnable context is learnableContextFor, and it is
  // called from exactly the four countdown ask sites — never from the six
  // status-less hooks (their confirmations can never mature into a hit) and
  // never from anywhere else. The gate (risk tier × category × sensitive fuse)
  // is evaluated here for the record-time snapshot and re-evaluated live at
  // the query point; failing either side means "never learned".
  const learningFuseHit = (req: any, args: any, policyReason: string | undefined): boolean => {
    if (RISK_NAME_PATTERN.test(String(req.toolName ?? ''))) return true
    if (policyReason !== undefined && RISK_REASON_PATTERN.test(policyReason)) return true
    let parsed: unknown = args
    if (typeof args === 'string') {
      try {
        parsed = JSON.parse(args)
      } catch {
        parsed = undefined
      }
    }
    const rawPathArgs = typeof parsed === 'string' || parsed === undefined
      ? (typeof args === 'string' ? args : undefined)
      : JSON.stringify(parsed)
    const target = rawPathArgs === undefined ? undefined : extractToolPath(rawPathArgs)
    if (target === undefined) return false
    const roots = rootsFor({ agent: req.agent })
    const normalized = normalizePath(target, roots.workspace, roots.home)
    return sensitiveBasenameAt(normalized, roots) || isProtectedProjectPath(normalized, roots)
  }

  interface LearnableContext {
    key: string
    workspace: string
    kind: LearningKind
    skeleton: string
  }

  const learnableContextFor = (
    req: any,
    args: any,
    classified: { risk: StaticRisk; category?: string },
  ): LearnableContext | undefined => {
    try {
      if (!config.learningEnabled) return undefined
      if (!learnGateEligible({
        enabled: config.learningEnabled,
        staticRisk: classified.risk,
        category: classified.category,
        fuseHit: learningFuseHit(req, args, undefined),
      })) return undefined
      const toolName = String(req.toolName ?? '')
      let input: { kind: LearningKind; command?: string; toolName?: string; args?: unknown }
      if (toolName === 'bash' || toolName === 'pwsh') {
        let parsed: unknown = args
        if (typeof args === 'string') {
          try {
            parsed = JSON.parse(args)
          } catch {
            return undefined
          }
        }
        const command = (parsed as any)?.command
        if (typeof command !== 'string' || command.trim() === '') return undefined
        input = { kind: toolName === 'bash' ? 'shell-bash' : 'shell-pwsh', command }
      } else {
        let parsed: unknown = args
        if (typeof args === 'string') {
          try {
            parsed = JSON.parse(args)
          } catch {
            parsed = undefined
          }
        }
        input = { kind: 'tool', toolName, args: parsed }
      }
      const signature = signatureFor(input)
      if (signature === undefined) return undefined
      const workspace = rootsFor({ agent: req.agent }).workspace
      if (workspace === undefined || workspace === '') return undefined
      return {
        key: learningKey(input.kind, workspace, signature.signature),
        workspace,
        kind: input.kind,
        skeleton: signature.skeleton,
      }
    } catch {
      return undefined
    }
  }

  const riskReviewed = (risk: 'LOW' | 'MEDIUM' | 'HIGH', scope: Config['llmReviewScope']): boolean => {
    if (scope === 'low-or-above') return true
    if (scope === 'medium-or-above') return risk !== 'LOW'
    return risk === 'HIGH'
  }

  const riskSeconds = (risk: 'LOW' | 'MEDIUM' | 'HIGH'): number => {
    if (risk === 'LOW') return Math.max(1, Math.round(config.lowRiskSeconds))
    if (risk === 'MEDIUM') return Math.max(1, Math.round(config.mediumRiskSeconds))
    return Math.max(1, Math.round(config.highRiskSeconds))
  }

  const riskTakenOver = (risk: 'LOW' | 'MEDIUM' | 'HIGH', scope: Config['llmTakeoverScope']): boolean => {
    if (scope === 'low') return risk === 'LOW'
    if (scope === 'medium-or-below') return risk === 'LOW' || risk === 'MEDIUM'
    return true
  }

  // ── symlink-escape guard (host-side) ────────────────────────────────────
  // The pure policy layer is deliberately fs-free and only compares textual
  // paths, so a workspace symlink pointing outside (e.g. `ws/ln -> ~/.bashrc`)
  // would let a write/read that is textually "inside the workspace" actually
  // hit an external file and defeat the home/DSH_HOME/credential fuses. This
  // host-side guard resolves the deepest existing ancestor of the target and
  // hard-denies when its realpath leaves the workspace. Best-effort: any fs
  // failure returns undefined and the normal (textual) policy decides.
  // The per-tool target extraction lives in policy.symlinkGuardTargets (pure,
  // contract-tested) so the guard sees the exact same paths as the policy.
  // Resolve the realpath of the workspace root once (cached) so targets are
  // compared against the *resolved* workspace, not its textual spelling: a
  // workspace that lives under a junctioned/symlinked parent (OneDrive,
  // AppData links, …) must not turn every routine read into a false escape.
  let realWorkspace: string | undefined
  const resolveDeepest = (input: string): string | undefined => {
    let probe = input
    while (true) {
      try {
        return realpathSync(probe)
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return undefined
        probe = parent
      }
    }
  }
  const symlinkEscapeReason = (exec: any, roots: any): string | undefined => {
    const args = (typeof exec.arguments === 'object' && exec.arguments !== null && !Array.isArray(exec.arguments)) ? exec.arguments : undefined
    if (args === undefined) return undefined
    const name = String(exec.name ?? '')
    const targets = symlinkGuardTargets(name, args)
    if (targets === undefined || targets.length === 0) return undefined
    if (realWorkspace === undefined) realWorkspace = resolveDeepest(roots.workspace)
    if (realWorkspace === undefined) return undefined
    const realWsNormalized = normalizePath(realWorkspace, roots.workspace, roots.home)
    const aggressive = roots.mode === 'aggressive'
    // Custom trusted directories join both zone checks (G8): a target that is
    // textually inside a trustedDir is still hard-denied when its realpath
    // escapes every allowed zone (workspace ∪ plugin zone ∪ trustedDirs).
    const trustedZone: string[] = [...(roots.allowedDshSubpaths ?? []), ...(roots.trustedDirs ?? [])]
    for (const target of targets) {
      const textual = normalizePath(target, roots.workspace, roots.home)
      // Only a target that is textually inside the workspace (or inside a
      // trusted plugin-development path, which the policy auto-allows) is this
      // guard's business: a realpath escaping it is worth hard-denying only
      // when the textual target pretended to be local/trusted. Any other
      // textually-external target is judged by the normal hard-deny / 'ask'
      // escalation instead of being turned into an unconditional hard deny.
      // Under aggressive the position gate is relaxed, so the realpath re-check
      // covers every textual target — the remaining credential/system fence.
      const inTrustedZone = trustedZone.some(root => isWithin(root, textual))
      if (!isWithin(roots.workspace, textual) && !inTrustedZone && !aggressive) continue
      const resolved = resolveDeepest(target)
      if (resolved === undefined) continue
      const normalized = normalizePath(resolved, roots.workspace, roots.home)
      // Independent runtime-state re-check, orthogonal to zone escape: a
      // textual workspace/trusted-zone target whose RESOLVED landing spot is a
      // plugin runtime-state file must hard-deny even when the realpath stays
      // inside every allowed zone (the escape check below stays silent there).
      // Mode-independent on purpose: mutating approval/audit/learning state is
      // never a routine write under either position mode.
      if (runtimeStateTargetInZone(normalized, roots.allowedDshSubpaths)) {
        return `target resolves into plugin runtime state via a symlink: ${normalized}`
      }
      const escape = realpathCriticalReason(textual, normalized, roots, roots.trustedDirs, realWsNormalized)
      if (escape === undefined) continue
      if (aggressive) {
        // An escape outside every allowed zone keeps its hard deny only when
        // it lands on a critical tree, DSH_HOME, or plugin runtime state; a
        // plain external target is the aggressive design goal and stays open.
        if (isCriticalPath(normalized, roots) || isWithin(roots.dshHome, normalized) || runtimeStateTargetInZone(normalized, roots.allowedDshSubpaths)) {
          return escape
        }
        continue
      }
      return escape
    }
    return undefined
  }

  anyCtx.tools?.guard?.((exec: any) => {
    if (!isAutoExecution(exec)) return undefined
    const roots = rootsFor(exec)
    const hard = hardDenyReason(exec, roots)
    if (hard !== undefined) return hard
    return symlinkEscapeReason(exec, roots)
  })

  anyCtx.on('tools/pre-execute', async (exec: any, next: any) => {
    if (!isAutoExecution(exec)) return next()
    // First-use onboarding: the first tool call of an AUTO root session (per
    // process lifetime) queues a one-shot greeting through the safe notice
    // queue — it only registers a pending entry, never touches the decision
    // flow below, and the flush point (step/end) keeps it out of the
    // tool-calls message-sequence window.
    if (markFirstAutoSessionNotice(authorityKeyFor(exec))) {
      queueNotice(exec.agent.session, exec.callId, onboardingNoticeText(config.timeoutAction))
      debugLog({ ev: 'onboarding-inject', sessionId: exec.agent?.session?.id ?? null, callId: exec.callId ?? null, action: config.timeoutAction })
    }
    const roots = rootsFor(exec)
    const assessment = assessTool(exec, roots, artifacts)
    if (assessment.plannedCreates !== undefined) artifacts.plan(exec, assessment.plannedCreates, roots)
    if (assessment.decision === 'deny') return { kind: 'deny', reason: `[auto-mode hard deny] ${assessment.reason}` }
    // Audit-only trail: a shell command that cleared the hard fuse and may
    // still run (statically allowed or classifier-approved) while opening one
    // of the plugin's own runtime-state files for reading (approval history,
    // audit log, …). Purely observational — it never alters any verdict.
    if ((exec.name === 'bash' || exec.name === 'pwsh') && typeof exec.arguments?.command === 'string') {
      const stateReads = runtimeStateReadHits(exec.arguments.command, exec.name, roots)
      if (stateReads.length > 0) debugLog({ ev: 'runtime-state-read', callId: exec.callId ?? null, files: stateReads })
    }
    // Category tightening (only deny/ask; auto/inherit never intercept here).
    // Deny/ask apply to every non-hard-denied result, including static allows,
    // so a routine read/write cannot slip past a category deny/ask. deny
    // performs the full rejection dialogue (feedback + history) itself; ask
    // returns immediately so the LLM classifier fast path can never answer a
    // category ask — a category ask is an explicit human decision.
    const { directive, category } = categoryDirectiveFor(exec, roots, config)
    if (directive === 'deny') {
      recordDecisionFeedback(exec.callId, formatDenyFeedback('category', { toolName: exec.name }))
      pushHistory({
        sessionId: authorityKeyFor(exec),
        toolName: exec.name,
        outcome: 'rejected',
        source: 'category-deny',
        category,
        categoryDecision: 'deny',
        mode: config.categoryMode,
      })
      debugLog({ ev: 'category', callId: exec.callId ?? null, toolName: exec.name, category, decision: 'deny', mode: config.categoryMode })
      return { kind: 'deny', reason: `[auto-mode category deny] ${exec.name}` }
    }
    if (directive === 'ask') {
      return { kind: 'ask', reason: `[auto-mode category ask] ${exec.name}` }
    }
    if (assessment.decision === 'allow') return next()
    if (!assessment.classifierEligible) return { kind: 'ask', reason: `[auto-mode approval required] ${assessment.reason}` }
    try {
      const authority = authorityFor(exec)
      const route = resolveModelRoute(exec.agent) ?? resolveModelRoute(authority)
      const aggressiveAuto = config.categoryMode === 'aggressive' && 'auto' === directive && AGGRESSIVE_BUILTIN.includes(category as CategoryKey)
      const riskTier = riskFromAssessment(assessment, exec.name)
      const decision = await classifier.classify({
        toolName: exec.name,
        arguments: sanitizeClassifierArguments(exec.arguments),
        workspaceRoot: roots.workspace,
        // The assessment reason embeds tool names and user-controlled paths;
        // sanitize at the classifier boundary like every other payload field
        // (RISK-04 prompt-injection surface).
        policyReason: sanitizeClassifierText(assessment.reason),
        trustedUserMessages: trustedUserMessages(authority),
        mode: config.categoryMode,
        aggressiveAuto: aggressiveAuto,
        riskTier: riskTier,
        ...(route === undefined ? {} : { route }),
      }, exec.signal)
      debugLog({ ev: 'classifier-decision', callId: exec.callId ?? null, toolName: exec.name, category, directive, mode: config.categoryMode, aggressiveAuto, riskTier, decision: decision.decision, reason: sanitizeReviewReason(decision.reason) })
      if (decision.decision === 'allow') return next()
      if (decision.decision === 'deny') return { kind: 'deny', reason: `[auto-mode classifier deny] ${decision.reason}` }
      return { kind: 'ask', reason: `[auto-mode classifier asks] ${decision.reason}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'ask', reason: `[auto-mode classifier unavailable] ${message}` }
    }
  })

  anyCtx.on('tools/result', (exec: any, result: any) => {
    if (!isAutoExecution(exec)) return
    artifacts.settle(exec, result, rootsFor(exec))
  })

  watchNotices(anyCtx)
  trustedHosts = resolveTrustedHosts(anyCtx)
  installFeedbackRoute(anyCtx)
  installSettingsRoute(anyCtx, settings)
  installReviewerCredentialRoute(anyCtx, anyCtx.get('credentials'))
  installHistoryRoute(anyCtx)
  installReviewStatusRoute(anyCtx)
  installModelsRoute(anyCtx, llm)
  installTestRoute(anyCtx, llm)
  installSessionModeRoute(anyCtx)
  installStatsRoute(anyCtx)

  // Sweep expired follow-phase statuses so a client that never ACKs (closed
  // tab / headless page) cannot leak callId keys in reviewStates.
  const followSweep = setInterval(() => {
    sweepFollowPhase(Date.now())
  }, 1_000)
  ctx.effect(() => () => clearInterval(followSweep))

  anyCtx.on('tools/post-execute', (exec: any, result: any, next: any) => {
    sweepFeedbackMaps()
    const timeoutEntry = timeoutFeedback.get(exec?.callId)
    const decisionEntry = decisionFeedback.get(exec?.callId)
    // Result-side masking: hangs on the single `!result?.isError` gate so
    // it covers BOTH early-return paths below (no feedback entry, and entry
    // present but the tool actually succeeded — the delayed-denial race).
    // Fail-closed by construction: any masking anomaly falls back to the
    // untouched result plus a mask-failed audit line; the accept+value path
    // re-runs the output-schema check in dsh-tools, so a shape-violating mask
    // must never turn a successful call into an error.
    if (!result?.isError && config.redactResults && isAutoExecution(exec)) {
      try {
        const cleaned = redactResultValue(result.value)
        if (cleaned !== result.value) {
          auditRedact(exec?.callId, exec?.toolName)
          return Promise.resolve({ kind: 'accept', value: cleaned })
        }
      } catch (error) {
        auditMaskFailed(exec?.callId, exec?.toolName)
        console.warn('[dsh-auto-approval-llm] result masking failed, forwarding the untouched result', error instanceof Error ? error.message : String(error))
        return next()
      }
    }
    if (!timeoutEntry && !decisionEntry) return next()
    if (timeoutEntry) timeoutFeedback.delete(exec.callId)
    if (decisionEntry) decisionFeedback.delete(exec.callId)
    if (!result?.isError) return next()
    const text = decisionEntry?.text ?? timeoutEntry?.text ?? ''
    return Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text }] })
  }, { global: true })

  // ── auto-switch never -> ask (only for auto preset, opt-in) ──────────────
  const switchTimers = new Set<ReturnType<typeof setTimeout>>()
  const clearSwitchTimers = () => {
    for (const timer of switchTimers) clearTimeout(timer)
    switchTimers.clear()
  }
  ctx.effect(() => clearSwitchTimers)

  const ensureAsk = (agent: any) => {
    if (!config.autoSwitchPolicyToAsk || !agent?.session) return
    if (!permissionPresets) return
    const preset = permissionPresets.current?.(agent.session.events)
    if (preset !== AUTO_PRESET) return
    if (approval?.overrideOf?.(agent.session) !== 'never') return
    const timer = setTimeout(() => {
      switchTimers.delete(timer)
      try {
        approval.setPolicy(agent, 'ask')
      } catch (error) {
        console.error('[dsh-auto-approval-llm] setPolicy failed:', error)
      }
    }, 0)
    switchTimers.add(timer)
  }

  anyCtx.on('agent/created', (payload: any) => {
    ensureAsk(payload?.agent)
  })

  // Sweep already-live agents on startup so existing auto-preset sessions that
  // were left with a `never` override also get switched to `ask`.
  const agents = anyCtx.get('agents')
  if (agents && typeof agents.list === 'function') {
    for (const agent of agents.list()) ensureAsk(agent)
  }

  // ── approval/request answerer (prepend => terminal for handled asks) ─────
  const denials = new Map<string, number>()
  const reviewModes = loadReviewModes()
  const setReviewMode = (sessionKey: string, mode: ReviewMode): void => {
    const normalized = normalizeReviewMode(mode)
    if (normalized === 'smart') reviewModes.delete(sessionKey)
    else reviewModes.set(sessionKey, normalized)
    persistReviewModes(reviewModes)
  }
  const totalDenials = new Map<string, number>()
  const denialLog = new Map<string, Array<{ reason?: string; toolName: string }>>()
  // Learned allows per root authority session. This is the third, independent
  // brake on the learning layer: past the cap the whole layer sleeps for that
  // session (constant miss → back to a human), while applyBreaker and every
  // other pipeline stay untouched. Cleaned up on session disposal below.
  const sessionLearnedAllows = new Map<string, number>()
  // Per-session-key mutex serializing the breaker read-modify-write. Without it
  // two in-flight approvals sharing a sessionKey could interleave their map
  // reads/writes (after an await) and lose an increment. The critical section
  // contains ONLY synchronous Map ops — never the surrounding await — so
  // unrelated approvals stay concurrent.
  const breakerMutex = createKeyedMutex()
  // Independent mutex for the learning store: keyed by the signature hash so
  // concurrent confirms of the same signature serialize, different signatures
  // never wait on each other. The critical section contains ONLY synchronous
  // map ops + the synchronous tmp+rename persist — never an await (same
  // contract as the breaker mutex above).
  const learningMutex = createKeyedMutex()

  // Breaker counters are keyed by the authority session id (see
  // authorityKeyFor). A `session/disposed` only fires for the exact session
  // that is going away — a subagent disposal never fires for its root — so it
  // is safe to drop the counters when that id itself is a key: the authority
  // is gone and its breaker state must not leak in a long-lived process.
  anyCtx.on('session/disposed', (session: any) => {
    const key = session?.id
    if (key === undefined) return
    // Drop the breaker counters under the same per-key lock as the in-flight
    // approval writes, so a write that is still queued behind us cannot
    // resurrect a stale counter after disposal (reset race). The shared Promise
    // chain serializes this delete after any pending critical section for the
    // key; a write that starts after disposal recreates the key, which is fine
    // because the session is gone.
    void breakerMutex.run(key, () => {
      denials.delete(key)
      totalDenials.delete(key)
      denialLog.delete(key)
      // The learned-allow allowance is keyed by the same authority id; drop it
      // here so a disposed root session cannot leak its counter (a fresh
      // session starts with a full learning allowance again).
      sessionLearnedAllows.delete(key)
    })
    if (requestAtByKey.has(key)) requestAtByKey.delete(key)
    // Persisted per-session review mode is keyed by the same authority id; drop
    // it so a long-lived process neither leaks the entry in memory nor grows the
    // review-mode.json file forever with disposed sessions.
    if (reviewModes.has(key)) {
      reviewModes.delete(key)
      persistReviewModes(reviewModes)
    }
  })
  // request→resolution total time, tracked per session authority so concurrent
  // approves in different sessions cannot clobber each other's timestamp.
  const requestAtByKey = new Map<string, number>()

  const askHuman = async (req: any, review: ReviewResult | undefined, next: () => Promise<any>, breaker = false, status?: ReviewStatus, handle?: RaceHumanHandle, llmDecided?: boolean, learnable?: LearnableContext): Promise<any> => {
    // Delegate to the official ApprovalPanel; the client half parses the
    // countdown marker and adds the visible countdown + auto-answer. Breaker
    // requests intentionally omit the marker so no automatic timeout runs.
    if (status && req.callId !== undefined) reviewStates.set(req.callId, status)
    const notes: string[] = []
    let breakerReasons: string[] | undefined
    if (review) {
      notes.push(reviewSuggestionNote(review))
    }
    if (breaker) {
      const key = authorityKeyFor({ agent: req.agent })
      const log = denialLog.get(key) ?? []
      breakerReasons = log.map((d, i) => `${i + 1}. ${d.toolName}${d.reason ? ` — ${d.reason}` : ''}`)
      const reasons = breakerReasons.join('\n')
      const concur = denials.get(key) ?? 0
      const total = totalDenials.get(key) ?? 0
      const byConsecutive = config.maxConsecutiveDenials > 0 && concur >= config.maxConsecutiveDenials
      const limitText = byConsecutive
        ? `rejected ${config.maxConsecutiveDenials} times in a row`
        : `rejected ${config.maxTotalDenials} times in total`
      notes.push(`⚠️ Breaker: model was ${limitText}; handed to a human, auto-countdown disabled.${reasons ? `\nPrevious denial reasons:\n${reasons}` : ''}`)
    } else {
      const seconds = status
        ? Math.max(1, Math.round(status.seconds))
        : Math.max(1, Math.round(config.highRiskSeconds))
      const actionText = status?.action === 'allow' ? 'approve' : 'reject'
      notes.push(`[dsh-auto-approval-llm] ⏳ will auto-${actionText} in ${seconds}s if no response`)
    }
    const extra = notes.map((n) => `\n\n${n}`).join('')
    // Edit-class operations get a line-level diff preview of the target file
    // appended as a trailing marked block (display-only). Any failure, gate
    // rejection, or disabled config omits the block entirely.
    let editDiffText: string | undefined
    if (config.editDiffPreview === true && EDIT_DIFF_TOOLS.has(String(req.toolName ?? ''))) {
      const roots = rootsFor({ agent: req.agent })
      const rawArgs = findToolCallArguments(req.agent.session, req.callId, EDIT_DIFF_ARGS_MAX_CHARS)
      const diff = buildEditDiff(String(req.toolName ?? ''), rawArgs, roots.workspace, roots.home)
      if (diff !== undefined) editDiffText = buildEditDiffText(diff)
    }
    // Strip any client-parseable auto-answer markers from the model-controlled
    // base reason first: only the notes this host appends below may arm the
    // browser watcher's countdown.
    req.reason = buildAskReason(req.reason, extra, editDiffText)
    let outcome: any
    let timedOut = false
    // Whether a decisive caller (an LLM takeover) authoritatively settled the
    // race. Only this — never the mere presence of an advisory review verdict —
    // may label the resolution `llm-*` or feed the denial breaker.
    let claimed = false
    // Whether the delegated official approval (next()) rejected — session
    // disposed or the request was cancelled. The follow published in the finally
    // must then never claim the human decided (source 'abort', action reject).
    let aborted = false
    const t0 = Date.now()
    const canTimeout = status !== undefined && req.callId !== undefined &&
      status.phase === 'countdown' && status.seconds > 0
    try {
      if (canTimeout && status !== undefined) {
        // Host-authoritative countdown: the official panel still receives the
        // request via next(), but an automatic outcome is produced here so a
        // closed tab / headless session can never hang an approval forever.
        const raced = await raceHumanDecision(() => next(), {
          status: { seconds: status.seconds, action: status.action },
          callId: req.callId,
          recordTimeout: (id, text) => recordTimeoutFeedback(id, text),
        }, handle)
        outcome = raced.outcome
        timedOut = raced.timedOut
        claimed = raced.claimed
      } else {
        outcome = await Promise.resolve().then(() => next())
      }
    } catch (error) {
      // The delegated official approval (next()) rejected — e.g. the session
      // was disposed or the request was cancelled while awaiting the panel.
      // The success path below (resolvedCallIds/verdict/autoAnswered cleanup,
      // history, breaker) is skipped by the propagating exception, so perform
      // the essential per-callId cleanup here to keep the maps bounded, mark
      // the ask host-resolved so a late FEEDBACK ACK cannot relabel it, and
      // drop any stored verdict/auto-answer marker. Then rethrow so the
      // approval chain observes the failure (fail-closed: never a fabricated
      // resolution).
      aborted = true
      if (req.callId !== undefined) {
        resolvedCallIds.set(req.callId, Date.now())
        reviewVerdicts.delete(req.callId)
        autoAnswered.delete(req.callId)
      }
      throw error
    } finally {
      // Release the in-flight panel status so a headless/aborted path can
      // never leak a callId key in reviewStates — but keep a `follow` phase
      // visible for the client's poll window. The host has already decided,
      // and the official panel is only closed by the client's respond, so a
      // deleted status would make the next poll 404 and restart the visible
      // countdown (the reported "LLM 审批后弹窗仍倒计时" bug). The verdict
      // maps are read RIGHT AFTER this block to compute the source, so they
      // are cleaned up later (after pushHistory), never here.
      if (status && req.callId !== undefined) {
        const current = reviewStates.get(req.callId)
        const resolution = followResolution(
          current?.phase,
          { risk: status.risk, outcome },
          { timedOut, aborted },
        )
        if (resolution.kind === 'publish') {
          reviewStates.set(req.callId, resolution.follow)
        }
        followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
      }
    }
    // Mark the ask as host-resolved so a late client ACK (FEEDBACK auto:true)
    // cannot relabel it "no response: auto-*" or re-add it to autoAnswered.
    // Covers status-less asks too: their client-side countdown answer is also
    // a resolution the host has already finished by the time the ACK lands.
    if (req.callId !== undefined) resolvedCallIds.set(req.callId, Date.now())
    // The denial breaker is updated below, after `source` is computed, so it
    // only ever reacts to a human decision (reset) or a decided LLM denial
    // (increment) — never to a timeout or an advisory (non-takeover) review.
    const key = authorityKeyFor({ agent: req.agent })
    // Honest provenance: only the host timer actually expiring (`timedOut`,
    // returned by raceHumanDecision) is a timeout. The client's own
    // FEEDBACK_ROUTE write (auto/follow respond) must NOT relabel this as a
    // timeout — that was mislabeling every auto-answer as 'timeout-*'.
    const follow = (review as any) ?? (req.callId !== undefined ? reviewVerdicts.get(req.callId) : undefined)
    const followDecidable = follow && (follow.decision === 'ALLOW' || follow.decision === 'DENY')
    const llmMeta = follow && follow.decision
      ? {
          llmDecision: follow.decision,
          llmRisk: follow.riskLevel,
          llmReason: follow.reason,
          ...(Array.isArray(follow.attempts) && follow.attempts.length > 0 ? { attempts: follow.attempts } : {}),
        }
      : {}
    const auto = req.callId !== undefined && autoAnswered.has(req.callId)
    // Honest provenance: only a genuine LLM takeover (the caller's claim
    // settled the race) may label the resolution `llm-*`. An advisory review
    // verdict may still exist (followDecidable), but a human/timeout/auto
    // resolution is NOT an LLM decision, and the breaker must not count it.
    const source = approvalSource({
      outcome,
      timedOut,
      claimed,
      auto,
      reviewerDecision: followDecidable ? follow.decision : undefined,
    })
    // Breaker transition: a human answer resets the counters, a decided LLM
    // denial (only when this ask was an LLM takeover — never an advisory HIGH
    // review) increments them; every other outcome leaves them untouched.
    // Serialize the read-modify-write per sessionKey so concurrent approvals
    // for the same session cannot interleave and lose an increment. The block
    // is synchronous (no await) — holding the lock across an await would
    // serialize unrelated approvals for the session.
    await breakerMutex.run(key, () => {
      const transition = applyBreaker(
        { consecutive: denials.get(key) ?? 0, total: totalDenials.get(key) ?? 0 },
        source,
        llmDecided === true,
      )
      denials.set(key, transition.counts.consecutive)
      totalDenials.set(key, transition.counts.total)
      if (transition.reset) denialLog.delete(key)
      if (transition.increment) {
        const log = denialLog.get(key) ?? []
        log.push({ reason: (follow as any)?.reason ? sanitizeReviewReason((follow as any).reason) : undefined, toolName: req.toolName })
        if (log.length > config.maxConsecutiveDenials) log.shift()
        denialLog.set(key, log)
      }
    })
    if (debugOn) console.log('[dsh-auto-approval-llm][debug] approval resolved', {
      callId: req.callId ?? null,
      outcome,
      timedOut,
      source,
      auto,
      seconds: status?.seconds ?? null,
      elapsedMs: Date.now() - t0,
      llmDecision: (follow as any)?.decision ?? null,
      breaker: breaker === true,
    })
    const requestAt = requestAtByKey.get(key) ?? null
    debugLog({ ev: 'resolve', callId: req.callId ?? null, outcome, timedOut, source, auto, seconds: status?.seconds ?? null, elapsedMs: Date.now() - t0, requestAt, requestToResolveMs: requestAt !== null ? Date.now() - requestAt : null, llmDecision: (follow as any)?.decision ?? null })
    pushHistory({
      sessionId: key,
      toolName: req.toolName,
      outcome,
      source,
      ...llmMeta,
      ...(breaker ? { breaker: true, breakerReasons } : {}),
    })
    // Learning bookkeeping at the single convergence point, right next to the
    // history write. Only a genuine human allow on a qualified (countdown)
    // hook increments — `learnable` is produced exclusively by those four
    // sites; a human deny on the same signature resets its count; every other
    // resolution source (timeout-*, llm-*, auto-*, abort, learned-allow) is a
    // zero code path here. The critical section is synchronous-only (map ops
    // + the synchronous tmp+rename persist), honoring the keyed-mutex
    // "never await inside" contract.
    if (learnable !== undefined) {
      const action = confirmActionFor(source)
      if (action !== 'ignore') {
        try {
          await learningMutex.run(learnable.key, () => {
            if (action === 'reset') {
              resetConfirmation(learningStore, learnable.key, Date.now())
            } else {
              recordConfirm(learningStore, learnable.key, { workspace: learnable.workspace, kind: learnable.kind, skeleton: learnable.skeleton }, Date.now())
            }
            persistLearning(LEARNING_FILE, learningStore)
          })
          debugLog({ ev: 'learn-record', callId: req.callId ?? null, source, action })
        } catch (error) {
          debugLog({ ev: 'learn-record-error', callId: req.callId ?? null, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    // Verdict maps are read above to compute the source; clean them now.
    if (req.callId !== undefined) {
      reviewVerdicts.delete(req.callId)
      autoAnswered.delete(req.callId)
    }
    return outcome
  }

  // ── confirmation-learning query + release gate ───────────────────────────
  // Runs at exactly one wiring point: AFTER the terminal policy hard-deny and
  // BEFORE the risk branches (so every hard layer above structurally precedes
  // any learned allow), and only when the switch is on. A hit still owes the
  // current call one standard online reviewer audit — same machinery as the
  // ordinary reviews (reasoning-blind input, per-tier budget, CRITICAL-flag
  // block); anything other than a clean ALLOW falls through to the ordinary
  // branch as if the layer never matched. The verification never touches the
  // denial breaker, and confirmed samples (skeleton included) never enter a
  // prompt.
  const learnAttempt = async (
    req: any,
    args: any,
    classified: { risk: StaticRisk; category?: string; mode?: string },
    sessionKey: string,
    reviewOpts: {
      userMessages?: string[]
      workspaceRoot?: string
      home?: string
      contextFacts?: { artifacts: ArtifactRegistry; owner?: unknown }
    },
  ): Promise<'allowed-once' | undefined> => {
    try {
      if (!config.learningEnabled) return undefined
      const capUsed = sessionLearnedAllows.get(sessionKey) ?? 0
      const capMax = THRESHOLD_DEFAULTS.learningSessionAllowCap
      const routeAvailable = !!((config.reviewerProvider && config.reviewerModel) || config.reviewerBaseUrl || sessionModelRoute(req.agent.session))
      if (!routeAvailable) return undefined
      const learnable = learnableContextFor(req, args, classified)
      if (learnable === undefined) return undefined
      const decision = learnDecision({
        enabled: config.learningEnabled,
        staticRisk: classified.risk,
        category: classified.category,
        key: learnable.key,
        workspace: learnable.workspace,
        threshold: clampLearningThreshold(config.learningThreshold, THRESHOLD_DEFAULTS.learningThreshold),
        now: Date.now(),
        capUsed,
        capMax,
        store: learningStore,
      })
      if (!decision.hit) return undefined
      // DENY can never reach this line (the terminal above returned); the
      // assertion only narrows the tier type for the per-risk budget.
      const seconds = riskSeconds(classified.risk as 'LOW' | 'MEDIUM' | 'HIGH')
      const start = Date.now()
      const { review, attempts } = await reviewWithLLM(credentials, llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: false,
      })
      pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - start, settled: review.failure === undefined, attempts: Math.max(1, attempts.length) })
      debugLog({ ev: 'learned-review', callId: req.callId ?? null, decision: review.decision, risk: review.riskLevel ?? null, tookMs: Date.now() - start })
      // Anything but a clean ALLOW (DENY / ESCALATE / failure / CRITICAL-flagged
      // contradiction) is treated as a miss and slides back into the ordinary
      // risk branch below — fail-closed in exactly one direction.
      if (review.decision !== 'ALLOW' || reviewerAutoAllowBlocked(review as any)) return undefined
      sessionLearnedAllows.set(sessionKey, capUsed + 1)
      if (learningCapState(capUsed, capMax).alert) {
        appendAuditLine(JSON.stringify({ type: 'learning-cap-reached', at: Date.now(), sessionId: sessionKey, allows: capUsed + 1 }))
        debugLog({ ev: 'learn-cap', sessionId: sessionKey, allows: capUsed + 1 })
      }
      if (config.notifyUser && req.callId !== undefined) {
        queueNotice(req.agent.session, req.callId, `✅ 已学习放行（仍通过一次在线评审）"${req.toolName}"`)
      }
      pushHistory({
        sessionId: sessionKey,
        toolName: req.toolName,
        outcome: 'allowed-once',
        source: 'learned-allow',
        category: classified.category,
        categoryDecision: 'learned',
        mode: classified.mode,
        llmDecision: review.decision,
        llmRisk: review.riskLevel,
        llmReason: review.reason,
        ...(attempts.length > 0 ? { attempts } : {}),
      })
      return 'allowed-once'
    } catch (error) {
      debugLog({ ev: 'learn-error', callId: req.callId ?? null, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  anyCtx.on('approval/request', async (req: any, next: () => Promise<any>) => {
    if (!config.enabled) return next()
    if (!permissionPresets) return next()
    // Preset gate walks the authority parent chain so subagent asks inherit
    // Auto (mirrors tools/pre-execute) instead of falling through to the
    // official panel without review or breaker.
    const authority = authorityFor({ agent: req.agent, signal: req.signal })
    const preset = permissionPresets.current?.(authority?.session?.events ?? req.agent.session.events)
    if (preset !== AUTO_PRESET) return next()
    const sessionKey = authorityKeyFor({ agent: req.agent })
    requestAtByKey.set(sessionKey, Date.now())
    debugLog({ ev: 'request', callId: req.callId ?? null, toolName: req.toolName, sessionKey })
    const reviewOpts = {
      userMessages: trustedUserMessages(authority),
      workspaceRoot: rootsFor({ agent: req.agent }).workspace,
      home: rootsFor({ agent: req.agent }).home,
      ...(config.reviewerContextFacts === true
        ? { contextFacts: { artifacts, owner: req.agent?.session } }
        : {}),
    }

    const toolName = req.toolName
    const args = findToolCallArguments(req.agent.session, req.callId, config.maxArgsChars)

    // B1 declared rules (Claude-style Tool(pattern)) — evaluated first so a
    // user-defined policy takes precedence over the built-in lists.
    if (config.rulesText.trim() !== '') {
      const declared = parseRulesText(config.rulesText)
      if (declared.errors.length > 0) {
        console.error('[dsh-auto-approval-llm] rulesText 解析错误，跳过声明规则', declared.errors)
      } else {
        const subject = {
          toolName,
          reason: req.reason,
          arguments: args,
          agentName: req.agent?.session?.id,
          agentKind: agentKind(req.agent?.session?.header?.origin),
          workspaceRoot: rootsFor({ agent: req.agent }).workspace,
        }
        const matched = evaluateRules(declared.rules, subject)
        if (matched) {
          if (config.rulesDryRun) {
            console.log(`[dsh-auto-approval-llm][rules-dry-run] ${toolName} matched rule ${matched.rule.source} (would ${matched.policy}); dry-run: not enforced`)
          } else if (matched.policy === 'deny') {
            recordDecisionFeedback(req.callId, formatDenyFeedback('rule', { reason: matched.rule.source }))
            pushHistory({
              sessionId: sessionKey,
              toolName,
              outcome: 'rejected',
              source: 'rule-deny',
              llmReason: `matched ${matched.rule.source}`,
            })
            return 'rejected'
          } else if (matched.policy === 'allow') {
            // Declared-rule allow is an approval decision too: keep it in the
            // durable history/audit trail (same as rule-deny), no user notice.
            pushHistory({
              sessionId: sessionKey,
              toolName,
              outcome: 'allowed-once',
              source: 'rule-allow',
              llmReason: `matched ${matched.rule.source}`,
            })
            return 'allowed-once'
          } else {
            return askHuman(req, undefined, next)
          }
        } else if ((subject.agentKind === 'unknown' || subject.workspaceRoot === undefined) &&
            declared.rules.some((r) => r.dimensions !== undefined && r.policy !== 'allow')) {
          // Scope rules exist but the agent context (kind/workspace root)
          // cannot be established today: a deny/human scope rule may apply,
          // so hand the request to a human instead of letting downstream
          // auto-answer paths decide it (fail closed, allow rules untouched).
          console.warn('[dsh-auto-approval-llm] rulesText 维度规则上下文缺失（agentKind 或 workspaceRoot 不可用），deny/human 维度规则降级人工审批')
          appendAuditLine(JSON.stringify({
            type: 'rules-context-missing',
            at: Date.now(),
            toolName: toolName ?? null,
            agentKind: subject.agentKind ?? null,
            workspaceRoot: subject.workspaceRoot ?? null,
          }))
          return askHuman(req, undefined, next)
        }
      }
    }

    const staticDecision = staticListDecision(config, toolName)
    if (staticDecision.kind === 'reject') {
      recordDecisionFeedback(req.callId, formatDenyFeedback('denyList', { toolName }))
      pushHistory({
        sessionId: sessionKey,
        toolName,
        outcome: 'rejected',
        source: staticDecision.source,
      })
      return 'rejected'
    }
    // Category layer (Q2 order: denyList → category-deny → allowlist →
    // humanOnly → category-ask → manual → breaker → risk application). The
    // directive is recomputed here from scratch (same pure function as
    // pre-execute, no state crosses between the wiring points); the auto→LOW
    // injection already happened inside classifyStaticRisk.
    const classified = classifyStaticRisk(req, args)
    const staticRisk = classified.risk
    const policyReason = classified.reason
    if (classified.directive === 'deny') {
      // Defense-in-depth terminal (pre-execute normally rejects first); same
      // shape as the denyList/policy deny: feedback + history + rejected.
      recordDecisionFeedback(req.callId, formatDenyFeedback('category', { toolName }))
      pushHistory({
        sessionId: sessionKey,
        toolName,
        outcome: 'rejected',
        source: 'category-deny',
        category: classified.category,
        categoryDecision: 'deny',
        mode: classified.mode,
      })
      return 'rejected'
    }
    if (staticDecision.kind === 'allow') {
      // Static-policy allow: the approval trail must not be silent about a
      // decision that permitted a tool call.
      pushHistory({
        sessionId: sessionKey,
        toolName,
        outcome: 'allowed-once',
        source: staticDecision.source,
      })
      return 'allowed-once'
    }
    if (staticDecision.kind === 'ask-human') {
      return askHuman(req, undefined, next)
    }
    if (classified.directive === 'ask') {
      // Category ask ≡ explicit human decision: status-less askHuman (no
      // countdown, no LLM takeover, no timeout auto-allow), same path as
      // humanOnlyList / manual review mode.
      return askHuman(req, undefined, next)
    }

    // B3 per-session review mode.
    const reviewMode = reviewModes.get(sessionKey) ?? config.defaultReviewMode
    if (reviewMode === 'manual') {
      // Manual: every remaining ask is decided by a human; no LLM auto-answer
      // and no automatic countdown.
      return askHuman(req, undefined, next)
    }
    const autoUnattended = reviewMode === 'unattended'

    const prior = denials.get(sessionKey) ?? 0
    const denialsTotal = totalDenials.get(sessionKey) ?? 0
    if (breakerTripped(config.maxConsecutiveDenials, config.maxTotalDenials, prior, denialsTotal)) {
      return askHuman(req, undefined, next, true)
    }

    // Terminal hard-deny from the policy layer (e.g. a plugin runtime-state
    // mutation): answer with an immediate rejection — never a countdown
    // status, so timeoutAction=allow and LLM takeovers can neither answer it
    // nor leave an "allowed" record against an effect that is permanently
    // forbidden. Mirrors the rule-deny path: history gets one honest rejected
    // entry, the breaker counters stay untouched (this is not an LLM denial).
    if (staticRisk === 'DENY') {
      recordDecisionFeedback(req.callId, formatDenyFeedback('policy', { toolName, reason: policyReason }))
      pushHistory({
        sessionId: sessionKey,
        toolName,
        outcome: 'rejected',
        source: 'policy-deny',
        llmReason: undefined,
      })
      return 'rejected'
    }
    // Confirmation-learning query layer — the only wiring slot where a learned
    // allow may ever return: every preceding hard terminal (declared rules,
    // deny list, category deny, static allows/asks, manual mode, breaker trip,
    // and the policy hard-deny immediately above) has already answered by the
    // time this line runs, so a stored confirmation can structurally never
    // touch a hard-denied call. A miss, a failed verification, or any error
    // falls through to the ordinary LOW/MEDIUM/HIGH pipeline unchanged.
    const learnedAllow = await learnAttempt(req, args, classified, sessionKey, reviewOpts)
    if (learnedAllow !== undefined) return learnedAllow
    const llmRouteAvailable = !!((config.reviewerProvider && config.reviewerModel) || config.reviewerBaseUrl || sessionModelRoute(req.agent.session))
    const llmReviews = llmRouteAvailable && riskReviewed(staticRisk, config.llmReviewScope)
    const llmTakeover = llmReviews && riskTakenOver(staticRisk, config.llmTakeoverScope)
    const seconds = riskSeconds(staticRisk)

    if (staticRisk === 'LOW') {
      if (!llmReviews) {
        // An auto-directive LOW that reaches this branch without an LLM
        // reviewer is a category-driven allow: label the history honestly
        // (G6/G11) and never show a countdown.
        const categoryAllow = classified.directive === 'auto'
        pushHistory({
          sessionId: sessionKey,
          toolName,
          outcome: 'allowed-once',
          source: categoryAllow ? 'category-allow' : 'auto-allow',
          ...(categoryAllow ? { category: classified.category, categoryDecision: 'auto', mode: classified.mode } : {}),
        })
        return 'allowed-once'
      }
      const lowHandle: RaceHumanHandle = { claim: () => {} }
      const lowStatus: ReviewStatus = {
        risk: staticRisk,
        phase: 'countdown',
        action: riskTimedOutAction('LOW', config.timeoutAction, autoUnattended),
        seconds,
      }
      // LOW runs the human countdown in PARALLEL with the reviewer: while the
      // panel is open the LLM keeps trying (retries stay budget-bound), and a
      // decisive ALLOW/DENY that lands inside the window takes over the race —
      // a slow-but-healthy official review (DeepSeek 2.9-4.9s) still decides
      // instead of silently escalating into the timeout action. A reviewer
      // failure still fails closed immediately (never auto-allows, never
      // waits for the countdown to allow via timeoutAction=allow).
      const lowAskPromise = askHuman(req, undefined, next, false, lowStatus, lowHandle, true, learnableContextFor(req, args, classified))
      const lowReviewStart = Date.now()
      void reviewWithLLM(credentials, llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: false,
      })
        .then(async ({ review, attempts }) => {
          debugLog({ ev: 'review', callId: req.callId, decision: review.decision, risk: review.riskLevel ?? null, startAt: lowReviewStart, tookMs: Date.now() - lowReviewStart, scope: 'low', attempts: attempts.length })
          // Latency telemetry is sampled for every attempt, settled or not;
          // only `failure` marks an aborted call (timeout/network/parse).
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - lowReviewStart, settled: review.failure === undefined, attempts: Math.max(1, attempts.length) })
          // Late response that already lost the countdown race is discarded.
          if (!req.callId || reviewStates.get(req.callId)?.phase !== 'countdown') return
          const verdict = lowRiskReviewOutcome(review)
          if (verdict.kind === 'allow') {
            reviewVerdicts.set(req.callId, { ...review, attempts })
            // Serialize the reset so a concurrent denial for this session
            // cannot interleave and lose its increment (or resurrect stale
            // counters).
            await breakerMutex.run(sessionKey, () => {
              denials.set(sessionKey, 0)
              totalDenials.set(sessionKey, 0)
              denialLog.delete(sessionKey)
            })
            if (config.notifyUser) queueNotice(req.agent.session, req.callId, `✅ Model approved "${toolName}"`)
            pushHistory({
              sessionId: sessionKey,
              toolName,
              outcome: 'allowed-once',
              source: 'llm-allow',
              llmDecision: review.decision,
              llmRisk: review.riskLevel,
              llmReason: review.reason,
              ...(attempts.length > 0 ? { attempts } : {}),
            })
            lowHandle.claim('allowed-once')
            reviewStates.set(req.callId, {
              risk: staticRisk,
              phase: 'follow',
              action: 'allow',
              seconds: 0,
              note: reviewSuggestionNote(review),
              source: 'llm',
            })
            followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
            debugLog({ ev: 'follow', callId: req.callId, decision: review.decision, tookMs: Date.now() - lowReviewStart })
            return
          }
          if (verdict.kind === 'deny') {
            if (verdict.llmDenied) {
              // Serialize the increment: read the counters INSIDE the lock so
              // a concurrent approval cannot interleave and lose it.
              await breakerMutex.run(sessionKey, () => {
                const priorNow = denials.get(sessionKey) ?? 0
                const totalNow = totalDenials.get(sessionKey) ?? 0
                denials.set(sessionKey, priorNow + 1)
                totalDenials.set(sessionKey, totalNow + 1)
                const log = denialLog.get(sessionKey) ?? []
                log.push({ reason: review.reason ? sanitizeReviewReason(review.reason) : undefined, toolName })
                if (log.length > config.maxConsecutiveDenials) log.shift()
                denialLog.set(sessionKey, log)
              })
              recordDecisionFeedback(req.callId, formatDenyFeedback('llm', { toolName, reason: review.reason }))
              pushHistory({
                sessionId: sessionKey,
                toolName,
                outcome: 'rejected',
                source: 'llm-deny',
                llmDecision: review.decision,
                llmRisk: review.riskLevel,
                llmReason: review.reason,
                ...(attempts.length > 0 ? { attempts } : {}),
              })
              lowHandle.claim('rejected')
              reviewStates.set(req.callId, {
                risk: staticRisk,
                phase: 'follow',
                action: 'reject',
                seconds: 0,
                note: reviewSuggestionNote(review),
                source: 'llm',
              })
              followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
              debugLog({ ev: 'follow', callId: req.callId, decision: review.decision, tookMs: Date.now() - lowReviewStart })
            } else {
              // Reviewer unavailable/crashed: fail closed on LOW, never
              // auto-allow and never count toward the LLM-denial breaker.
              recordDecisionFeedback(req.callId, formatDenyFeedback('timeout'))
              pushHistory({
                sessionId: sessionKey,
                toolName,
                outcome: 'rejected',
                source: 'llm-failed',
                llmReason: review.failure ?? 'reviewer unavailable',
                ...(attempts.length > 0 ? { attempts } : {}),
              })
              lowHandle.claim('rejected')
            }
            return
          }
          // verdict.kind === 'ask' → genuine ESCALATE: never auto-answer from
          // a reviewer that could not decide — the human countdown continues
          // and the timeout action applies when it expires.
        })
      return lowAskPromise
    }

    if (staticRisk === 'MEDIUM') {
      if (!llmReviews) {
        const fallback = riskTimedOutAction('MEDIUM', config.timeoutAction, autoUnattended)
        const status: ReviewStatus = {
          risk: staticRisk,
          phase: 'countdown',
          action: fallback,
          seconds,
          ...(fallback === 'reject' ? { feedback: REVIEW_TIMEOUT_NOTICE } : {}),
        }
        return askHuman(req, undefined, next, false, status, undefined, undefined, learnableContextFor(req, args, classified))
      }
      const fallbackAction = riskTimedOutAction('MEDIUM', config.timeoutAction, autoUnattended)
      const status: ReviewStatus = {
        risk: staticRisk,
        phase: 'countdown',
        action: fallbackAction,
        seconds,
        ...(fallbackAction === 'reject' ? { feedback: REVIEW_TIMEOUT_NOTICE } : {}),
      }
      const mediumHandle: RaceHumanHandle = { claim: () => {} }
      const askPromise = askHuman(req, undefined, next, false, status, mediumHandle, true, learnableContextFor(req, args, classified))
      const reviewStart = Date.now()
      void reviewWithLLM(credentials, llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: true,
      })
        .then(({ review, attempts }) => {
          debugLog({ ev: 'review', callId: req.callId, decision: review.decision, risk: review.riskLevel ?? null, startAt: reviewStart, tookMs: Date.now() - reviewStart, scope: 'medium', attempts: attempts.length })
          // Sample before the phase guard: a late response that lost the
          // countdown race is still a real latency observation (and the most
          // diagnostic one — the reviewer was slow).
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: review.failure === undefined, attempts: Math.max(1, attempts.length) })
          if (!req.callId || reviewStates.get(req.callId)?.phase !== 'countdown') return
          const note = reviewSuggestionNote(review)
          // Remember the verdict for history whether or not it takes over.
          reviewVerdicts.set(req.callId, { ...review, attempts })
          // A CRITICAL-flagged ALLOW is contradictory (the reviewer is told to
          // deny CRITICAL); it must NOT take over and auto-allow — surface to a
          // human instead. DENY stays decisive.
          const blockedAllow = reviewerAutoAllowBlocked(review as any)
          if ((llmTakeover || autoUnattended) && !blockedAllow && (review.decision === 'ALLOW' || review.decision === 'DENY')) {
            if (review.decision === 'DENY') {
              recordDecisionFeedback(req.callId, formatDenyFeedback('llm', { toolName, reason: review.reason }))
            }
            // Settle the race authoritatively: the decisive LLM conclusion wins
            // over the host countdown (clears the timer; nondeterministic
            // auto-answers in headless sessions are resolved).
            mediumHandle.claim(review.decision === 'ALLOW' ? 'allowed-once' : 'rejected')
            reviewStates.set(req.callId, {
              risk: staticRisk,
              phase: 'follow',
              action: review.decision === 'ALLOW' ? 'allow' : 'reject',
              seconds: 0,
              note,
              source: 'llm',
            })
            followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
            if (debugOn) console.log('[dsh-auto-approval-llm][debug] MEDIUM follow set', {
              callId: req.callId,
              decision: review.decision,
              risk: review.riskLevel,
              at: Date.now(),
            })
            debugLog({ ev: 'follow', callId: req.callId, decision: review.decision, tookMs: Date.now() - reviewStart })
          } else if (reviewStates.get(req.callId)?.phase === 'countdown') {
            // Advisory verdict while the ask is still live: refresh the note on
            // the countdown status only. Re-check the phase at set time so a
            // late advisory can never revert a follow the host already published
            // (human/timeout resolution) back to a countdown.
            reviewStates.set(req.callId, { ...status, note })
          }
        })
        .catch((error) => {
          debugLog({ ev: 'review-error', callId: req.callId, scope: 'medium', error: error instanceof Error ? error.message : String(error) })
          // An unexpected rejection is still an aborted attempt: sample it so
          // the latency window never silently drops failures.
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: false })
        })
      return await askPromise
    }

    // HIGH
    const highAction = riskTimedOutAction('HIGH', config.timeoutAction, autoUnattended)
    const status: ReviewStatus = {
      risk: staticRisk,
      phase: 'countdown',
      action: highAction,
      seconds,
      ...(highAction === 'allow' ? {} : { feedback: REVIEW_TIMEOUT_NOTICE }),
    }
    const askPromise = askHuman(req, undefined, next, false, status, undefined, undefined, learnableContextFor(req, args, classified))
    if (llmReviews) {
      const reviewStart = Date.now()
      void reviewWithLLM(credentials, llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: true,
      })
        .then(({ review, attempts }) => {
          debugLog({ ev: 'review', callId: req.callId, decision: review.decision, risk: review.riskLevel ?? null, startAt: reviewStart, tookMs: Date.now() - reviewStart, scope: 'high', attempts: attempts.length })
          // Sample before the phase guard (see MEDIUM: late responses are the
          // most diagnostic latency observations and must not be dropped).
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: review.failure === undefined, attempts: Math.max(1, attempts.length) })
          if (!req.callId || reviewStates.get(req.callId)?.phase !== 'countdown') return
          const note = reviewSuggestionNote(review)
          reviewVerdicts.set(req.callId, { ...review, attempts })
          // Re-check the phase at set time: a late advisory must never revert a
          // follow the host already published (human/timeout resolution) back
          // to a countdown.
          if (reviewStates.get(req.callId)?.phase === 'countdown') {
            reviewStates.set(req.callId, { ...status, note })
          }
        })
        .catch((error) => {
          debugLog({ ev: 'review-error', callId: req.callId, scope: 'high', error: error instanceof Error ? error.message : String(error) })
          // Unexpected rejection = aborted attempt; sample so failures stay
          // visible in the latency window (see MEDIUM).
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: false })
        })
    }
    return await askPromise
  }, { prepend: true, global: true })

  // ── /stats (composer status chip data) ─────────────────────────────────
  function installStatsRoute(ctx: any): void {
    const webServer = ctx.get('webServer')
    if (!webServer) return
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: STATS_ROUTE,
      handler: async (req: any, res: any) => {
        if (!isTrustedRequest(req, trustedHosts)) {
          responseJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          responseJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!sessionId) {
          responseJson(res, 400, { ok: false, error: 'sessionId is required' })
          return
        }
        const agent = anyCtx.get('agents')?.get?.(sessionId)
        const authority = authorityFor({ agent })
        const key = authorityKeyFor({ agent })
        let mode: string | null = null
        try {
          mode = permissionPresets?.current?.(authority?.session?.events ?? agent?.session?.events ?? []) ?? null
        } catch {
          mode = null
        }
        const consecutive = denials.get(key) ?? 0
        const total = totalDenials.get(key) ?? 0
        const records = approvalHistory.filter((r) => r.sessionId === key)
        responseJson(res, 200, {
          ok: true,
          value: {
            mode,
            reviewMode: reviewModes.get(key) ?? config.defaultReviewMode,
            counts: {
              total: records.length,
              allow: records.filter((r) => r.outcome === 'allowed-once').length,
              deny: records.filter((r) => r.outcome === 'rejected').length,
              timeout: records.filter((r) => r.source.startsWith('timeout')).length,
              breaker: records.filter((r) => r.breaker).length,
            },
            breaker: {
              consecutive,
              total,
              maxConsecutive: config.maxConsecutiveDenials,
              maxTotal: config.maxTotalDenials,
              tripped: breakerTripped(config.maxConsecutiveDenials, config.maxTotalDenials, consecutive, total),
            },
          },
        })
      },
    }), 'dsh-auto-approval-llm: stats route')
  }

  // ── /approval reset ────────────────────────────────────────────────────
  // Escape hatch: reset breaker counters and in-flight review status without
  // touching persisted policy. Registered only when the commands service is
  // present (it is active in the web profile).
  const commands = anyCtx.get('commands')
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'approval',
      description: '/approval reset — reset breaker counters and in-flight approval state',
      handler: (_invocation: any) => {
        denials.clear()
        totalDenials.clear()
        denialLog.clear()
        clearApprovalState()
        return { kind: 'success', text: 'Breaker counters and approval state reset.' }
      },
    }), 'dsh-auto-approval-llm: /approval command')
    ctx.effect(() => commands.register({
      name: 'approval-mode',
      description: '/approval-mode [manual|smart|unattended] show/set this session review mode',
      handler: (invocation: any) => {
        const agent = invocation?.agent
        const key = authorityKeyFor({ agent })
        const current = reviewModes.get(key) ?? config.defaultReviewMode
        const arg = String(invocation?.rawInput ?? '').trim()
        if (arg === '') {
          return { kind: 'success', text: `Current review mode: ${current} (manual / smart / unattended)` }
        }
        if (!['manual', 'smart', 'unattended'].includes(arg)) {
          return { kind: 'error', text: `Unknown mode "${arg}" (expected manual|smart|unattended)` }
        }
        setReviewMode(key, arg as ReviewMode)
        return { kind: 'success', text: `Review mode for this session set to: ${arg}` }
      },
    }), 'dsh-auto-approval-llm: /approval-mode command')
  } else {
    console.log('[dsh-auto-approval-llm] commands service unavailable, /approval & /approval-mode disabled')
  }
}
