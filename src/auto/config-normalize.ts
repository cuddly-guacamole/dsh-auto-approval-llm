/**
 * dsh-auto-approval-llm · configuration normalization.
 *
 * The single entry point that turns a stored/hand-written config value into the
 * runtime config: every clamp, retirement and migration lives here, so boot,
 * live re-read and each fallback branch share one normalization. Plain data in,
 * plain data out — the only host touchpoint is `process.env.DSH_HOME`, and the
 * one `Config` reference is a type annotation (erased at compile time).
 */
import type { Config } from '../index.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CATEGORY_KEYS, LOCKED_CATEGORIES } from './category.js'
import { THRESHOLD_DEFAULTS } from './constants.js'
import { plainConfigValue } from './decision.js'
import { clampLearningThreshold } from './learning.js'
import { normalizeLane, normalizeSharedEndpoint } from './model-channel.js'
import { normalizeLoopThreshold } from './loop-guard.js'
import { isWithin, isCriticalPath, normalizePath } from './paths.js'

/** One-time flag: the threshold=1 clamp warning fires once per process. */
let loopThresholdWarned = false

export function resolveConfig(raw: Config): Config {
  // The host config plane resolves the schema before it hands the value over, so
  // every volatile (card-owned) field arrives as a `{ get() }` reference rather
  // than as its value: reading the reference directly yields an object, not the
  // configured scalar. Unwrap the whole input once, here, so the single entry
  // point covers every caller (boot, live re-read and each fallback branch) and
  // the body below works on plain data. The unwrap is idempotent, so a second
  // call on an already-plain config is a no-op.
  raw = plainConfigValue(raw)
  // Retired guard key: schemastery neither rejects nor strips unknown keys and
  // resolveConfig spreads `...raw`, so the value must be explicitly read,
  // warned, and normalized here so no later code path can act on it.
  if ((raw as any).autoSwitchPolicyToAsk === true) {
    console.warn('[dsh-auto-approval-llm] autoSwitchPolicyToAsk is retired and ignored; remove the key from settings/patch')
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
  // are warned and dropped = inherit), except privilege when
  // privilegeAutoReview is on. Mirrors the timeoutAction migration
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
    if (LOCKED_CATEGORIES.includes(key as (typeof LOCKED_CATEGORIES)[number]) && value !== 'ask'
      && !(key === 'privilege' && raw.privilegeAutoReview === true)
      && !(key === 'protected' && raw.protectedAutoReview === true)) {
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
  // DSH_HOME write openings. DSH_HOME is hard-denied as one tree, which also
  // blocks legitimate operator work (editing a skill, a profile). An operator
  // may name subtrees here, under clamps that keep the reason the fence exists:
  // the entry must be absolute and inside DSH_HOME, must not be DSH_HOME
  // itself (that would erase the fence wholesale), and must not re-open the
  // trees whose contents are credentials, transcripts, or this plugin's own
  // audit trail. Everything dropped is warned, never silently ignored.
  const trustedDshSubpaths: string[] = []
  // Named relative to DSH_HOME: session transcripts, credential files, and
  // the plugin tree whose runtime state is the audit trail (the plugin's own
  // dev zone is granted separately and keeps its narrower runtime-state deny).
  // The two names the DSH tree really uses for credential material
  // (`.credentials.yaml`) and its own configuration (`settings.yaml`) are
  // listed alongside the legacy directory spellings: fencing only
  // `credentials/` and `credentials.json`, neither of which exists in this
  // tree, let an opening re-expose the credential store and the operator
  // configuration file — the very trees the clamps exist to keep closed.
  // `profiles` joins the fence because `profiles/*/cordis.patch.yml` is the
  // DSH plugin-assembly carrier: an opening there let an Auto session rewrite
  // which plugins load and with what config (the plugin-zone code carve-out
  // only covers a plugin repository itself, not this profile subtree).
  const FENCED_DSH_SUBTREES = ['sessions', 'plugins', 'credentials', 'credentials.json', '.credentials.yaml', 'settings.yaml', 'profiles']
  for (const dir of raw.trustedDshSubpaths ?? []) {
    if (typeof dir !== 'string' || dir.trim() === '' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(dir)) {
      console.warn(`[dsh-auto-approval-llm] ignoring non-absolute trustedDshSubpath "${String(dir)}"`)
      continue
    }
    const normalized = normalizePath(dir, dshHome, home)
    const normalizedDshHome = normalizePath(dshHome, dshHome, home)
    if (!isWithin(normalizedDshHome, normalized)) {
      console.warn(`[dsh-auto-approval-llm] ignoring trustedDshSubpath outside DSH_HOME: ${normalized}`)
      continue
    }
    if (normalized === normalizedDshHome) {
      console.warn(`[dsh-auto-approval-llm] ignoring trustedDshSubpath that is DSH_HOME itself: ${normalized}`)
      continue
    }
    const fenced = FENCED_DSH_SUBTREES
      .map((name) => normalizePath(join(normalizedDshHome, name), dshHome, home))
      .find((root) => isWithin(root, normalized) || isWithin(normalized, root))
    if (fenced !== undefined) {
      console.warn(`[dsh-auto-approval-llm] ignoring trustedDshSubpath covering a fenced DSH_HOME tree (${fenced}): ${normalized}`)
      continue
    }
    const roots = { workspace: normalized, home, dshHome }
    if (isCriticalPath(normalized, roots)) {
      console.warn(`[dsh-auto-approval-llm] ignoring trustedDshSubpath inside a critical tree: ${normalized}`)
      continue
    }
    trustedDshSubpaths.push(normalized)
  }
  // Maintenance openings: same absolute/inside/fenced discipline as
  // trustedDshSubpaths. Only non-runtime-state files inside them are
  // relaxed at the guard (see hardDestructiveTargetReason); runtime-state
  // basenames and shell vectors never inherit the relief.
  const maintenanceDshPaths: string[] = []
  for (const dir of raw.maintenanceDshPaths ?? []) {
    if (typeof dir !== 'string' || dir.trim() === '' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(dir)) {
      console.warn(`[dsh-auto-approval-llm] ignoring non-absolute maintenanceDshPath "${String(dir)}"`)
      continue
    }
    const normalized = normalizePath(dir, dshHome, home)
    const normalizedDshHome = normalizePath(dshHome, dshHome, home)
    if (!isWithin(normalizedDshHome, normalized) || normalized === normalizedDshHome) {
      console.warn(`[dsh-auto-approval-llm] ignoring maintenanceDshPath outside DSH_HOME: ${normalized}`)
      continue
    }
    const fenced = FENCED_DSH_SUBTREES
      .map((name) => normalizePath(join(normalizedDshHome, name), dshHome, home))
      .find((root) => isWithin(root, normalized) || isWithin(normalized, root))
    if (fenced !== undefined) {
      console.warn(`[dsh-auto-approval-llm] ignoring maintenanceDshPath covering a fenced DSH_HOME tree (${fenced}): ${normalized}`)
      continue
    }
    maintenanceDshPaths.push(normalized)
  }
  // Learning-threshold clamp: warn + clamp, never throw and never drop — a
  // wild value keeps the magnitude of the user's intent (mirrors the
  // categoryPolicy warn+normalize pattern, but numeric instead of tri-state).
  const learningThreshold = clampLearningThreshold(
    raw.learningThreshold,
    THRESHOLD_DEFAULTS.learningThreshold,
  )
  // Only an actually-present invalid value warns: an omitted key is the schema
  // default and must not spam a "clamping undefined" warning on every boot.
  if (
    raw.learningThreshold !== undefined && raw.learningThreshold !== null &&
    (typeof raw.learningThreshold !== 'number' ||
      !Number.isInteger(raw.learningThreshold) ||
      raw.learningThreshold < 2 ||
      raw.learningThreshold > 10)
  ) {
    console.warn(`[dsh-auto-approval-llm] clamping learningThreshold ${String(raw.learningThreshold)} to ${learningThreshold} (valid range: integer 2..10)`)
  }
  // Model-source normalization: each lane
  // resolves through the shared channel layer. An explicit preset/endpoint
  // choice that is half-configured is surfaced via the lane's `error` (consumers
  // fail loudly); it is never silently downgraded to the session model. A
  // `session` source carrying leftover preset values is silently cleaned, and a
  // stale 'custom' enum from the retired 2-source era normalizes to session —
  // warn and never throw, so a hand-written settings file can never crash
  // bootstrap.
  const classifierLane = normalizeLane({
    source: (raw as any).classifierSource,
    presetProvider: (raw as any).classifierProvider,
    presetModel: (raw as any).classifierModel,
  })
  if (classifierLane.error) {
    console.warn(`[dsh-auto-approval-llm] classifierSource=${String((raw as any).classifierSource)} without a complete provider/model pair — ${classifierLane.error}`)
  }
  const reviewerLane = normalizeLane({
    source: (raw as any).reviewerSource,
    presetProvider: (raw as any).reviewerProvider,
    presetModel: (raw as any).reviewerModel,
  })
  if (reviewerLane.error) {
    console.warn(`[dsh-auto-approval-llm] reviewerSource=${String((raw as any).reviewerSource)} without a complete provider/model pair — ${reviewerLane.error}`)
  }
  const sharedEndpoint = normalizeSharedEndpoint({
    url: (raw as any).endpointUrl,
    model: (raw as any).endpointModel,
    protocol: (raw as any).endpointProtocol,
  })
  // Loop guard threshold: resolveConfig also consumes plain objects that never
  // passed the schema, so the 1→2 clamp lives here, not only in zod.
  const loopThreshold = normalizeLoopThreshold(raw.loopDetectionThreshold)
  if (loopThreshold.warned && !loopThresholdWarned) {
    loopThresholdWarned = true
    console.warn('[dsh-auto-approval-llm] loopDetectionThreshold=1 would turn every auto-allowed call into an ask; clamped to 2')
  }
  return {
    ...raw,
    autoSwitchPolicyToAsk: false,
    loopDetectionThreshold: loopThreshold.value,
    classifierSource: classifierLane.source,
    classifierProvider: classifierLane.presetProvider,
    classifierModel: classifierLane.presetModel,
    reviewerSource: reviewerLane.source,
    reviewerProvider: reviewerLane.presetProvider,
    reviewerModel: reviewerLane.presetModel,
    endpointUrl: sharedEndpoint.url,
    endpointModel: sharedEndpoint.model,
    endpointProtocol: sharedEndpoint.protocol,
    timeoutAction,
    categoryPolicy,
    categoryMode: raw.categoryMode === 'aggressive' ? 'aggressive' : 'standard',
    // Default-off (fail-closed): only an explicit true unlocks privilege
    // (delete/protected/disk stay locked regardless).
    privilegeAutoReview: raw.privilegeAutoReview === true,
    // Default-off for the same reason; an explicit true is the only unlock.
    protectedAutoReview: raw.protectedAutoReview === true,
    trustedDirs,
    trustedDshSubpaths,
    maintenanceDshPaths,
    // Default-off (fail-closed): only an explicit true enables learning.
    learningEnabled: raw.learningEnabled === true,
    learningThreshold,
    llmReviewScope: raw.llmReviewScope ?? 'low-or-above',
    llmTakeoverScope: raw.llmTakeoverScope ?? 'medium-or-below',
    lowRiskSeconds: raw.lowRiskSeconds ?? THRESHOLD_DEFAULTS.lowRiskSeconds,
    mediumRiskSeconds: raw.mediumRiskSeconds ?? THRESHOLD_DEFAULTS.mediumRiskSeconds,
    highRiskSeconds: raw.highRiskSeconds ?? THRESHOLD_DEFAULTS.highRiskSeconds,
    redactResults: raw.redactResults === true,
    reviewWaitSeconds: raw.reviewWaitSeconds ?? THRESHOLD_DEFAULTS.reviewWaitSeconds,
    // Default-off (fail-closed): only an explicit true enables guidance.
    rejectGuidance: raw.rejectGuidance === true,
  }
}
