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
// Ctrl-C or an early exit always returns /settings to the captured snapshot.
// Without --mock the script performs no writes at all.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAuthChecks, parseAuthArgs, exchangeToken, readCookieFile } from './verify-auth.mjs'

let TARGET_HOST = '127.0.0.1'
let TARGET_PORT = 3080
let AUTHORITY = '127.0.0.1:3080'
let SESSION_COOKIE = null
const SETTINGS_ROUTE = '/api/auto-approval-llm/settings'
const CREDENTIAL_ROUTE = '/api/auto-approval-llm/reviewer-credential'
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
// The deep-review lane rides the shared custom endpoint (mock reviewer).
const MOCK_CONFIG = {
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

const getSettings = async () => {
  const res = await request('GET', SETTINGS_ROUTE)
  if (res.status !== 200) {
    throw new Error(`cannot snapshot current settings (HTTP ${res.status}): the web carrier requires a session — pass --url <startup-url> or --cookie-file <file>`)
  }
  return res.json?.value?.value ?? null
}

const putSettings = async (value) => {
  const snap = await request('GET', SETTINGS_ROUTE)
  const revision = snap.json?.value?.revision ?? 0
  const res = await request('POST', SETTINGS_ROUTE, { value, expectedRevision: revision })
  if (res.status !== 200) throw new Error(`settings POST failed (${res.status}): ${res.body}`)
  return res.json
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
    SESSION_COOKIE = session.cookie
    AUTHORITY = session.authority
    TARGET_HOST = session.host
    TARGET_PORT = session.port
  } else if (args.cookieFile !== undefined) {
    SESSION_COOKIE = readCookieFile(args.cookieFile)
    if (args.host !== undefined) {
      TARGET_HOST = args.host
      AUTHORITY = `${args.host}:${args.port ?? 3080}`
    }
    if (args.port !== undefined) TARGET_PORT = args.port
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
      await putSettings(before)
      console.log('[verify-runtime] settings restored ok')
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
      await putSettings(MOCK_CONFIG)
      dirty = true
      console.log('\n[verify-runtime] mock reviewer up; mock config applied')
      console.log('[verify-runtime]   reviewerSource=endpoint endpointUrl=127.0.0.1:18777  debug=true  timeoutAction=allow')
      console.log('[verify-runtime] drive the approval flow now — settings auto-restore in 90s or on Ctrl-C')
      await new Promise((r) => setTimeout(r, 90_000))
    }
    console.log('\n[verify-runtime] done')
  } finally {
    if (dirty) await restore()
  }
}

await main()
