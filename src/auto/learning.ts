/**
 * dsh-auto-approval-llm · confirmation-learning store (pure core).
 *
 * Same-signature operations confirmed by a human N times may be answered
 * without asking again — but every release still passes a fresh online review,
 * and every failure mode falls back to the ordinary (human) pipeline.
 *
 * This module owns the deterministic side of that bargain:
 *  - signatureFor builds a normalized whole-line template from a command or a
 *    structured tool call. Raw values never survive: operands collapse into
 *    type slots, flag values are dropped, and anything the static lexer cannot
 *    read (dynamic expansion, globs, quotes, opaque constructs, colon-style
 *    parameters, known uncovered write-vector heads) prunes the WHOLE line so
 *    an unreadable call can neither record nor hit.
 *  - Entries are stored keyed by SHA-256(sigVersion|kind|workspace|signature)
 *    with only a redacted, value-free skeleton as the readable payload.
 *  - Matching is exact equality on the normalized template — never prefix,
 *    glob, regex, or edit-distance.
 *  - Every validity failure (corrupt file, schema violation, poisoned
 *    metacharacter skeleton, version drift, TTL expiry, LRU eviction, disabled
 *    switch) degrades to "not learned", i.e. back to the human pipeline.
 *
 * The store is plain data; loadLearning/persistLearning take explicit paths so
 * tests can use temp fixtures. Persistence is synchronous tmp+rename (the same
 * pattern as review-mode) so callers can hold it inside a keyed-mutex critical
 * section without awaiting I/O.
 */

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { LOCKED_CATEGORIES } from './category.js'
import { THRESHOLD_DEFAULTS } from './constants.js'
import { redactSecrets } from './redact.js'
import { decomposeCommandLine } from './shell.js'

/** Bump when the template grammar changes; stale entries can never match. */
export const LEARNING_SIG_VERSION = 2

export type LearningKind = 'shell-bash' | 'shell-pwsh' | 'tool'

export const LEARNING_KINDS: readonly LearningKind[] = ['shell-bash', 'shell-pwsh', 'tool']

/**
 * Head commands whose write vectors the static lexer has never covered
 * (`tee f`, `dd of=`, `sed -i`, `truncate`, coreutils `install`). A segment
 * headed by one of them is not learnable in either direction, so a learned
 * entry can never upgrade these asks into silent allows. Deliberately
 * conservative: `sed` without `-i` loses learnability too, and `npm install`
 * stays learnable because its HEAD is `npm`.
 */
export const LEARNING_NON_LEARNABLE_COMMAND_HEADS = new Set(['tee', 'dd', 'sed', 'truncate', 'install'])

/** pwsh-style colon parameter (`-Path:C:\x`) hides its value inside the token. */
const COLON_PARAM = /^-[A-Za-z]+:/

/**
 * The only characters a stored skeleton may contain. Angle-bracket type slots
 * and the tool-shape parentheses are fine; wildcard/regex metacharacters
 * (`*?[]\`), quotes and expansion markers are not — a hand-written
 * `{skeleton:"*",count:999}` is dropped on load and can therefore never
 * produce an allow. Flag names keep their original case, so uppercase passes.
 */
const SKELETON_ALLOWED = /^[a-zA-Z0-9_.,:<>|&+=() -]+$/
const SKELETON_MAX = 512

/** Monotonicity tolerance for timestamps coming from another clock. */
const TIME_TOLERANCE_MS = 60_000

export interface LearningEntry {
  sigVersion: number
  /** Normalized workspace root; entries never match across workspaces. */
  workspace: string
  kind: LearningKind
  /** Human-readable, value-free template (passed through redactSecrets before persistence). */
  skeleton: string
  count: number
  firstAt: number
  lastAt: number
}

export interface LearningStore {
  version: number
  entries: Record<string, LearningEntry>
}

export interface SignatureInput {
  kind: LearningKind
  /** Shell command line for the shell-bash / shell-pwsh kinds. */
  command?: string
  /** Registered tool name for the tool kind. */
  toolName?: string
  /** Parsed arguments object for the tool kind. */
  args?: unknown
}

export interface SignatureResult {
  /** Normalized template — exactly what the dictionary key hashes. */
  signature: string
  /** Redacted display form stored inside the entry. */
  skeleton: string
}

