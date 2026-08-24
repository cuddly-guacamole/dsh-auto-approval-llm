// One-command runtime verification of the plugin's trust boundary, with a
// guaranteed config restore (never leaves the mock-reviewer state behind).
//
//   node scripts/verify-runtime.mjs             # read-only: auth checks only
//   node scripts/verify-runtime.mjs --mock      # auth checks + start mock
//                                               # reviewer, apply mock config,
//                                               # drive the approval flow, then
//                                               # restore settings + stop mock
//
// The restore runs in `finally` and on SIGINT/SIGTERM, so Ctrl-C or an early
// exit always returns /settings to the captured snapshot. Without --mock the
// script performs no writes at all.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAuthChecks } from './verify-auth.mjs'

const HOST = '127.0.0.1'
const PORT = 3080
const SETTINGS_ROUTE = '/_dsh/auto-approval-llm/settings'
const here = dirname(fileURLToPath(import.meta.url))
const MOCK_REVIEWER = join(here, 'mock-reviewer.mjs')
// The learning store is plugin runtime state just like history/audit; the
// verification writes real confirmations, so back it up and restore it no
// matter how the run ends.
const LEARNING_FILE = join(dirname(here), 'learning.json')

// Runtime-verification payload (mirrors the old standalone verify-config-set.mjs).
// Deliberately puts the plugin into the mock-reviewer state so the approval
// flow can be reproduced; the orchestrator restores the snapshot afterwards.
const MOCK_CONFIG = {
  enabled: true,
  autoSwitchPolicyToAsk: true,
  debug: true,
  reviewerProvider: 'bogus-provider',
  reviewerModel: 'bogus-model',
  reviewerProtocol: 'openai',
  reviewerBaseUrl: 'http://127.0.0.1:18777',
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
  aiButtonPosition: 'header',
  classifierTimeoutMs: 8000,
  classifierMaxOutputTokens: 1024,
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request(
      { host: HOST, port: PORT, path, method, headers: { host: `${HOST}:${PORT}`, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
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

const getSettings = async () => (await request('GET', SETTINGS_ROUTE)).json?.value?.value ?? null

const putSettings = async (value) => {
  const snap = await request('GET', SETTINGS_ROUTE)
  const revision = snap.json?.value?.revision ?? 0
  const res = await request('POST', SETTINGS_ROUTE, { value, expectedRevision: revision })
  if (res.status !== 200) throw new Error(`settings POST failed (${res.status}): ${res.body}`)
  return res.json
}

async function main() {
  const wantMock = process.argv.includes('--mock')
  const before = await getSettings()
  if (!before) throw new Error('cannot snapshot current settings (is the plugin listening on 127.0.0.1:3080?)')
  console.log(`[verify-runtime] snapshot captured; mock=${wantMock}${wantMock ? '' : ' (read-only)'}`)

  let dirty = false
  let mock = null
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
    if (mock) { mock.kill(); mock = null }
  }
  process.on('SIGINT', () => { void restore().then(() => process.exit(130)) })
  process.on('SIGTERM', () => { void restore().then(() => process.exit(143)) })

  try {
    console.log('\n== auth boundary ==')
    const { pass, fail, results } = await runAuthChecks()
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  -> ${r.status} (expect ${r.expect})`)
    if (fail) throw new Error(`auth checks: ${fail} of ${results.length} failed`)

    if (wantMock) {
      mock = spawn(process.execPath, [MOCK_REVIEWER], { stdio: 'inherit' })
      await new Promise((r) => setTimeout(r, 600))
      await putSettings(MOCK_CONFIG)
      dirty = true
      console.log('\n[verify-runtime] mock reviewer up; mock config applied')
      console.log('[verify-runtime]   reviewerBaseUrl=127.0.0.1:18777  debug=true  timeoutAction=allow')
      console.log('[verify-runtime] drive the approval flow now — settings auto-restore in 90s or on Ctrl-C')
      await new Promise((r) => setTimeout(r, 90_000))
    }
    console.log('\n[verify-runtime] done')
  } finally {
    if (dirty) await restore()
  }
}

await main()
