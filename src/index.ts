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
 * - The preset gate reads the durable raw permission identity: the plugin's
 *   own `auto-approval` preset, plus the legacy `auto` alias only on hosts
 *   whose capability probe reports the pre-reservation surface.
 * - The retired `autoSwitchPolicyToAsk` key is a host-owned no-op. The raw
 *   `auto-approval` identity is protected by an unconditional spec restore
 *   (effective never -> ask), never by configuration.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { methodOf, registerCarrierFetchRoute } from './auto/carrier-route.js'
import {
  approvalHistory,
  approvalState,
  autoAnsweredCallIds,
  configError,
  decisionFeedback,
  firstAutoNoticeSeen,
  followExpiry,
  learningStore,
  llmLatency,
  loopGuardPinned,
  loopStates,
  pendingPanelReleases,
  rejectGuidanceSeen,
  resolvedCallIds,
  reviewSessions,
  REVIEW_STATUS_HOLD_MS,
  reviewStates,
  reviewVerdicts,
  setConfigError,
  setDebugOn,
  setLearningStore,
  timeoutFeedback,
  trustedIntentReported,
  debugOn,
  type ReviewStatus,
} from './auto/approval-state.js'
import { ArtifactRegistry } from './auto/artifacts.js'
import { appendAuditLine, recordAuditClear } from './auto/audit.js'
import { AGGRESSIVE_BUILTIN, applyCategoryDirective, CATEGORY_KEYS, categoryDirectiveFor, type CategoryKey, HARD_LOCKED_CATEGORIES, LOCKED_CATEGORIES, realpathCriticalReason, sensitiveBasenameAt } from './auto/category.js'
import { sanitizeClassifierArguments, sanitizeClassifierText, sanitizeReviewReason } from './auto/classifier.js'
import { DIRECT_HUMAN_TOOL, GATED_PRESET, THRESHOLD_DEFAULTS } from './auto/constants.js'
import { createDshClassifier, createEndpointClassifier } from './auto/dsh-classifier.js'
import { PLUGIN_MESSAGE_SOURCE } from './auto/message-source.js'
import { type RaceHumanHandle, type ReviewResult, type StaticRisk, AWAITING_MARKER, EDITABLE_CONFIG_KEYS, HOST_ONLY_KEYS, LOCKED_ASK_MARKER, REVIEW_TIMEOUT_NOTICE, SHIPPED_PINNED_KEYS, applyBreaker, approvalSource, assembleReviewerSystem, breakerNote, breakerTripped, buildAskReason, createKeyedMutex, DENY_CIRCUMVENTION_GUIDANCE, extractToolPath, followResolution, formatDenyFeedback, frameReviewerInput, lowRiskReviewOutcome, parseReview, stripCountdownMarkers, unattendedMustFailClosed, plainConfigValue, raceHumanDecision, reviewSuggestionNote, reviewerAutoAllowBlocked, riskFromAssessment, staticListDecision } from './auto/decision.js'
import { LATENCY_SUMMARY_WINDOW, clearLatencySamples, loadLatencySamples, pushLatencySample, summarizeLatency } from './auto/latency.js'
import { loopKeyFor, createLoopState, recordLoopCall } from './auto/loop-guard.js'
import { RECENT_REJECTION_CAP, baselineFromPermissionState, observePermissionChange, permissionChangeFromEvent, recentRejectionPointers, type PermissionState } from './auto/permission-change.js'
import {
  clampLearningThreshold,
  confirmActionFor,
  LEARNING_SIG_VERSION,
  learningCapState,
  learningFileFingerprint,
  learningFuseDecision,
  learningKey,
  learnDecision,
  learnGateEligible,
  loadLearning,
  recordConfirm,
  resetConfirmation,
  revokeLearning,
  sameLearningFingerprint,
  signatureFor,
  type LearningFileFingerprint,
  type LearningKind,
} from './auto/learning.js'
import { isWithin, normalizePath, resolveRoots, devZoneRootsFor } from './auto/paths.js'
import { assessTool, hardDenyReason, structuredRuntimeStateReadHits, type Roots } from './auto/policy.js'
import { resolveDeepest, symlinkEscapeReason } from './auto/symlink.js'
import { redactResultValue } from './auto/redact.js'
import { agentKind, evaluateRules, parseRulesText, summarizeRulesParseErrors, type RuleParseError } from './auto/rules.js'
import { isReviewRetryable, retryAfterMs, retryReviewLoop, toLlmFailure, type RetryAttempt, type ReviewFailure } from './auto/retry.js'
import { type ReviewMode, loadReviewModes, normalizeReviewMode, persistReviewModes } from './auto/review-mode.js'
import {
  DEBUG_FILENAME,
  HISTORY_FILENAME,
  LEARNING_FILENAME,
  appendRuntimeLine,
  resolveRuntimeReadPath,
  resolveRuntimeWritePath,
  runtimeFilePath,
  setRuntimeStateDir,
  writeRuntimeAtomic,
} from './auto/runtime-paths.js'
import { runtimeStateReadHits } from './auto/shell.js'
import { isLoopbackHostname, isTrustedFetchRequest, resolvePublicReviewerTarget, reviewerProbeTargetAllowed, validateReviewerBaseUrl } from './auto/trust.js'
import { aggregateToolStats } from './auto/tool-stats.js'
import { normalizeLane, normalizeSharedEndpoint, resolveTransport } from './auto/model-channel.js'
import { callEndpointText, createPinnedLookup, requestEndpointText } from './auto/endpoint-call.js'
import { resolveConfig } from './auto/config-normalize.js'
import { currentPreset, findToolCallArguments, findToolDescription, resolveModelRoute, riskTimedOutAction, sessionEventList, sessionModelRoute } from './auto/session-introspect.js'
import { autoPermissionAuthority } from './auto/gate-decision.js'
import {
  FEEDBACK_ROUTE,
  HISTORY_ROUTE,
  LEARNING_STORE_ROUTE,
  LLM_LATENCY_ROUTE,
  REVEAL_ROUTE,
  REVIEWER_CREDENTIAL_REF,
  REVIEW_STATUS_ROUTE,
  SESSION_MODE_ROUTE,
  SESSION_REVIEW_STATUS_ROUTE,
  SETTINGS_FIRST_READ_MAX_ATTEMPTS,
  SETTINGS_FIRST_READ_RETRY_MS,
  SETTINGS_NS,
  SETTINGS_ROUTE,
  SETTINGS_UNAVAILABLE_ERROR,
  STATS_ROUTE,
  TEST_ROUTE,
  TOOL_STATS_ROUTE,
  atomicWriteFile,
  reviewerKeyFromCredentialFile,
} from './auto/route-table.js'
import { json, readJson, resolveTrustedHosts, setTrustedHosts, trustedHosts } from './auto/http-pipeline.js'
import { holdWhile, installLlmCatalogRoutes, installReviewerCredentialRoute } from './auto/route-installers.js'
import {
  classifyForMigration,
  detectHostCapability,
  enforceOwnSpec,
  gatePresetNames,
  isUsableTargetSpec,
  migrationAuditLine,
  rawPresetOf,
  rawStateOf,
  rootAuthoritySessionId,
  runPresetMigration,
  safeResolveSpec,
  scanAuditLine,
  type MigrationScanCounts,
} from './auto/preset-migration.js'
import { buildRejectGuidanceText, extractProbeErrorSummary, markFirstAutoSessionNotice, maybeInjectRejectGuidance, onboardingNoticeText, queueNotice, watchNotices } from './auto/notices.js'
import { auditMaskFailed, auditRedact, recordDecisionFeedback, recordTimeoutFeedback, sweepFeedback } from './auto/feedback-maps.js'
import { historyWritePath, pushHistory } from './auto/approval-history.js'
import { debugLog, denyOnAuditFailure, directHumanTargetRefusal, guardDenyDecision, nameChannelLockRefusal, reportRulesParseErrors, sameEndpointTarget } from './auto/debug-and-decisions.js'
import { loadRuntimeStores, persistLearningGuarded } from './auto/runtime-stores.js'
import { reportTrustedIntentOrigins, trustedIntentWindow, trustedUserMessages, withWindowOverflowNote } from './auto/trusted-intent.js'

// The public export surface is unchanged by the module split: every symbol
// this file used to define and export is re-exported here by name, so a
// consumer (or a test) importing it from the package entry keeps working.
export { resolveConfig } from './auto/config-normalize.js'
export { currentPreset, riskTimedOutAction, sessionEventList, sessionModelRoute } from './auto/session-introspect.js'
export { autoPermissionAuthority, LEARNABLE_HOOK_SITES } from './auto/gate-decision.js'
export { atomicWriteFile, clearReviewerKeyFromCredentialFile, clearReviewerKeyInFile, extractReviewerKeyLine } from './auto/route-table.js'
export { holdWhile, installLlmCatalogRoutes, installReviewerCredentialRoute } from './auto/route-installers.js'
export { REVIEW_STATUS_HOLD_MS } from './auto/approval-state.js'
export { buildRejectGuidanceText, extractProbeErrorSummary, markFirstAutoSessionNotice, maybeInjectRejectGuidance, OFFICIAL_REJECT_GUIDANCE_TEXT, officialRejectionIn, onboardingNoticeText, onboardingTimeoutLabel } from './auto/notices.js'
export { historyFilePath, parseHistoryLines, setHistoryFilePathForTests } from './auto/approval-history.js'
export type { HistoryRecord } from './auto/approval-history.js'
export { directHumanTargetRefusal, guardDenyDecision, nameChannelLockRefusal, sameEndpointTarget } from './auto/debug-and-decisions.js'
export { questionAnswerMessages, trustedIntentWindow, trustedUserIntents, trustedUserMessages, withWindowOverflowNote } from './auto/trusted-intent.js'
export type { QuestionAnswerEntry, TrustedIntentWindow, TrustedUserIntent } from './auto/trusted-intent.js'

export const name = 'dsh-auto-approval-llm'
// No web-server service is listed here: a carrier that never provides one
// (Electron desktop) must still start the plugin. apply() binds the route block
// to the carrier's Fetch registry instead, so the routes appear when that
// registry arrives and stay absent otherwise.
export const inject = ['approval', 'permissionPresets', 'sessions', 'tools', 'llm', 'agents', 'settings', 'commands']

export interface Config {
  enabled: boolean
  /** Retired host-owned no-op: resolveConfig warns and normalizes it to false. */
  autoSwitchPolicyToAsk: boolean
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
  /** One-shot first-use agent notice (English); false disables injection. */
  onboardingMessageEnabled?: boolean
  /** Auto-mode enter/exit agent announcements; false disables them. */
  autoModeNoticeEnabled?: boolean
  breakerAntiHijackMs: number
  /** Hold the official panel back for countdown asks; 0 = show it immediately. */
  panelDelayMs?: number
  workspaceRoot?: string
  dshHome?: string
  tempRoots?: string[]
  classifierTimeoutMs?: number
  classifierMaxOutputTokens?: number
  /** Fast-decision lane model source: session / preset (host DSH model) / endpoint (custom, retained but no longer maintained). */
  classifierSource: 'session' | 'preset' | 'endpoint'
  /** Fast-decision preset pair; honored only while classifierSource==='preset'. */
  classifierProvider: string
  classifierModel: string
  /** Deep-review lane model source: session / preset / endpoint (custom, retained but no longer maintained). */
  reviewerSource: 'session' | 'preset' | 'endpoint'
  /** Deep-review preset provider (name revived from the retired pair era). */
  reviewerProvider: string
  reviewerModel: string
  /** Deep-review output budget in tokens. The historical 256 assumed a plain
   * chat model; reasoning models spend most of it thinking, so the budget is
   * configurable (default 2048) to let the final JSON answer through. */
  reviewerMaxTokens: number
  /** Deep-review reasoning effort for host-route models. '' = follow the
   * adapter default; explicit values (off/minimal/low/medium/high/xhigh/max)
   * are passed as the dsh reasoningEffort — a model that does not support the
   * chosen value fails the review loudly (UNSUPPORTED_REASONING_EFFORT), never
   * silently. */
  reviewerReasoning: '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Fast-decision reasoning effort (same semantics as reviewerReasoning). */
  classifierReasoning: '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Shared custom-endpoint config (lane-agnostic; both lanes' endpoint source references it). */
  endpointUrl: string
  endpointModel: string
  endpointProtocol: 'openai' | 'anthropic'
  /** Extra LLM review attempts after the first (0 = single-shot, 1 = default). */
  reviewMaxRetries?: number
  /** Loop guard: the Nth identical auto-allowed call in a row turns into a pinned ask (0 = off). */
  loopDetectionThreshold?: number
  /** Seconds one reviewer attempt may wait (per-attempt timeout). */
  reviewWaitSeconds?: number
  debug: boolean
  /** Mask credential-shaped material in successful tool results. */
  redactResults: boolean
  /** Inject short guidance to the agent when a tool call is rejected. */
  rejectGuidance: boolean
  /** DSH_HOME subtrees for operator maintenance (non-runtime-state files only). */
  maintenanceDshPaths: string[]
  /** Per-category tri-state override; empty = inherit current behavior. */
  categoryPolicy: Record<string, 'auto' | 'ask' | 'deny'>
  /** Position-gate mode: 'standard' (current) | 'aggressive' (location-unrestricted, hardened). */
  categoryMode: 'standard' | 'aggressive'
  /** Opt-out of the privilege LOCKED clamp: false = privilege stays ask-only. */
  privilegeAutoReview: boolean
  /**
   * Opt-out of the protected LOCKED clamp: false = protected paths stay
   * ask-only with a hard-reject countdown. Turning it on hands protected paths
   * to the ordinary pipeline. Its width matters: protected covers protected
   * project metadata (.env, .npmrc, .git/*, …) and reads of credential trees
   * (~/.ssh, ~/.aws, …) — those reads are protected asks, not hard denies;
   * only their writes are hard-denied, and that fuse is unaffected here.
   */
  protectedAutoReview: boolean
  /** Extra trusted directories for Standard mode (host-only, absolute paths). */
  trustedDirs: string[]
  /**
   * DSH_HOME subtrees an Auto session may write (host-only, absolute paths).
   * Empty by default: DSH_HOME stays hard-denied unless an operator names a
   * subtree here. Membership grants the same allow as the plugin's own
   * development zone, so name the narrowest directory that unblocks the work.
   */
  trustedDshSubpaths: string[]
  /** Confirmation learning master switch: off by default (zero behavior change). */
  learningEnabled: boolean
  /** Human confirmations before a same-signature ask may auto-allow; clamped to [2,10]. */
  learningThreshold: number
  /** Direct-human-approval channel: the agent may call dsa_request_user to route a follow-up operation to a human instead of the LLM classifier. Off by default (zero behavior change). */
  directHumanEnabled: boolean
  /** Slash commands /approval-mode, /approval-reset, /approval-reset-all registration. Off by default: commands are absent from the palette unless enabled. */
  slashCommandsEnabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  // Retired host-owned no-op kept as a schema key so a stored value is not
  // deleted by a card save; resolveConfig warns and normalizes it to false.
  autoSwitchPolicyToAsk: z.boolean().default(false),
  debug: z.boolean().default(false),
  timeoutAction: z.string().default('reject'),
  llmReviewScope: z.union(['low-or-above', 'medium-or-above', 'high'] as const).default('low-or-above'),
  // 'high-or-below' is accepted for stored-config compatibility but is
  // behaviorally identical to 'medium-or-below': the HIGH branch never hands
  // control to the LLM by design (HIGH always lands on a human). Do not pick
  // it expecting HIGH automation.
  llmTakeoverScope: z.union(['low', 'medium-or-below', 'high-or-below'] as const).default('medium-or-below'),
  defaultReviewMode: z.union(['manual', 'smart', 'unattended'] as const).default('smart'),
  lowRiskSeconds: z.number().default(THRESHOLD_DEFAULTS.lowRiskSeconds).min(1),
  mediumRiskSeconds: z.number().default(THRESHOLD_DEFAULTS.mediumRiskSeconds).min(1),
  highRiskSeconds: z.number().default(THRESHOLD_DEFAULTS.highRiskSeconds).min(1),
  // safetyPrompt goes (secret-redacted, framed as constraints-only) into the
  // reviewer system prompt (decision.ts assembleReviewerSystem) and into every
  // online review — bound it like the rules text so an oversized prompt cannot
  // inflate review cost or eat the countdown window.
  safetyPrompt: z.string().default('').max(2000),
  allowlist: z.array(z.string()).default([]),
  denyList: z.array(z.string()).default([]),
  humanOnlyList: z.array(z.string()).default([]),
  rulesText: z.string().default(''),
  rulesDryRun: z.boolean().default(false),
  maxConsecutiveDenials: z.number().default(THRESHOLD_DEFAULTS.maxConsecutiveDenials).min(0),
  maxTotalDenials: z.number().default(THRESHOLD_DEFAULTS.maxTotalDenials).min(0),
  maxArgsChars: z.number().default(THRESHOLD_DEFAULTS.maxArgsChars).min(1),
  loopDetectionThreshold: z.number().min(0).max(20).default(0),
  notifyUser: z.boolean().default(true),
  showSessionPanel: z.union(['on', 'auto', 'off'] as const).default('auto'),
  // One-shot first-use notice injected into the session for the AGENT
  // (English, context-style); off disables the injection entirely.
  onboardingMessageEnabled: z.boolean().default(true),
  // Auto-mode enter/exit announcements to the agent (independent switch).
  autoModeNoticeEnabled: z.boolean().default(true),
  breakerAntiHijackMs: z.number().default(0).min(0),
  // Hold the official approval panel back for countdown asks; 0 = the panel
  // appears immediately. Bounded so a mis-set value cannot hide an ask for
  // longer than the shortest countdown can settle it.
  panelDelayMs: z.number().default(THRESHOLD_DEFAULTS.panelDelayMs).min(0).max(10_000),
  workspaceRoot: z.string().default(''),
  dshHome: z.string().default(''),
  tempRoots: z.array(z.string()).default([]),
  classifierTimeoutMs: z.number().default(8_000).min(100).max(60_000),
  classifierMaxOutputTokens: z.number().default(1_024).min(64).max(4_096),
  // Model-source switches default to 'session' so behavior stays byte-identical
  // unless the operator opts into a preset (host DSH model) or endpoint
  // (custom, marked legacy) source. Keys carry .default('') / a default enum
  // (never a bare optional) so a hand-written settings/patch file with one side
  // only cannot reach the classifier constructor half-wired — resolveConfig
  // normalizes anyway, this is the schema-level backstop.
  classifierSource: z.union(['session', 'preset', 'endpoint'] as const).default('session'),
  classifierProvider: z.string().default(''),
  classifierModel: z.string().default(''),
  reviewerSource: z.union(['session', 'preset', 'endpoint'] as const).default('session'),
  // reviewerProvider: preset-pair provider for the deep-review lane (name
  // revived from the retired pair era — user ruling).
  reviewerProvider: z.string().default(''),
  reviewerModel: z.string().default(''),
  // Deep-review output budget (reasoning models spend most of it thinking —
  // 256 starved the final JSON answer on mimo-v2.5-free).
  reviewerMaxTokens: z.number().default(THRESHOLD_DEFAULTS.reviewerMaxTokens).min(256).max(16_384),
  // Reasoning effort: '' follows the adapter default (byte-identical to the
  // pre-switch era); an explicit value is forwarded to the dsh reasoningEffort
  // and a model that does not support it fails loudly, never silently.
  reviewerReasoning: z.union(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).default(''),
  classifierReasoning: z.union(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).default(''),
  // Shared custom-endpoint config (lane-agnostic): both lanes' endpoint source
  // reference the same endpointUrl/endpointModel + the shared API key.
  endpointUrl: z.string().default(''),
  endpointModel: z.string().default(''),
  endpointProtocol: z.union(['openai', 'anthropic'] as const).default('openai'),
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
  // Rejected-call guidance for the agent (user-message injection with a
  // whitelist-only payload: source/category enums, never tool names or free
  // text). On by default; rate-limited per callId and per 60s window.
  rejectGuidance: z.boolean().default(true),
  // Operator maintenance openings: DSH_HOME subtrees where the guard's
  // DSH_HOME hard-deny is relaxed for NON-runtime-state files (skills,
  // profiles, docs…); runtime-state basenames stay hard-denied everywhere,
  // and the shell DSH_HOME fuse is unaffected. Host-only, patch/YAML only.
  maintenanceDshPaths: z.array(z.string()).default([]),
  // Per-category tri-state override: a dict accepts any key but resolveConfig
  // clamps unknown/LOCKED keys (see resolveConfig); empty = inherit.
  categoryPolicy: z.dict(z.union(['auto', 'ask', 'deny'] as const), z.string()).default({}),
  categoryMode: z.union(['standard', 'aggressive'] as const).default('standard'),
  // Privilege-category opt-out from the LOCKED clamp (fail-closed off): when
  // true, `privilege` commands (system management / nested execution /
  // security-sensitive tools) may be configured auto|ask|deny like ordinary
  // categories — auto flows through classifier + LLM review + countdown.
  // delete/protected/disk stay locked regardless.
  privilegeAutoReview: z.boolean().default(false),
  // Same shape for protected: unlocked, a protected path rides the ordinary
  // pipeline (classifier + LLM review + countdown) instead of the ask-only
  // clamp with its hard-reject countdown. Ships off: the default is what keeps
  // protected project metadata out of an unattended auto-allow.
  protectedAutoReview: z.boolean().default(false),
  trustedDirs: z.array(z.string()).default([]),
  // DSH_HOME write openings: fail-closed default (empty). resolveConfig drops
  // any entry that is not an absolute path inside DSH_HOME, or that would
  // re-expose the credential/session/runtime-state trees.
  trustedDshSubpaths: z.array(z.string()).default([]),
  // Confirmation learning: fail-closed default (off). The threshold accepts a
  // wide numeric range here; resolveConfig warns and clamps into [2,10]
  // instead of throwing, mirroring the categoryPolicy schema/decision split.
  learningEnabled: z.boolean().default(false),
  learningThreshold: z.number().default(THRESHOLD_DEFAULTS.learningThreshold),
  // Direct-human-approval channel: fail-closed default (off). Two layers:
  // the tool is REGISTERED only when the switch is on at boot (tool sets are
  // not hot-swappable — enabling needs a restart), while the answerer and
  // execute checks read the switch LIVE, so turning it off stops the channel
  // at once and a boot-time-registered tool routes only while enabled.
  directHumanEnabled: z.boolean().default(false),
  // Slash commands /approval-mode, /approval-reset, /approval-reset-all:
  // fail-closed default (off). Command sets are not hot-swappable — they are
  // REGISTERED only when the switch is on at boot (enabling needs a restart,
  // same as the direct-human tool); each handler additionally reads the
  // switch LIVE and refuses with a clear error when it is off, so disabling
  // stops the already-registered commands at once.
  slashCommandsEnabled: z.boolean().default(false),
})