const commandHead = (token: string): string => basename(token.replaceAll('\\', '/')).toLowerCase()

const looksLikePath = (token: string): boolean =>
  token.startsWith('/') || token.startsWith('.') || token.startsWith('~')
  || /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token)

function slotOf(word: string): '<path>' | '<literal>' {
  return looksLikePath(word) ? '<path>' : '<literal>'
}

function typeSlotOf(value: unknown): string {
  if (typeof value === 'string') return slotOf(value)
  if (typeof value === 'number') return Number.isFinite(value) ? '<number>' : '<literal>'
  if (typeof value === 'boolean') return '<boolean>'
  if (Array.isArray(value)) return '<list>'
  if (value === null) return '<null>'
  if (typeof value === 'object') return '<object>'
  return '<literal>'
}

interface SkeletonWord {
  text: string
  dynamic: boolean
  glob: boolean
  quoted: boolean
}

interface SkeletonSegment {
  words: SkeletonWord[]
  writeTargets: SkeletonWord[]
  readTargets: SkeletonWord[]
}

/**
 * One segment → `head [subcommand] [flag,names] <slot>… <out:slot>…`, or
 * undefined when ANY word carries a dynamic/glob/quoted flag or a colon-style
 * parameter, or when the head sits on the uncovered write-vector table. All
 * words participate (not just the head), so a poisoned operand cannot hide.
 */
/**
 * Second-word subcommands that are identity, not data (`git push` vs
 * `git pull`, `npm install` vs `npm publish`). Any other second word — a
 * filename, a hostname, a make target — folds into its operand slot so the
 * stored skeleton stays value-free (`cp secret-config.yaml <path>` used to
 * keep the file name verbatim in learning.json and the settings card).
 */
const LEARNABLE_SUBCOMMANDS = new Set([
  'git:status', 'git:diff', 'git:log', 'git:show', 'git:add', 'git:commit', 'git:push', 'git:pull', 'git:fetch', 'git:merge', 'git:rebase', 'git:checkout', 'git:switch', 'git:restore', 'git:stash', 'git:tag', 'git:branch', 'git:clone', 'git:init', 'git:remote', 'git:clean', 'git:reset', 'git:rm', 'git:mv', 'git:apply', 'git:revert', 'git:cherry-pick',
  'npm:install', 'npm:ci', 'npm:run', 'npm:test', 'npm:exec', 'npm:publish', 'npm:pack', 'npm:link', 'npm:audit', 'npm:outdated', 'npm:update', 'npm:init', 'npm:create',
  'npx:install', 'npx:run',
  'pnpm:install', 'pnpm:add', 'pnpm:remove', 'pnpm:run', 'pnpm:test', 'pnpm:exec', 'pnpm:publish', 'pnpm:update',
  'yarn:install', 'yarn:add', 'yarn:remove', 'yarn:run', 'yarn:test', 'yarn:publish', 'yarn:upgrade',
  'bun:install', 'bun:add', 'bun:remove', 'bun:run', 'bun:test', 'bun:publish',
  'pip:install', 'pip:uninstall', 'pip:freeze', 'pip:list', 'pip:show',
  'pip3:install', 'pip3:uninstall', 'pip3:freeze', 'pip3:list', 'pip3:show',
  'cargo:build', 'cargo:test', 'cargo:run', 'cargo:check', 'cargo:publish', 'cargo:install', 'cargo:update', 'cargo:doc', 'cargo:new', 'cargo:init',
  'go:build', 'go:test', 'go:run', 'go:get', 'go:install', 'go:vet', 'go:mod',
  'docker:build', 'docker:pull', 'docker:push', 'docker:run', 'docker:exec', 'docker:compose', 'docker:images', 'docker:ps', 'docker:logs', 'docker:rm', 'docker:rmi', 'docker:stop', 'docker:start', 'docker:restart', 'docker:network', 'docker:volume',
  'kubectl:get', 'kubectl:apply', 'kubectl:delete', 'kubectl:describe', 'kubectl:logs', 'kubectl:rollout', 'kubectl:edit', 'kubectl:scale', 'kubectl:expose',
  'dotnet:build', 'dotnet:test', 'dotnet:run', 'dotnet:publish', 'dotnet:restore',
  'make:clean', 'make:build', 'make:test', 'make:install',
])

