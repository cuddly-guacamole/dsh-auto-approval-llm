/**
 * dsh-auto-approval-llm · plugin zone self-modify fuse.
 *
 * The plugin's dev zone is a permanent opening in the DSH_HOME hard-deny
 * (rootsFor always grants it), which also let an Auto session rewrite the
 * review/audit body itself: lib/**, the package manifests, the build config,
 * or the loader patch. The fuse lives inside hardDestructiveTargetReason —
 * the single destructive-target predicate every write gate (guard, policy
 * write/edit, apply_patch/str_replace_editor, shell) already consults — so
 * one hook covers all consumers. src/ and tests/ stay writable: the zone
 * exists for development.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { hardDestructiveTargetReason, pluginZoneSelfModifyReason, resolveRoots } from '../lib/auto/paths.js'
import { assessTool } from '../lib/auto/policy.js'

// The zone is this repo: tests/ sits one level under the plugin root, and the
// compiled fuse derives the same root from lib/auto/paths.js.
const ZONE = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const roots = resolveRoots('C:/work/ws')
// Mimic index.ts rootsFor: the plugin zone is always granted.
roots.allowedDshSubpaths = [ZONE]

test('zone fuse: execution code and contract files inside the zone are hard-denied', () => {
  for (const target of [
    `${ZONE}/lib/auto/policy.js`,
    `${ZONE}/lib/index.js`,
    `${ZONE}/package.json`,
    `${ZONE}/package-lock.json`,
    `${ZONE}/tsdown.config.ts`,
    `${ZONE}/tsconfig.json`,
    `${ZONE}/cordis.patch.yml`,
    `${ZONE}/node_modules/foo/index.js`,
  ]) {
    const reason = hardDestructiveTargetReason(target, roots)
    assert.match(reason ?? '', /plugin's own/, `${target} must be fused`)
  }
})

test('zone fuse: development surfaces stay writable', () => {
  for (const target of [
    `${ZONE}/src/index.ts`,
    `${ZONE}/src/auto/paths.ts`,
    `${ZONE}/tests/foo.test.mjs`,
    `${ZONE}/notes.md`,
  ]) {
    assert.equal(hardDestructiveTargetReason(target, roots), undefined, `${target} must stay writable`)
  }
})

test('zone fuse: targets outside the zone are unaffected', () => {
  assert.equal(pluginZoneSelfModifyReason('C:/work/ws/package.json'), undefined, 'a workspace package.json is not the plugin contract')
  assert.equal(pluginZoneSelfModifyReason('C:/Users/Administrator/.dsh/history.jsonl'), undefined, 'outside the zone the fuse stays silent (DSH_HOME fuse governs)')
})

test('zone fuse: the write tool cannot rewrite lib through the policy gate', () => {
  const verdict = assessTool(
    { name: 'write', arguments: { file_path: `${ZONE}/lib/auto/policy.js`, content: 'x' }, agent: {} },
    roots,
    { has: () => false },
  )
  assert.equal(verdict.decision, 'deny')
  assert.match(verdict.reason ?? '', /plugin's own/)
  const src = assessTool(
    { name: 'write', arguments: { file_path: `${ZONE}/src/index.ts`, content: 'x' }, agent: {} },
    roots,
    { has: () => false },
  )
  assert.notEqual(src.decision, 'deny', 'src stays writable')
})
