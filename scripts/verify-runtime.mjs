// One-command runtime verification of the plugin's trust boundary, with a
// guaranteed config restore (never leaves the mock-reviewer state behind).
//
//   node scripts/verify-runtime.mjs                        # no session: composed-fence auth checks only
//   node scripts/verify-runtime.mjs --url '<startup-url>'  # auth + settings snapshot/restore
//   node scripts/verify-runtime.mjs --url '<startup-url>' --mock
//                                               # + start mock reviewer, apply mock
//                                               # config, drive the approval flow, then
//                                               # restore settings + stop mock
//
// The web carrier authenticates /api before the plugin handler runs, so the
// settings/approval rounds need a session: pass the launch URL (operator shell)
// or --cookie-file. The restore runs in `finally` and on SIGINT/SIGTERM, so
// Ctrl-C or an early exit always returns the settings to the captured snapshot.
// Without --mock the script performs no writes at all.
//
// The settings round writes through the host settings plane — the same Typert
// Remote endpoint the host settings page uses (`POST /api/settings/mutate` on
// the shared /api channel), with the plugin's own configuration namespace as
// its target. The host owns that write and persists it into the current
// profile's Cordis patch, so the verification never becomes a second
// configuration owner. The plugin's own settings route stays read-only and is
// used for the pre-run snapshot and for the post-restore re-read. Field edits
// are path ops, and the set of writable fields comes from the host's own
// describe answer: keys the host does not expose as editable (host-owned keys)
// are never sent and are reported instead.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { runAuthChecks, parseAuthArgs, exchangeToken, readCookieFile } from './verify-auth.mjs'

let TARGET_HOST = '127.0.0.1'
let TARGET_PORT = 3080
let AUTHORITY = '127.0.0.1:3080'
let SESSION_COOKIE = null
const SETTINGS_ROUTE = '/api/auto-approval-llm/settings'
const CREDENTIAL_ROUTE = '/api/auto-approval-llm/reviewer-credential'
// Host settings plane: the profile entry id is the namespace key, and the
// endpoint path is the shared /api channel plus the Remote `namespace/method`.
const SETTINGS_NS = 'auto-approval-llm'
const API_CHANNEL = '/api/'
const HOST_SETTINGS_DESCRIBE = `${API_CHANNEL}settings/describe`
const HOST_SETTINGS_MUTATE = `${API_CHANNEL}settings/mutate`
const here = dirname(fileURLToPath(import.meta.url))
const MOCK_REVIEWER = join(here, 'mock-reviewer.mjs')

/**
 * Where the plugin's runtime files live: `<DSH_HOME>/auto-approval-llm/`, with the
 * two earlier layouts read as a migration chain (`<plugin root>/runtime/` then the
 * package root). Prefer whichever exists and report the canonical path when none
 * does. A verification helper must not depend on the plugin's build output, so
 * the rule is repeated here rather than imported from `lib/`.
 */
function runtimeOrDefault(name) {
  const root = join(here, '..')
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const canonical = join(dshHome, 'auto-approval-llm', name)
  if (existsSync(canonical)) return canonical
  for (const dir of [join(root, 'runtime'), root]) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return canonical
}

// The learning store is plugin runtime state just like history/audit; the
// verification writes real confirmations, so back it up and restore it no
// matter how the run ends.
const LEARNING_FILE = runtimeOrDefault('learning.json')
// Mock reviewer must be reachable by the online-reviewer path, which requires
// the configured credential (three-piece gate: baseUrl+model+key). The key is
// written to the credential store for the mock round and deleted on restore.
// Overridable via DSH_VERIFY_MOCK_KEY (a deployed secret must never sit in
// this repo).
const MOCK_API_KEY = process.env.DSH_VERIFY_MOCK_KEY ?? 'dsh-verify-mock-key'