// The host config plane projects only fields under a volatile ancestor and
// refuses a write to any other key. Mark the card-owned keys volatile so the
// settings card can read and write them; the host-owned keys stay ordinary so
// no save can reach them. `extra` returns a new schema instance, so each marked
// field is written back into the object's field map.
for (const key of EDITABLE_CONFIG_KEYS) {
  const dict = Config.dict as Record<string, any>
  dict[key] = dict[key].extra('volatile', true)
}

/**
 * Every schema key at the value the schema itself declares for it: the factory
 * configuration, which is also what the shipped patch rows restate.
 *
 * The import offer reads this to tell a stored operator choice from a
 * declaration that merely restates the schema: the config plane writes the
 * effective value of every card-owned key back into the entry config on a save,
 * so a declared value equal to the default is the plane's echo, while a
 * declared value that differs is a value somebody chose. Resolving the schema
 * is the only source for it — a hand-written table of defaults would be a
 * second one, and would drift.
 *
 * Taken after the volatile marking above, and unwrapped, because a marked field
 * resolves to a `{ get() }` reference rather than to its value.
 */
const FACTORY_CONFIG_DEFAULTS: Record<string, unknown> = plainConfigValue(Config()) as unknown as Record<string, unknown>

/**
 * Retry calibration history: the original 3.5s fit the
 * mock/opencode latency profile (p95 ≈ 3.06s); direct DeepSeek official
 * review latency spans 266ms–4.9s, so the per-attempt
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
  /** host = DSH LLM route (session/preset); raw = shared endpoint config. */
  transport: 'host' | 'raw'
  payload: string
  system: string
  route?: { provider: string; model: string }
  baseUrl?: string
  /** Reviewer model fixed at snapshot time (raw attempts re-read it otherwise). */
  model?: string
  protocol?: 'openai' | 'anthropic'
  apiKey?: string
  /** Output budget + reasoning effort, frozen with the rest so a settings
   * change mid-review cannot steer retry N>1 to a different budget/effort. */
  maxTokens?: number
  reasoningEffort?: string
}

/**
 * Resolve the shared endpoint API key once from the credentials service, with
 * the shared-credential-file fallback. Disable the file read with
 * DSH_AUTO_APPROVAL_READ_CRED_FILE=0 (keeps contract tests isolated from the
 * host machine's credential file).
 */
async function resolveReviewerApiKey(credentials: any): Promise<string | undefined> {
  let apiKey: string | undefined
  try {
    const resolved = await credentials?.resolve?.(REVIEWER_CREDENTIAL_REF)
    apiKey = resolved?.value
  } catch {
    apiKey = undefined
  }
  if (!apiKey && process.env.DSH_AUTO_APPROVAL_READ_CRED_FILE !== '0') {
    apiKey = reviewerKeyFromCredentialFile()
  }
  return apiKey
}

/**
 * Optimistic route-availability predicate for the deep-review lane, consumed
 * by both the confirmation-learning gate and the main risk pipeline. Mirrors
 * the exact snapshot-time resolution but without the async key lookup: a
 * session/preset source with a resolvable host route or an endpoint source
 * with a configured URL+model counts as available. The snapshot re-checks
 * precisely and fails loudly on any half-configuration — the gate is an
 * optimistic pre-check only (misjudgment worst case is ESCALATE/ask, never an
 * auto-allow).
 */
export function reviewerRouteAvailable(config: Config, session: any): boolean {
  const lane = normalizeLane({
    source: config.reviewerSource,
    presetProvider: config.reviewerProvider,
    presetModel: config.reviewerModel,
  })
  const endpoint = normalizeSharedEndpoint({
    url: config.endpointUrl,
    model: config.endpointModel,
    protocol: config.endpointProtocol,
  })
  const transport = resolveTransport(lane.source, lane, endpoint, sessionModelRoute(session))
  return transport.transport !== 'none'
}

export async function buildReviewSnapshot(
  credentials: any, tools: any, session: any, req: any, config: Config,
  opts: {
    userMessages?: string[]
    workspaceRoot?: string
    home?: string
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
  const payload = frameReviewerInput({
    toolName: req.toolName,
    description: findToolDescription(tools, req.toolName),
    rawArguments: rawArgs,
    trustedUserMessages: opts.userMessages ?? [],
    workspaceRoot: opts.workspaceRoot ?? undefined,
    targetRelative,
    inWorkspace,
  })
  // system = REVIEWER_SYSTEM + safetyPrompt + sanitized/bounded rules
  // summary (rules are constraints only; they can never authorize).
  const system = assembleReviewerSystem(config.safetyPrompt, config.rulesText)

  // Channel-driven transport: the reviewer
  // source switch decides how this review travels — session/preset ride the
  // host LLM through a provider/model route; endpoint rides raw fetch to the
  // shared custom endpoint config. The API key (endpoint) resolves once into
  // the snapshot (never cached beyond one review), so a settings change
  // mid-review cannot steer a retry toward a different endpoint or key.
  const reviewerLane = normalizeLane({
    source: config.reviewerSource,
    presetProvider: config.reviewerProvider,
    presetModel: config.reviewerModel,
  })
  if (reviewerLane.error) {
    // The operator explicitly chose a source and misconfigured it — fail
    // loudly, never silently follow the session model (ruling).
    return { failure: reviewerLane.error }
  }
  const endpoint = normalizeSharedEndpoint({
    url: config.endpointUrl,
    model: config.endpointModel,
    protocol: config.endpointProtocol,
  })
  const transport = resolveTransport(
    reviewerLane.source,
    reviewerLane,
    endpoint,
    sessionModelRoute(session),
  )
  if (transport.transport === 'none') {
    if (reviewerLane.source === 'session') return { failure: 'no reviewer route' }
    return { failure: transport.reason }
  }
  if (transport.transport === 'raw') {
    const validated = validateReviewerBaseUrl(transport.baseUrl)
    if (!validated.ok) {
      console.warn(`[dsh-auto-approval-llm] ${validated.reason}`)
      return { failure: validated.reason }
    }
    const apiKey = await resolveReviewerApiKey(credentials)
    // A configured endpoint without a resolved key is treated as unconfigured:
    // log what is missing and fail — an endpoint review without a key can only
    // produce AUTH.
    if (!apiKey) {
      debugLog({ ev: 'reviewer-incomplete', callId: req.callId, baseUrl: validated.baseUrl, missing: ['key'] })
      return { failure: 'endpoint source needs a resolved API key' }
    }
    return {
      transport: 'raw',
      payload,
      system,
      baseUrl: validated.baseUrl,
      model: transport.model,
      protocol: transport.protocol,
      apiKey,
      maxTokens: config.reviewerMaxTokens ?? 2_048,
    }
  }
  return {
    transport: 'host',
    payload,
    system,
    route: { provider: transport.provider, model: transport.model },
    maxTokens: config.reviewerMaxTokens ?? 2_048,
    reasoningEffort: config.reviewerReasoning ?? '',
  }
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
  if (snapshot.transport === 'host') {
    const route = snapshot.route!
    const callConfig: any = { provider: route.provider, model: route.model, maxTokens: snapshot.maxTokens ?? 2_048 }
    // Reasoning effort: '' follows the adapter default; an explicit value is
    // forwarded to the dsh reasoningEffort. A model that does not support it
    // throws UNSUPPORTED_REASONING_EFFORT → the review fails loudly (never
    // silently). The stream spreads prepared.config, so the effort lands on
    // the wire only when the adapter accepted it.
    if (snapshot.reasoningEffort && snapshot.reasoningEffort !== '') callConfig.reasoningEffort = snapshot.reasoningEffort
    const prepared = await llm.prepareCall(callConfig, signal)
    const messages = [createUserMessage({
      content: [{ type: 'text', text: snapshot.payload }],
      source: PLUGIN_MESSAGE_SOURCE,
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

  // Raw endpoint transport: the shared endpoint call owns the SSRF/redirect
  // fence and protocol routing; HTTP failures map to the review failure codes.
  const result = await callEndpointText({
    baseUrl: snapshot.baseUrl!,
    model: snapshot.model!,
    protocol: snapshot.protocol!,
    apiKey: snapshot.apiKey,
    system: snapshot.system,
    messages: [snapshot.payload],
    maxTokens: snapshot.maxTokens ?? 2_048,
    signal,
  })
  if (!result.ok) {
    const failure: ReviewFailure = httpStatusFailure(result.status ?? 0, result.message, { headers: { get: () => null } })
    if (result.retryAfterMs !== undefined) failure.providerRetryAfterMs = result.retryAfterMs
    throw failure
  }
  return parseReviewTextOrThrow(result.text)
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

// Monotonic revision source for published review states.
let reviewRevisionSeq = 0

/** Hard ceiling for the panel hold, independent of what settings carry. */
const MAX_PANEL_DELAY_MS = 10_000

export interface PanelGate {
  /** Resolves when the panel may appear (delay elapsed or released). */
  wait(): Promise<void>
  /** Whether the ask settled while the panel was still held back. */
  isCancelled(): boolean
  cancel(): void
}

/**
 * Hold the official panel back for `delayMs` so a short-lived ask cannot take
 * over the composer. The gate is resolved by the delay, by the user asking to
 * see the panel, or by {@link PanelGate.cancel} when the ask settles first —
 * a settled ask must never forward its request to the client afterwards.
 */
export function createPanelGate(callId: string | undefined, delayMs: number): PanelGate | undefined {
  const bounded = Math.max(0, Math.min(Math.round(delayMs), MAX_PANEL_DELAY_MS))
  if (callId === undefined || bounded === 0) return undefined
  let cancelled = false
  let resolveOpen: () => void = () => {}
  const opened = new Promise<void>((resolve) => { resolveOpen = resolve })
  const release = () => {
    clearTimeout(timer)
    pendingPanelReleases.delete(callId)
    resolveOpen()
  }
  const timer = setTimeout(release, bounded)
  pendingPanelReleases.set(callId, release)
  return {
    wait: () => opened,
    isCancelled: () => cancelled,
    cancel: () => {
      cancelled = true
      release()
    },
  }
}

// Follow-phase statuses are retained briefly after the host resolution so the
// client's poll can observe the follow and close the official panel with the
// real outcome. Swept by FOLLOW_STATE_TTL_MS; released earlier on client ACK.
// 120s covers Chrome's background-tab intensive throttling (≥1 min between
// timer firings after 5 min hidden), so a throttled client still observes the
// follow instead of falling back to a stale countdown action.
const FOLLOW_STATE_TTL_MS = 120_000

// callIds whose approval/request has already been settled by the host (any
// resolution path). The client's follow ACK (FEEDBACK POST) arrives AFTER
// askHuman finished, so without this set the ACK would relabel a resolved ask
// with the timeout notice. Map<callId, timestamp>; swept with the follow
// sweep; only used to gate feedback text.
const RESOLVED_TTL_MS = 30_000

function clearApprovalState(): void {
  for (const map of Object.values(approvalState)) map.clear()
}

/**
 * Test-only view of the callId-keyed approval maps.
 *
 * The /feedback route's real contract is that it WRITES for a callId the plugin
 * issued and stays a no-op otherwise, and the two cases answer with the same
 * `200 {ok:true}`. Pinning only the response therefore cannot tell them apart:
 * dropping the write entirely used to leave the suite green. This accessor lets
 * a test seed a live callId, exercise the route, and assert the write actually
 * landed — and that the no-op path still writes nothing.
 */
export function approvalStateForTests(): typeof approvalState {
  return approvalState
}

function sweepFollowPhase(now = Date.now()): void {
  for (const [callId, expiry] of followExpiry) {
    if (expiry <= now) {
      followExpiry.delete(callId)
      reviewStates.delete(callId)
      reviewSessions.delete(callId)
    }
  }
  for (const [callId, at] of resolvedCallIds) {
    if (now - at > RESOLVED_TTL_MS) resolvedCallIds.delete(callId)
  }
  for (const [callId, at] of autoAnsweredCallIds) {
    if (now - at > RESOLVED_TTL_MS) autoAnsweredCallIds.delete(callId)
  }
}

function sweepFeedbackMaps(): void {
  sweepFeedback(timeoutFeedback, { ttlMs: 60_000, maxEntries: 256 })
  sweepFeedback(decisionFeedback, { ttlMs: 60_000, maxEntries: 256 })
  sweepFeedback(loopGuardPinned, { ttlMs: 60_000, maxEntries: 256 })
}

export function installFeedbackRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: FEEDBACK_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: feedback route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (method !== 'POST') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'POST' })
      }
      // Feedback plane: loopback-same-origin only (privileged domain — the
      // route writes approval state keyed by a callId the review-status
      // protocol carries in the open, so LAN peers must not be able to forge
      // those writes).
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      try {
        const body = await readJson(request)
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
        // A callId the plugin never issued (or one whose state is fully swept)
        // is a no-op, not a write: every legitimate ACK arrives for a live
        // ask, a resolved ask, or a verdict, and writing feedback for a
        // foreign id would only poison the bounded feedback maps with entries
        // nothing will ever read. Still 200 — from the client the ACK is
        // idempotent, and the route must not leak which callIds exist.
        const knownCallId = timeoutFeedback.has(body.callId) || decisionFeedback.has(body.callId) ||
          resolvedCallIds.has(body.callId) || reviewStates.has(body.callId) ||
          followExpiry.has(body.callId) || reviewVerdicts.has(body.callId)
        const reviewStatus = reviewStates.get(body.callId)
        // A published `follow` phase means the host already resolved this ask —
        // by a human click, an LLM takeover, or its own timer — and the timer
        // records the timeout notice itself when it fires. The resolvedCallIds
        // marker alone cannot carry that guarantee: it ages out (30s) before the
        // follow window closes (120s), so an ACK landing in between relabelled a
        // settled human/LLM decision as "no response".
        if (knownCallId && !decisionFeedback.has(body.callId) && !resolvedCallIds.has(body.callId) &&
          reviewStatus?.phase !== 'follow') {
          // A client auto-answer arrives with `auto: true`; mark it so the
          // resolution is labelled `auto-*` rather than credited to a human.
          if (body.auto === true) autoAnsweredCallIds.set(body.callId, Date.now())
          recordTimeoutFeedback(body.callId, `[dsh-auto-approval-llm] auto-${actionText} by the configured timeout action (timeout — not a user denial)`)
        }
        // The client has seen the follow phase and is answering: release the
        // follow state early instead of waiting for the TTL sweep.
        if (reviewStatus?.phase === 'follow') {
          reviewStates.delete(body.callId)
          followExpiry.delete(body.callId)
        }
        return json(200, { ok: true })
      } catch (error) {
        return json(error instanceof RangeError ? 413 : 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
}

// ── retired settings document ─────────────────────────────────────────────
// The host line that stores settings as a profile patch imported the previous
// `settings.yaml` once and renamed it, so this namespace's stored values stayed
// in that renamed file and never reached the live configuration. The reader
// below is the only way back, and it is deliberately narrow: the file belongs to
// the host, not to this plugin, and a wrong value would be written into the live
// namespace by one click.

/** Name the host line gives the settings document it imported. */
export const LEGACY_SETTINGS_FILENAME = 'settings.yaml.imported'

/**
 * A scalar this reader recognises, and whether it recognises it at all.
 *
 * `known: false` drops the field. Every unsupported shape lands there on
 * purpose: a nested mapping, a flow collection carrying entries, a quoted
 * scalar with escapes, an anchor/alias, a block scalar, a `null`, and a scalar
 * with a trailing comment all read as "not understood" rather than as a guess.
 */
function legacyScalar(text: string): { known: boolean; value?: unknown } {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return { known: false }
  if (trimmed.startsWith('&') || trimmed.startsWith('*')) return { known: false }
  if (trimmed === '[]') return { known: true, value: [] }
  if (trimmed === '{}') return { known: true, value: {} }
  if ('[{|}>&*!'.includes(trimmed[0] ?? '')) return { known: false }
  const quoted = /^"(.*)"$/s.exec(trimmed) ?? /^'(.*)'$/s.exec(trimmed)
  if (quoted !== null) {
    const body = quoted[1] ?? ''
    if (trimmed.startsWith('"') ? body.includes('\\') : body.includes("''")) return { known: false }
    return { known: true, value: body }
  }
  if (trimmed.includes(' #')) return { known: false }
  if (trimmed === 'true' || trimmed === 'false') return { known: true, value: trimmed === 'true' }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return { known: true, value: Number(trimmed) }
  return { known: true, value: trimmed }
}

/** A block list of scalars, or `known: false` when any item is another shape. */
function legacyBlockList(items: readonly string[]): { known: boolean; value?: unknown } {
  const out: unknown[] = []
  for (const item of items) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*:(?:[ \t]|$)/.test(item)) return { known: false }
    const scalar = legacyScalar(item)
    if (!scalar.known) return { known: false }
    out.push(scalar.value)
  }
  return { known: true, value: out }
}

/**
 * Values of one top-level `<ns>:` segment of a settings document.
 *
 * Bounded on purpose: it recognises the shape the host writes — a top-level
 * segment header, then one indented `key: value` per field, with a scalar, an
 * empty `[]`/`{}`, or a block list of scalars as the value — and treats every
 * other shape as a field it does not understand, dropping it instead of
 * guessing. Text with no such segment, an empty segment, a truncated line, a
 * tab-indented or nested body: all yield fewer fields, never an exception.
 */
export function readSettingsSegment(text: string, ns: string): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  let inSegment = false
  let fieldIndent = -1
  let name: string | null = null
  let inline: string | undefined
  let children: string[] = []
  let unsupported = false
  const commit = () => {
    if (name !== null && !unsupported) {
      const parsed = inline === undefined
        ? (children.length === 0 ? { known: false } : legacyBlockList(children))
        : legacyScalar(inline)
      if (parsed.known) values[name] = parsed.value
    }
    name = null
    inline = undefined
    children = []
    unsupported = false
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t]+$/, '')
    const body = line.trimStart()
    if (body === '' || body.startsWith('#')) continue
    const indent = line.length - body.length
    if (indent === 0) {
      commit()
      fieldIndent = -1
      inSegment = body === `${ns}:`
      continue
    }
    if (!inSegment) continue
    if (fieldIndent < 0) fieldIndent = indent
    if (indent > fieldIndent) {
      // A line below the field level: the current field's own block list, or a
      // shape this reader does not model (a nested mapping).
      if (name !== null && inline === undefined && !unsupported && body.startsWith('- ')) children.push(body.slice(2))
      else unsupported = true
      continue
    }
    if (indent < fieldIndent) {
      commit()
      unsupported = true
      continue
    }
    commit()
    const field = /^([A-Za-z_$][A-Za-z0-9_$]*):(?:[ \t]+(.*))?$/.exec(body)
    if (field === null) {
      unsupported = true
      continue
    }
    name = field[1] as string
    inline = field[2]
  }
  commit()
  return values
}

