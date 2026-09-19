/**
 * The workspace protected-project table must agree with the category plane on
 * the `.bash*` family.
 *
 * The category plane fuses every `.bash*` basename; the workspace table listed
 * only `.bashrc` and `.bash_profile`, so a structured write of the workspace's
 * `.bash_login` / `.bash_logout` / `.bash_aliases` was a routine project edit
 * (a persistence-hook window when `$HOME` points at the workspace) while the
 * neighboring `.bashrc` asks. The table now uses the same prefix rule and
 * carries the remaining rc family the shell-critical list knows.
 *
 * Run: node --test tests/audit-bashrc-family-policy.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessTool } from '../lib/auto/policy.js'
import { isProtectedProjectPath, resolveRoots } from '../lib/auto/paths.js'
import { sensitiveBasenameAt } from '../lib/auto/category.js'

const roots = resolveRoots('C:/ws')
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

test('structured writes of .bash* files are judged like .bashrc', () => {
  for (const name of ['.bash_login', '.bash_logout', '.bash_aliases', '.bashrc', '.bash_profile']) {
    const verdict = assessTool({ name: 'write', arguments: { file_path: `C:/ws/${name}` } }, roots, artifacts)
    assert.notEqual(verdict.decision, 'allow', `write of ${name} must not be a routine edit`)
  }
})

test('the two planes agree on the .bash* family inside the workspace (drift guard)', () => {
  for (const name of ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.bash_history']) {
    assert.equal(
      isProtectedProjectPath(`C:/ws/${name}`, roots),
      sensitiveBasenameAt(`C:/ws/${name}`, roots),
      `${name} must be judged the same on both planes`,
    )
  }
})

test('ordinary project files stay routine (no over-block)', () => {
  assert.equal(isProtectedProjectPath('C:/ws/bashly.yaml', roots), false, 'a file starting with bash is not a bash rc')
  assert.equal(isProtectedProjectPath('C:/ws/notes.md', roots), false)
  assert.equal(assessTool({ name: 'write', arguments: { file_path: 'C:/ws/notes.md' } }, roots, artifacts).decision, 'allow')
})

test('the location-free owner sees the same basenames (shared contract)', () => {
  assert.equal(sensitiveBasenameAt('C:/ws/.bash_login', roots), true)
})
