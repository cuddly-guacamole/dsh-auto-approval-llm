/**
 * Agent Teams built-in allow-plane contract tests.
 *
 * The Agent Teams tool package (@deepseek-ai/dsh-experimental-tool-agent-team)
 * registers nine model-facing tools. Four of them already sat in the built-in
 * allow plane as orchestration names; the shared-task-board tools and the
 * teammate spawner did not, so an Auto session had to escalate calls that only
 * mutate workspace-local team coordination state.
 *
 * The allow plane is hand-maintained in three places that must agree:
 *   - policy.ts   — the actual allow plane (assessTool -> 'allow', no argument
 *                   inspection, no approval request, no countdown, no reviewer)
 *   - category.ts — the 'harnessInternal' label, which is what keeps the call
 *                   out of the category-tightening path
 *   - constants.ts — the settings-card display catalog
 * Keeping them in step by hand is exactly what `policy -> catalog` drift
 * exploits: a name allowed by policy but absent from the catalog is allowed
 * yet invisible in the UI. The cross-copy test below reads the compiled
 * modules and compares all three, so it also covers names added later.
 *
 * Negative cases matter as much as positive ones: a name that merely looks
 * like a team tool must not ride in on the same change, and non-tool
 * identifiers from the package (a system-prompt section id, event names) must
 * never be admitted as tools.
 *
 * Run: node --test tests/agent-team-tools-allow.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ALLOW_TOOL_GROUPS, DEFAULT_ALLOW_TOOLS } from '../lib/auto/constants.js'
import { assessTool } from '../lib/auto/policy.js'
import { categorizeTool, categoryDirective } from '../lib/auto/category.js'
import { RISK_NAME_PATTERN } from '../lib/auto/risk-tokens.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
const artifacts = { has: () => false }

const verdict = (name) => assessTool({ name, arguments: {} }, roots, artifacts)
const label = (name) => categorizeTool({ name, arguments: {} }, roots)
const libSource = (rel) => readFileSync(fileURLToPath(new URL(`../lib/${rel}`, import.meta.url)), 'utf8')

/**
 * String literals inside a `const NAME = new Set([...])` region of compiled
 * output. Formatting-agnostic on purpose: only the quoted members are read, so
 * a compiler reflow cannot break the anchor.
 */