/** One segment of the retired document at `path`; an unreadable file reads as none. */
export function readLegacySettings(path: string, ns: string): Record<string, unknown> {
  try {
    if (path === '' || !existsSync(path)) return {}
    return readSettingsSegment(readFileSync(path, 'utf8'), ns)
  } catch (error) {
    console.warn('[dsh-auto-approval-llm] the retired settings document could not be read; nothing is offered for import', error)
    return {}
  }
}

/**
 * The retired values still worth importing: keys the settings card may write,
 * that the retired document carries, that the shipped layer does not pin, and
 * whose value differs from the effective configuration.
 *
 * Three separate questions, because any one alone is wrong:
 *
 *   - `pinned` — the keys the shipped patch layer declares for this
 *     deployment. They are refused outright: the shipped layer states the
 *     policy this installation runs with, and a stale document must not reload
 *     a relaxed timeout action or an allowlist the card never showed.
 *   - `declared` — the configuration the entry owns. A card-owned key it names
 *     at a value of its own is the operator's stored value: offering it would
 *     put a value the user can see and edit back behind one click. A key it
 *     names at exactly the value the schema defaults to is not that: the config
 *     plane writes the effective value of every card-owned key into the entry
 *     config on a save, so a default-valued declaration is the plane echoing
 *     the schema, and treating it as a declaration would empty the offer on
 *     every installation that has saved once.
 *   - `current` — the effective configuration the route serves. A key whose
 *     retired value equals the value already in effect changes nothing when it
 *     is imported; offering it would only pin a schema default into an explicit
 *     declaration. That is a no-op, and a batch of no-ops hides the fields the
 *     import actually changes.
 *
 * The host-owned keys are excluded by name as well as by the editable list, so
 * the plan stays correct even if the two lists ever overlap. A key the effective
 * configuration does not carry counts as differing: absent is not equal.
 */
export function legacyImportPlan(legacy: Record<string, unknown>, declared: Record<string, unknown>, current: Record<string, unknown>): { keys: string[]; value: Record<string, unknown> } {
  const keys: string[] = []
  const value: Record<string, unknown> = {}
  const hostOwned = new Set<string>(HOST_ONLY_KEYS)
  const pinned = new Set<string>(SHIPPED_PINNED_KEYS)
  for (const key of EDITABLE_CONFIG_KEYS) {
    if (hostOwned.has(key)) continue
    if (pinned.has(key)) continue
    if (!Object.prototype.hasOwnProperty.call(legacy, key)) continue
    if (legacy[key] === undefined) continue
    if (Object.prototype.hasOwnProperty.call(declared, key) && !sameConfigValue(declared[key], FACTORY_CONFIG_DEFAULTS[key])) continue
    // A value comparison has to mean one thing across the document, the schema
    // and the card: same type, same shape, same tree. Two values that agree that
    // way are the same settings value whatever the plane stored as the carrier.
    if (Object.prototype.hasOwnProperty.call(current, key) && sameConfigValue(legacy[key], current[key])) continue
    keys.push(key)
    value[key] = legacy[key]
  }
  return { keys, value }
}

/**
 * Whether two configuration values are the same value: same type, same shape,
 * same entries. A key that is absent on either side is not the same value, so a
 * missing field reads as a difference rather than as a match against undefined.
 *
 * Configuration values are data — scalars, lists and plain records — so a
 * structural walk is the whole comparison; `depth` bounds it against a value
 * that is not the data its shape claims to be.
 */
function sameConfigValue(left: unknown, right: unknown, depth = 0): boolean {
  if (left === right) return true
  if (depth > 16) return false
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftList = Array.isArray(left)
  if (leftList !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (!sameConfigValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1)) return false
  }
  return true
}

/** One-time flag: the missing declarations report fires once per process. */
let declaredConfigWarned = false

/**
 * The configuration the live namespace DECLARES: the entry's own config, i.e.
 * the shipped patch layer merged with whatever the profile patch carries.
 *
 * The import offer asks this DECLARATION what it may OFFER, so a key it names
 * at a value of its own is excluded. Whether a value is worth offering is the
 * question `legacyImportPlan` answers against `current`, the effective resolved
 * configuration: it carries every card-owned key because each has a schema
 * default, so an offer needing a key ABSENT from `current` could never appear.
 * `current` is also what the host's own configuration editor writes.
 *
 * Whether the host exposes the raw patch content or a schema-completed set of
 * every key does not change the offer, because a declared value equal to the
 * schema default is read as the plane echoing the schema rather than as a
 * stored choice (see `legacyImportPlan`). An entry the host does not expose
 * reads as "nothing declared" and offers nothing, never a guess at the whole
 * editable set.
 */
function declaredConfig(ctx: any): Record<string, unknown> | undefined {
  const declared = ctx?.fiber?.entry?.options?.config
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    return declared as Record<string, unknown>
  }
  if (!declaredConfigWarned) {
    declaredConfigWarned = true
    console.warn('[dsh-auto-approval-llm] the host exposed no entry configuration; the retired settings document is not offered for import')
  }
  return undefined
}

export function installSettingsRoute(ctx: any, settings: any, baseConfig: Record<string, unknown> = {}, dshHome = ''): void {
  if (!settings) return

  // The retired document is read per request, never at startup: a missing or
  // malformed file must not be able to affect the plugin's own load, and the
  // answer has to follow the file rather than the boot state.
  const legacyPath = dshHome === '' ? '' : join(dshHome, LEGACY_SETTINGS_FILENAME)
  // The offer takes the effective configuration the snapshot is about to serve:
  // one source of "the current value" for the page and for the offer, so a field
  // the import would not change is not offered to change it.
  const legacyImport = (current: Record<string, unknown>) => {
    if (legacyPath === '') return { keys: [], value: {} }
    const declared = declaredConfig(ctx)
    if (declared === undefined) return { keys: [], value: {} }
    return legacyImportPlan(readLegacySettings(legacyPath, SETTINGS_NS), declared, current)
  }

  // Read-only snapshot. The settings card writes through the host form the
  // page owner hands it, so this route owns no write path; GET stays as the
  // degradation source for a card that has no host form (entry not ACTIVE) and
  // as the carrier of the configError banner.
  //
  // The host config plane exposes stored values through describe() keyed by the
  // profile entry id, and projects only the volatile (card-owned) fields. The
  // loader entry config supplies the host-owned keys, which the plane never
  // returns, so the card keeps showing their effective values. A stored value
  // that fails schema validation makes describe() throw: never let that turn
  // GET into a permanent error — answer with the base so the card can still
  // render and offer to clear the bad keys.
  const describeSettings = (): { value: any; revision: number; writable: boolean; applies: string; configError: string | null; legacyImport: { keys: string[]; value: Record<string, unknown> } } => {
    try {
      const desc = settings.describe().find((row: any) => row.ns === SETTINGS_NS)
      const value = { ...baseConfig, ...(desc?.value ?? {}) }
      return {
        value,
        revision: desc?.revision ?? 0,
        writable: settings.writable,
        applies: desc?.applies ?? 'live',
        configError: configError ?? null,
        legacyImport: legacyImport(value),
      }
    } catch (error) {
      console.error('[dsh-auto-approval-llm] settings.describe failed, falling back to the entry config', error)
      const value = { ...baseConfig }
      return {
        value,
        revision: 0,
        writable: settings.writable,
        applies: 'live',
        configError: configError ?? (error instanceof Error ? error.message : String(error)),
        legacyImport: legacyImport(value),
      }
    }
  }

  registerCarrierFetchRoute(ctx, {
    path: SETTINGS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: settings route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      // Configuration plane: loopback-same-origin only (privileged domain,
      // mirroring the official settings/credentials fence).
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      return json(200, { ok: true, value: describeSettings() })
  })
}

export function installHistoryRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: HISTORY_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: history route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method === 'GET') {
        // Latency split by lane: `llmLatency` stays the reviewer summary
        // (backward compatible); `llmLatencyClassifier` is the fast-decision
        // lane; `llmLatencyAll` merges both for an at-a-glance view.
        return json(200, {
          ok: true,
          value: {
            records: [...approvalHistory].reverse(),
            llmLatency: summarizeLatency(llmLatency, LATENCY_SUMMARY_WINDOW, 'reviewer'),
            llmLatencyClassifier: summarizeLatency(llmLatency, LATENCY_SUMMARY_WINDOW, 'classifier'),
            llmLatencyAll: summarizeLatency(llmLatency, LATENCY_SUMMARY_WINDOW),
          },
        })
      }
      if (method === 'DELETE') {
        // Truncate FIRST and report honestly: clearing the in-memory window
        // while the file it was loaded from still holds the records means the
        // next boot resurrects them, and a 200 for that is a false success. The
        // clear also leaves a recoverable audit trail (never a silent erase),
        // so a failed truncate must not claim to have cleared anything.
        let truncated = false
        try {
          writeFileSync(historyWritePath(), '')
          truncated = statSync(historyWritePath()).size === 0
        } catch {
          truncated = false
        }
        if (!truncated) {
          return json(500, { ok: false, error: 'history clear failed: the history file could not be truncated' })
        }
        const clearedCount = approvalHistory.length
        approvalHistory.length = 0
        recordAuditClear(clearedCount)
        return json(200, { ok: true, value: { records: [] } })
      }
      return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET, POST' })
  })
}

export function installLatencyRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: LLM_LATENCY_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: llm-latency route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'DELETE') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'POST' })
      }
      // Clear only the LLM latency telemetry window + file. Approval history
      // is deliberately untouched — the history DELETE leaves latency alone
      // (telemetry is not an approval record), so this clear leaves history
      // alone in turn. A file that cannot be truncated is a 500, never a
      // success the next boot undoes.
      if (!clearLatencySamples(llmLatency)) {
        return json(500, { ok: false, error: 'latency clear failed: the latency file could not be truncated' })
      }
      return json(200, { ok: true, value: { records: [] } })
  })
}

export function installToolStatsRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: TOOL_STATS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: tool-stats route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      // Aggregates the same in-memory history window the history route serves
      // (loaded from history.jsonl at boot, capped at 200 records). Read-only:
      // chips are advisory candidates — the actual list lives in the settings
      // value and is edited/saved entirely client-side.
      return json(200, { ok: true, value: { stats: aggregateToolStats(approvalHistory) } })
  })
}

export function installLearningStoreRoute(ctx: any, revoke: (key: string) => Promise<boolean>): void {
  registerCarrierFetchRoute(ctx, {
    path: LEARNING_STORE_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: learning-store route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      // The learning store is a privileged surface: read-only list + single
      // revoke. Same-origin loopback/LAN-whitelist gate as every other route.
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method === 'GET') {
        // Display view of the store: keys are opaque hashes (never the raw
        // signature), the skeleton is the redacted zero-value template that
        // the store already persisted — nothing secret crosses the wire.
        const entries = Object.entries(learningStore.entries).map(([key, e]) => ({
          key,
          workspace: e.workspace,
          kind: e.kind,
          skeleton: e.skeleton,
          count: e.count,
          firstAt: e.firstAt,
          lastAt: e.lastAt,
        })).sort((a, b) => b.lastAt - a.lastAt)
        return json(200, { ok: true, value: { entries } })
      }
      if (method === 'DELETE') {
        // Same error contract as every sibling route: a JSON body over the
        // limit is a 413 and any other failure a JSON 400. Without this the
        // host answered a bare, non-JSON 400 that the settings card could not
        // read, so the revoke failed silently in the UI.
        try {
          const body = await readJson(request)
          if (typeof body?.key !== 'string' || body.key === '') {
            throw new TypeError('key is required')
          }
          const removed = await revoke(body.key)
          if (removed !== true) {
            return json(404, { ok: false, error: 'learning entry not found' })
          }
          if (!persistLearningGuarded()) {
            // The revoke applied in memory but not on disk, and the file is what
            // the next boot loads: claiming success here would resurrect the
            // entry silently (the same false success the history route refuses).
            return json(500, {
              ok: false,
              error: 'learning revoke could not be persisted: the entry was removed in memory only and returns after a restart',
            })
          }
          // Revoking a learned entry changes future decisions — leave a
          // recoverable audit trail (mirrors recordAuditClear's discipline).
          appendAuditLine(JSON.stringify({ type: 'learning-revoked', at: Date.now(), key: body.key }))
          return json(200, { ok: true, value: { removed: true } })
        } catch (error) {
          return json(error instanceof RangeError ? 413 : 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET, POST' })
  })
}

export function installReviewStatusRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: REVIEW_STATUS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: review status route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      // Call id travels in a request header (not the URL query) so it does not
      // leak into devtools/logs/Referer. Same-origin + loopback-trusted plan.
      const callId = String(request.headers.get('x-auto-approval-call-id') ?? '').trim()
      // Long poll: the client asks to be woken when this ask changes instead of
      // waking up every 500ms. `0`/absent keeps the short-poll behaviour.
      const holdMs = boundedHoldMs(request.headers.get('x-auto-approval-wait-ms'))
      if (callId && holdMs > 0) {
        await holdWhileUnchanged(callId, holdMs, request)
      }
      const status = callId ? reviewStates.get(callId) : undefined
      return json(200, status ? { ok: true, value: withRemaining(status) } : { ok: false, error: 'not-found' })
  })
}

/** Clamp a requested hold to the server's own ceiling; 0 disables the hold. */
export function boundedHoldMs(raw: unknown): number {
  const value = Number(String(raw ?? '').trim())
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.round(value), REVIEW_STATUS_HOLD_MS)
}

/**
 * Hold a review-status response until the ask's revision changes or the hold
 * budget elapses. The check runs in-process (no HTTP traffic), the timer is
 * released on client disconnect, and the route answers with the current state
 * either way — a hold timeout is a heartbeat, never a resolution.
 */
export function holdWhileUnchanged(callId: string, holdMs: number, request: Request): Promise<void> {
  return holdWhile(request, () => reviewStates.get(callId)?.revision, holdMs)
}

/** The status as the client sees it: remaining time derived from the host clock. */
export function withRemaining(status: ReviewStatus): ReviewStatus & { remainingMs: number } {
  const remainingMs = status.phase === 'countdown'
    ? Math.max(0, Math.min((status.expiresAt ?? Date.now()) - Date.now(), Math.max(0, status.seconds) * 1000))
    : 0
  return { ...status, remainingMs }
}

/**
 * Session-scoped discovery: every ask the host currently holds for one session.
 * The official panel is held back for `panelDelayMs`, so during that window the
 * client's only way to show the countdown is this route.
 */
export function installSessionReviewStatusRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: SESSION_REVIEW_STATUS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: session review status route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      // Session id travels in a request header, same discipline as the call id.
      const sessionId = String(request.headers.get('x-auto-approval-session-id') ?? '').trim()
      if (!sessionId) {
        return json(400, { ok: false, error: 'session-id-required' })
      }
      // Same long poll as the per-ask route: the client is woken by a change in
      // this session's ask list instead of re-asking on a fixed cadence.
      const holdMs = boundedHoldMs(request.headers.get('x-auto-approval-wait-ms'))
      if (holdMs > 0) {
        await holdWhile(request, () => sessionReviewFingerprint(sessionId), holdMs)
      }
      const reviews: unknown[] = []
      for (const [callId, status] of reviewStates) {
        if (reviewSessions.get(callId) !== sessionId) continue
        reviews.push({ ...withRemaining(status), callId })
      }
      return json(200, { ok: true, value: { reviews } })
  })
}

/**
 * Identity of one session's ask list: any publish, settlement or removal
 * changes it, which is exactly when a held discovery request must answer.
 */
export function sessionReviewFingerprint(sessionId: string): string {
  const parts: string[] = []
  for (const [callId, status] of reviewStates) {
    if (reviewSessions.get(callId) !== sessionId) continue
    parts.push(`${callId}:${status.revision ?? ''}:${status.phase}`)
  }
  return parts.sort().join('|')
}

/**
 * Release a held-back panel early ("show it now" from the client's countdown
 * surface). Unknown or already-settled asks answer `revealed: false` rather
 * than inventing a panel.
 */
export function installRevealRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: REVEAL_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: reveal route',
  }, (request: Request): Response => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'POST') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'POST' })
      }
      const callId = String(request.headers.get('x-auto-approval-call-id') ?? '').trim()
      const release = callId ? pendingPanelReleases.get(callId) : undefined
      if (release) release()
      return json(200, { ok: true, value: { revealed: release !== undefined } })
  })
}

function installTestRoute(ctx: any, llm: any, endpointUrlFor: () => string = () => ''): void {
  registerCarrierFetchRoute(ctx, {
    path: TEST_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: test route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      // The online branch performs a server-side HTTP request driven by
      // request-body settings, so it must sit on the same trust plane as the
      // settings/credential routes: loopback-same-origin only. Otherwise any
      // LAN peer that passes `trustedHosts` (when the web server binds
      // 0.0.0.0) could turn the host process into an SSRF-to-loopback probe.
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'POST') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'POST' })
      }
      try {
        const body = await readJson(request)

        // Online-reviewer mode: hit the endpoint directly with the typed
        // (not-yet-saved) key and model from the draft. The key is never
        // logged or returned. Scheme fence matches the saved-reviewer path
        // (validateReviewerBaseUrl): https is allowed anywhere (the live
        // review relay already sends real requests there), cleartext http
        // only to loopback hosts (no key over plaintext to the LAN/Docker).
        // Unlike the configured BaseUrl (admin-controlled), this value comes
        // from the request body, so the target is still muzzled to https or
        // loopback — an http probe of an arbitrary intranet host stays closed.
        if (body?.online) {
          const protocol = body.protocol === 'anthropic' ? 'anthropic' : 'openai'
          const validated = validateReviewerBaseUrl(body.baseUrl ?? '')
          if (!validated.ok) throw new TypeError(validated.reason)
          const baseUrl = validated.baseUrl
          const model = String(body.model ?? '').trim()
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          if (!baseUrl || !model) throw new TypeError('API 地址和模型名称是必填项')
          // The stored reviewer key may only be attached when this probe
          // targets the endpoint that key belongs to. The route sits on the
          // loopback trust plane, which any loopback peer passes — including
          // the agent's own shell — while the target host comes from the
          // request body, so an unconditional fallback handed the saved key to
          // whatever address the caller named: a credential-exfiltration
          // primitive that needed no filesystem access. A foreign target now
          // probes unauthenticated and reports the real auth failure.
          const storedKeyAllowed = sameEndpointTarget(baseUrl, endpointUrlFor())
          const probeApiKey = apiKey || (storedKeyAllowed ? await (async () => {
            const creds = ctx.get('credentials')
            try {
              const resolved = await creds?.resolve?.(REVIEWER_CREDENTIAL_REF)
              if (resolved?.value) return String(resolved.value)
            } catch { /* fall through to file */ }
            return reviewerKeyFromCredentialFile() ?? ''
          })() : '')
          let probeUrl: URL
          try {
            probeUrl = new URL(baseUrl)
          } catch {
            throw new TypeError('API 地址不是合法 URL')
          }
          if (!reviewerProbeTargetAllowed(probeUrl)) {
            throw new TypeError('在线评审测试仅支持 https 地址或本机回环地址（127.0.0.1 / localhost / [::1]）')
          }
          // Public-address enforcement (SSRF hardening, mirrors the official
          // dsh-web-fetch-http provider): resolve once, refuse the whole set
          // when any address is not public unicast, so an https intranet or
          // metadata host cannot be probed even through a public-looking FQDN.
          // Loopback stays exempt (local mock reviewer / Ollama / LM Studio).
          // The validated set then PINS the connection (same shared transport
          // as the live review): a pre-flight resolution alone left the window
          // between the check and the connect open to a re-binding FQDN.
          let probeLookup: ReturnType<typeof createPinnedLookup> | undefined
          if (!isLoopbackHostname(probeUrl.hostname)) {
            const resolved = await resolvePublicReviewerTarget(probeUrl.hostname)
            if (!resolved.ok) throw new TypeError(resolved.reason)
            if (isIP(probeUrl.hostname.replace(/^\[|\]$/g, '')) === 0) probeLookup = createPinnedLookup(resolved.addresses)
          }
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (probeApiKey) {
            if (protocol === 'anthropic') headers['x-api-key'] = probeApiKey
            else headers.Authorization = `Bearer ${probeApiKey}`
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8_000)
          try {
            const probePath = protocol === 'anthropic' ? '/messages' : '/chat/completions'
            const probeBody = protocol === 'anthropic'
              ? JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
              : JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
            const probe = await requestEndpointText(new URL(`${baseUrl}${probePath}`), {
              headers,
              body: probeBody,
              signal: controller.signal,
              ...(probeLookup === undefined ? {} : { lookup: probeLookup }),
            })
            if (probe.tooLarge) throw new Error(extractProbeErrorSummary(0, 'the probe response exceeded the size limit'))
            // Same redirect fence as the configured reviewer: the transport
            // never follows a 302, so it surfaces here as a non-2xx status.
            if (probe.status < 200 || probe.status >= 300) {
              throw new Error(extractProbeErrorSummary(probe.status, probe.body))
            }
            return json(200, { ok: true, value: { reachable: true, modelFound: true } })
          } finally {
            clearTimeout(timer)
          }
        }

        const provider = body?.provider
        const model = body?.model
        if (!provider || !model) {
          throw new TypeError('provider and model are required')
        }
        const models = await llm.listModels(provider)
        const found = models.some((m: any) => m.id === model || m.name === model)
        return json(200, {
          ok: true,
          value: { reachable: true, modelFound: found, count: models.length },
        })
      } catch (error) {
        return json(400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
}

export function installSessionModeRoute(ctx: any): void {
  // Bounded once-per-id note for "this process has no live agent for that id".
  // The status code no longer carries that fact — it is a normal answer — so
  // keep it diagnosable behind the debug switch instead of losing it entirely.
  const unknownSessionLogged = new Set<string>()
  const UNKNOWN_SESSION_LOG_CAP = 32
  registerCarrierFetchRoute(ctx, {
    path: SESSION_MODE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: session mode route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, trustedHosts)) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      // Session id travels in a request header (never the URL query) so it
      // does not leak into devtools/logs/Referer — the same discipline as the
      // review-status call-id header (shared.ts documents the rule
      // client-side).
      const sessionId = String(request.headers.get('x-auto-approval-session-id') ?? '').trim()
      if (!sessionId) {
        return json(400, { ok: false, error: 'sessionId is required' })
      }
      const agents = ctx.get('agents')
      const permissionPresets = ctx.get('permissionPresets')
      const agent = agents?.get?.(sessionId)
      if (!agent?.session) {
        // No live agent for this id is a normal answer, not a client error: the
        // client asks about whichever session the sidebar currently selects, and
        // right after a restart that session is in history while its agent is
        // not instantiated yet. The success shape already expresses "no mode
        // known" as `mode: null` — the same answer the session stats route gives
        // for the same situation — whereas a 404 only produced console noise
        // that no page can suppress.
        if (!unknownSessionLogged.has(sessionId) && unknownSessionLogged.size < UNKNOWN_SESSION_LOG_CAP) {
          unknownSessionLogged.add(sessionId)
          debugLog({ ev: 'session-mode-unknown', sessionId })
        }
        return json(200, { ok: true, value: { mode: null } })
      }
      // Report the durable raw identity normalized to the plugin's machine
      // name: a legacy `auto` session reads as auto-approval so the client
      // panel stays visible, while a modern upstream `auto` stays `auto`.
      const gateNames = gatePresetNames(detectHostCapability(permissionPresets).capability)
      const raw = rawPresetOf(permissionPresets, agent.session)
      const mode = raw !== undefined && gateNames.includes(raw) ? GATED_PRESET : (raw ?? null)
      return json(200, { ok: true, value: { mode } })
  })
}

