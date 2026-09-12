/**
 * dsh-auto-approval-llm · an operator opening must not lift protected metadata.
 *
 * `allowedDshSubpaths` is the maintenance opening that clears the DSH_HOME
 * hard-deny; the plugin's own dev zone is always granted so an Auto session
 * can develop `src/` and `tests/`. The write/edit branch returned its zone
 * allow BEFORE the protected-metadata gate, so `.env`, `.npmrc`, `.mcp.json`
 * and `.git/hooks/**` inside the zone were silently writable from any
 * workspace — a planted git hook is arbitrary code execution, and a rewritten
 * `.env` is a credential change, neither of which the opening is meant to
 * grant.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assessTool, hardDenyReason } from '../lib/auto/policy.js'

// The real checkout: the zone-opening fixture must be the tree the compiled
// self-modify fuse derives from its own module location, otherwise the
// plugin-code anchors below would point at a path no owner can see.
const ZONE = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const HOME = 'C:/Users/u'
const DSH_HOME = 'C:/Users/u/.dsh'
const artifacts = { has: () => false, plan: () => {} }

const roots = {
  workspace: ZONE,
  home: HOME,
  dshHome: DSH_HOME,
  tempRoots: [],
  trustedDirs: [],
  allowedDshSubpaths: [ZONE],
  maintenanceDshPaths: [],
  mode: 'standard',
}

const mutationVectors = (target) => [
  { name: 'write', arguments: { file_path: target, content: 'x' } },
  { name: 'edit', arguments: { file_path: target, old_text: 'a', new_text: 'b' } },
  { name: 'apply_patch', arguments: { patches: [{ file_path: target }] } },
  { name: 'str_replace_editor', arguments: { command: 'create', path: target, file_text: 'x' } },
]

test('protected metadata inside the zone opening is not silently allowed', () => {
  for (const target of [
    `${ZONE}/.env`,
    `${ZONE}/.env.local`,
    `${ZONE}/.npmrc`,
    `${ZONE}/.netrc`,
    `${ZONE}/.mcp.json`,
    `${ZONE}/.git/hooks/pre-commit`,
    `${ZONE}/.git/config`,
    `${ZONE}/.vscode/settings.json`,
  ]) {
    for (const exec of mutationVectors(target)) {
      assert.equal(hardDenyReason(exec, roots), undefined, `${exec.name} ${target} is not a DSH_HOME hard deny`)
      const verdict = assessTool(exec, roots, artifacts)
      assert.notEqual(verdict.decision, 'allow', `${exec.name} ${target} must not be allowed by the opening`)
      assert.equal(verdict.decision, 'ask', `${exec.name} ${target} must go to semantic review`)
    }
  }
})

test('the development surfaces the zone exists for stay writable', () => {
  for (const target of [`${ZONE}/src/index.ts`, `${ZONE}/src/auto/paths.ts`, `${ZONE}/tests/foo.test.mjs`, `${ZONE}/notes.md`]) {
    const verdict = assessTool({ name: 'write', arguments: { file_path: target, content: 'x' } }, roots, artifacts)
    assert.equal(verdict.decision, 'allow', `${target} must stay writable`)
    assert.match(verdict.reason, /trusted DSH_HOME path/)
  }
})

test('the plugin execution code stays hard-denied inside the opening', () => {
  for (const target of [`${ZONE}/lib/index.js`, `${ZONE}/package.json`, `${ZONE}/cordis.patch.yml`]) {
    const verdict = assessTool({ name: 'write', arguments: { file_path: target, content: 'x' } }, roots, artifacts)
    assert.equal(verdict.decision, 'deny', `${target} must stay hard-denied`)
  }
})