function segmentTemplate(segment: SkeletonSegment): string | undefined {
  const all = [...segment.words, ...segment.writeTargets, ...segment.readTargets]
  for (const word of all) {
    if (word.dynamic || word.glob || word.quoted) return undefined
    if (COLON_PARAM.test(word.text)) return undefined
  }
  let rest = [...segment.words]
  // Leading VAR=value assignments are environment, not identity.
  while (rest.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]?.text ?? '')) rest = rest.slice(1)
  const head = commandHead(rest[0]?.text ?? '')
  if (head === '' || !head.trim()) return undefined
  if (LEARNING_NON_LEARNABLE_COMMAND_HEADS.has(head)) return undefined
  const parts: string[] = [head]
  let index = 1
  if (rest.length > 1 && !rest[1].text.startsWith('-')) {
    const second = rest[1].text.toLowerCase()
    parts.push(LEARNABLE_SUBCOMMANDS.has(`${head}:${second}`) ? second : slotOf(rest[1].text))
    index = 2
  }
  const flags: string[] = []
  for (let i = index; i < rest.length; i += 1) {
    const text = rest[i].text
    if (text.startsWith('-')) {
      const name = text.split('=')[0] ?? text
      if (!flags.includes(name)) flags.push(name)
    } else {
      parts.push(slotOf(text))
    }
  }
  if (flags.length > 0) parts.push(flags.sort().join(','))
  for (const target of segment.readTargets) parts.push(`<in:${slotOf(target.text).slice(1, -1)}>`)
  for (const target of segment.writeTargets) parts.push(`<out:${slotOf(target.text).slice(1, -1)}>`)
  return parts.join(' ')
}

function toolTemplate(toolName: unknown, args: unknown): string | undefined {
  const name = typeof toolName === 'string' ? toolName.trim() : ''
  if (name === '') return undefined
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const shape = keys.map((key) => `${key}:${typeSlotOf(record[key])}`).join(',')
  return `${name}(${shape})`
}

/**
 * Deterministic template signature for one call, or undefined when the call is
 * not learnable at all (unreadable input, pruned construct, empty template).
 * Same input ⇒ same output, always; the template contains zero raw values.
 */
export function signatureFor(input: SignatureInput): SignatureResult | undefined {
  try {
    if (input.kind === 'tool') {
      const template = toolTemplate(input.toolName, input.args)
      if (template === undefined || template.length > SKELETON_MAX) return undefined
      return { signature: template, skeleton: redactSecrets(template) }
    }
    if (input.kind !== 'shell-bash' && input.kind !== 'shell-pwsh') return undefined
    const shell = input.kind === 'shell-bash' ? 'bash' : 'pwsh'
    const decomposition = decomposeCommandLine(String(input.command ?? ''), shell) as {
      kind?: string
      segments?: SkeletonSegment[]
    }
    if (decomposition.kind !== 'segments') return undefined
    const templates: string[] = []
    for (const segment of decomposition.segments ?? []) {
      const template = segmentTemplate(segment)
      if (template === undefined) return undefined
      templates.push(template)
    }
    const line = templates.join(' && ')
    if (!line.trim() || line.length > SKELETON_MAX || !SKELETON_ALLOWED.test(line)) return undefined
    return { signature: line, skeleton: redactSecrets(line) }
  } catch {
    return undefined
  }
}

/** Dictionary key: SHA-256 over sigVersion|kind|workspace|normalizedSignature. */
export function learningKey(kind: LearningKind, workspace: string, signature: string): string {
  return createHash('sha256').update(`${LEARNING_SIG_VERSION}|${kind}|${workspace}|${signature}`).digest('hex')
}

/**
 * Threshold clamp: NaN / non-finite / non-integers fall back to the default;
 * out-of-range integers clamp into [2,10]. Never throws, never drops the
 * setting silently to something the user did not choose — the magnitude of
 * their intent survives even a wild value.
 */
export function clampLearningThreshold(
  value: unknown,
  fallback = THRESHOLD_DEFAULTS.learningThreshold,
  min = 2,
  max = 10,
): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num)) return fallback
  if (num < min) return min
  if (num > max) return max
  return num
}

/**
 * Pure counting policy for one resolved ask outcome. Only a genuine human
 * allow on a qualified ask increments; a human deny resets the key; every
 * other resolution source (timeout-*, llm-*, auto-*, abort, learned-allow,
 * anything unknown) is a zero-code-path ignore. Consumers read the SOURCE
 * string, never the outcome vocabulary.
 */