export function apply(ctx: Context, rawConfig: Config): void {
  // ── services, capability probe, boot audit ──────────────────────────────
  const anyCtx = ctx as any
  const approval = anyCtx.get('approval')
  // Premise made explicit (F2-03): the host derives a cold session's approval
  // from the BASE approval policy, which the dsh base patch pins to 'never'
  // when DSH_PERMISSION_MODE=danger-full-access. In that environment a cold
  // session derives as danger-full-access, never as Auto, so this plugin
  // stays inactive for it — fail-closed direction, but totally silent. Warn
  // once at boot so the premise is on the record.
  if ((approval as any)?.config?.policy === 'never') {
    console.warn('[dsh-auto-approval-llm] base approval policy is never (DSH_PERMISSION_MODE=danger-full-access?): cold sessions will not be detected as Auto, so auto approval stays inactive until the base policy is ask.')
  }
  const permissionPresets = anyCtx.get('permissionPresets')
  // Capability is probed once and frozen for the process: it decides the
  // accepted gate names and whether the legacy `auto` identity may be migrated.
  // A signal mismatch is intentionally fail-closed (no alias, no migration).
  const hostCapability = detectHostCapability(permissionPresets)
  const gateNames = gatePresetNames(hostCapability.capability)
  // Boot diagnostics are collected here but appended only after
  // setRuntimeStateDir below, so the line lands in the DSH_HOME this process
  // actually resolves instead of the pre-config default.
  let hostCapabilityAudit: string | undefined
  let presetConfigAudit: string | undefined
  if (hostCapability.capability === 'unknown') {
    console.warn(`[dsh-auto-approval-llm] host permission-preset surface is unknown (${hostCapability.reason}); the legacy "auto" alias and migration stay disabled (fail-closed)`)
    hostCapabilityAudit = JSON.stringify({ type: 'host-capability', at: Date.now(), capability: 'unknown', reason: hostCapability.reason })
  }
  // Boot self-check: the composed permission table must carry the plugin's own
  // preset as danger-full-access + ask. The gate is raw-identity based, so a
  // missing preset cannot be selected for new sessions; the check makes the
  // deployment gap loud instead of showing up as "the plugin never runs".
  {
    const targetSpec = safeResolveSpec(permissionPresets, GATED_PRESET)
    const names = permissionPresets?.names
    const listed = Array.isArray(names) ? names.includes(GATED_PRESET) : undefined
    if (!isUsableTargetSpec(targetSpec) || listed === false) {
      console.warn(`[dsh-auto-approval-llm] preset "${GATED_PRESET}" is missing or is not danger-full-access+ask in the composed permission table; define it in the bundle patch/profile or the plugin cannot gate`)
      presetConfigAudit = JSON.stringify({ type: 'preset-config-missing', at: Date.now(), preset: GATED_PRESET })
    }
  }
  const tools = anyCtx.get('tools')
  const llm = anyCtx.get('llm')
  const settings = anyCtx.get('settings')
  // Optional: DSH credential store for the online-reviewer API key (present
  // in the web profile). Absent → online reviewer degrades to ESCALATE and
  // the credential UI reports "unavailable". Resolved per use, never captured
  // at apply() time: the provider mounts asynchronously (Service.init), so a
  // one-shot `ctx.get()` here would freeze every credential route on
  // undefined for the whole process life even when the service is up.
  const getCredentials = (): any => anyCtx.get('credentials')

  // ── config load, classifier, settings wiring ────────────────────────────
  let config: Config
  // Reads this plugin's own stored row from the host config plane. The plane
  // projects only the volatile (card-owned) keys and exposes no get(); the
  // loader entry config is the base that carries the host-owned keys. A row is
  // present only while this plugin's own fiber is ACTIVE, so `undefined` means
  // "nothing stored is visible right now" and never "the stored keys are gone".
  let readSettingsRow: (() => any) | undefined
  // Merges a stored row onto the loader entry config; an absent row resolves to
  // the entry config alone, which is the fail-closed base.
  let mergeStoredConfig: ((row: any) => Config) | undefined
  // Set once a stored row has been read successfully. After that an empty
  // describe() is never a downgrade signal (see the deferred read in apply).
  let storedConfigLoaded = false
  // Never hard-crash apply() because of a bad config: every risky step is
  // isolated, we fall back to the (valid) patch defaults, and the error is
  // surfaced to the settings banner. A failed plugin fiber would only lose the
  // approval features; running on safe defaults + a visible error is better.
  try {
    if (settings) {
      readSettingsRow = (): any => {
        try {
          return settings.describe().find((entry: any) => entry.ns === SETTINGS_NS)
        } catch (error) {
          console.error('[dsh-auto-approval-llm] settings.describe failed', error)
          setConfigError(error instanceof Error ? error.message : String(error))
          return undefined
        }
      }
      mergeStoredConfig = (row: any): Config =>
        resolveConfig(row === undefined ? rawConfig : { ...rawConfig, ...row.value })
      try {
        const row = readSettingsRow()
        config = mergeStoredConfig(row)
        setConfigError(null)
        // A re-apply can already see the row; treat it as the loaded state so
        // the deferred read does not mistake a later empty result for a
        // first-read miss and retry over an already loaded config.
        storedConfigLoaded = row !== undefined
      } catch (error) {
        // Illegal persisted value: run on safe defaults and surface the error
        // so the settings card can offer to clear the offending keys.
        console.error('[dsh-auto-approval-llm] persisted config invalid, running defaults', error)
        setConfigError(error instanceof Error ? error.message : String(error))
        config = resolveConfig(rawConfig)
      }
    } else {
      config = resolveConfig(rawConfig)
    }
  } catch (error) {
    console.error('[dsh-auto-approval-llm] settings init failed, fallback to rawConfig', error)
    config = resolveConfig(rawConfig)
  }
  setDebugOn(config.debug)

  // Reviewer provider/model and classifier knobs are read at construction
  // time, so the classifier must be rebuilt whenever (live) settings change;
  // The override pair must be complete: a lone provider (or model) would throw
  // inside the classifier once-during construction and take the whole plugin
  // down at boot: half-configured reviewer settings crashed
  // dsh). Single-sided values are ignored defensively.
  // The classifier follows the session model unless the operator opted into a
  // preset lane: classifierSource==='preset' with a complete pair (already
  // normalized by resolveConfig) forwards that pair into createDshClassifier,
  // whose existing override branch (config.provider/model) then wins over the
  // per-call session route. The 'endpoint' source is NOT handled here — it
  // dispatches through the shared raw-endpoint call at classify time (the
  // construction-time override only serves host-LLM routes). Default 'session'
  // forwards nothing and behavior is byte-identical to the retired-pair era.
  const classifierOverrideFor = (cfg: Config) =>
    cfg.classifierSource === 'preset'
      && cfg.classifierProvider.length > 0
      && cfg.classifierModel.length > 0
      ? { provider: cfg.classifierProvider, model: cfg.classifierModel }
      : {}
  let classifier = createDshClassifier(llm, {
    timeoutMs: config.classifierTimeoutMs ?? THRESHOLD_DEFAULTS.classifierTimeoutMs,
    maxOutputTokens: config.classifierMaxOutputTokens ?? THRESHOLD_DEFAULTS.classifierMaxOutputTokens,
    reasoningEffort: config.classifierReasoning ?? '',
    ...classifierOverrideFor(config),
  })
  // Endpoint-source classifier: synchronous raw call, endpoint config resolved
  // fresh per classify() (never construction-frozen). Shares the payload and
  // system prompt with the host path; only the transport differs.
  const endpointClassifier = createEndpointClassifier({
    timeoutMs: config.classifierTimeoutMs ?? THRESHOLD_DEFAULTS.classifierTimeoutMs,
    maxOutputTokens: config.classifierMaxOutputTokens ?? THRESHOLD_DEFAULTS.classifierMaxOutputTokens,
    reasoningEffort: config.classifierReasoning ?? '',
  })
  const rebuildClassifier = () => {
    classifier = createDshClassifier(llm, {
      timeoutMs: config.classifierTimeoutMs ?? THRESHOLD_DEFAULTS.classifierTimeoutMs,
      maxOutputTokens: config.classifierMaxOutputTokens ?? THRESHOLD_DEFAULTS.classifierMaxOutputTokens,
      reasoningEffort: config.classifierReasoning ?? '',
      ...classifierOverrideFor(config),
    })
  }

  if (settings && readSettingsRow !== undefined) {
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryAttempts = 0
    let retryDisposed = false
    const stopRetry = (): void => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
    }
    // The one live-config path: the host signal and the bounded first-read
    // retry both land here, so a save-triggered reload and the startup read can
    // never disagree about what "apply the stored config" means. Returns true
    // when a stored row was read and applied.
    const applyHostConfig = (): boolean => {
      const row = readSettingsRow!()
      // An empty describe() has two meanings, and neither is "the stored keys
      // were cleared": before the first successful read the fiber is not ACTIVE
      // yet, and afterwards the entry left ACTIVE (the host emits
      // settings/document-updated for that transition too). The fail-closed
      // entry-config base is already live in the first case and must stay live
      // in the second, so an empty result never rewrites the running config.
      if (row === undefined) return false
      try {
        config = mergeStoredConfig!(row)
        setConfigError(null)
        setDebugOn(config.debug)
        rebuildClassifier()
        storedConfigLoaded = true
        stopRetry()
        console.log('[dsh-auto-approval-llm] settings updated, applied live')
        return true
      } catch (error) {
        console.error('[dsh-auto-approval-llm] live settings update failed', error)
        setConfigError(error instanceof Error ? error.message : String(error))
        return false
      }
    }
    // Bounded fallback for the first read: describe() skips an entry whose fiber
    // is not ACTIVE, and this plugin's own fiber reaches ACTIVE only after apply
    // returns, so the row is legitimately absent on the first attempt. Once a
    // row has been read the chain stops and is never re-armed on its own.
    const scheduleRetry = (): void => {
      if (retryDisposed || storedConfigLoaded || retryTimer !== undefined) return
      if (retryAttempts >= SETTINGS_FIRST_READ_MAX_ATTEMPTS) {
        setConfigError(SETTINGS_UNAVAILABLE_ERROR)
        return
      }
      const delay = retryAttempts === 0 ? 0 : SETTINGS_FIRST_READ_RETRY_MS
      retryAttempts += 1
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (!applyHostConfig()) scheduleRetry()
      }, delay)
    }
    // The deterministic signal: the host emits this with the profile entry id
    // (our settings namespace) and a content-derived revision, for a save AND
    // for the entry leaving the active set. Only our own namespace may touch
    // our config. The signal re-arms a spent budget, because it is fresh
    // evidence that the row should now be readable.
    anyCtx.on('settings/document-updated', (ns: string, _revision: number) => {
      if (ns !== SETTINGS_NS) return
      retryAttempts = 0
      if (!applyHostConfig()) scheduleRetry()
    })
    anyCtx.effect(() => {
      scheduleRetry()
      return () => {
        retryDisposed = true
        stopRetry()
      }
    }, 'dsh-auto-approval-llm: deferred settings read')
  }

  // ── ported auto-mode policy (replaces @nanmicoder/dsh-auto-mode) ────────
  const artifacts = new ArtifactRegistry()
  const rootOptions = {
    ...(config.workspaceRoot ? { workspaceRoot: config.workspaceRoot } : {}),
    ...(config.dshHome ? { dshHome: config.dshHome } : {}),
    ...(config.tempRoots ? { tempRoots: config.tempRoots } : {}),
  }
  // Persisted state lives in `<DSH_HOME>/auto-approval-llm/`. Align it with the
  // very same dshHome the guard resolves, so the directory the plugin writes to
  // is always the directory the guard protects: a divergence would put the files
  // outside the protected subtree while the guard watched a different one.
  setRuntimeStateDir(join(resolveRoots(process.cwd(), rootOptions).dshHome, 'auto-approval-llm'))
  // Only now is the state directory known. Loading must happen after this call,
  // never at module load: the directory depends on `config.dshHome`, which does
  // not exist until here, and a load that ran earlier would read one directory
  // while every write went to another.
  loadRuntimeStores()
  if (hostCapabilityAudit !== undefined) appendAuditLine(hostCapabilityAudit)
  if (presetConfigAudit !== undefined) appendAuditLine(presetConfigAudit)
  const parentAgent = (sessionId: any) => anyCtx.get('agents')?.get(sessionId)
  // Every roots consumer re-reads mode/trustedDirs from the LIVE config (G4):
  // neither key enters the frozen rootOptions, so a settings/document-updated
  // hot swap is reflected by the very next call into policy/shell/category.
  const rootsFor = (exec: any) => {
    const roots = resolveRoots(exec.agent?.session.header.cwd, rootOptions) as {
      workspace: string
      home: string
      dshHome: string
      tempRoots?: string[]
      allowedDshSubpaths?: string[]
      devZoneRoots?: string[]
      maintenanceDshPaths?: string[]
      mode?: 'standard' | 'aggressive'
      trustedDirs?: string[]
    }
    // Two sets, one owner. devZoneRoots holds the constant development zones
    // (module install root plus the gated session workspace) and is the only
    // set the shell fuse extends. allowedDshSubpaths adds the DSH_HOME-derived
    // install spelling (legacy, structured-only) and the operator-named
    // subtrees. The zones keep their narrower runtime-state deny.
    roots.devZoneRoots = devZoneRootsFor(roots.workspace, roots.dshHome, roots.home, realpathSync)
    const assumedInstall = normalizePath(join(roots.dshHome, 'plugins', 'dsh-auto-approval-llm'), roots.workspace, roots.home)
    roots.allowedDshSubpaths = [
      assumedInstall,
      ...roots.devZoneRoots.filter((root) => root !== assumedInstall),
      ...(config.trustedDshSubpaths ?? []).map((dir) => normalizePath(dir, roots.workspace, roots.home)),
    ]
    roots.maintenanceDshPaths = (config.maintenanceDshPaths ?? []).map((dir) => normalizePath(dir, roots.workspace, roots.home))
    roots.mode = config.categoryMode
    roots.trustedDirs = (config.trustedDirs ?? []).map((dir) => normalizePath(dir, roots.workspace, roots.home))
    return roots
  }
  const authorityFor = (exec: any) => autoPermissionAuthority(exec, parentAgent, permissionPresets, gateNames)
  const isAutoExecution = (exec: any) => authorityFor(exec) !== undefined
  // LOCKED-category predicate honoring the two opt-outs: delete / disk are
  // always locked; privilege is locked unless privilegeAutoReview is on, and
  // protected unless protectedAutoReview is on (both then follow the ordinary
  // pipeline). The protected opt-out is clamped by the same `credentialRead`
  // floor `categoryDirective` applies, so a credential-material read cannot be
  // unlocked in one plane and locked in the other.
  const isLockedCategory = (category: string | undefined, provenArtifactDeletion = false, credentialRead = false, opaqueLocked = false): boolean => {
    if (opaqueLocked === true) return true
    if (category === undefined) return false
    if (category === 'privilege' && config.privilegeAutoReview === true) return false
    if (category === 'protected' && config.protectedAutoReview === true && !credentialRead) return false
    // A deletion the policy plane proved targets only session-created paths keeps
    // its honest `delete` label but must not take the locked countdown. Both
    // planes read the same structured flag, so the label and the clamp cannot
    // disagree the way the protected read once did.
    if (category === 'delete' && provenArtifactDeletion) return false
    return LOCKED_CATEGORIES.includes(category as (typeof LOCKED_CATEGORIES)[number])
  }
  // Root session of the parent chain. The preset gate, breaker counter, and
  // history are all keyed on that root, so creating or switching a subagent
  // can never split (or reset) a breaker bucket — including the case where the
  // subagent's own raw identity is the gated preset. A non-gated exec has no
  // authority and keys on 'unknown'.
  const authorityKeyFor = (exec: any): string =>
    authorityFor(exec) === undefined ? 'unknown' : (rootAuthoritySessionId(exec, parentAgent) ?? 'unknown')

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
    const { directive, category } = categoryDirectiveFor(exec, roots, config, assessment)
    let risk = riskFromAssessment(assessment, req.toolName)
    const applied = applyCategoryDirective(risk, directive, assessment)
    if (applied !== 'DENY') risk = applied
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
  const learningFuseHit = (req: any, args: any): boolean => learningFuseDecision({
    toolName: req.toolName,
    args,
    roots: rootsFor({ agent: req.agent }),
    config,
  })

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
    // Site label from LEARNABLE_HOOK_SITES: contract metadata, never read —
    // the LP3 test matches each label at its call site.
    site?: string,
  ): LearnableContext | undefined => {
    try {
      if (!config.learningEnabled) return undefined
      if (!learnGateEligible({
        enabled: config.learningEnabled,
        staticRisk: classified.risk,
        category: classified.category,
        fuseHit: learningFuseHit(req, args),
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

  // Loop guard gate, called ONLY at the auto-allow sites (both planes): the
  // stream sequence advances per gated call, so the streak means "identical
  // auto-allowed calls back to back". Threshold 0 short-circuits before the
  // key is even built. A fire records the one-shot cross-plane pin, leaves a
  // non-decision audit row for provenance (the eventual timeout-deny history
  // row is generic), and never touches pushHistory or the breaker.
  const loopGateFires = (sessionKey: string, toolName: string, args: unknown, callId: string | undefined): boolean => {
    const threshold = config.loopDetectionThreshold ?? 0
    if (threshold <= 0) return false
    let state = loopStates.get(sessionKey)
    if (state === undefined) {
      state = createLoopState()
      loopStates.set(sessionKey, state)
    }
    const { consecutive, fired } = recordLoopCall(state, loopKeyFor(toolName, args), threshold)
    if (!fired) return false
    if (callId) loopGuardPinned.set(callId, { consecutive, threshold, at: Date.now() })
    debugLog({ ev: 'loop-guard', callId: callId ?? null, toolName, consecutive, threshold })
    appendAuditLine(JSON.stringify({
      type: 'loop-guard', at: Date.now(), callId: callId ?? null,
      sessionId: sessionKey, toolName, consecutive, threshold,
    }))
    return true
  }

  // The pinned countdown shape the escalated ask settles into (LOCKED-category
  // precedent: pinned reject action, no LLM takeover handle, no learnable
  // context — so unattended it times out to deny and learning can neither
  // answer nor feed on it).
  const loopGuardStatus = (category: string | undefined): ReviewStatus => ({
    risk: 'HIGH',
    phase: 'countdown',
    action: 'reject',
    seconds: Math.max(1, Math.round(config.highRiskSeconds)),
    category,
  })

  // Settlement for an escalated call. Manual mode keeps its contract — a human
  // decides with no automatic countdown — so the escalation lands as a plain
  // status-less ask there; every other mode rides the locked countdown shape.
  const loopGuardAsk = (req: any, next: () => Promise<any>, sessionKey: string, category: string | undefined) => {
    if ((reviewModes.get(sessionKey) ?? config.defaultReviewMode) === 'manual') {
      return askHuman(req, undefined, next)
    }
    return askHuman(req, undefined, next, false, loopGuardStatus(category))
  }

  const loopGuardReason = (toolName: string): string =>
    `[dsh-auto-approval-llm] loop guard: this exact ${toolName} call has been auto-allowed repeatedly (repetition guard, not a risk judgment)`

  const riskTakenOver = (risk: 'LOW' | 'MEDIUM' | 'HIGH', scope: Config['llmTakeoverScope']): boolean => {
    if (scope === 'low') return risk === 'LOW'
    if (scope === 'medium-or-below') return risk === 'LOW' || risk === 'MEDIUM'
    return true
  }

  // ── symlink-escape guard (host-side) ────────────────────────────────────
  // The guard core lives in auto/symlink.ts (pure, injectable resolver,
  // contract-tested): the workspace root and every target are resolved FRESH
  // per call — one process serves every workspace, and a process-wide cached
  // anchor made every non-first workspace's targets look like escapes and
  // hard-denied all of their file mutations (multi-workspace regression).
  // The host consults guards only AFTER an allow decision, so a guard denial
  // here overrides an `allowed-once` record the pre-execute plane just wrote
  // for the same call (the tool never dispatches). The fuse verdict is
  // appended under its own `guard` source — outcome rejected, reason carried
  // like the pre-execute `hard-deny` record — and the prior allow record is
  // never amended (the audit is append-only); the guard line is the call's
  // terminal state, and the fuse sources (`guard`, `hard-deny`, the static
  // allows) sit outside the tool-stats adjudicated-source whitelist, so the
  // pair is never double-tallied as allow + deny. Recording failure never
  // softens the denial: the reason is still returned, so the host refuses
  // the call either way (a broken audit cannot let the call dispatch).
  anyCtx.tools?.guard?.((exec: any) => {
    if (!isAutoExecution(exec)) return undefined
    const roots = rootsFor(exec)
    const reason = guardDenyDecision(exec, roots)
    if (reason === undefined) return undefined
    try {
      if (!pushHistory({
        sessionId: authorityKeyFor(exec),
        toolName: exec.name,
        outcome: 'rejected',
        source: 'guard',
        reason,
      })) {
        debugLog({ ev: 'guard-deny-audit-failure', callId: exec.callId ?? null, toolName: exec.name })
        console.warn('[dsh-auto-approval-llm] guard denial could not be persisted to the audit; the call stays denied')
      }
    } catch (error) {
      debugLog({ ev: 'guard-deny-record-error', callId: exec.callId ?? null, toolName: exec.name, error: error instanceof Error ? error.message : String(error) })
      console.warn('[dsh-auto-approval-llm] guard denial record failed; the call stays denied')
    }
    return reason
  })

  // ── direct-human-approval tool ─────────────────────────────────────────
  // dsa_request_user is the agent's explicit request for a human verdict on
  // a follow-up operation. The tool itself executes nothing: the policy layer
  // pins the call onto the pure-human ask plane, the answerer routes the ask
  // through the confirmation-learning hook against the TARGET tool's
  // signature, and a granted approval is recorded as a human confirmation on
  // that signature — never on this tool's own name. The tool is registered
  // ONLY when the switch is on at boot: the registration happens at apply()
  // and the tool set is not hot-swappable, so toggling the switch needs a
  // restart to take effect (mirrors the settings-card note). With the switch
  // off the tool is simply absent from every agent's toolset.
  if (config.directHumanEnabled === true && anyCtx.tools?.register && typeof anyCtx.tools.register === 'function') {
    try {
      const disposeDirectHumanTool = anyCtx.tools.register({
        name: DIRECT_HUMAN_TOOL,
        description:
          'Request a human decision on a follow-up tool operation before running it, instead of relying on the automatic LLM classifier review. ' +
          'This tool is registered when the direct-human channel is enabled and answers only in an Auto-preset session; in any other session it has no special effect, so if you are not sure the current session is Auto, execute the operation through its normal tool instead. ' +
          'It is meant for LOW/MEDIUM-risk operations that a human should review: delete / protected / disk operations, privilege escalation, and other hard-denied targets are refused here and must go through the ordinary approval pipeline. ' +
          'The human approves or rejects in the approval panel. On approval the target operation is allowed once and, when the target is learnable, trains the confirmation layer for that signature so identical later operations may pass without asking; a rejected target is never learned. ' +
          'Executes nothing itself; after it returns, run the target operation through its normal tool.',
        parameters: {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'Name of the follow-up tool operation to submit for human review (e.g. "memory_update", "write").' },
            args: { type: 'string', description: 'JSON text of the target operation arguments used to build the learned signature; must parse as valid JSON or the request is rejected. Omit for a coarse tool-name-level confirmation.' },
            reason: { type: 'string', description: 'Optional short reason for requesting a human review; shown in the approval panel only.' },
          },
          required: ['toolName'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['granted'] },
              message: { type: 'string' },
              targetTool: { type: 'string' },
            },
            required: ['status', 'message', 'targetTool'],
          },
          render(args: any, value: any) {
            // Contract: render returns ContentBlock[] ({type:'text', ...}),
            // never a bare string — the host calls .some()/iterates on it.
            return [{ type: 'text', text: value?.message ?? DIRECT_HUMAN_TOOL }]
          },
        },
        execute: async (args: any, exec: any) => {
          // This tool is only meaningful under an Auto-preset session with the
          // channel enabled: the answerer routes its ask onto the pure-human
          // plane there. In any other session the approval request is NOT
          // answered by this plugin, so reaching execute means the call went
          // through an ordinary pipeline that granted nothing the tool
          // promised. Fail loudly instead of returning a fake grant — the
          // agent must not believe a human pre-approved its target operation;
          // it should just execute the operation directly (its normal tools
          // still carry their own approvals).
          if (config.directHumanEnabled !== true || !isAutoExecution({ agent: exec?.agent })) {
            throw new Error(
              'this session has no direct-human approval channel (requires an Auto-preset session with the direct-human channel enabled); ' +
              'do not request escalation — execute the target operation directly through its normal tool and let the ordinary approval flow decide',
            )
          }
          // The human verdict is delivered by the approval answerer, which
          // settles this call as allowed-once (granted) or rejected before
          // execute runs; reaching execute means the panel granted it.
          return {
            status: 'granted',
            message: `human approval granted for ${String(args?.toolName ?? 'the request')}; run the target operation now through its normal tool`,
            targetTool: String(args?.toolName ?? ''),
          }
        },
      } as any)
      if (disposeDirectHumanTool) {
        ctx.effect(() => disposeDirectHumanTool, 'dsa_request_user register')
      }
    } catch (error) {
      console.warn('[dsh-auto-approval-llm] failed to register direct-human tool', error instanceof Error ? error.message : String(error))
    }
  }

  // ── tools/pre-execute handler ───────────────────────────────────────────
  anyCtx.on('tools/pre-execute', async (exec: any, next: any) => {
    if (!isAutoExecution(exec)) return next()
    // First-use onboarding: the first tool call of an AUTO root session (per
    // process lifetime) queues a one-shot greeting through the safe notice
    // queue — it only registers a pending entry, never touches the decision
    // flow below, and delivery goes through the agent inbox, which seats the
    // message at a step boundary rather than inside the tool-calls window.
    if (config.onboardingMessageEnabled !== false && markFirstAutoSessionNotice(authorityKeyFor(exec))) {
      // The notice is context for the agent (whose reasoning runs in
      // English), so it is injected in English rather than the UI language;
      // it is not an interactive user banner. Can be turned off entirely.
      queueNotice(exec.agent, exec.callId, onboardingNoticeText(config.timeoutAction, 'en'))
      debugLog({ ev: 'onboarding-inject', sessionId: exec.agent?.session?.id ?? null, callId: exec.callId ?? null, action: config.timeoutAction })
    }
    const roots = rootsFor(exec)
    const assessment = assessTool(exec, roots, artifacts)
    if (assessment.plannedCreates !== undefined) {
      const recorded = artifacts.plan(exec, assessment.plannedCreates, roots)
      // Observation only (never feeds a verdict): the session-artifact exemption
      // is an allow layer with no other trace, so without this a broken
      // provenance chain is invisible — which is exactly how it stayed broken
      // while every contract test passed.
      if (recorded.length > 0) {
        appendAuditLine(JSON.stringify({
          type: 'artifact-provenance', at: Date.now(), phase: 'plan',
          callId: exec.callId ?? null, sessionId: authorityKeyFor(exec),
          toolName: exec.name ?? null, paths: recorded,
        }))
      }
    }
    if (assessment.decision === 'deny') {
      // The code-enforced fuse is the decision users trust most, so it must
      // leave the same durable trace as every other terminal. Until this
      // record existed a hard deny was visible only as the error string
      // handed back to the model: no panel entry, no history.jsonl line, not
      // even a debug one. Its own `hard-deny` source keeps the static fuse
      // separable from the classifier plane; `category`/`riskTier` are
      // derived further down this handler and are left off rather than
      // recomputed here, since neither took part in this verdict.
      pushHistory({
        sessionId: authorityKeyFor(exec),
        toolName: exec.name,
        outcome: 'rejected',
        source: 'hard-deny',
        // Not `llmReason`: this verdict is the policy layer's, not the LLM's —
        // carried in the generic reason slot so audit consumers never mistake
        // it for reviewer output.
        reason: assessment.reason,
      })
      debugLog({ ev: 'hard-deny', callId: exec.callId ?? null, toolName: exec.name, reason: sanitizeReviewReason(assessment.reason) })
      return { kind: 'deny', reason: `[dsh-auto-approval-llm] hard deny ${assessment.reason}\n${DENY_CIRCUMVENTION_GUIDANCE}` }
    }
    // Audit-only trail: a call that cleared the hard fuse and may still run
    // (statically allowed or classifier-approved) while opening one of the
    // plugin's own runtime-state files for reading (approval history, audit
    // log, review modes, learning allow-list, …) — a shell reader command, or
    // a structured read tool whose path operand names such a file directly.
    // Purely observational — it never alters any verdict, never counts as a
    // decision. The audit line is written unconditionally (default-on, unlike
    // the debug trail below which stays behind the settings debug switch).
    const stateReads = (exec.name === 'bash' || exec.name === 'pwsh') && typeof exec.arguments?.command === 'string'
      ? runtimeStateReadHits(exec.arguments.command, exec.name, roots)
      : structuredRuntimeStateReadHits(exec.name, exec.arguments, roots)
    if (stateReads.length > 0) {
      debugLog({ ev: 'runtime-state-read', callId: exec.callId ?? null, toolName: exec.name, files: stateReads })
      appendAuditLine(JSON.stringify({
        type: 'runtime-state-read',
        at: Date.now(),
        callId: exec.callId ?? null,
        sessionId: authorityKeyFor(exec),
        toolName: exec.name,
        files: stateReads,
      }))
    }
    // Bounded, sanitized fetch destination for the audit trail (web_fetch /
    // web_search static allows). Returns undefined for every other tool or
    // when the argument is missing.
    const fetchAuditTarget = (exec: any): string | undefined => {
      if (exec?.name !== 'web_fetch' && exec?.name !== 'web_search') return undefined
      const raw = exec?.arguments?.url ?? exec?.arguments?.query
      if (typeof raw !== 'string' || raw.trim() === '') return undefined
      const sanitized = sanitizeReviewReason(raw).replace(/\s+/g, ' ').trim()
      return sanitized === '' ? undefined : `target: ${sanitized.slice(0, 300)}`
    }

    // ── user terminal gates (B1/G2 mirrored onto the pre-execute plane) ────
    // The answerer alone cannot be a terminal for these: the static allow
    // below and the classifier allow both return next() without ever creating
    // an approval/request, so denyList / declared-rule denies / humanOnly were
    // silently bypassed by statically-routine calls (e.g. `bash ls` under
    // denyList:['bash'], or an in-workspace `write` under
    // humanOnlyList:['write']). Evaluate the same user policy HERE, before
    // any fast-path allow, so an explicit operator terminal holds on every
    // Auto-session call — matching the answerer's precedence (rules →
    // denyList → humanOnly). The allowlist is mirrored too (below, after the
    // category gates, with the hard-locked categories exempted). Rules
    // evaluated here cannot see the approval reason
    // (reason-field rules still bind ask-path calls in the answerer; a
    // reason-rule deny on a static-allow call is the one remaining gap,
    // inherent to the pre-execute plane).
    // Category layer results, derived before the declared rules because a
    // rule-allow matches on the TOOL name and therefore has to consult the same
    // locked / credential floor the allowlist path consults. Pure and
    // state-free: the same function both wiring points use, no state crossing.
    const { directive, category } = categoryDirectiveFor(exec, roots, config, assessment)
    if (config.rulesText.trim() !== '') {
      const declared = parseRulesText(config.rulesText)
      if (declared.errors.length > 0) {
        reportRulesParseErrors('pre-execute', declared.errors)
      } else {
        const subject = {
          toolName: exec.name,
          arguments: exec.arguments,
          agentName: exec.agent?.session?.id,
          agentKind: agentKind(exec.agent?.session?.header?.origin),
          workspaceRoot: roots.workspace,
        }
        const matched = evaluateRules(declared.rules, subject)
        if (matched !== undefined) {
          if (config.rulesDryRun) {
            console.log(`[dsh-auto-approval-llm][rules-dry-run] ${exec.name} matched rule ${matched.rule.source} (would ${matched.policy}); dry-run: not enforced`)
          } else if (matched.policy === 'deny') {
            recordDecisionFeedback(exec.callId, formatDenyFeedback('rule', { reason: matched.rule.source }))
            pushHistory({
              sessionId: authorityKeyFor(exec),
              toolName: exec.name,
              outcome: 'rejected',
              source: 'rule-deny',
              llmReason: `matched ${matched.rule.source}`,
            })
            maybeInjectRejectGuidance(exec.agent, exec.callId, config, buildRejectGuidanceText('rule'))
            return { kind: 'deny', reason: `[dsh-auto-approval-llm] rule deny ${exec.name}` }
          } else if (matched.policy === 'human') {
            return { kind: 'ask', reason: `[dsh-auto-approval-llm] rule ask ${exec.name}` }
          } else {
            // A declared allow rule matches on the TOOL name, so it is a
            // name-based channel like the allowlist: the user decision behind
            // the hard lock is that no name-based channel pre-authorizes
            // delete/disk in either plane, and the credential-read floor rides
            // the same predicate. The category layer runs below this block, so
            // it is evaluated here for the one branch that would return first.
            const ruleLock = nameChannelLockRefusal({
              category,
              sessionArtifactDeletion: assessment?.sessionArtifactDeletion === true,
              credentialRead: assessment?.credentialRead === true,
              opaqueLocked: assessment?.opaqueLocked === true,
            })
            if (ruleLock !== undefined) {
              return { kind: 'ask', reason: `[dsh-auto-approval-llm] ${ruleLock} ${exec.name}` }
            }
            const audited = pushHistory({
              sessionId: authorityKeyFor(exec),
              toolName: exec.name,
              outcome: 'allowed-once',
              source: 'rule-allow',
              llmReason: `matched ${matched.rule.source}`,
            })
            if (!audited) {
              denyOnAuditFailure(exec.callId)
              return { kind: 'deny', reason: `[dsh-auto-approval-llm] audit failure ${exec.name}` }
            }
            return next()
          }
        }
      }
    }
    const listDecision = staticListDecision(config, exec.name)
    if (listDecision.kind === 'reject') {
      recordDecisionFeedback(exec.callId, formatDenyFeedback('denyList', { toolName: exec.name }))
      pushHistory({
        sessionId: authorityKeyFor(exec),
        toolName: exec.name,
        outcome: 'rejected',
        source: 'denyList-deny',
      })
      maybeInjectRejectGuidance(exec.agent, exec.callId, config, buildRejectGuidanceText('denyList'))
      return { kind: 'deny', reason: `[dsh-auto-approval-llm] denyList ${exec.name}` }
    }
    if (listDecision.kind === 'ask-human') {
      return { kind: 'ask', reason: `[dsh-auto-approval-llm] human-only ${exec.name}` }
    }
    // Category tightening (only deny/ask; auto/inherit never intercept here).
    // Deny/ask apply to every non-hard-denied result, including static allows,
    // so a routine read/write cannot slip past a category deny/ask. deny
    // performs the full rejection dialogue (feedback + history) itself; ask
    // returns immediately so the LLM classifier fast path can never answer a
    // category ask — a category ask is an explicit human decision. The
    // directive/category pair itself is derived above, before the declared
    // rules, because a rule-allow has to consult the same locked predicate.
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
      // The pre-execute plane is the primary terminal for a category deny (the
      // answerer's copy is defense-in-depth), so it owes the model the same
      // user-role guidance the rule/denyList denies give: the same target or
      // effect stays denied under any rewording, and the user is the way out.
      maybeInjectRejectGuidance(exec.agent, exec.callId, config, buildRejectGuidanceText('category', category))
      return { kind: 'deny', reason: `[dsh-auto-approval-llm] category deny ${exec.name}` }
    }
    if (directive === 'ask') {
      return { kind: 'ask', reason: `[dsh-auto-approval-llm] category ask ${exec.name}` }
    }
    // Explicit allowlist (mirrored onto the pre-execute plane):
    // the allowlist used to answer only in the approval/request answerer, but
    // the classifier fast path below returns next() without ever creating an
    // approval/request, so a classifier deny could override a user's explicit
    // allowlist entry. A listed tool is the operator's declared intent — let
    // it through BEFORE the LLM classifier, exactly as the answerer already
    // lets it beat human-only. Category deny/ask above still wins, and the
    // hard-locked categories (delete / disk) are exempt from the mirror
    // entirely: no name-based channel pre-authorizes them (protected /
    // privilege remain overridable — the operator's list is explicit intent).
    if (listDecision.kind === 'allow') {
      // Hard-locked categories (delete / disk) cannot be pre-authorized by a
      // name: the mirror skips them and hands an explicit ask to the
      // answerer, which pins the call to the hard-reject countdown. The one
      // exception is a deletion the shell classifier proved targets only
      // session-created paths — that provenance is not a name-based channel, so
      // it lifts the hard lock here exactly as it does in the locked predicate.
      // The same predicate also carries the credential-read floor: an allowlist
      // entry names a TOOL, not a path, so it can no more hand over key
      // material than `protectedAutoReview` can.
      const mirrorRefusal = nameChannelLockRefusal({
        category,
        sessionArtifactDeletion: assessment?.sessionArtifactDeletion === true,
        credentialRead: assessment?.credentialRead === true,
        opaqueLocked: assessment?.opaqueLocked === true,
      })
      if (mirrorRefusal !== undefined) {
        return { kind: 'ask', reason: `[dsh-auto-approval-llm] ${mirrorRefusal} ${exec.name}` }
      }
      const audited = pushHistory({
        sessionId: authorityKeyFor(exec),
        toolName: exec.name,
        outcome: 'allowed-once',
        source: 'allowlist-allow',
      })
      if (!audited) {
        denyOnAuditFailure(exec.callId)
        return { kind: 'deny', reason: `[dsh-auto-approval-llm] audit failure ${exec.name}` }
      }
      return next()
    }
    if (assessment.decision === 'allow') {
      // Loop guard: the Nth identical auto-allowed call escalates to a pinned
      // ask instead of silently dispatching again. The gate runs BEFORE the
      // allow history row — a call the guard escalated was never allowed.
      if (loopGateFires(authorityKeyFor(exec), exec.name, exec.arguments, exec.callId)) {
        return { kind: 'ask', reason: loopGuardReason(exec.name) }
      }
      // A static-assessment allow is a verdict like any other: it takes
      // effect only if its decision audit record persisted (APPROVAL-07).
      const fetchTarget = fetchAuditTarget(exec)
      const audited = pushHistory({
        sessionId: authorityKeyFor(exec),
        toolName: exec.name,
        outcome: 'allowed-once',
        source: 'static-allow',
        ...(typeof assessment.reason === 'string' && assessment.reason !== '' ? { reason: assessment.reason } : {}),
        // Mark the provenance-based allow explicitly: on a compound line the
        // reason above is the generic merged text, so the exemption would be
        // indistinguishable from a routine allow in the trail.
        ...(assessment.sessionArtifactDeletion === true ? { sessionArtifactDeletion: true } : {}),
        // A static-allowed web_fetch is the one external call whose target
        // never appears anywhere else: no approval panel, no reviewer payload.
        // Record the destination (sanitized + capped) so "what did it fetch"
        // stays answerable from the audit trail.
        ...(fetchTarget !== undefined ? { llmReason: fetchTarget } : {}),
      })
      if (!audited) {
        denyOnAuditFailure(exec.callId)
        return { kind: 'deny', reason: `[dsh-auto-approval-llm] audit failure ${exec.name}` }
      }
      return next()
    }
    if (!assessment.classifierEligible) return { kind: 'ask', reason: `[dsh-auto-approval-llm] approval required ${assessment.reason}` }
    try {
      const authority = authorityFor(exec)
      const route = resolveModelRoute(exec.agent) ?? resolveModelRoute(authority)
      const aggressiveAuto = config.categoryMode === 'aggressive' && 'auto' === directive && AGGRESSIVE_BUILTIN.includes(category as CategoryKey)
      const riskTier = riskFromAssessment(assessment, exec.name)
      const intentWindow = trustedIntentWindow(authority)
      const trustedIntents = intentWindow.admitted
      reportTrustedIntentOrigins(authorityKeyFor(exec), trustedIntents, intentWindow.overflow > 0)
      const classifierInput = {
        toolName: exec.name,
        arguments: sanitizeClassifierArguments(exec.arguments),
        workspaceRoot: roots.workspace,
        // The assessment reason embeds tool names and user-controlled paths;
        // sanitize at the classifier boundary like every other payload field
        // (RISK-04 prompt-injection surface).
        policyReason: sanitizeClassifierText(assessment.reason),
        trustedUserMessages: trustedIntents.map((intent) => intent.text),
        mode: config.categoryMode,
        aggressiveAuto: aggressiveAuto,
        riskTier: riskTier,
        ...(route === undefined ? {} : { route }),
      }
      const classifierLane = normalizeLane({
        source: config.classifierSource,
        presetProvider: config.classifierProvider,
        presetModel: config.classifierModel,
      })
      let decision: { decision: 'allow' | 'ask' | 'deny'; reason: string }
      const classifierStart = Date.now()
      try {
        if (classifierLane.source === 'endpoint') {
          // Endpoint source: synchronous raw call, endpoint config + key resolved
          // fresh per classify (never construction-frozen).
          if (!config.endpointUrl || !config.endpointModel) {
            throw new Error('endpoint source needs a URL and model for classification')
          }
          const endpointApiKey = await resolveReviewerApiKey(getCredentials())
          // Half-configuration discipline, mirroring the reviewer lane: an
          // explicitly chosen endpoint with no resolved key cannot classify
          // anything, and a request sent without one only turns the
          // misconfiguration into a silent AUTH failure the operator never
          // sees. Fail loudly here; the catch below converts it into an ask.
          if (!endpointApiKey) {
            debugLog({ ev: 'classifier-incomplete', callId: exec.callId ?? null, baseUrl: config.endpointUrl, missing: ['key'] })
            throw new Error('endpoint source needs a resolved API key for classification')
          }
          decision = await endpointClassifier.classify(classifierInput, exec.signal, {
            url: config.endpointUrl,
            model: config.endpointModel,
            protocol: config.endpointProtocol,
            apiKey: endpointApiKey,
          })
        } else {
          if (classifierLane.error) {
            throw new Error(classifierLane.error)
          }
          decision = await classifier.classify(classifierInput, exec.signal)
        }
      } catch (error) {
        // The fast-decision lane's own latency is telemetry too: a failed or
        // timed-out classification still cost wall-clock time.
        pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - classifierStart, settled: false, channel: 'classifier' })
        throw error
      }
      pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - classifierStart, settled: true, channel: 'classifier' })
      debugLog({ ev: 'classifier-decision', callId: exec.callId ?? null, toolName: exec.name, category, directive, mode: config.categoryMode, aggressiveAuto, riskTier, decision: decision.decision, reason: sanitizeReviewReason(decision.reason) })
      // This fast path answers without ever entering the `approval/request`
      // answerer, where every other pushHistory site lives — so an allow or a
      // deny is recorded here or nowhere, and the panel stayed empty for the
      // one plane where the model decides on its own. 'ask' is deliberately
      // left out: it continues into the answerer, which records the settled
      // outcome downstream (recording here too would double-count it). The
      // sources are distinct from the answerer's so the two decision planes
      // stay separable in the history.
      // Loop guard (classifier plane): the fast-path allow is exactly the
      // silent repeat the guard exists for, so it escalates BEFORE the
      // classifier-allow history row is written.
      if (decision.decision === 'allow' && loopGateFires(authorityKeyFor(exec), exec.name, exec.arguments, exec.callId)) {
        return { kind: 'ask', reason: loopGuardReason(exec.name) }
      }
      let audited = true
      if (decision.decision !== 'ask') {
        audited = pushHistory({
          sessionId: authorityKeyFor(exec),
          toolName: exec.name,
          outcome: decision.decision === 'allow' ? 'allowed-once' : 'rejected',
          source: decision.decision === 'allow' ? 'classifier-allow' : 'classifier-deny',
          category,
          mode: config.categoryMode,
          llmDecision: decision.decision,
          llmRisk: riskTier,
          llmReason: decision.reason,
          llmTookMs: Date.now() - classifierStart,
        })
      }
      if (decision.decision === 'allow') {
        if (!audited) {
          denyOnAuditFailure(exec.callId)
          return { kind: 'deny', reason: `[dsh-auto-approval-llm] audit failure ${exec.name}` }
        }
        return next()
      }
      if (decision.decision === 'deny') {
        return {
          kind: 'deny',
          reason: withWindowOverflowNote(`[dsh-auto-approval-llm] classifier deny ${decision.reason}`, intentWindow.overflow) + `\n${DENY_CIRCUMVENTION_GUIDANCE}`,
        }
      }
      return { kind: 'ask', reason: `[dsh-auto-approval-llm] classifier asks ${decision.reason}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'ask', reason: `[dsh-auto-approval-llm] classifier unavailable ${message}` }
    }
  })

  // ── tools/result observer ───────────────────────────────────────────────
  anyCtx.on('tools/result', (exec: any, result: any) => {
    if (!isAutoExecution(exec)) return
    const promoted = artifacts.settle(exec, result, rootsFor(exec))
    if (promoted.length > 0) {
      appendAuditLine(JSON.stringify({
        type: 'artifact-provenance', at: Date.now(), phase: 'promote',
        callId: exec.callId ?? null, sessionId: authorityKeyFor(exec),
        toolName: exec.name ?? null, paths: promoted,
      }))
    }
  })

  watchNotices(anyCtx, () => config, () => gateNames)
  setTrustedHosts(resolveTrustedHosts(anyCtx))
  // Route registration lives on the carrier's Fetch registry: a carrier without
  // it leaves the routes unregistered while the rest of the plugin keeps running,
  // and a carrier that mounts the registry later still gets them on arrival.
  // Every installer binds itself inside registerCarrierFetchRoute().
  // ── route installation, sweep timers ────────────────────────────────────
  installFeedbackRoute(anyCtx)
  installSettingsRoute(anyCtx, settings, plainConfigValue(rawConfig) as unknown as Record<string, unknown>, resolveRoots(process.cwd(), rootOptions).dshHome)
  installReviewerCredentialRoute(anyCtx)
  installHistoryRoute(anyCtx)
  installLatencyRoute(anyCtx)
  installToolStatsRoute(anyCtx)
  installReviewStatusRoute(anyCtx)
  installSessionReviewStatusRoute(anyCtx)
  installRevealRoute(anyCtx)
  installLearningStoreRoute(anyCtx, (key: string) =>
    // Serialize revoke + persist under the same per-key mutex the learning
    // writers use, so a concurrent recordConfirm cannot interleave.
    learningMutex.run(key, () => revokeLearning(learningStore, key)).then((done) => {
      if (done) persistLearningGuarded()
      return done
    }))
  installTestRoute(anyCtx, llm, () => config.endpointUrl)
  installLlmCatalogRoutes(anyCtx, llm)
  installSessionModeRoute(anyCtx)
  installStatsRoute(anyCtx)
  // Sweep expired follow-phase statuses so a client that never ACKs (closed
  // tab / headless page) cannot leak callId keys in reviewStates.
  const followSweep = setInterval(() => {
    sweepFollowPhase(Date.now())
  }, 1_000)
  ctx.effect(() => () => clearInterval(followSweep))
  // Keep the trusted Host authorities fresh (webRuntime service values can
  // change while a deployment stays up); the hot paths read the module-level
  // array directly, so only this assignment mutates it.
  const trustedHostRefresh = setInterval(() => {
    setTrustedHosts(resolveTrustedHosts(anyCtx))
  }, 5 * 60_000)
  ctx.effect(() => () => clearInterval(trustedHostRefresh))

  // ── tools/post-execute handler ──────────────────────────────────────────
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

  // ── session lifecycle: legacy auto migration, own-spec enforcement, baselines ──
  //
  // Migration is a raw identity rewrite (`session.append('permission/preset')`)
  // and never calls permissionPresets.set(): set() short-circuits on the
  // derived current() and would also rewrite knobs, silently widening a
  // sandbox. Idempotency is read from the durable raw identity only.
  //
  // Ordering: the `session/created` migration listener is prepended so it runs
  // before the host's pinInitialPermission; it is synchronous and never throws
  // (a throw would abort the announce loop and roll the session back). The
  // startup scan covers sessions that were already live, and `agent/created`
  // is the idempotent fallback.
  const agents = anyCtx.get('agents')
  const permissionBaselines = new Map<string, PermissionState>()
  const pluginInitiatedSessions = new Set<string>()
  const specRestoreTimers = new Set<ReturnType<typeof setTimeout>>()
  ctx.effect(() => () => {
    for (const timer of specRestoreTimers) clearTimeout(timer)
    specRestoreTimers.clear()
  })

  const markPluginInitiated = (session: any): (() => void) => {
    const id = session?.id
    if (typeof id !== 'string') return () => {}
    pluginInitiatedSessions.add(id)
    return () => { pluginInitiatedSessions.delete(id) }
  }

  // The single mutation seam. `session.append` is public host API; going
  // through one wrapper keeps the migration module free of a session import
  // and makes "append-only, never set()" greppable.
  const appendSessionEvent = (session: any, type: string, data: unknown): void => {
    if (session === undefined || session === null || typeof session.append !== 'function') {
      throw new Error('session.append is unavailable')
    }
    session.append(type, data)
  }

  const migrationDeps = {
    permissionPresets,
    capability: hostCapability.capability,
    approval,
    append: appendSessionEvent,
    audit: appendAuditLine,
    warn: (message: string) => console.warn(`[dsh-auto-approval-llm] ${message}`),
    markPluginInitiated,
    current: (session: any) => {
      try {
        return currentPreset(permissionPresets, session)
      } catch {
        return undefined
      }
    },
    now: () => Date.now(),
  }

  const rememberPermissionBaseline = (session: any) => {
    try {
      const id = session?.id
      if (typeof id !== 'string') return
      permissionBaselines.set(id, baselineFromPermissionState(permissionPresets?.permissionState?.(session)))
    } catch (error) {
      console.warn('[dsh-auto-approval-llm] permission baseline listener failed:', error)
    }
  }

  // One entry point for every lifecycle hook: migrate the legacy raw identity
  // first, then restore this plugin's own spec, and never let an exception
  // cross the announce boundary.
  const runLifecycleMigration = (session: any) => {
    if (!session) return
    try {
      runPresetMigration(session, migrationDeps)
    } catch (error) {
      try {
        appendAuditLine(migrationAuditLine({ ok: false, sessionId: session?.id ?? null, stage: 'listener', reason: error instanceof Error ? error.message : String(error) }))
      } catch { /* audit is best-effort inside the listener */ }
      console.warn('[dsh-auto-approval-llm] preset migration listener failed:', error)
    }
    try {
      enforceOwnSpec(session, migrationDeps)
    } catch (error) {
      console.warn('[dsh-auto-approval-llm] preset spec enforcement failed:', error)
    }
  }

  // Prepend: run before the host pinInitialPermission writes the pinned state.
  anyCtx.on('session/created', (session: any) => runLifecycleMigration(session), { prepend: true, global: true })
  // Fallback for a session whose `session/created` fired before this plugin
  // loaded; raw-identity idempotency makes a second run a no-op.
  anyCtx.on('agent/created', (payload: any) => runLifecycleMigration(payload?.agent?.session))
  // The baseline listener stays a push listener: it folds the host's pinned
  // baseline, which is written by the pin callback that runs after our
  // prepended migration.
  anyCtx.on('session/created', (session: any) => {
    try {
      rememberPermissionBaseline(session)
    } catch (error) {
      console.warn('[dsh-auto-approval-llm] permission baseline listener failed:', error)
    }
  })
  anyCtx.on('session/event', (session: any, event: any) => {
    // Observation only: a permission-plane move leaves one durable line with
    // pointers to the latest rejections, so a switch made right after a block
    // can be read together with what was blocked. It never feeds a verdict, a
    // review prompt, or the statistics.
    const change = permissionChangeFromEvent(event)
    if (change !== undefined) {
      const id = typeof session?.id === 'string' ? session.id : undefined
      const observed = observePermissionChange(
        id === undefined ? undefined : permissionBaselines.get(id),
        change,
        { pluginInitiated: id !== undefined && pluginInitiatedSessions.has(id) },
      )
      if (id !== undefined) permissionBaselines.set(id, observed.baseline)
      if (observed.record) {
        appendAuditLine(
          JSON.stringify({
            type: 'permission-change',
            at: Date.now(),
            sessionId: session?.id ?? null,
            scope: change.scope,
            to: change.to,
            actor: 'user',
            recentRejectedIds: recentRejectionPointers(approvalHistory, RECENT_REJECTION_CAP),
          }),
        )
      }
    }
    // Own-spec enforcement, deferred one tick: the host is publishing this
    // `approval/policy` event and a same-tick append would hit the session
    // re-entrancy guard. The callback re-reads the raw state, so a session that
    // moved preset meanwhile is skipped instead of rewritten.
    if (event?.type === 'approval/policy' && event.data?.policy === 'never') {
      const timer = setTimeout(() => {
        specRestoreTimers.delete(timer)
        try {
          enforceOwnSpec(session, migrationDeps)
        } catch (error) {
          console.warn('[dsh-auto-approval-llm] deferred spec enforcement failed:', error)
        }
      }, 0)
      specRestoreTimers.add(timer)
    }
  })

  // Baseline sweep for sessions that were already live when the plugin loaded.
  if (agents && typeof agents.list === 'function') {
    for (const agent of agents.list()) rememberPermissionBaseline(agent?.session)
  }

  // Startup scan of live sessions: migrate the legacy signature, restore the
  // own spec, and leave one auditable count line. `sessions.list()` only holds
  // live sessions, so no non-live append can masquerade as a success.
  const sessionsService = anyCtx.get('sessions')
  if (sessionsService && typeof sessionsService.list === 'function') {
    const counts: MigrationScanCounts = { candidates: 0, foreign: 0, never: 0, unknown: 0 }
    for (const session of sessionsService.list()) {
      const classification = classifyForMigration(rawStateOf(permissionPresets, session), approval)
      if (classification === 'candidate') counts.candidates += 1
      else if (classification === 'never') counts.never += 1
      else if (classification === 'unknown') counts.unknown += 1
      else counts.foreign += 1
      runLifecycleMigration(session)
      rememberPermissionBaseline(session)
    }
    try {
      appendAuditLine(scanAuditLine(counts))
    } catch (error) {
      console.warn('[dsh-auto-approval-llm] preset migration scan audit failed:', error)
    }
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
  // Recent-denial log shown on the breaker-tripped panel. Capped by its own
  // constant, NOT by maxConsecutiveDenials: with the consecutive breaker set
  // to 0 (disabled) a shared cap would shift every entry out immediately and
  // a panel tripped via maxTotalDenials would render with no reasons at all.
  const DENIAL_LOG_CAP = 10
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
    permissionBaselines.delete(key)
    pluginInitiatedSessions.delete(key)
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
      // The one-shot greeting marker is keyed by the same id; drop it so a
      // long-lived process never grows the Set with disposed sessions.
      firstAutoNoticeSeen.delete(key)
      // The trusted-intent signature is keyed by the same authority id and had
      // no other owner: without this it kept one entry per Auto session that
      // ever reached the classifier, for the process lifetime.
      trustedIntentReported.delete(key)
      // Loop-guard streaks are keyed by the same authority id; drop them with
      // the other per-session state so a disposed session cannot leak its
      // streak into a long-lived process.
      loopStates.delete(key)
      // rejectGuidanceSeen keys are `${sessionId}:${callId}`; drop every key
      // of a disposed session wholesale (same L1 discipline — the Set is
      // additionally capped by insert-order FIFO in maybeInjectRejectGuidance).
      const prefix = `${key}:`
      for (const seenKey of rejectGuidanceSeen) {
        if (seenKey.startsWith(prefix)) rejectGuidanceSeen.delete(seenKey)
      }
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

  // `auditCategory` is a record-only label for asks that deliberately carry no
  // `status` (a status would give them a countdown and automatic resolution,
  // which is a different behaviour). It never influences the verdict.
  // ── askHuman ────────────────────────────────────────────────────────────
  const askHuman = async (req: any, review: ReviewResult | undefined, next: () => Promise<any>, breaker = false, status?: ReviewStatus, handle?: RaceHumanHandle, llmDecided?: boolean, learnable?: LearnableContext, auditCategory?: string): Promise<any> => {
    // Delegate to the official ApprovalPanel; the client half parses the
    // countdown marker and adds the visible countdown + auto-answer. Breaker
    // requests intentionally omit the marker so no automatic timeout runs.
    if (status && req.callId !== undefined) {
      // Single choke point: every countdown ask reaches the panel through this
      // call, so the revision and the deadline are attached exactly once and
      // stay consistent with what the client will be told.
      if (status.phase === 'countdown' && status.revision === undefined) {
        status.revision = ++reviewRevisionSeq
        status.expiresAt = Date.now() + Math.max(0, status.seconds) * 1000
      }
      reviewStates.set(req.callId, status)
      const sessionId = (req.agent as any)?.session?.id
      if (typeof sessionId === 'string' && sessionId) reviewSessions.set(req.callId, sessionId)
    }
    const notes: string[] = []
    let breakerReasons: string[] | undefined
    if (review) {
      // The reviewer's reason is model-authored text that this host relays to the
      // panel, so it gets the same marker fence a model-controlled base reason
      // does: a reason spelling a protocol marker must not be able to claim the
      // locked, status-less or breaker state the host never set.
      notes.push(stripCountdownMarkers(reviewSuggestionNote(review)))
    }
    if (breaker) {
      const key = authorityKeyFor({ agent: req.agent })
      const log = denialLog.get(key) ?? []
      breakerReasons = log.map((d, i) => `${i + 1}. ${stripCountdownMarkers(`${d.toolName}${d.reason ? ` — ${d.reason}` : ''}`)}`)
      const reasons = breakerReasons.join('\n')
      const concur = denials.get(key) ?? 0
      const total = totalDenials.get(key) ?? 0
      const byConsecutive = config.maxConsecutiveDenials > 0 && concur >= config.maxConsecutiveDenials
      const limitText = byConsecutive
        ? `rejected ${config.maxConsecutiveDenials} times in a row`
        : `rejected ${config.maxTotalDenials} times in total`
      notes.push(breakerNote(limitText, reasons))
    } else if (status?.lockedAsk === true) {
      // A locked ask is a countdown like any other — except that nothing but a
      // click can release it, so it MUST carry a sentence of its own. Users read
      // the countdown as "waiting for the reviewer / for me to answer", and the
      // authorization they typed in the conversation has no effect on this
      // category; the marker says so without repeating a number (the number
      // lives on the session chip and would go stale in the panel body).
      notes.push(LOCKED_ASK_MARKER)
    } else if (!status) {
      // Status-less asks (category ask / manual / human-only / breaker-free
      // rules fallbacks) carry the machine marker: the client renders its
      // localized sentence. Other countdown asks carry no prose at all — the
      // number lives on the session chip, and a static "in Ns" line in the panel
      // body would contradict it a second later.
      notes.push(AWAITING_MARKER)
    }
    const extra = notes.map((n) => `\n\n${n}`).join('')
    // Strip any client-parseable auto-answer markers from the model-controlled
    // base reason first: only the notes this host appends below may arm the
    // browser watcher's countdown.
    req.reason = buildAskReason(req.reason, extra)
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
    // Panel hold for this ask: undefined when the ask has no countdown or the
    // hold is disabled, so status-less asks still reach the panel at once.
    let panelGate: PanelGate | undefined
    const t0 = Date.now()
    const canTimeout = status !== undefined && req.callId !== undefined &&
      status.phase === 'countdown' && status.seconds > 0
    try {
      if (canTimeout && status !== undefined) {
        // Host-authoritative countdown: the official panel still receives the
        // request via next(), but an automatic outcome is produced here so a
        // closed tab / headless session can never hang an approval forever.
        panelGate = createPanelGate(req.callId, config.panelDelayMs ?? 0)
        const delegate = () => {
          if (!panelGate) return next()
          const gate = panelGate
          return gate.wait().then(() => (gate.isCancelled() ? undefined : next()))
        }
        const raced = await raceHumanDecision(delegate, {
          // A locked-category status is pinned to reject; tell the racer so its
          // timeout notice can name the lock instead of the configured action.
          status: { seconds: status.seconds, action: status.action, ...(status.lockedAsk === true ? { lockedAsk: true } : {}) },
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
      // The success path below (resolvedCallIds/verdict cleanup, history, breaker)
      // is skipped by the propagating exception, so perform the essential
      // per-callId cleanup here to keep the maps bounded, mark the ask
      // host-resolved so a late FEEDBACK ACK cannot relabel it, and drop any
      // stored verdict marker. Then rethrow so the approval chain observes the
      // failure (fail-closed: never a fabricated resolution).
      aborted = true
      if (req.callId !== undefined) {
        resolvedCallIds.set(req.callId, Date.now())
        reviewVerdicts.delete(req.callId)
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
        // The ask is settled, so a held-back panel must never appear: releasing
        // the gate without opening cancels the pending forward.
        panelGate?.cancel()
        const current = reviewStates.get(req.callId)
        const resolution = followResolution(
          current?.phase,
          { risk: status.risk, outcome, ...(status.lockedAsk === true ? { lockedAsk: true } : {}) },
          { timedOut, aborted },
        )
        if (resolution.kind === 'publish') {
          reviewStates.set(req.callId, resolution.follow)
        }
        followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
      }
    }
    // Mark the ask as host-resolved so a late client ACK (FEEDBACK POST) cannot
    // relabel it with the timeout notice. Covers status-less asks too: their
    // client-side countdown answer is also a resolution the host has already
    // finished by the time the ACK lands.
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
    // A claim that settled with a reviewer failure (ESCALATE + failure) is an
    // honest 'llm-failed' resolution: fail-closed, never an LLM denial streak.
    const followFailed = follow !== undefined && follow.decision === 'ESCALATE' && follow.failure !== undefined
    // A claim that settled because the reviewer's ALLOW was CRITICAL-flagged
    // and the auto-allow guard refused it is its own resolution kind: the
    // reviewer said ALLOW but the policy refused it — labeled 'llm-blocked',
    // distinct from a reviewer failure and from a decided 'llm-allow'.
    const followBlocked = follow !== undefined && reviewerAutoAllowBlocked(follow)
    const llmMeta = follow && follow.decision
      ? {
          llmDecision: follow.decision,
          llmRisk: follow.riskLevel,
          llmReason: follow.failure !== undefined && follow.reason === undefined ? follow.failure : follow.reason,
          ...(Array.isArray(follow.attempts) && follow.attempts.length > 0 ? { attempts: follow.attempts } : {}),
        }
      : {}
    // Honest provenance: only a genuine LLM takeover (the caller's claim
    // settled the race) may label the resolution `llm-*`. An advisory review
    // verdict may still exist (followDecidable), but a human/timeout/auto
    // resolution is NOT an LLM decision, and the breaker must not count it.
    const autoAnswer = req.callId !== undefined && autoAnsweredCallIds.has(req.callId)
    if (req.callId !== undefined) autoAnsweredCallIds.delete(req.callId)
    const source = approvalSource({
      outcome,
      timedOut,
      claimed,
      auto: autoAnswer,
      reviewerDecision: followDecidable ? follow.decision : undefined,
      ...(followFailed ? { reviewerFailure: true } : {}),
      ...(followBlocked ? { reviewerBlockedAllow: true } : {}),
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
        if (log.length > DENIAL_LOG_CAP) log.shift()
        denialLog.set(key, log)
      }
    })
    if (debugOn) console.log('[dsh-auto-approval-llm][debug] approval resolved', {
      callId: req.callId ?? null,
      outcome,
      timedOut,
      source,
      seconds: status?.seconds ?? null,
      elapsedMs: Date.now() - t0,
      llmDecision: (follow as any)?.decision ?? null,
      breaker: breaker === true,
    })
    const requestAt = requestAtByKey.get(key) ?? null
    debugLog({ ev: 'resolve', callId: req.callId ?? null, outcome, timedOut, source, seconds: status?.seconds ?? null, elapsedMs: Date.now() - t0, requestAt, requestToResolveMs: requestAt !== null ? Date.now() - requestAt : null, llmDecision: (follow as any)?.decision ?? null })
    const llmTookMs = typeof source === 'string' && source.startsWith('llm') && requestAt !== null
      ? Date.now() - requestAt
      : undefined
    const audited = pushHistory({
      sessionId: key,
      toolName: req.toolName,
      outcome,
      source,
      ...llmMeta,
      ...(llmTookMs !== undefined ? { llmTookMs } : {}),
      ...(breaker ? { breaker: true, breakerReasons } : {}),
      ...(status?.category !== undefined
        ? { category: status.category }
        : auditCategory !== undefined ? { category: auditCategory } : {}),
    })
    if (!audited) {
      // Fail closed (APPROVAL-07): no unaudited allow may take effect. The
      // learning bookkeeping below is skipped — an unaudited verdict must
      // never train the confirmation layer — but the verdict map is still
      // cleaned so a retry cannot reuse a claim from a dropped decision.
      denyOnAuditFailure(req.callId)
      if (req.callId !== undefined) {
        reviewVerdicts.delete(req.callId)
      }
      return 'rejected'
    }
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
            persistLearningGuarded()
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
    },
  ): Promise<'allowed-once' | undefined> => {
    try {
      if (!config.learningEnabled) return undefined
      const capUsed = sessionLearnedAllows.get(sessionKey) ?? 0
      const capMax = THRESHOLD_DEFAULTS.learningSessionAllowCap
      const routeAvailable = reviewerRouteAvailable(config, req.agent.session)
      if (!routeAvailable) return undefined
      const learnable = learnableContextFor(req, args, classified, 'learn-attempt-query')
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
      const { review, attempts } = await reviewWithLLM(getCredentials(), llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: false,
      })
      pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - start, settled: review.failure === undefined, attempts: Math.max(1, attempts.length), channel: 'reviewer' })
      debugLog({ ev: 'learned-review', callId: req.callId ?? null, decision: review.decision, risk: review.riskLevel ?? null, tookMs: Date.now() - start })
      // Anything but a clean ALLOW (DENY / ESCALATE / failure / CRITICAL-flagged
      // contradiction) is treated as a miss and slides back into the ordinary
      // risk branch below — fail-closed in exactly one direction.
      if (review.decision !== 'ALLOW' || reviewerAutoAllowBlocked(review as any)) return undefined
      // Atomic learned-allow increment under the same keyed mutex as the
      // breaker counters and session/disposed deletion: the count is re-read
      // inside the critical section, so two concurrent learned allows for one
      // session each land their increment — the per-session cap cannot be
      // diluted by parallel subagents. The LLM review stayed outside the lock
      // (only synchronous map ops may run under it). The gate above still
      // reads a pre-review snapshot: that is the soft-brake check-then-act,
      // and an exact count with a momentary overshoot is honest.
      const used = await breakerMutex.run(sessionKey, () => {
        const next = (sessionLearnedAllows.get(sessionKey) ?? 0) + 1
        sessionLearnedAllows.set(sessionKey, next)
        return next
      })
      if (used === capMax) {
        appendAuditLine(JSON.stringify({ type: 'learning-cap-reached', at: Date.now(), sessionId: sessionKey, allows: used }))
        debugLog({ ev: 'learn-cap', sessionId: sessionKey, allows: used })
      }
      if (config.notifyUser && req.callId !== undefined) {
        queueNotice(req.agent, req.callId, `✅ Learned allow for "${req.toolName}" (still passes one online review)`)
      }
      const audited = pushHistory({
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
      if (!audited) {
        // Fail closed: no unaudited learned allow may take effect. Fall
        // through to the ordinary pipeline (same as a learning miss) — the
        // eventual verdict carries its own audit gate below.
        denyOnAuditFailure(req.callId)
        return undefined
      }
      return 'allowed-once'
    } catch (error) {
      debugLog({ ev: 'learn-error', callId: req.callId ?? null, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  // ── approval/request terminal answerer ──────────────────────────────────
  anyCtx.on('approval/request', async (req: any, next: () => Promise<any>) => {
    if (!config.enabled) return next()
    if (!permissionPresets) return next()
    // Preset gate walks the authority parent chain so subagent asks inherit
    // Auto (mirrors tools/pre-execute) instead of falling through to the
    // official panel without review or breaker.
    const authority = authorityFor({ agent: req.agent, signal: req.signal })
    const rawPreset = rawPresetOf(permissionPresets, authority?.session ?? req.agent.session)
    if (rawPreset === undefined || !gateNames.includes(rawPreset)) return next()
    const sessionKey = authorityKeyFor({ agent: req.agent })
    requestAtByKey.set(sessionKey, Date.now())
    debugLog({ ev: 'request', callId: req.callId ?? null, toolName: req.toolName, sessionKey })
    const reviewOpts = {
      userMessages: trustedUserMessages(authority),
      workspaceRoot: rootsFor({ agent: req.agent }).workspace,
      home: rootsFor({ agent: req.agent }).home,
    }

    const toolName = req.toolName
    const args = findToolCallArguments(req.agent.session, req.callId, config.maxArgsChars)
    // Category layer (Q2 order: denyList → category-deny → hard-locked gate →
    // allowlist → humanOnly → category-ask → manual → breaker → risk
    // application). Recomputed here from scratch (same pure function as
    // pre-execute, no state crosses between the wiring points) and BEFORE the
    // declared rules: a rule-allow is a name-based channel, so it must be able
    // to ask the locked/credential floor the same question the allowlist path
    // asks. The auto→LOW injection already happened inside classifyStaticRisk.
    const classified = classifyStaticRisk(req, args)

    // Policy hard-deny is a code-enforced terminal, so it answers before any
    // declared rule on this plane too. Pre-execute already orders it that way;
    // here a `reason`-dimension allow rule (invisible to pre-execute, which
    // never sees the approval reason) could otherwise turn the deny into an
    // allowed-once when the primary plane did not settle the call. Never a
    // countdown status: timeoutAction=allow and LLM takeovers must not be able
    // to answer an effect that is permanently forbidden.
    if (classified.risk === 'DENY') {
      recordDecisionFeedback(req.callId, formatDenyFeedback('policy', { toolName, reason: classified.reason }))
      pushHistory({
        sessionId: sessionKey,
        toolName,
        outcome: 'rejected',
        source: 'policy-deny',
        llmReason: undefined,
      })
      return 'rejected'
    }

    // B1 declared rules (Claude-style Tool(pattern)) — evaluated first so a
    // user-defined policy takes precedence over the built-in lists.
    if (config.rulesText.trim() !== '') {
      const declared = parseRulesText(config.rulesText)
      if (declared.errors.length > 0) {
        reportRulesParseErrors('answerer', declared.errors)
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
            maybeInjectRejectGuidance(req.agent, req.callId, config, buildRejectGuidanceText('rule'))
            return 'rejected'
          } else if (matched.policy === 'allow') {
            // A declared allow rule matches on the TOOL name, so it is a
            // name-based channel like the allowlist: the user decision behind
            // the hard lock is that no name-based channel pre-authorizes
            // delete/disk in either plane, and the credential-read floor rides
            // the same predicate. Refused targets fall to the locked
            // hard-reject countdown below instead of settling here.
            const ruleLock = nameChannelLockRefusal({
              category: classified.category,
              sessionArtifactDeletion: classified.assessment?.sessionArtifactDeletion === true,
              credentialRead: classified.assessment?.credentialRead === true,
              opaqueLocked: classified.assessment?.opaqueLocked === true,
            })
            if (ruleLock !== undefined) {
              const lockedStatus: ReviewStatus = {
                risk: 'HIGH',
                phase: 'countdown',
                action: 'reject',
                seconds: Math.max(1, Math.round(config.highRiskSeconds)),
                category: classified.category,
                lockedAsk: true,
              }
              return askHuman(req, undefined, next, false, lockedStatus)
            }
            // Declared-rule allow is an approval decision too: keep it in the
            // durable history/audit trail (same as rule-deny), no user notice.
            const audited = pushHistory({
              sessionId: sessionKey,
              toolName,
              outcome: 'allowed-once',
              source: 'rule-allow',
              llmReason: `matched ${matched.rule.source}`,
            })
            if (!audited) {
              denyOnAuditFailure(req.callId)
              return 'rejected'
            }
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

    // ── direct-human-approval channel (dsa_request_user) ─────────────────
    // The agent asks that a FOLLOW-UP operation be judged by a human instead
    // of the LLM classifier. The channel only serves operations that are
    // safe-by-policy but plausibly misjudged as unauthorized (the classifier
    // is exactly the layer being bypassed), so a target that the static
    // policy grades HIGH / DENY / LOCKED is refused here and must take the
    // ordinary pipeline instead. A qualified target goes straight to a
    // status-less human ask whose learnable is built from the TARGET's
    // signature — a granted approval therefore trains the confirmation layer
    // for the target operation, not for this request tool itself.
    if (toolName === DIRECT_HUMAN_TOOL && config.directHumanEnabled === true) {
      let targetTool: string | undefined
      let targetArgs: unknown
      let targetArgsText: string | undefined
      if (typeof args === 'string') {
        try {
          const parsed = JSON.parse(args)
          targetTool = typeof parsed?.toolName === 'string' ? parsed.toolName : undefined
          targetArgs = parsed?.args
          targetArgsText = typeof parsed?.args === 'string' ? parsed.args : undefined
        } catch {
          targetTool = undefined
        }
      } else if (args && typeof args === 'object') {
        const rec = args as Record<string, unknown>
        targetTool = typeof rec.toolName === 'string' ? rec.toolName : undefined
        targetArgs = rec.args
        targetArgsText = typeof rec.args === 'string' ? rec.args : undefined
      }
      if (targetTool === undefined || targetTool === '' || targetTool === DIRECT_HUMAN_TOOL) {
        recordDecisionFeedback(req.callId, '[dsh-auto-approval-llm] direct human request missing a valid target toolName')
        pushHistory({
          sessionId: sessionKey,
          toolName,
          outcome: 'rejected',
          source: 'direct-human-rejected',
          llmReason: 'missing or invalid target toolName',
        })
        return 'rejected'
      }
      // Grade the target through the same static pipeline so the channel can
      // never smuggle a HIGH / DENY / LOCKED operation past the ordinary
      // risk controls into a human-only shortcut.
      const targetReq = { ...req, toolName: targetTool }
      // Normalize an absent target-args payload to an empty object: a
      // tool-name-level confirmation (no args) still gets a stable coarse
      // signature (e.g. `memory_update()`), because signatureFor returns
      // undefined for an undefined args payload and the confirmation would
      // silently never be recorded. Empty-object args also keep the static
      // risk grade honest.
      const targetArgsPayload = targetArgs ?? targetArgsText ?? {}
      const targetClassified = classifyStaticRisk(targetReq, targetArgsPayload)
      const targetRisk = targetClassified.risk
      const targetCategory = targetClassified.category
      // The channel serves only operations the static policy leaves to the
      // ordinary pipeline. A target the policy grades DENY carries that verdict
      // in `directive` (a deny directive is what `applyCategoryDirective` turns
      // into the terminal DENY), and a LOCKED category is what the answerer
      // would have handed to a human with no auto-answer path at all. Both were
      // read as "low/medium risk" and let through: a `{risk:'LOW', directive:
      // 'deny'}` target skipped the refusal clause, and a locked target
      // (delete/protected/privilege/disk) was never consulted, so an explicitly
      // denied or locked operation could train the confirmation layer through
      // this shortcut. The predicate is one place, and it is contract-tested.
      const targetLocked = isLockedCategory(
        targetCategory,
        targetClassified.assessment?.sessionArtifactDeletion === true,
        targetClassified.assessment?.credentialRead === true,
        targetClassified.assessment?.opaqueLocked === true,
      )
      const refusal = directHumanTargetRefusal({
        risk: targetRisk,
        directive: targetClassified.directive,
        lockedCategory: targetLocked,
      })
      if (refusal !== undefined) {
        recordDecisionFeedback(req.callId, `[dsh-auto-approval-llm] direct human request target "${targetTool}" cannot use this channel (${refusal}); it takes the ordinary approval pipeline`)
        pushHistory({
          sessionId: sessionKey,
          toolName,
          outcome: 'rejected',
          source: 'direct-human-refused',
          llmReason: `target ${targetTool} graded ${targetRisk ?? 'UNKNOWN'}${targetLocked ? ' locked' : ''}`,
          category: targetCategory,
        })
        return 'rejected'
      }
      // Build the target learnable (may be undefined when learning is off or
      // the target is non-learnable — the human ask still happens either way).
      // The learnable is NOT handed to askHuman (that would add another
      // learnable-construction site beyond the ones the LP3 contract pins);
      // instead the resolution below records the confirmation explicitly when
      // the human grants it.
      const targetLearnable = learnableContextFor(targetReq, targetArgsPayload, {
        risk: targetRisk,
        category: targetCategory,
      }, 'direct-human-target')
      debugLog({ ev: 'direct-human', callId: req.callId ?? null, toolName, targetTool, targetRisk: targetRisk ?? null, learnable: targetLearnable !== undefined })
      // Status-less explicit human ask: no countdown, no LLM takeover, no
      // breaker interaction. The answer resolves as allowed-once (grant) or
      // rejected (denial); the target learnable is recorded/reset below.
      const directOutcome = await askHuman(req, undefined, next, false, undefined, undefined, false, undefined)
      if (targetLearnable !== undefined) {
        try {
          await learningMutex.run(targetLearnable.key, () => {
            if (directOutcome === 'allowed-once') {
              recordConfirm(learningStore, targetLearnable.key, { workspace: targetLearnable.workspace, kind: targetLearnable.kind, skeleton: targetLearnable.skeleton }, Date.now())
            } else {
              resetConfirmation(learningStore, targetLearnable.key, Date.now())
            }
            persistLearningGuarded()
          })
          debugLog({ ev: 'learn-record', callId: req.callId ?? null, source: 'direct-human', action: directOutcome === 'allowed-once' ? 'increment' : 'reset' })
        } catch (error) {
          debugLog({ ev: 'learn-record-error', callId: req.callId ?? null, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return directOutcome
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
      maybeInjectRejectGuidance(req.agent, req.callId, config, buildRejectGuidanceText('denyList'))
      return 'rejected'
    }
    // Category layer results were computed above, before the declared rules.
    const staticRisk = classified.risk
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
      maybeInjectRejectGuidance(req.agent, req.callId, config, buildRejectGuidanceText('category', classified.category))
      return 'rejected'
    }
    // Loop guard cross-plane pin (one-shot): a pre-execute allow site escalated
    // this exact callId to the guard, so the ask must settle into the locked
    // countdown shape — reject-pinned action, no takeover handle, no learnable
    // context — instead of the static-allow answerer branch below. Read here,
    // after the deny terminals (they must keep winning) and before the static
    // allow that would otherwise swallow the call.
    const loopPinned = req.callId !== undefined ? loopGuardPinned.get(req.callId) : undefined
    if (loopPinned !== undefined) {
      loopGuardPinned.delete(req.callId)
      return loopGuardAsk(req, next, sessionKey, classified.category)
    }
    if (staticDecision.kind === 'allow'
      && nameChannelLockRefusal({
        category: classified.category,
        sessionArtifactDeletion: classified.assessment?.sessionArtifactDeletion === true,
        credentialRead: classified.assessment?.credentialRead === true,
        opaqueLocked: classified.assessment?.opaqueLocked === true,
      }) !== undefined) {
      // Hard-locked categories (delete / disk) cannot be pre-authorized by a
      // name — the allowlist does not beat them in either plane. The call
      // falls to the same hard-reject countdown as the locked ask branch
      // below: pinned to reject, no LLM takeover, no learning,
      // highRiskSeconds to respond. The credential-read floor rides the same
      // predicate, so a name-based allow never releases key material.
      const lockedStatus: ReviewStatus = {
        risk: 'HIGH',
        phase: 'countdown',
        action: 'reject',
        seconds: Math.max(1, Math.round(config.highRiskSeconds)),
        category: classified.category,
        lockedAsk: true,
      }
      return askHuman(req, undefined, next, false, lockedStatus)
    }
    if (staticDecision.kind === 'allow') {
      // Loop guard (answerer plane): calls can reach this branch without
      // passing the pre-execute allow gate (the two planes use different
      // authority predicates), so the streak counts here too.
      if (loopGateFires(sessionKey, toolName, args, req.callId)) {
        return loopGuardAsk(req, next, sessionKey, classified.category)
      }
      // Static-policy allow: the approval trail must not be silent about a
      // decision that permitted a tool call.
      const audited = pushHistory({
        sessionId: sessionKey,
        toolName,
        outcome: 'allowed-once',
        source: staticDecision.source,
      })
      if (!audited) {
        denyOnAuditFailure(req.callId)
        return 'rejected'
      }
      return 'allowed-once'
    }
    if (staticDecision.kind === 'ask-human') {
      return askHuman(req, undefined, next)
    }
    if (classified.directive === 'ask') {
      // LOCKED category ask (delete / protected / disk, plus privilege when
      // privilegeAutoReview is off) still requires a human look, but it
      // carries a hard-reject countdown: the action is pinned to 'reject'
      // regardless of timeoutAction (never auto-allow), no LLM takeover
      // handle is wired, and no learnable context is passed — after
      // highRiskSeconds with no response the ask settles as timeout-deny so
      // unattended sessions cannot hang forever on a dangerous command.
      if (isLockedCategory(classified.category, classified.assessment?.sessionArtifactDeletion === true, classified.assessment?.credentialRead === true, classified.assessment?.opaqueLocked === true)) {
        const lockedStatus: ReviewStatus = {
          risk: 'HIGH',
          phase: 'countdown',
          action: 'reject',
          seconds: Math.max(1, Math.round(config.highRiskSeconds)),
          category: classified.category,
          lockedAsk: true,
        }
        return askHuman(req, undefined, next, false, lockedStatus)
      }
      // Other category asks remain status-less (explicit human decision). The
      // category still travels, for the record only: without it the refusals of
      // exactly the class this unlock exposes (unlocked protected metadata) stay
      // ungroupable in the audit trail, which is the gap this batch exists to
      // close. It is passed as an audit label, NOT as a status, so the ask keeps
      // its status-less "explicit human decision" semantics (no countdown, no
      // automatic resolution) — changing that would be a behaviour change.
      return askHuman(req, undefined, next, false, undefined, undefined, undefined, undefined, classified.category)
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

    // Confirmation-learning query layer — the only wiring slot where a learned
    // allow may ever return: every preceding hard terminal (declared rules,
    // deny list, category deny, static allows/asks, manual mode, breaker trip,
    // and the policy hard-deny at the top of this handler) has already answered by the
    // time this line runs, so a stored confirmation can structurally never
    // touch a hard-denied call. A miss, a failed verification, or any error
    // falls through to the ordinary LOW/MEDIUM/HIGH pipeline unchanged.
    const learnedAllow = await learnAttempt(req, args, classified, sessionKey, reviewOpts)
    if (learnedAllow !== undefined) return learnedAllow
    const llmRouteAvailable = reviewerRouteAvailable(config, req.agent.session)
    const llmReviews = llmRouteAvailable && riskReviewed(staticRisk, config.llmReviewScope)
    const llmTakeover = llmReviews && riskTakenOver(staticRisk, config.llmTakeoverScope)
    const seconds = riskSeconds(staticRisk)

    if (staticRisk === 'LOW') {
      if (!llmReviews) {
        // Two LOW shapes reach this branch without a reviewer, and only one
        // of them may auto-allow (user decision):
        // - a NATIVE allow assessment (decision:'allow'; those are always
        //   classifierEligible:false) is the documented low-risk channel the
        //   relaxed/strict presets and the onboarding text promise;
        // - a COMPRESSED LOW is the only way an 'ask' assessment can sit at
        //   LOW here (applyCategoryDirective compresses ask+eligible to LOW
        //   under an auto directive). Pre-execute failed closed — the
        //   classifier was unavailable or the category wanted a look — and
        //   letting that silently allow would invert the fail-closed ask
        //   whenever review is absent (route missing or scope excludes LOW).
        //   It goes back to a human countdown with the LOW timeout action
        //   instead. Learning still short-circuits above for confirmed
        //   signatures, so the learned-allow channel is unchanged.
        const compressed = classified.assessment?.decision === 'ask'
        if (!compressed) {
          // Loop guard (answerer plane): the no-review auto-allow is the
          // quietest repeat lane of all — gate it before its history row.
          if (loopGateFires(sessionKey, toolName, args, req.callId)) {
            return loopGuardAsk(req, next, sessionKey, classified.category)
          }
          const audited = pushHistory({
            sessionId: sessionKey,
            toolName,
            outcome: 'allowed-once',
            source: 'auto-allow',
          })
          if (!audited) {
            denyOnAuditFailure(req.callId)
            return 'rejected'
          }
          return 'allowed-once'
        }
        const fallback = riskTimedOutAction('LOW', config.timeoutAction, autoUnattended)
        const status: ReviewStatus = {
          risk: staticRisk,
          phase: 'countdown',
          action: fallback,
          seconds,
          ...(fallback === 'reject' ? { feedback: REVIEW_TIMEOUT_NOTICE } : {}),
          category: classified.category,
        }
        return askHuman(req, undefined, next, false, status, undefined, undefined, learnableContextFor(req, args, classified, 'low-countdown'))
      }
      const lowHandle: RaceHumanHandle = { claim: () => {} }
      const lowStatus: ReviewStatus = {
        risk: staticRisk,
        phase: 'countdown',
        action: riskTimedOutAction('LOW', config.timeoutAction, autoUnattended),
        seconds,
        category: classified.category,
      }
      // LOW runs the human countdown in PARALLEL with the reviewer: while the
      // panel is open the LLM keeps trying (retries stay budget-bound), and a
      // decisive ALLOW/DENY that lands inside the window takes over the race —
      // a slow-but-healthy official review (DeepSeek 2.9-4.9s) still decides
      // instead of silently escalating into the timeout action. A reviewer
      // failure still fails closed immediately (never auto-allows, never
      // waits for the countdown to allow via timeoutAction=allow).
      const lowAskPromise = askHuman(req, undefined, next, false, lowStatus, lowHandle, true, learnableContextFor(req, args, classified, 'low-llm-countdown'))
      const lowReviewStart = Date.now()
      void reviewWithLLM(getCredentials(), llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: false,
      })
        .then(async ({ review, attempts }) => {
          debugLog({ ev: 'review', callId: req.callId, decision: review.decision, risk: review.riskLevel ?? null, startAt: lowReviewStart, tookMs: Date.now() - lowReviewStart, scope: 'low', attempts: attempts.length })
          // Latency telemetry is sampled for every attempt, settled or not;
          // only `failure` marks an aborted call (timeout/network/parse).
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - lowReviewStart, settled: review.failure === undefined, attempts: Math.max(1, attempts.length), channel: 'reviewer' })
          // Late response that already lost the countdown race is discarded.
          if (!req.callId || reviewStates.get(req.callId)?.phase !== 'countdown') return
          const verdict = lowRiskReviewOutcome(review)
          if (verdict.kind === 'allow') {
            // Single-source accounting: history and the denial breaker are
            // updated exactly once in askHuman's continuation (the claim
            // resolves it) — counting here as well would double-record. The
            // breaker is also never reset by an LLM allow: only a human
            // decision resets it (LOW/MEDIUM parity).
            reviewVerdicts.set(req.callId, { ...review, attempts })
            if (config.notifyUser) queueNotice(req.agent, req.callId, `✅ Model approved "${toolName}"`)
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
              // Decisive LLM denial: register the verdict and claim the race.
              // The breaker increment and the history record land exactly once
              // in askHuman's continuation — incrementing here in addition
              // would double-count the denial. LOW/MEDIUM now share the same
              // accounting path.
              reviewVerdicts.set(req.callId, { ...review, attempts })
              recordDecisionFeedback(req.callId, formatDenyFeedback('llm', { toolName, reason: review.reason }))
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
              // auto-allow and never count toward the LLM-denial breaker. The
              // verdict (ESCALATE + failure) is registered so the continuation
              // labels the resolution 'llm-failed' — which applyBreaker does
              // not count — instead of a decided 'llm-deny'. A follow is
              // published like every other decisive claim so the client closes
              // the official panel with the real outcome.
              reviewVerdicts.set(req.callId, { ...review, attempts })
              recordDecisionFeedback(req.callId, formatDenyFeedback('timeout'))
              reviewStates.set(req.callId, {
                risk: staticRisk,
                phase: 'follow',
                action: 'reject',
                seconds: 0,
                note: reviewSuggestionNote(review),
                source: 'llm',
              })
              followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
              lowHandle.claim('rejected')
            }
            return
          }
          if (verdict.kind === 'ask' && autoUnattended && unattendedMustFailClosed(review)) {
            // MEDIUM guard parity: an unattended session must not ride the LOW
            // countdown into riskTimedOutAction('LOW', …, unattended) = allow
            // for a CRITICAL-flagged ALLOW the policy refused. The verdict is
            // registered so the continuation labels the resolution
            // 'llm-blocked' — not an agreed 'llm-allow' and not a reviewer
            // failure. Attended sessions keep the standing human ask below.
            reviewVerdicts.set(req.callId, { ...review, attempts })
            recordDecisionFeedback(req.callId, formatDenyFeedback('timeout'))
            reviewStates.set(req.callId, {
              risk: staticRisk,
              phase: 'follow',
              action: 'reject',
              seconds: 0,
              note: reviewSuggestionNote(review),
              source: 'llm',
            })
            followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
            lowHandle.claim('rejected')
            return
          }
          // verdict.kind === 'ask' → genuine ESCALATE: never auto-answer from
          // a reviewer that could not decide — the human countdown continues
          // and the timeout action applies when it expires. (A CRITICAL-flagged
          // ALLOW that reaches this point is the attended case: the unattended
          // one was settled above.)
        })
        .catch((error) => {
          // The LOW review races the countdown exactly like MEDIUM/HIGH; an
          // unexpected rejection must be observed (latency + debug trail), not
          // left as an unhandledRejection that could crash the host process.
          // The countdown keeps running, so a healthy human answer is unaffected.
          debugLog({ ev: 'review-error', callId: req.callId, scope: 'low', error: error instanceof Error ? error.message : String(error) })
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - lowReviewStart, settled: false, channel: 'reviewer' })
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
          category: classified.category,
        }
        return askHuman(req, undefined, next, false, status, undefined, undefined, learnableContextFor(req, args, classified, 'medium-countdown'))
      }
      const fallbackAction = riskTimedOutAction('MEDIUM', config.timeoutAction, autoUnattended)
      const status: ReviewStatus = {
        risk: staticRisk,
        phase: 'countdown',
        action: fallbackAction,
        seconds,
        ...(fallbackAction === 'reject' ? { feedback: REVIEW_TIMEOUT_NOTICE } : {}),
        category: classified.category,
      }
      const mediumHandle: RaceHumanHandle = { claim: () => {} }
      const askPromise = askHuman(req, undefined, next, false, status, mediumHandle, true, learnableContextFor(req, args, classified, 'medium-llm-countdown'))
      const reviewStart = Date.now()
      void reviewWithLLM(getCredentials(), llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: true,
      })
        .then(({ review, attempts }) => {
          debugLog({ ev: 'review', callId: req.callId, decision: review.decision, risk: review.riskLevel ?? null, startAt: reviewStart, tookMs: Date.now() - reviewStart, scope: 'medium', attempts: attempts.length })
          // Sample before the phase guard: a late response that lost the
          // countdown race is still a real latency observation (and the most
          // diagnostic one — the reviewer was slow).
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: review.failure === undefined, attempts: Math.max(1, attempts.length), channel: 'reviewer' })
          if (!req.callId || reviewStates.get(req.callId)?.phase !== 'countdown') return
          const note = reviewSuggestionNote(review)
          // Remember the verdict for history whether or not it takes over.
          reviewVerdicts.set(req.callId, { ...review, attempts })
          // A CRITICAL-flagged ALLOW is contradictory (the reviewer is told to
          // deny CRITICAL); it must NOT take over and auto-allow — surface to a
          // human instead. DENY stays decisive.
          const blockedAllow = reviewerAutoAllowBlocked(review as any)
          if (autoUnattended && unattendedMustFailClosed(review)) {
            // Unattended fail-closed (LOW parity): a reviewer failure or a
            // CRITICAL-blocked ALLOW settles as rejected right away instead
            // of riding the countdown into riskTimedOutAction('MEDIUM', …,
            // unattended) = allow. The registered verdict keeps the
            // resolution labeled 'llm-failed' (reviewer failure) or
            // 'llm-blocked' (a CRITICAL-flagged ALLOW the guard refused) so
            // the breaker is not fed.
            recordDecisionFeedback(req.callId, formatDenyFeedback('timeout'))
            mediumHandle.claim('rejected')
            reviewStates.set(req.callId, {
              risk: staticRisk,
              phase: 'follow',
              action: 'reject',
              seconds: 0,
              note,
              source: 'llm',
            })
            followExpiry.set(req.callId, Date.now() + FOLLOW_STATE_TTL_MS)
            debugLog({ ev: 'follow', callId: req.callId, decision: review.decision, tookMs: Date.now() - reviewStart, unattendedFailClosed: true })
            return
          }
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
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: false, channel: 'reviewer' })
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
      category: classified.category,
    }
    const askPromise = askHuman(req, undefined, next, false, status, undefined, undefined, learnableContextFor(req, args, classified, 'high-countdown'))
    if (llmReviews) {
      const reviewStart = Date.now()
      void reviewWithLLM(getCredentials(), llm, tools, req.agent.session, req, config, seconds * 1000, reviewOpts, {
        maxRetries: config.reviewMaxRetries ?? THRESHOLD_DEFAULTS.reviewMaxRetries,
        budgetMs: seconds * 1000,
        asyncPath: true,
      })
        .then(({ review, attempts }) => {
          debugLog({ ev: 'review', callId: req.callId, decision: review.decision, risk: review.riskLevel ?? null, startAt: reviewStart, tookMs: Date.now() - reviewStart, scope: 'high', attempts: attempts.length })
          // Sample before the phase guard (see MEDIUM: late responses are the
          // most diagnostic latency observations and must not be dropped).
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: review.failure === undefined, attempts: Math.max(1, attempts.length), channel: 'reviewer' })
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
          pushLatencySample(llmLatency, { at: Date.now(), tookMs: Date.now() - reviewStart, settled: false, channel: 'reviewer' })
        })
    }
    return await askPromise
  }, { prepend: true, global: true })

  // ── /stats (composer status chip data) ─────────────────────────────────
  function installStatsRoute(ctx: any): void {
    registerCarrierFetchRoute(ctx, {
      path: STATS_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      label: 'dsh-auto-approval-llm: stats route',
    }, async (request: Request): Promise<Response> => {
        const method = methodOf(request)
        if (!isTrustedFetchRequest(request, trustedHosts)) {
          return json(403, { ok: false, error: 'forbidden' })
        }
        if (method !== 'GET') {
          return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
        }
        // Session id travels in a request header, never the URL query (same
        // discipline as SESSION_MODE_ROUTE).
        const sessionId = String(request.headers.get('x-auto-approval-session-id') ?? '').trim()
        if (!sessionId) {
          return json(400, { ok: false, error: 'sessionId is required' })
        }
        const agent = anyCtx.get('agents')?.get?.(sessionId)
        const authority = authorityFor({ agent })
        const key = authorityKeyFor({ agent })
        let mode: string | null = null
        try {
          const raw = rawPresetOf(permissionPresets, authority?.session ?? agent?.session)
          mode = raw !== undefined && gateNames.includes(raw) ? GATED_PRESET : (raw ?? null)
        } catch {
          mode = null
        }
        const consecutive = denials.get(key) ?? 0
        const total = totalDenials.get(key) ?? 0
        const records = approvalHistory.filter((r) => r.sessionId === key)
        return json(200, {
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
    })
  }

  // ── /approval-mode + /approval-reset + /approval-reset-all (optional) ──
  // Escape hatch: reset breaker counters and in-flight review status without
  // touching persisted policy. Registered ONLY when slashCommandsEnabled is on
  // at boot (command sets are not hot-swappable — enabling needs a restart,
  // mirroring the direct-human tool) and only when the commands service is
  // present (it is active in the web profile). Each handler additionally reads
  // the switch LIVE and refuses with a clear error when it is off, so a
  // running process that disables the switch stops the already-registered
  // commands at once. The GUI command palette runs a picked command
  // immediately and offers no argument entry, so the global reset variant is
  // its own zero-argument command — otherwise `reset all` would be
  // unreachable from the web UI.
  const commands = anyCtx.get('commands')
  const slashCommandsLive = () => config.slashCommandsEnabled === true
  const resetAllSessions = () => {
    denials.clear()
    totalDenials.clear()
    denialLog.clear()
    clearApprovalState()
    return { kind: 'success', text: 'Breaker counters and in-flight approval state reset for ALL sessions.' }
  }
  if (commands && config.slashCommandsEnabled === true) {
    ctx.effect(() => commands.register({
      name: 'approval-reset-all',
      description: '/approval-reset-all — global reset of ALL sessions: clears every session\'s denial-breaker counters AND in-flight approval state. Destructive to current approval state; prefer the session-scoped /approval-reset unless you need a global reset.',
      handler: () => {
        if (!slashCommandsLive()) {
          return { kind: 'error', text: 'Slash commands are disabled (slashCommandsEnabled off); re-enable the switch and restart to use /approval-reset-all.' }
        }
        return resetAllSessions()
      },
    }), 'dsh-auto-approval-llm: /approval-reset-all command')
    ctx.effect(() => commands.register({
      name: 'approval-reset',
      description: '/approval-reset — reset THIS session\'s denial-breaker counters (consecutive/cumulative). Does not affect other sessions or in-flight approvals; use /approval-reset-all for a global reset. Takes no arguments.',
      handler: (invocation: any) => {
        if (!slashCommandsLive()) {
          return { kind: 'error', text: 'Slash commands are disabled (slashCommandsEnabled off); re-enable the switch and restart to use /approval-reset.' }
        }
        // User decision: a bare reset is session-scoped — one
        // session's escape hatch must not silently clear a concurrent
        // session's denial breaker (the counters are authority-session keyed,
        // so the scoped variant is a plain key delete). The global variant is
        // the separate zero-argument /approval-reset-all command, because the
        // GUI palette executes a picked command immediately and cannot pass
        // arguments. In-flight approval state is callId-keyed and short-lived
        // (follow TTL 120s, resolvedCallIds 30s); scoping it would need a
        // session index for little gain, so only the global command clears it.
        const arg = String(invocation?.rawInput ?? '').trim()
        if (arg !== '') {
          return { kind: 'error', text: 'Unexpected argument — this command takes none. For the global reset use /approval-reset-all.' }
        }
        const key = authorityKeyFor({ agent: invocation?.agent })
        if (!key) {
          return { kind: 'error', text: 'Cannot resolve the calling session for a scoped reset; use /approval-reset-all.' }
        }
        denials.delete(key)
        totalDenials.delete(key)
        denialLog.delete(key)
        return { kind: 'success', text: 'Breaker counters reset for this session. Use /approval-reset-all to clear every session (and in-flight approval state).' }
      },
    }), 'dsh-auto-approval-llm: /approval-reset command')
    ctx.effect(() => commands.register({
      name: 'approval-mode',
      description: '/approval-mode — show or set THIS session\'s review mode: manual (human decides every ask), smart (LLM-assisted review), unattended (auto-answer; HIGH risk still asks a human). No argument shows the current mode. Only affects this session.',
      handler: (invocation: any) => {
        if (!slashCommandsLive()) {
          return { kind: 'error', text: 'Slash commands are disabled (slashCommandsEnabled off); re-enable the switch and restart to use /approval-mode.' }
        }
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
  } else if (commands) {
    console.log('[dsh-auto-approval-llm] slash commands disabled (slashCommandsEnabled off), /approval-mode /approval-reset /approval-reset-all not registered')
  } else {
    console.log('[dsh-auto-approval-llm] commands service unavailable, /approval-mode /approval-reset /approval-reset-all disabled')
  }
}
