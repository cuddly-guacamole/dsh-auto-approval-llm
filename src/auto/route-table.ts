/**
 * dsh-auto-approval-llm · web route table + settings/credential constants.

 * The single place the plugin's HTTP surface is spelled: one constant per
 * route under the plugin prefix, plus the settings namespace, the first-read
 * retry budget and the reviewer credential ref. The route installers (both
 * the ones that stayed in the entry and the ones in `route-installers.ts`)
 * import these by name, so a route cannot be registered under a path the
 * client, the docs and the fetch fence do not agree on.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── same-origin feedback route ────────────────────────────────────────────
// The browser client cannot use `host.call` here (this is a static bundle, not
// a dynamic Cordis Package). Instead it POSTs the timeout marker to this route
// immediately before answering the approval, so `tools/post-execute` can tell
// an automatic timeout apart from a deliberate user rejection.
export const FEEDBACK_ROUTE = '/api/auto-approval-llm/feedback'
export const SETTINGS_ROUTE = '/api/auto-approval-llm/settings'
export const REVIEWER_CREDENTIAL_ROUTE = '/api/auto-approval-llm/reviewer-credential'
export const HISTORY_ROUTE = '/api/auto-approval-llm/history'
export const LLM_LATENCY_ROUTE = '/api/auto-approval-llm/llm-latency'
export const TOOL_STATS_ROUTE = '/api/auto-approval-llm/tool-stats'
export const TEST_ROUTE = '/api/auto-approval-llm/test'
export const SESSION_MODE_ROUTE = '/api/auto-approval-llm/session-mode'
export const REVIEW_STATUS_ROUTE = '/api/auto-approval-llm/review-status'
export const SESSION_REVIEW_STATUS_ROUTE = '/api/auto-approval-llm/session-review-status'
export const REVEAL_ROUTE = '/api/auto-approval-llm/reveal-approval'
export const STATS_ROUTE = '/api/auto-approval-llm/stats'
// Provider/model catalog feeds the Issue #5 model-source pickers in the
// settings card. Named llm-models (not /models) so the retired /models route
// — whose anti-resurrection anchor pins the exact string in the compiled host —
// stays gone; these are new live consumers for a new UI, not a resurrection.
export const PROVIDERS_ROUTE = '/api/auto-approval-llm/providers'
export const LLM_MODELS_ROUTE = '/api/auto-approval-llm/llm-models'
export const REASONING_EFFORTS_ROUTE = '/api/auto-approval-llm/reasoning-efforts'
export const LEARNING_STORE_ROUTE = '/api/auto-approval-llm/learning-store'
export const SETTINGS_NS = 'auto-approval-llm' as any
// Budget for the first stored-config read. `settings.describe()` lists only the
// entries whose fiber is ACTIVE, and this plugin's own fiber reaches ACTIVE only
// after apply() returns, so the read cannot succeed synchronously; a sibling
// entry or a config reload can push the transition later still. The first read
// is retried on a fixed cadence until the row appears, bounded so a host that
// never projects the row cannot become a poll loop: the first attempt runs on
// the next tick, the rest every SETTINGS_FIRST_READ_RETRY_MS, and the budget is
// spent after SETTINGS_FIRST_READ_MAX_ATTEMPTS attempts (worst case ≈ 2s).
export const SETTINGS_FIRST_READ_RETRY_MS = 50
export const SETTINGS_FIRST_READ_MAX_ATTEMPTS = 40
// Raised when the budget is spent without a readable row: the card surfaces it,
// so "the settings page shows shipped defaults" is distinguishable from "the
// stored configuration was read and really is those defaults".
export const SETTINGS_UNAVAILABLE_ERROR =
  'settings plane unavailable: the host never listed this plugin entry, so the stored configuration could not be read; running on the shipped defaults'

// The online-reviewer API key lives in the DSH credential store (env-var
// reference name), never in the settings value — the UI only ever sees
// `configured`, never the secret. Resolved per operation, not cached.
export const REVIEWER_CREDENTIAL_REF = 'DSH_AUTO_APPROVAL_REVIEWER_API_KEY'

/**
 * Parse the `DSH_AUTO_APPROVAL_REVIEWER_API_KEY: <value>` line out of the
 * shared credential file text. Pure so the fallback parsing is contract-tested.
 * Handles the two spellings users actually write: bare `sk-...` and a value
 * wrapped in single/double quotes (`"sk-..."`), stripping the closing quote so
 * a quoted YAML value never ships a trailing quote character as part of the
 * key.
 */
export function extractReviewerKeyLine(text: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*${REVIEWER_CREDENTIAL_REF}\\s*:\\s*["']?(sk-[^\\s]+)`, 'm'))
  if (!match) return undefined
  return match[1].replace(/["']+$/, '')
}

/** Best-effort fallback: read the reviewer key from the shared DSH credential
 * file (`~/.dsh/.credentials.yaml`) when the credentials service is not
 * reachable from the plugin scope. Never throws; returns undefined if absent. */
export function reviewerKeyFromCredentialFile(): string | undefined {
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
        const key = extractReviewerKeyLine(text)
        if (key !== undefined) return key
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
 * touches any other ref line.
 *
 * Tri-state on purpose: the route must not answer 200 while the key it claims
 * to have cleared is still readable there — `resolveReviewerApiKey` falls back
 * to this file on the next review, so a failed removal means the key stays live
 * and keeps being sent. `absent` (no readable candidate carries the ref) is a
 * success; `failed` (the ref is present and could not be removed) is not. */
export function clearReviewerKeyFromCredentialFile(): 'cleared' | 'absent' | 'failed' {
  const candidates = [
    process.env.DSH_HOME ? join(process.env.DSH_HOME, '.credentials.yaml') : '',
    join(homedir(), '.dsh', '.credentials.yaml'),
  ]
  let failed = false
  for (const file of candidates) {
    const result = clearReviewerKeyInFile(file)
    if (result === 'cleared') return 'cleared'
    if (result === 'failed') failed = true
  }
  return failed ? 'failed' : 'absent'
}

/**
 * Remove the reviewer ref line from ONE credential file.
 *
 * Tri-state on purpose: the route must not answer 200 while the key it claims
 * to have cleared is still readable there — `resolveReviewerApiKey` falls back
 * to this file on the next review, so a failed removal means the key stays live
 * and keeps being sent. 'absent' (no such line, or an unreadable file) is a
 * success; 'failed' (the line is present and could not be rewritten) is not.
 * Takes the path so the verdict is contract-testable without touching the
 * machine's real credential file.
 */
export function clearReviewerKeyInFile(file: string): 'cleared' | 'absent' | 'failed' {
  if (!file) return 'absent'
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 'absent'
  }
  const pattern = new RegExp(`^\\s*${REVIEWER_CREDENTIAL_REF}\\s*:.*$`, 'm')
  if (!pattern.test(text)) return 'absent'
  try {
    // The credentials file is shared across providers; rewrite it through the
    // atomic path so a crash mid-clear cannot truncate the whole store.
    atomicWriteFile(file, text.replace(pattern, ''))
  } catch {
    return 'failed'
  }
  return 'cleared'
}


/**
 * Write `content` to `file` through a same-directory temp file and a rename,
 * so a crash between truncate and write can never leave the target truncated.
 * On failure the temp file is removed and the previous content stays
 * untouched — fail-closed: prefer stale data over lost data.
 */
export function atomicWriteFile(file: string, content: string): void {
  const tmp = `${file}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, file)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Best-effort cleanup; the original file is unchanged.
    }
    throw error
  }
}