export function confirmActionFor(source: string): 'increment' | 'reset' | 'ignore' {
  if (source === 'human-allow') return 'increment'
  if (source === 'human-deny') return 'reset'
  return 'ignore'
}

// 'unknown' is deliberately absent: unrecognized-but-confirmed operations
// became learnable in 2026-09 (E-line); only the locked four and the
// internal harness category stay out of the learning domain.
const NON_LEARNABLE_CATEGORIES: readonly string[] = [...LOCKED_CATEGORIES, 'harnessInternal']

/**
 * Learnable-domain gate (risk tier × category × sensitive fuse). Evaluated
 * once when recording (snapshot at the qualified hooks) and again live at the
 * query point — the two evaluations are independent, and failing either one
 * means "never learned" / "not a hit".
 */
export function learnGateEligible(input: {
  enabled: boolean
  staticRisk: string
  category?: string
  fuseHit?: boolean
}): boolean {
  if (!input.enabled) return false
  if (input.staticRisk !== 'LOW' && input.staticRisk !== 'MEDIUM') return false
  const category = input.category ?? ''
  if (category === '' || NON_LEARNABLE_CATEGORIES.includes(category)) return false
  if (input.fuseHit === true) return false
  return true
}

/** Structural + monotonicity validation; returns a clean entry or undefined. */
export function validateLearningEntry(value: unknown, now: number): LearningEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.sigVersion !== LEARNING_SIG_VERSION) return undefined
  const { workspace, kind, skeleton } = raw as Partial<LearningEntry>
  if (typeof workspace !== 'string' || workspace === '') return undefined
  if (typeof kind !== 'string' || !LEARNING_KINDS.includes(kind as LearningKind)) return undefined
  if (typeof skeleton !== 'string' || skeleton === '' || skeleton.length > SKELETON_MAX) return undefined
  if (!SKELETON_ALLOWED.test(skeleton)) return undefined
  const { count, firstAt, lastAt } = raw as Partial<LearningEntry>
  if (typeof count !== 'number' || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) return undefined
  if (typeof firstAt !== 'number' || !Number.isFinite(firstAt) || firstAt < 0) return undefined
  if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt < 0) return undefined
  if (lastAt < firstAt) return undefined
  if (lastAt > now + TIME_TOLERANCE_MS) return undefined
  return { sigVersion: LEARNING_SIG_VERSION, workspace, kind: kind as LearningKind, skeleton, count, firstAt, lastAt }
}

const ttlMs = (ttlDays: number | undefined): number =>
  (ttlDays ?? THRESHOLD_DEFAULTS.learningTtlDays) * 86_400_000

/**
 * Drop expired entries, then evict least-recently-used (by lastAt) until the
 * store fits maxEntries. Returns a fresh entries record; the input is untouched.
 */
export function evictLearning(
  entries: Record<string, LearningEntry>,
  opts: { maxEntries?: number; ttlDays?: number; now: number },
): Record<string, LearningEntry> {
  const maxEntries = opts.maxEntries ?? THRESHOLD_DEFAULTS.learningMaxEntries
  const limit = ttlMs(opts.ttlDays)
  const alive = Object.entries(entries).filter(([, entry]) => opts.now - entry.lastAt <= limit)
  alive.sort((a, b) => a[1].lastAt - b[1].lastAt)
  while (alive.length > Math.max(0, maxEntries)) alive.shift()
  return Object.fromEntries(alive)
}

export const emptyLearningStore = (): LearningStore => ({ version: 1, entries: {} })

/** Load + validate + lazy-prune; any failure warns and yields an empty store. */
export function loadLearning(path: string, opts: { now?: number; ttlDays?: number; maxEntries?: number } = {}): LearningStore {
  const now = opts.now ?? Date.now()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      console.warn(`[dsh-auto-approval-llm] learning.json failed validation (version/entries shape); refusing to load ${path}`)
      return emptyLearningStore()
    }
    const valid: Record<string, LearningEntry> = {}
    for (const [key, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
      const entry = validateLearningEntry(value, now)
      if (entry !== undefined) valid[key] = entry
    }
    return { version: 1, entries: evictLearning(valid, { ...opts, now }) }
  } catch (error) {
    console.warn(`[dsh-auto-approval-llm] learning.json unreadable or corrupted (${error instanceof Error ? error.message : String(error)}); refusing to load ${path}`)
    return emptyLearningStore()
  }
}

