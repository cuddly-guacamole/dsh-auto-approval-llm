/**
 * dsh-auto-approval-llm · web route installers.
 *
 * Every route this plugin serves from the entry's route block lives here: the
 * installers register from the shared route table, the shared HTTP pipeline and
 * the shared approval state alone, so none of them needs an entry-local value.
 * The retired-settings reader and the import-offer predicate sit here too,
 * because the settings route is their only consumer.
 *
 * The factory configuration the offer compares a declaration against is the one
 * value this module cannot resolve by itself: the schema belongs to the entry
 * (the loader's only entry point), and importing it back would make the two
 * modules a cycle. The entry hands it over once through
 * {@link setFactoryConfigDefaults} instead.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { appendAuditLine, recordAuditClear } from './audit.js'
import { methodOf, registerCarrierFetchRoute } from './carrier-route.js'
import { historyWritePath } from './approval-history.js'
import {
  approvalHistory,
  autoAnsweredCallIds,
  configError,
  decisionFeedback,
  followExpiry,
  learningStore,
  llmLatency,
  pendingPanelReleases,
  resolvedCallIds,
  REVIEW_STATUS_HOLD_MS,
  reviewSessions,
  reviewStates,
  reviewVerdicts,
  timeoutFeedback,
  type ReviewStatus,
} from './approval-state.js'
import { GATED_PRESET } from './constants.js'
import { debugLog, sameEndpointTarget } from './debug-and-decisions.js'
import { EDITABLE_CONFIG_KEYS, HOST_ONLY_KEYS, SHIPPED_PINNED_KEYS } from './decision.js'
import { createPinnedLookup, requestEndpointText } from './endpoint-call.js'
import { recordTimeoutFeedback } from './feedback-maps.js'
import { json, readJson, trustedHosts } from './http-pipeline.js'
import { LATENCY_SUMMARY_WINDOW, clearLatencySamples, summarizeLatency } from './latency.js'
import { extractProbeErrorSummary } from './notices.js'
import { detectHostCapability, gatePresetNames, rawPresetOf } from './preset-migration.js'
import { persistLearningGuarded } from './runtime-stores.js'
import { aggregateToolStats } from './tool-stats.js'
import { isLoopbackHostname, isTrustedFetchRequest, resolvePublicReviewerTarget, reviewerProbeTargetAllowed, validateReviewerBaseUrl } from './trust.js'
import {
  FEEDBACK_ROUTE,
  HISTORY_ROUTE,
  LEARNING_STORE_ROUTE,
  LLM_LATENCY_ROUTE,
  LLM_MODELS_ROUTE,
  PROVIDERS_ROUTE,
  REASONING_EFFORTS_ROUTE,
  REVEAL_ROUTE,
  REVIEWER_CREDENTIAL_REF,
  REVIEWER_CREDENTIAL_ROUTE,
  REVIEW_STATUS_ROUTE,
  SESSION_MODE_ROUTE,
  SESSION_REVIEW_STATUS_ROUTE,
  SETTINGS_NS,
  SETTINGS_ROUTE,
  TEST_ROUTE,
  TOOL_STATS_ROUTE,
  clearReviewerKeyFromCredentialFile,
  reviewerKeyFromCredentialFile,
} from './route-table.js'

/**
 * The factory configuration (every schema key at the value the schema declares)
 * the import offer compares a declaration against. The entry resolves it from
 * the schema, which lives with the loader entry point, and hands it over here.
 */
let factoryConfigDefaults: Record<string, unknown> = {}

/** Owner setter: the entry is the only caller (see the module header). */
export function setFactoryConfigDefaults(defaults: Record<string, unknown>): void {
  factoryConfigDefaults = defaults
}

