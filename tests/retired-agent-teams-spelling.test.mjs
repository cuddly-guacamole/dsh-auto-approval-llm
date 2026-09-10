/**
 * Retired `agent_teams_*` allow-plane spelling — contract test.
 *
 * The nine `agent_teams_*` names came from the upstream dsh-auto-mode project
 * this plugin's static engine was derived from. Nothing in the DSH_HOME tree
 * registers them: the installed `@deepseek-ai/dsh-experimental-tool-agent-team`
 * package exports exactly nine model-facing tools, and every one of them uses
 * the `team_task_*` / `spawn_teammate` / … spelling.
 *
 * They were therefore dead entries that widened the static allow plane against
 * tools that do not exist. Removing them must fail CLOSED for any future
 * package that does register that spelling: an unrecognized registered tool
 * falls to `assessTool`'s last branch (ask, classifier-eligible) instead of a
 * silent allow. This file pins both halves — the removal and the fail-closed
 * direction — so the intent survives the next bulk copy of a tool list.
 *
 * Run: node --test tests/retired-agent-teams-spelling.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ALLOW_TOOL_GROUPS, DEFAULT_ALLOW_TOOLS } from '../lib/auto/constants.js'
import { assessTool } from '../lib/auto/policy.js'
import { categorizeTool } from '../lib/auto/category.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
const artifacts = { has: () => false }
const verdict = (name) => assessTool({ name, arguments: {} }, roots, artifacts)
const libSource = (rel) => readFileSync(fileURLToPath(new URL(`../lib/${rel}`, import.meta.url)), 'utf8')

/** The nine names the transplant brought in; none of them is a real tool. */
const RETIRED_NAMES = [
  'agent_teams_create',
  'agent_teams_add_member',
  'agent_teams_remove_member',
  'agent_teams_create_task',
  'agent_teams_claim_task',
  'agent_teams_update_task',
  'agent_teams_send_message',
  'agent_teams_status',
  'agent_teams_delete',
]

test('retired spelling: no compiled module exports an agent_teams_* allow member', () => {
  // Reading the compiled output (not the TypeScript source) keeps this honest
  // for whichever copy a future edit forgets: policy, category or catalog.
  for (const rel of ['auto/policy.js', 'auto/category.js', 'auto/constants.js']) {
    const source = libSource(rel)
    for (const name of RETIRED_NAMES) {
      assert.equal(
        source.includes(`'${name}'`),
        false,
        `${rel} still carries the retired name ${name}`,
      )
    }
  }
})

test('retired spelling: the names are absent from the settings display catalog', () => {
  for (const name of RETIRED_NAMES) {
    assert.equal(DEFAULT_ALLOW_TOOLS.includes(name), false, `${name} must not be advertised as allowed`)
  }
  const group = DEFAULT_ALLOW_TOOL_GROUPS.find((entry) => entry.label === 'AgentTeams coordination')
  assert.ok(group !== undefined, 'the AgentTeams coordination group still exists')
  assert.deepEqual(
    [...group.tools].sort(),
    ['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'],
    'the coordination group lists exactly the four registered board tools',
  )
})

test('retired spelling: a future registration of it fails closed into review', () => {
  // The discriminating half. If the names were merely dropped from the catalog
  // but stayed in the allow plane, the checks above could still pass while the
  // call was silently allowed — so assert the verdict itself.
  for (const name of RETIRED_NAMES) {
    const result = verdict(name)
    assert.notEqual(result.decision, 'allow', `${name} must not be statically allowed`)
    assert.equal(result.classifierEligible, true, `${name} must reach the semantic reviewer, not a locked countdown`)
  }
})

test('control: the registered spelling still allows, so the check above is not vacuous', () => {
  // Without this control a blanket "nothing is allowed" bug would make the test
  // above pass while the whole allow plane was broken.
  for (const name of ['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']) {
    const result = verdict(name)
    assert.equal(result.decision, 'allow', `${name} must stay statically allowed`)
    assert.equal(result.classifierEligible, false, `${name} must not ask`)
    assert.equal(categorizeTool({ name, arguments: {} }, roots), 'harnessInternal', `${name} keeps the harness label`)
  }
})

test('control: the retired prefix is not swallowed by a near-miss allowance', () => {
  // `agent_teams_created` is the shape a bulk copy would have added next.
  const result = verdict('agent_teams_created')
  assert.notEqual(result.decision, 'allow', 'a near-miss of the retired family must not be allowed')
})
