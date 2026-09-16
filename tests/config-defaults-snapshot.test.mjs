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
      loopDetectionThreshold: 0,
      notifyUser: true,
      showSessionPanel: 'auto',
      onboardingMessageEnabled: true,
      autoModeNoticeEnabled: true,
      breakerAntiHijackMs: 0,
      panelDelayMs: 3000,
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
      rejectGuidance: true,
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

test('patch pin consistency: every shipped insert pin equals its schema default', () => {
  // The patch pin block (comment-stripped rows under the insert config) must
  // equal these values. The retired autoSwitchPolicyToAsk guard is not pinned
  // at all: pinning it true would contradict the host-owned no-op contract.
  const lines = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
  const insertAt = lines.findIndex((line) => /^\s*- insert:/.test(line))
  assert.ok(insertAt !== -1, 'the shipped patch must carry the insert row')
  // The search domain is the insert block itself, read by indentation — not
  // "everything after the insert row": a later top-level row must not be able
  // to satisfy a pin.
  const base = lines[insertAt].length - lines[insertAt].trimStart().length
  const blockLines = []
  for (let i = insertAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '' && line.length - line.trimStart().length <= base) break
    blockLines.push(line)
  }
  const block = blockLines.join('\n')
  const defaults = Config({})
  const pinned = {
    enabled: true,
    timeoutAction: 'reject',
    allowlist: [],
    denyList: [],
    humanOnlyList: [],
    maxConsecutiveDenials: 3,
    maxTotalDenials: 20,
    maxArgsChars: 4000,
    notifyUser: true,
  }
  assert.doesNotMatch(block, /autoSwitchPolicyToAsk/, 'the retired guard key must not be pinned')
  for (const [key, expected] of Object.entries(pinned)) {
    assert.ok(Object.hasOwn(defaults, key), `the pinned key ${key} must exist in the schema`)
    const m = new RegExp('^[ ]+' + key + ':[ ]+(.+)$', 'm').exec(block)
    assert.ok(m, `the patch must still pin ${key}`)
    const actual = m[1].trim()
    let parsed = actual
    if (actual === '[]') parsed = []
    else if (actual === 'true' || actual === 'false') parsed = actual === 'true'
    else if (/^-?\d+$/.test(actual)) parsed = Number(actual)
    else parsed = actual.replace(/^'(.*)'$/, '$1')
    // Both directions participate: the table must equal the schema default
    // (a stale literal reddens) and the patch must equal the table (an
    // undocumented override reddens).
    assert.deepEqual(expected, defaults[key], `the pinned table value for ${key} must equal the schema default`)
    assert.deepEqual(parsed, expected, `pin ${key} must equal the pinned table value`)
  }
})