export function installReviewerCredentialRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: REVIEWER_CREDENTIAL_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: reviewer credential route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      // Credential plane: loopback-same-origin only (privileged domain).
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      // Resolve the service per request: the provider mounts asynchronously
      // after apply(), so a closure captured earlier would stay undefined and
      // report "unavailable" even when the store is up.
      const credentials = ctx.get('credentials')
      try {
        if (method === 'GET') {
          if (!credentials) {
            return json(200, { ok: true, value: { configured: false, source: undefined, writable: false } })
          }
          const info = await credentials.describe(REVIEWER_CREDENTIAL_REF)
          return json(200, {
            ok: true,
            value: {
              configured: info?.configured === true,
              source: info?.source ?? undefined,
              writable: info?.writable === true,
            },
          })
        }
        if (method === 'DELETE') {
          // DELETEs carry no body, so this branch must run before the JSON
          // body reader (which requires a JSON content type).
          // Never report a cleared credential unless the store actually
          // dropped it: an unset failure (read-only store, backend error)
          // must surface to the settings card instead of a silent ok:true
          // that leaves the API key live and still being sent (M3).
          if (credentials) {
            const cleared = await credentials.unset(REVIEWER_CREDENTIAL_REF).then(() => true).catch(() => false)
            if (!cleared) {
              return json(400, { ok: false, error: 'credential clear failed on the store' })
            }
          }
          // Also drop the shared-file fallback source (the line this plugin
          // appended earlier): a cleared reviewer key must not resurrect from
          // the credential file on the next review. The removal is reported
          // honestly — a 200 here means the key is gone from every source, so a
          // failure to rewrite the file is a 400 rather than a silent ok the
          // next review would contradict by sending the key again.
          const fileClear = clearReviewerKeyFromCredentialFile()
          if (fileClear === 'failed') {
            return json(400, { ok: false, error: 'credential clear failed on the shared credential file' })
          }
          return json(200, { ok: true })
        }
        const body = await readJson(request)
        if (method !== 'POST') {
          return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET, POST' })
        }
        if (!credentials) {
          return json(400, { ok: false, error: 'credential service unavailable' })
        }
        const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey) throw new TypeError('apiKey is required')
        await credentials.set(REVIEWER_CREDENTIAL_REF, apiKey)
        return json(200, { ok: true })
      } catch (error) {
        return json(400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
}



/**
 * Hold a response until `current()` changes or the hold budget elapses. The
 * check runs in-process (no HTTP traffic), the timer is released on client
 * disconnect (the request signal aborts), and the caller answers with the
 * current state either way — a hold timeout is a heartbeat, never a resolution.
 */
export function holdWhile(request: Request, current: () => unknown, holdMs: number): Promise<void> {
  const startedAt = Date.now()
  const initial = current()
  return new Promise((resolve) => {
    let done = false
    let timer: any
    const finish = () => {
      if (done) return
      done = true
      if (timer !== undefined) clearInterval(timer)
      request.signal.removeEventListener('abort', finish)
      resolve()
    }
    request.signal.addEventListener('abort', finish, { once: true })
    timer = setInterval(() => {
      if (done) return
      if (current() !== initial || Date.now() - startedAt >= holdMs) finish()
    }, 200)
  })
}



// Provider/model catalog for the Issue #5 model-source pickers. Read-only
// display metadata (adapter route ids + discovered models), no credentials and
// no adapter internals cross the wire (dsh-llm already detaches these). Sits
// on the same loopback-only plane as the settings card that consumes it.
export function installLlmCatalogRoutes(ctx: any, llm: any): void {
  registerCarrierFetchRoute(ctx, {
    path: PROVIDERS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: providers route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      try {
        const providers = (llm?.listProviders?.() ?? []).map((p: any) => ({ id: p.id, name: p.name ?? p.id }))
        return json(200, { ok: true, value: { providers } })
      } catch (error) {
        return json(400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
  registerCarrierFetchRoute(ctx, {
    path: LLM_MODELS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: llm-models route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      const url = new URL(request.url, 'http://x')
      const provider = url.searchParams.get('provider') ?? ''
      if (!provider) {
        return json(400, { ok: false, error: 'provider is required' })
      }
      try {
        const models = await llm.listModels(provider)
        return json(200, {
          ok: true,
          value: { models: models.map((m: any) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id })) },
        })
      } catch (error) {
        // Unregistered provider surfaces as NO_ADAPTER — a 400 with the
        // adapter's message beats a bare stack in the picker.
        return json(400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
  registerCarrierFetchRoute(ctx, {
    path: REASONING_EFFORTS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: reasoning-efforts route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      const url = new URL(request.url, 'http://x')
      const provider = url.searchParams.get('provider') ?? ''
      const model = url.searchParams.get('model') ?? ''
      if (!provider || !model) {
        return json(400, { ok: false, error: 'provider and model are required' })
      }
      try {
        // Resolve the exact model's metadata from its owning adapter — the
        // adapter's own declared reasoning efforts drive the picker, so the
        // plugin never maintains a per-provider effort table.
        const info = await llm.resolveModelInfo(provider, model)
        const reasoning = info?.reasoning
        const efforts = Array.isArray(reasoning?.efforts)
          ? reasoning.efforts.map((e: any) => ({ id: e.id, name: e.name ?? e.id }))
          : []
        return json(200, {
          ok: true,
          value: { efforts, defaultEffort: reasoning?.defaultEffort ?? null },
        })
      } catch (error) {
        // Unknown provider/model or an adapter without resolveModel support —
        // an empty effort list (default-only picker) beats a hard error here.
        return json(200, { ok: true, value: { efforts: [], defaultEffort: null } })
      }
  })
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
export function legacyScalar(text: string): { known: boolean; value?: unknown } {
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
export function legacyBlockList(items: readonly string[]): { known: boolean; value?: unknown } {
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
    if (Object.prototype.hasOwnProperty.call(declared, key) && !sameConfigValue(declared[key], factoryConfigDefaults[key])) continue
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
export function sameConfigValue(left: unknown, right: unknown, depth = 0): boolean {
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
export function declaredConfig(ctx: any): Record<string, unknown> | undefined {
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

export function installTestRoute(ctx: any, llm: any, endpointUrlFor: () => string = () => ''): void {
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
