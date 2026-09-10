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

/** Same, for the inline orchestration array in policy.ts (an `if ([...])`). */
function inlineOrchestrationMembers(source) {
  const at = source.indexOf("if (['subagent', 'workflow', 'ralph'")
  assert.notEqual(at, -1, 'inline orchestration array present in the compiled policy')
  const open = source.indexOf('[', at)
  const close = source.indexOf(']', open)
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const sorted = (names) => [...names].sort()

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

test('cross-copy: policy, category and the display catalog carry identical members', () => {
  // The three copies are hand-maintained, so drift in either direction is a
  // real defect: allowed-but-invisible (policy -> catalog) or
  // visible-but-unknown (catalog -> policy). Comparing the compiled modules
  // keeps the check honest for names added after this change.
  const policySrc = libSource('auto/policy.js')
  const categorySrc = libSource('auto/category.js')
  const constantsSrc = libSource('auto/constants.js')

  const agentTeams = {
    policy: setMembers(policySrc, 'AGENT_TEAMS_CONTROL_TOOLS'),
    category: setMembers(categorySrc, 'AGENT_TEAMS_CONTROL_TOOLS'),
    catalog: groupMembers(constantsSrc, 'AgentTeams coordination'),
  }
  assert.deepEqual(sorted(agentTeams.policy), sorted(agentTeams.category), 'policy vs category: AGENT_TEAMS_CONTROL_TOOLS')
  assert.deepEqual(sorted(agentTeams.policy), sorted(agentTeams.catalog), 'policy vs catalog: AgentTeams coordination group')

  const orchestration = {
    policy: inlineOrchestrationMembers(policySrc),
    category: setMembers(categorySrc, 'ORCHESTRATION_TOOLS'),
    catalog: groupMembers(constantsSrc, 'Orchestration'),
  }
  assert.deepEqual(sorted(orchestration.policy), sorted(orchestration.category), 'policy vs category: orchestration')
  assert.deepEqual(sorted(orchestration.policy), sorted(orchestration.catalog), 'policy vs catalog: Orchestration group')

  // The comparison must actually be looking at populated regions.
  assert.ok(agentTeams.policy.length >= NEWLY_ALLOWED_TEAM_TOOLS.length, 'agent-teams members were parsed')
  assert.ok(orchestration.policy.length > 5, 'orchestration members were parsed')
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
