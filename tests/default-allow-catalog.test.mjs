/**
 * Default-allow catalog contract tests.
 *
 * The settings card shows the「默认放行工具」list sourced from
 * DEFAULT_ALLOW_TOOLS in constants.ts. This pins that list to what the policy
 * ACTUALLY allows unconditionally: every listed tool must come back allow from
 * assessTool with empty arguments (their allow does not inspect args), and the
 * known conditionally-allowed tools must NOT be listed.
 * Run: node --test tests/default-allow-catalog.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ALLOW_TOOL_GROUPS, DEFAULT_ALLOW_TOOLS } from '../lib/auto/constants.js'
import { assessTool } from '../lib/auto/policy.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
const artifacts = { has: () => false }

test('catalog: every listed tool is statically allowed with empty arguments', () => {
  const failures = []
  for (const name of DEFAULT_ALLOW_TOOLS) {
    const verdict = assessTool({ name, arguments: {} }, roots, artifacts)
    if (verdict.decision !== 'allow') failures.push(`${name} → ${verdict.decision}: ${verdict.reason}`)
  }
  assert.deepEqual(failures, [], `tools that are not unconditionally allowed:\n${failures.join('\n')}`)
})

test('catalog: flat list is deduplicated (send_message appears once)', () => {
  const dupes = DEFAULT_ALLOW_TOOLS.filter((t, i) => DEFAULT_ALLOW_TOOLS.indexOf(t) !== i)
  assert.deepEqual(dupes, [], 'no duplicate tool names')
})

test('catalog: conditionally-allowed tools are NOT listed', () => {
  // These allow only after path/argument inspection — listing them as
  // "default allowed" would mislead (sensitive paths still ask/deny).
  for (const conditional of ['read', 'write', 'edit', 'bash', 'pwsh', 'apply_patch', 'str_replace_editor', 'terminal_open', 'terminal_send']) {
    assert.ok(!DEFAULT_ALLOW_TOOLS.includes(conditional), `${conditional} must not be in the default-allow list`)
  }
})

test('catalog: every group has a label and non-empty tools', () => {
  for (const group of DEFAULT_ALLOW_TOOL_GROUPS) {
    assert.ok(group.label.length > 0, 'group label present')
    assert.ok(group.tools.length > 0, `group ${group.label} non-empty`)
  }
  assert.ok(DEFAULT_ALLOW_TOOLS.length >= 30, 'list covers the unconditional-allow plane')
})
