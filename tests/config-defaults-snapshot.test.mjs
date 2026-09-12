/**
 * dsh-auto-approval-llm · schema-defaults snapshot + patch pin consistency.
 *
 * The shipped cordis.patch.yml pins a subset of config keys; the settings
 * card's restore-defaults map hardcodes another subset. Both are silent until
 * they drift from the schema — a default change ripples into every new install
 * (pin) or every "restore defaults" click (client map) without any test
 * noticing. These snapshots make each drift an explicit, reviewed diff.
 * Run: node --test tests/config-defaults-snapshot.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Config } from '../lib/index.js'

test('schema defaults snapshot: changing a default must be a reviewed diff', () => {
  const defaults = Config({})
  assert.deepEqual(
    { ...defaults },
    {
      enabled: true,
      autoSwitchPolicyToAsk: false,
      debug: false,
      timeoutAction: 'reject',
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
      showSessionPanel: 'off',
      onboardingMessageEnabled: true,
      autoModeNoticeEnabled: true,
      breakerAntiHijackMs: 0,
      panelDelayMs: 3000,
      capsulePlacement: 'header',
      aiButtonPosition: 'header',
      workspaceRoot: '',
      dshHome: '',
      tempRoots: [],
      classifierTimeoutMs: 8000,
      classifierMaxOutputTokens: 1024,
      classifierSource: 'session',
      classifierProvider: '',
      classifierModel: '',
      reviewerSource: 'session',
      reviewerProvider: '',
      reviewerModel: '',
      reviewerMaxTokens: 2048,
      reviewerReasoning: '',
      classifierReasoning: '',
      endpointUrl: '',
      endpointModel: '',
      endpointProtocol: 'openai',
      reviewMaxRetries: 1,
      reviewWaitSeconds: 5,
      redactResults: false,
      reviewerContextFacts: false,
      editDiffPreview: false,
      rejectGuidance: false,
      maintenanceDshPaths: [],
      categoryPolicy: {},
      categoryMode: 'standard',
      privilegeAutoReview: false,
      protectedAutoReview: false,
      trustedDirs: [],
      trustedDshSubpaths: [],
      learningEnabled: false,
      learningThreshold: 3,
      directHumanEnabled: false,
      slashCommandsEnabled: false,
    },
    'a changed schema default ships to every new install — update this snapshot deliberately',
  )
})

test('patch pin consistency: the shipped insert pins match the schema defaults or the documented overrides', () => {
  // The patch pin block (comment-stripped rows under the insert config) must
  // equal these values: "equals code default" rows drift loudly, and the one
  // documented override (autoSwitchPolicyToAsk) stays deliberate.
  const lines = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
  const insertAt = lines.findIndex((line) => /^- insert:/.test(line))
  const block = lines.slice(insertAt).join('\n')
  const defaults = Config({})
  // The one pin that deliberately diverges from the schema default: shipping
  // the never->ask policy guard ON so a bundle install cannot run the auto
  // preset unapproved. Every other pin below must equal BOTH the schema default
  // and this table's value — the table used to be read for its keys only, so an
  // entry could rot to a stale literal while the patch and the schema drifted
  // together unnoticed.
  const OVERRIDES = {
    autoSwitchPolicyToAsk: true,
  }
  const pinned = {
    enabled: true,
    autoSwitchPolicyToAsk: true, // documented OVERRIDE of the schema default false
    timeoutAction: 'reject',
    allowlist: [],
    denyList: [],
    humanOnlyList: [],
    maxConsecutiveDenials: 3,
    maxTotalDenials: 20,
    maxArgsChars: 4000,
    notifyUser: true,
  }
  for (const [key, expected] of Object.entries(pinned)) {
    assert.ok(Object.hasOwn(defaults, key), `the pinned key ${key} must exist in the schema`)
    const m = new RegExp(`^\\s+${key}: (.+)$`, 'm').exec(block)
    assert.ok(m, `the patch must still pin ${key}`)
    const actual = m[1].trim()
    let parsed = actual
    if (actual === '[]') parsed = []
    else if (actual === 'true' || actual === 'false') parsed = actual === 'true'
    else if (/^-?\d+$/.test(actual)) parsed = Number(actual)
    else parsed = actual.replace(/^'(.*)'$/, '$1')
    if (Object.hasOwn(OVERRIDES, key)) {
      assert.deepEqual(parsed, OVERRIDES[key], `pin ${key} must carry the documented override`)
      assert.notDeepEqual(defaults[key], OVERRIDES[key], `the ${key} pin no longer overrides the schema default — drop it from OVERRIDES`)
      continue
    }
    // Both directions participate: the table must equal the schema default
    // (a stale literal reddens) and the patch must equal the table (an
    // undocumented override reddens).
    assert.deepEqual(expected, defaults[key], `the pinned table value for ${key} must equal the schema default`)
    assert.deepEqual(parsed, expected, `pin ${key} must equal the pinned table value`)
  }
})
