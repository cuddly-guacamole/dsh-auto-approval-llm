/**
 * Registered tools whose payload only touches Harness state were falling to the
 * step-18 fallback (ask + classifier): `present` (declare deliverables),
 * `list_subagent_models` (read-only route listing), the Cordis dynamic-plugin
 * bookkeeping tools (`cordis_define` / `cordis_stop` / `cordis_undefine` — none
 * of them executes the package) and the session reminder pair
 * (`schedule_create` / `schedule_delete`; `schedule_list` was already covered).
 * `schedule_delete` additionally carried a `delete` name token, so it reached
 * the risk-name branch while its sibling did not.
 *
 * Pins the allow verdict, the harnessInternal label, the display catalog and —
 * deliberately — that `cordis_run` stays outside every family (it is the one
 * member that executes model-written host code, and it is judged as
 * unrecognized rather than pre-approved).
 *
 * Run: node --test tests/audit-harmless-tool-families.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessTool } from '../lib/auto/policy.js'
import { categorizeTool } from '../lib/auto/category.js'
import { DEFAULT_ALLOW_TOOLS, DEFAULT_ALLOW_TOOL_GROUPS } from '../lib/auto/constants.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: [],
}
const verdict = (name, args = {}) => assessTool({ name, arguments: args }, roots, new ArtifactRegistry())
const groupOf = (name) => DEFAULT_ALLOW_TOOL_GROUPS.find((group) => group.tools.includes(name))?.label

const SESSION_FAMILY = ['cordis_define', 'cordis_stop', 'cordis_undefine', 'schedule_create', 'schedule_delete', 'present']
const READ_FAMILY = ['list_subagent_models']

test('the harmless registered tools take the static allow', () => {
  for (const name of [...SESSION_FAMILY, ...READ_FAMILY]) {
    const result = verdict(name)
    assert.equal(result.decision, 'allow', `${name}: ${result.decision} (${result.reason})`)
    assert.equal(result.classifierEligible, false, `${name} must not reach the classifier`)
  }
})

test('the category layer labels them harnessInternal so it never intervenes', () => {
  for (const name of [...SESSION_FAMILY, ...READ_FAMILY]) {
    assert.equal(categorizeTool({ name, arguments: {} }, roots), 'harnessInternal', name)
  }
})

test('the display catalog carries them in the same families', () => {
  for (const name of SESSION_FAMILY) assert.equal(groupOf(name), 'Session & control', name)
  for (const name of READ_FAMILY) assert.equal(groupOf(name), 'Read-only Harness', name)
  for (const name of [...SESSION_FAMILY, ...READ_FAMILY]) {
    assert.equal(DEFAULT_ALLOW_TOOLS.includes(name), true, `${name} must be in the flat catalog`)
  }
})

test('schedule_delete is allowed by family, not by the risk-name branch', () => {
  const result = verdict('schedule_delete', { id: 'reminder-1' })
  assert.equal(result.decision, 'allow')
  assert.doesNotMatch(String(result.reason ?? ''), /registered tool name indicates/)
})

test('cordis_run stays outside every allow family', () => {
  const result = verdict('cordis_run', { pluginId: 'p1', packageId: 'k1', mode: 'run' })
  assert.notEqual(result.decision, 'allow', 'activating a dynamic plugin must not be pre-approved')
  assert.match(String(result.reason ?? ''), /unrecognized registered plugin tool/)
  assert.equal(DEFAULT_ALLOW_TOOLS.includes('cordis_run'), false)
  assert.equal(groupOf('cordis_run'), undefined)
})

test('a family allow is name-based: arguments are not inspected for it', () => {
  // Mirrors the team_task_* precedent: the destructive/external regex matches
  // tool NAMES, so an action buried in the arguments cannot flip a family
  // verdict. Pinned here so a future argument-driven rewrite has to say why.
  assert.equal(verdict('cordis_undefine', { pluginId: 'p1' }).decision, 'allow')
  assert.equal(verdict('schedule_delete', { id: 'x' }).decision, 'allow')
  assert.equal(verdict('present', { files: [{ path: 'C:/ws/out.html' }] }).decision, 'allow')
})
