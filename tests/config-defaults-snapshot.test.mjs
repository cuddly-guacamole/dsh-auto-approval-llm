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
import { plainConfigValue } from '../lib/auto/decision.js'

test('schema defaults snapshot: changing a default must be a reviewed diff', () => {
  const defaults = plainConfigValue(Config({}))
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
  const defaults = plainConfigValue(Config({}))
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

test('endpointProtocol: the default is unchanged and all four known values validate', () => {
  // This batch adds NO config keys and changes NO default. The protocol union
  // gained two values, so the count surface (58 keys) and the default ('openai')
  // must both stay exactly where they were; only the accepted vocabulary moved.
  const defaults = plainConfigValue(Config({}))
  assert.equal(defaults.endpointProtocol, 'openai', 'the default protocol is still openai')
  assert.equal(Object.keys(defaults).length, 58, 'no config key was added or removed')

  for (const protocol of ['openai', 'anthropic', 'responses', 'systemone']) {
    assert.equal(
      plainConfigValue(Config({ endpointProtocol: protocol })).endpointProtocol,
      protocol,
      `${protocol} must survive schema validation`,
    )
  }
})

test('endpointProtocol: an unknown value is refused by the schema, not silently defaulted', () => {
  // Measured: @deepseek-ai/schemastery THROWS on an unknown union value instead
  // of falling back to the default. That is why the zod union and the
  // TypeScript union have to change in the same edit — a value the schema has
  // not learned fails the whole config validation rather than degrading.
  assert.throws(
    () => plainConfigValue(Config({ endpointProtocol: 'no-such-protocol' })),
    /endpointProtocol/,
  )
})
