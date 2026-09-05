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
      trustedDirs: [],
      trustedDshSubpaths: [],
      learningEnabled: false,
      learningThreshold: 3,
      directHumanEnabled: false,
    },
    'a changed schema default ships to every new install — update this snapshot deliberately',
  )
})

test('patch pin consistency: the shipped insert pins match the schema defaults or the documented overrides', () => {
  // The patch pin block (comment-stripped rows under the insert config) must
  // equal these values: "equals code default" rows drift loudly, and the two
  // documented overrides (autoSwitchPolicyToAsk, timeoutAction per patch) stay
  // deliberate.
  const lines = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
  const insertAt = lines.findIndex((line) => /^- insert:/.test(line))
  const block = lines.slice(insertAt).join('\n')
  const defaults = Config({})
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
    const m = new RegExp(`^\\s+${key}: (.+)$`, 'm').exec(block)
    assert.ok(m, `the patch must still pin ${key}`)
    const actual = m[1].trim()
    let parsed = actual
    if (actual === '[]') parsed = []
    else if (actual === 'true' || actual === 'false') parsed = actual === 'true'
    else if (/^-?\d+$/.test(actual)) parsed = Number(actual)
    else parsed = actual.replace(/^'(.*)'$/, '$1')
    if (key === 'autoSwitchPolicyToAsk') {
      assert.equal(parsed, true, 'the never->ask guard override must stay on')
      continue
    }
    assert.deepEqual(parsed, defaults[key], `pin ${key} must equal the schema default (or be a deliberate override)`)
  }
})