/** Atomic synchronous persist (tmp+rename); best-effort, never throws. */
export function persistLearning(path: string, store: LearningStore): void {
  try {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(store))
    renameSync(tmp, path)
  } catch {
    // Persistence is best-effort; the process copy still applies.
  }
}

/**
 * Count one more human confirmation for the key. Mutates the store in place
 * (callers hold it under a keyed mutex with a synchronous critical section)
 * and keeps the entry bounded via the usual prune. Returns the same store.
 */
export function recordConfirm(
  store: LearningStore,
  key: string,
  seed: { workspace: string; kind: LearningKind; skeleton: string },
  now: number,
  opts: { maxEntries?: number; ttlDays?: number } = {},
): LearningStore {
  const existing = store.entries[key]
  if (existing !== undefined && existing.workspace === seed.workspace) {
    existing.count += 1
    existing.lastAt = now
  } else {
    store.entries[key] = {
      sigVersion: LEARNING_SIG_VERSION,
      workspace: seed.workspace,
      kind: seed.kind,
      skeleton: seed.skeleton,
      count: 1,
      firstAt: now,
      lastAt: now,
    }
  }
  store.entries = evictLearning(store.entries, { ...opts, now })
  return store
}

/**
 * A human deny on the same signature zeroes the count immediately (the entry
 * itself stays behind for observation until TTL/LRU回收). Unknown keys are a
 * no-op — there is nothing to reset.
 */
export function resetConfirmation(store: LearningStore, key: string, now: number): LearningStore {
  const existing = store.entries[key]
  if (existing === undefined) return store
  existing.count = 0
  existing.lastAt = now
  return store
}

/**
 * Remove one learned entry entirely (the revoke-UI operation). Unknown keys
 * are a no-op returning false; a deletion returns true. The store is mutated
 * in place and the caller persists it — same contract as recordConfirm.
 */
export function revokeLearning(store: LearningStore, key: string): boolean {
  if (store.entries[key] === undefined) return false
  delete store.entries[key]
  return true
}

/** Exact-equality lookup: presence ∧ current sigVersion ∧ same workspace ∧ count ≥ threshold ∧ fresh. */
export function lookupLearning(
  store: LearningStore,
  opts: { key: string; workspace: string; threshold: number; now: number; ttlDays?: number },
): boolean {
  const entry = store.entries[opts.key]
  if (entry === undefined) return false
  if (entry.sigVersion !== LEARNING_SIG_VERSION) return false
  if (entry.workspace !== opts.workspace) return false
  if (!(entry.count >= opts.threshold)) return false
  if (opts.now - entry.lastAt > ttlMs(opts.ttlDays)) return false
  return true
}

/** Per-root-session allowance: sleep at the cap, alert exactly when crossing it. */
export function learningCapState(used: number, cap: number): { sleep: boolean; alert: boolean } {
  return { sleep: used >= cap, alert: used + 1 === cap }
}

export interface LearnDecisionInput {
  enabled: boolean
  staticRisk: string
  category?: string
  fuseHit?: boolean
  /** undefined ⇒ the signature was not constructible ⇒ never a hit. */
  key?: string
  workspace?: string
  threshold: number
  now: number
  ttlDays?: number
  capUsed?: number
  capMax?: number
  store: LearningStore
}

/** The full query-point decision: gate ∧ cap ∧ exact-equality entry validity. */
export function learnDecision(input: LearnDecisionInput): { hit: boolean } {
  if (!learnGateEligible({ enabled: input.enabled, staticRisk: input.staticRisk, category: input.category, fuseHit: input.fuseHit })) {
    return { hit: false }
  }
  if (input.key === undefined || input.workspace === undefined) return { hit: false }
  const capMax = input.capMax ?? THRESHOLD_DEFAULTS.learningSessionAllowCap
  if (learningCapState(input.capUsed ?? 0, capMax).sleep) return { hit: false }
  return {
    hit: lookupLearning(input.store, {
      key: input.key,
      workspace: input.workspace,
      threshold: input.threshold,
      now: input.now,
      ttlDays: input.ttlDays,
    }),
  }
}