function setMembers(source, name) {
  const at = source.indexOf(`const ${name} = new Set([`)
  assert.notEqual(at, -1, `${name} present in the compiled module`)
  const open = source.indexOf('[', at)
  const close = source.indexOf(']', open)
  assert.notEqual(close, -1, `${name} set is closed`)
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Same, for one group's `tools: [...]` array in the display catalog. */
function groupMembers(source, label_) {
  const at = source.indexOf(`label: '${label_}'`)
  assert.notEqual(at, -1, `catalog group '${label_}' present`)
  const open = source.indexOf('[', source.indexOf('tools: [', at))
  const close = source.indexOf(']', open)
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Same, for an inline `if ([...])` array in the compiled policy. */
function inlineMembers(source, firstMember) {
  const at = source.indexOf(`['${firstMember}'`)
  assert.notEqual(at, -1, `inline array starting with ${firstMember} present in the compiled policy`)
  const close = source.indexOf(']', at)
  return [...source.slice(at, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const sorted = (names) => [...names].sort()

/**
 * The allow plane, enumerated from the module that decides it. Reading the
 * compiled policy rather than the catalog is deliberate: the catalog is the
 * display mirror, and this file exists to make the two impossible to drift
 * apart.
 */
function allowPlaneNames(policySrc) {
  return [...new Set([
    ...setMembers(policySrc, 'SESSION_STATE_TOOLS'),
    ...setMembers(policySrc, 'HARNESS_READ_TOOLS'),
    ...setMembers(policySrc, 'OWNER_CONTROL_TOOLS'),
    ...setMembers(policySrc, 'AGENT_TEAMS_CONTROL_TOOLS'),
    ...inlineMembers(policySrc, 'web_search'),
    ...inlineMembers(policySrc, 'subagent'),
  ])]
}

/**
 * Families whose members the category layer labels harnessInternal, paired with
 * the policy carrier and the catalog group that must agree on them.
 */
const HARNESS_FAMILIES = [
  { group: 'Session & control', policySet: 'SESSION_STATE_TOOLS', categorySet: 'SESSION_STATE_TOOLS' },
  { group: 'Read-only Harness', policySet: 'HARNESS_READ_TOOLS', categorySet: 'HARNESS_READ_TOOLS' },
  { group: 'Owner lifecycle control', policySet: 'OWNER_CONTROL_TOOLS', categorySet: 'OWNER_CONTROL_TOOLS' },
  { group: 'AgentTeams coordination', policySet: 'AGENT_TEAMS_CONTROL_TOOLS', categorySet: 'AGENT_TEAMS_CONTROL_TOOLS' },
  { group: 'Orchestration', policySet: null, categorySet: 'ORCHESTRATION_TOOLS' },
]

/**
 * The read-only external lookup family is the documented exception: it has no
 * category set, and its members get their labels from explicit branches. Pinned
 * here so the exception stays intentional rather than drifting into "forgotten".
 */
const EXTERNAL_LOOKUP_LABELS = new Map([
  ['web_search', 'networkExec'],
  ['web_fetch', 'networkExec'],
  ['time', 'readOnly'],
  ['weather', 'readOnly'],
])

/**
 * Names whose membership in the allow plane is evaluated BEFORE the name-based
 * risk escalation, so the escalation can never fire for them. Existing entries
 * are acknowledged exceptions; a new one must be added here on purpose, with a
 * reason, instead of silently inheriting the suppression.
 */
const RISK_TOKEN_EXCEPTIONS = new Map([
  ['send_message', 'the token is the verb "send"; the tool posts to the durable peer mailbox, not to an external service'],
  ['agent_teams_send_message', 'same mailbox semantics under the retired agent_teams_* spelling'],
  ['agent_teams_remove_member', 'removes a member from the in-memory roster, not a file or an account'],
  ['agent_teams_delete', 'archives team state instead of erasing it (upstream tombstone)'],
])

/** The nine tools the installed Agent Teams package actually registers. */
const REGISTERED_TEAM_TOOLS = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
]

/** The five that were missing from the built-in allow plane before this change. */
const NEWLY_ALLOWED_TEAM_TOOLS = [
  'spawn_teammate',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
]

test('allow plane: the shared-task board and the teammate spawner are statically allowed', () => {
  const failures = []
  for (const name of NEWLY_ALLOWED_TEAM_TOOLS) {
    const result = verdict(name)
    if (result.decision !== 'allow' || result.classifierEligible !== false) {
      failures.push(`${name} -> ${result.decision} (classifierEligible=${result.classifierEligible}): ${result.reason}`)
    }
  }
  assert.deepEqual(failures, [], `not statically allowed:\n${failures.join('\n')}`)
})

test('allow plane: every registered Agent Teams tool is allowed, not just the new ones', () => {
  for (const name of REGISTERED_TEAM_TOOLS) {
    assert.equal(verdict(name).decision, 'allow', name)
  }
})

test('category layer: every registered Agent Teams tool is harnessInternal', () => {
  for (const name of REGISTERED_TEAM_TOOLS) {
    assert.equal(label(name), 'harnessInternal', name)
  }
})

test('category layer: the label suppresses the name-based risk escalation', () => {
  // This is the discriminating probe for the label. `categoryDirective`
  // returns 'inherit' for harnessInternal, so no operator key can intercept
  // the static allow and hand the call to a countdown the LLM can never
  // answer. A blanket `categoryPolicy.harnessInternal` key proves nothing
  // ('harnessInternal' and 'unknown' both degrade to 'inherit'), so the probe
  // uses a key that WOULD bind if the label were lost: without set
  // membership, send_message matches the external-write risk pattern and
  // classifies as 'publish', where an explicit deny bites.
  const dir = categoryDirective(
    { categoryPolicy: { publish: 'deny' }, categoryMode: 'aggressive' },
    label('send_message'),
    { decision: 'allow', classifierEligible: false },
  )
  assert.equal(dir, 'inherit', 'a category deny must not reach a harnessInternal call')
})

test('settings catalog: the newly allowed names are listed (display cannot lag the policy)', () => {
  const missing = NEWLY_ALLOWED_TEAM_TOOLS.filter((name) => !DEFAULT_ALLOW_TOOLS.includes(name))
  assert.deepEqual(missing, [], `allowed by policy but absent from the settings catalog: ${missing.join(', ')}`)
})

test('settings catalog: the team tools live in the AgentTeams coordination group', () => {
  const group = DEFAULT_ALLOW_TOOL_GROUPS.find((entry) => entry.label === 'AgentTeams coordination')
  assert.ok(group !== undefined, 'AgentTeams coordination group exists')
  for (const name of ['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']) {
    assert.ok(group.tools.includes(name), `${name} listed under ${group.label}`)
  }
  const orchestration = DEFAULT_ALLOW_TOOL_GROUPS.find((entry) => entry.label === 'Orchestration')
  assert.ok(orchestration !== undefined, 'Orchestration group exists')
  assert.ok(orchestration.tools.includes('spawn_teammate'), 'spawn_teammate listed under Orchestration')
})

test('cross-copy: every family agrees across policy, category and the display catalog', () => {
  // The three copies are hand-maintained, so drift in either direction is a
  // real defect: allowed-but-invisible (policy -> catalog) or
  // visible-but-unknown (catalog -> policy). Comparing the compiled modules
  // keeps the check honest for names added after this change. Every family is
  // covered, not only the two this change touched: a family that is skipped is
  // exactly where the next silent drift would hide.
  const policySrc = libSource('auto/policy.js')
  const categorySrc = libSource('auto/category.js')
  const constantsSrc = libSource('auto/constants.js')

  for (const family of HARNESS_FAMILIES) {
    const policy = family.policySet === null
      ? inlineMembers(policySrc, 'subagent')
      : setMembers(policySrc, family.policySet)
    const category = setMembers(categorySrc, family.categorySet)
    const catalog = groupMembers(constantsSrc, family.group)

    assert.ok(policy.length > 0, `${family.group}: policy members were parsed`)
    assert.deepEqual(sorted(policy), sorted(category), `${family.group}: policy vs category`)
    assert.deepEqual(sorted(policy), sorted(catalog), `${family.group}: policy vs catalog`)

    for (const name of catalog) {
      assert.equal(label(name), 'harnessInternal', `${family.group}: ${name} carries the harnessInternal label`)
    }
  }

  // The read-only external lookup family is the one deliberate exception: the
  // category layer has no set for it, and its members are labelled by explicit
  // branches. Pin the labels so "no set" cannot quietly become "no coverage".
  const externalPolicy = inlineMembers(policySrc, 'web_search')
  const externalCatalog = groupMembers(constantsSrc, 'Read-only external lookup')
  assert.deepEqual(sorted(externalPolicy), sorted(externalCatalog), 'Read-only external lookup: policy vs catalog')
  assert.deepEqual(sorted(externalPolicy), sorted([...EXTERNAL_LOOKUP_LABELS.keys()]), 'the pinned exception list is current')
  // The six families together must account for the entire declared plane: a
  // name that lives in no family would be invisible to every check above.
  assert.deepEqual(sorted(allowPlaneNames(policySrc)), sorted(DEFAULT_ALLOW_TOOLS), 'the families cover the whole allow plane')
  for (const [name, expected] of EXTERNAL_LOOKUP_LABELS) {
    assert.equal(label(name), expected, `${name} keeps its documented non-harnessInternal label`)
  }
})

test('allow plane: a name the risk escalation would catch is an explicit exception, not a silent one', () => {
  // Set membership is evaluated BEFORE the name-based risk escalation, so a
  // member matching DESTRUCTIVE_TOOL / EXTERNAL_WRITE_TOOL / SECURITY_CHANGE_TOOL
  // never escalates: adding such a name silently disables that channel for it.
  // The exceptions below are the ones already in the plane; anything new has to
  // be added here deliberately, with a reason, or this test fails.
  const plane = allowPlaneNames(libSource('auto/policy.js'))
  assert.ok(plane.length > 40, 'the allow plane was parsed')

  const suppressed = plane.filter((name) => RISK_NAME_PATTERN.test(name))
  const unacknowledged = suppressed.filter((name) => !RISK_TOKEN_EXCEPTIONS.has(name))
  assert.deepEqual(
    unacknowledged,
    [],
    `these names inherit the allow plane before the risk escalation can fire: ${unacknowledged.join(', ')}. `
      + 'Add each to RISK_TOKEN_EXCEPTIONS with the reason its effect is still confined, or the escalation is silently off for it.',
  )

  const stale = [...RISK_TOKEN_EXCEPTIONS.keys()].filter((name) => !plane.includes(name))
  assert.deepEqual(stale, [], `exceptions that no longer name a real allow-plane tool: ${stale.join(', ')}`)
})

test('allow plane: the risk escalation itself still works for names outside the plane', () => {
  // Guards the test above from passing because the pattern went dead: a name the
  // escalation is supposed to catch must still match it.
  for (const name of ['team_task_delete', 'delete_agent', 'publish_release', 'update_credential']) {
    assert.ok(RISK_NAME_PATTERN.test(name), `${name} must still be caught by the name-based escalation`)
  }
})

test('trigger condition: the allow is exact-name membership, not a substring or family match', () => {
  // Names that merely resemble a team tool must still fail closed into review.
  const nonTools = [
    'team_task_delete',        // the board has no such tool (deletion rides team_task_update's action enum)
    'team_task',
    'spawn_teammate_extra',
    'unspawn_teammate',
    'Team_Task_Create',        // case matters: membership is exact
    'agent_teams_created',     // exact members are allowed, near-misses are not
    'team_task_create_all',
  ]
  for (const name of nonTools) {
    assert.notEqual(verdict(name).decision, 'allow', `${name} must not be statically allowed`)
  }
})

test('non-tool identifiers from the Agent Teams package are never admitted as tools', () => {
  // `team:policy` is a systemPrompt section id; agent/created and agent/disposed
  // are event names. None of them is a registered tool, and a bulk copy of every
  // string in the package would have introduced them here.
  for (const name of ['team:policy', 'agent/created', 'agent/disposed', 'tool-team.scopedTools()', 'tool-agent-team']) {
    assert.equal(DEFAULT_ALLOW_TOOLS.includes(name), false, `${name} must not be in the allow catalog`)
    assert.notEqual(verdict(name).decision, 'allow', `${name} must not be statically allowed`)
  }
})