// Runtime-verification payload (mirrors the old standalone verify-config-set.mjs).
// Deliberately puts the plugin into the mock-reviewer state so the approval
// flow can be reproduced; the orchestrator restores the snapshot afterwards.
// The deep-review lane rides the shared custom endpoint (mock reviewer). Keys
// the host config plane does not expose as editable are carried for
// completeness and reported as untouched by the settings round.
export const MOCK_CONFIG = {
  enabled: true,
  debug: true,
  reviewerSource: 'endpoint',
  reviewerProvider: '',
  reviewerModel: '',
  endpointProtocol: 'openai',
  endpointUrl: 'http://127.0.0.1:18777',
  endpointModel: 'mock-model',
  timeoutAction: 'allow',
  llmReviewScope: 'low-or-above',
  llmTakeoverScope: 'medium-or-below',
  defaultReviewMode: 'smart',
  lowRiskSeconds: 5,
  mediumRiskSeconds: 8,
  highRiskSeconds: 10,
  safetyPrompt: '',
  allowlist: [],
  denyList: [],
  humanOnlyList: [],
  rulesText: '',
  rulesDryRun: false,
  maxConsecutiveDenials: 3,
  maxTotalDenials: 20,
  maxArgsChars: 4000,
  notifyUser: true,
  showSessionPanel: 'auto',
  breakerAntiHijackMs: 0,
  classifierTimeoutMs: 8000,
  classifierMaxOutputTokens: 1024,
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, path, method, headers: { host: AUTHORITY, 'content-type': 'application/json', ...(SESSION_COOKIE ? { cookie: SESSION_COOKIE } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let out = ''
        res.on('data', (c) => (out += c))
        res.on('end', () => {
          let json = null
          try { json = JSON.parse(out) } catch { json = null }
          resolve({ status: res.statusCode, json, body: out })
        })
      },
    )
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

/** Point the helper at one carrier session; the CLI wires this from its flags. */
export function useSession({ host, port, authority, cookie } = {}) {
  if (host !== undefined) TARGET_HOST = host
  if (port !== undefined) TARGET_PORT = port
  if (authority !== undefined) AUTHORITY = authority
  if (cookie !== undefined) SESSION_COOKIE = cookie
}

let rpcSeq = 0

/**
 * One Remote call on the shared /api channel: POST the envelope the carrier's
 * own client sends, and surface a refusal as an error instead of a status code
 * (the endpoint answers `result.ok === false` with HTTP 200).
 */
async function remoteCall(path, args) {
  const method = path.slice(API_CHANNEL.length)
  const rpcId = `verify-runtime-${(rpcSeq += 1)}`
  const res = await request('POST', path, { type: 'client-request', rpcId, method, payload: { args } })
  if (res.status !== 200) throw new Error(`${method} failed (HTTP ${res.status}): ${res.body}`)
  const result = res.json?.result
  if (result?.ok !== true) {
    // A Remote refusal is validated before the provider writes, so the caller
    // can tell "nothing happened" apart from an unknown transport outcome.
    const refused = new Error(`${method} refused: ${JSON.stringify(result?.error ?? res.body)}`)
    refused.refused = true
    throw refused
  }
  return result.value
}

/** The plugin's namespace view from the host settings plane. */
async function hostSettingsView() {
  const value = await remoteCall(HOST_SETTINGS_DESCRIBE, {})
  const view = (value?.namespaces ?? []).find((row) => row.ns === SETTINGS_NS)
  if (view === undefined) {
    throw new Error(`the host settings plane lists no namespace "${SETTINGS_NS}": its profile entry must be active and carry card-owned fields`)
  }
  return view
}

/** Top-level field names of a described form. The wire schema is a schemastery graph: {uid, refs}. */
function settingsFieldNames(view) {
  const wire = view?.schema
  const root = wire?.refs?.[String(wire?.uid)] ?? wire
  return Object.keys(root?.dict ?? {})
}

const getSettings = async () => {
  const res = await request('GET', SETTINGS_ROUTE)
  if (res.status !== 200) {
    throw new Error(`cannot snapshot current settings (HTTP ${res.status}): the web carrier requires a session — pass --url <startup-url> or --cookie-file <file>`)
  }
  return res.json?.value?.value ?? null
}

/**
 * Build the mock-reviewer edit without writing it, so the caller can arm its
 * rollback first. The writable field set is the host's own answer, and the
 * captured stored section is what a rollback puts back.
 */
export async function planMockSettings() {
  const view = await hostSettingsView()
  const editable = new Set(settingsFieldNames(view))
  if (editable.size === 0) {
    throw new Error(`the host settings plane exposes no editable field for namespace "${SETTINGS_NS}"`)
  }
  const ops = []
  const untouched = []
  for (const [key, value] of Object.entries(MOCK_CONFIG)) {
    if (editable.has(key)) ops.push({ op: 'set', path: [key], value })
    else untouched.push(key)
  }
  if (ops.length === 0) throw new Error(`the mock config shares no field with "${SETTINGS_NS}"`)
  return {
    ops,
    untouched,
    revision: view.revision,
    snapshot: { fields: ops.map((op) => op.path[0]), user: view.user ?? {} },
  }
}

/** Apply a planned edit and confirm the host resolved every written field. */
export async function commitMockSettings(plan) {
  await remoteCall(HOST_SETTINGS_MUTATE, { ns: SETTINGS_NS, ops: plan.ops, expectedRevision: plan.revision })
  const after = await hostSettingsView()
  const notApplied = plan.snapshot.fields.filter((key) => !isDeepStrictEqual(after.value?.[key], MOCK_CONFIG[key]))
  if (notApplied.length > 0) {
    throw new Error(`the host settings plane did not apply: ${notApplied.join(', ')}`)
  }
}

/**
 * Put every field the mock run wrote back to its pre-run stored state: a field
 * the stored section carried is restored to that value, and one the run
 * introduced is unset so the host resolves it from the inherited layer again.
 * The write is unconditional on purpose — a rollback must not be blocked by a
 * concurrent revision bump.
 */
export async function restoreSettings(snapshot) {
  if (snapshot === null || snapshot.fields.length === 0) return
  const ops = snapshot.fields.map((key) => Object.hasOwn(snapshot.user, key)
    ? { op: 'set', path: [key], value: snapshot.user[key] }
    : { op: 'unset', path: [key] })
  await remoteCall(HOST_SETTINGS_MUTATE, { ns: SETTINGS_NS, ops })
}

/**
 * Re-read the pre-run fields through the plugin's read-only route and report
 * the ones that did not come back, so a rollback that silently missed a field
 * is visible instead of passing as a clean exit.
 */
export async function driftedAfterRestore(snapshot, before) {
  const back = await getSettings()
  return (snapshot?.fields ?? []).filter((key) => !isDeepStrictEqual(back?.[key], before?.[key]))
}

// Make the online-reviewer three-piece gate (baseUrl+model+key) complete for
// the mock round. No-op when the store already reports configured.
const setupMockCredential = async () => {
  const info = (await request('GET', CREDENTIAL_ROUTE)).json?.value
  if (!info) return 'unavailable'
  if (info.configured) return 'already'
  if (info.writable !== true) return 'readonly'
  const res = await request('POST', CREDENTIAL_ROUTE, { apiKey: MOCK_API_KEY })
  if (res.status !== 200) return 'write-failed'
  return 'written'
}

const clearMockCredential = async () => {
  try {
    const res = await request('DELETE', CREDENTIAL_ROUTE)
    if (res.status === 200) console.log('[verify-runtime] mock credential cleared')
    else console.error(`[verify-runtime] credential clear failed (${res.status}): ${res.body}`)
  } catch (e) {
    console.error('[verify-runtime] credential clear error:', e.message)
  }
}

async function main() {
  const args = parseAuthArgs(process.argv.slice(2))
  const wantMock = process.argv.includes('--mock')
  if (args.url !== undefined) {
    const session = await exchangeToken(args.url)
    useSession({ cookie: session.cookie, authority: session.authority, host: session.host, port: session.port })
  } else if (args.cookieFile !== undefined) {
    useSession({
      cookie: readCookieFile(args.cookieFile),
      ...(args.host === undefined ? {} : { host: args.host, authority: `${args.host}:${args.port ?? 3080}` }),
      ...(args.port === undefined ? {} : { port: args.port }),
    })
  }
  const authenticated = SESSION_COOKIE !== null

  console.log('\n== auth boundary ==')
  const auth = await runAuthChecks({ host: TARGET_HOST, port: TARGET_PORT, cookie: SESSION_COOKIE, authenticated, authority: AUTHORITY })
  for (const r of auth.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  -> ${r.status} (expect ${r.expect})`)
  if (auth.fail) throw new Error(`auth checks: ${auth.fail} of ${auth.results.length} failed`)
  if (!authenticated) {
    console.log('[verify-runtime] no session: composed-fence auth checks only. Pass --url <startup-url> or --cookie-file <file> for the settings/approval rounds.')
    return
  }

  const before = await getSettings()
  console.log(`[verify-runtime] snapshot captured; mock=${wantMock}${wantMock ? '' : ' (read-only)'}`)

  let dirty = false
  let mock = null
  let credentialWritten = false
  let settingsSnapshot = null
  // learning.json snapshot (binary copy) taken before any write and restored
  // in every exit path; a file that did not exist before is removed again.
  const learningBackup = join(here, `.learning.verify-backup-${process.pid}`)
  const hadLearning = existsSync(LEARNING_FILE)
  if (hadLearning) copyFileSync(LEARNING_FILE, learningBackup)
  const restoreLearning = () => {
    try {
      if (hadLearning) copyFileSync(learningBackup, LEARNING_FILE)
      else if (existsSync(LEARNING_FILE)) rmSync(LEARNING_FILE)
      if (existsSync(learningBackup)) rmSync(learningBackup)
    } catch (e) {
      console.error('[verify-runtime] RESTORE FAILED for learning.json (manual revert needed):', e.message)
    }
  }
  const restore = async () => {
    console.log('[verify-runtime] restoring settings to pre-run state…')
    try {
      await restoreSettings(settingsSnapshot)
      let drifted = []
      try {
        drifted = await driftedAfterRestore(settingsSnapshot, before)
      } catch (e) {
        console.warn('[verify-runtime] WARN: could not re-read the pre-run snapshot:', e.message)
      }
      if (drifted.length === 0) console.log('[verify-runtime] settings restored ok')
      else console.warn(`[verify-runtime] WARN: the pre-run snapshot and the re-read differ for: ${drifted.join(', ')} — check the plugin settings page`)
    } catch (e) {
      console.error('[verify-runtime] RESTORE FAILED (manual revert needed):', e.message)
    }
    restoreLearning()
    if (credentialWritten) await clearMockCredential()
    if (mock) { mock.kill(); mock = null }
  }
  process.on('SIGINT', () => { void restore().then(() => process.exit(130)) })
  process.on('SIGTERM', () => { void restore().then(() => process.exit(143)) })

  try {
    if (wantMock) {
      mock = spawn(process.execPath, [MOCK_REVIEWER], { stdio: 'inherit' })
      await new Promise((r) => setTimeout(r, 600))
      const cred = await setupMockCredential()
      credentialWritten = cred === 'written'
      if (cred === 'unavailable') console.warn('[verify-runtime] WARN: credential route unavailable — reviewer falls back to the session model')
      else if (cred === 'readonly') console.warn('[verify-runtime] WARN: credential store read-only — endpoint reviews will fail loudly (no key)')
      else if (cred === 'write-failed') console.warn('[verify-runtime] WARN: credential write failed — endpoint reviews will fail loudly (no key)')
      else console.log(`[verify-runtime] mock credential: ${cred}`)
      const plan = await planMockSettings()
      // Arm the rollback before the write is issued: a request that lands while
      // its answer is lost must not strand the mock payload. A refusal is the
      // exception — the host validated before writing, so there is nothing to
      // roll back and the captured section is dropped again.
      settingsSnapshot = plan.snapshot
      dirty = true
      try {
        await commitMockSettings(plan)
      } catch (error) {
        if (error?.refused === true) { settingsSnapshot = null; dirty = false }
        throw error
      }
      console.log('\n[verify-runtime] mock reviewer up; mock config applied through the host settings plane')
      console.log('[verify-runtime]   reviewerSource=endpoint endpointUrl=127.0.0.1:18777  debug=true  timeoutAction=allow')
      if (plan.untouched.length > 0) console.log(`[verify-runtime]   host-owned keys left untouched: ${plan.untouched.join(', ')}`)
      console.log('[verify-runtime] drive the approval flow now — settings auto-restore in 90s or on Ctrl-C')
      await new Promise((r) => setTimeout(r, 90_000))
    }
    console.log('\n[verify-runtime] done')
  } finally {
    if (dirty) await restore()
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main()
