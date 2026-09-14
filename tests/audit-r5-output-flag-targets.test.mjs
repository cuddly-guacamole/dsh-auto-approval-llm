/**
 * A read-only command's own output flag (`sort -o out`, `tree -o out`,
 * `git diff --output=out`) writes a file without any redirection token. Only
 * the destructive-target predicate judged those targets, so
 * `sort -o history.jsonl in.txt` stayed a classifier-answerable ask while
 * `printf x > history.jsonl` is hard-denied — the same write, one tier apart.
 * Both target families now run the same three predicates.
 *
 * Run: node --test tests/audit-r5-output-flag-targets.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const roots = {
  workspace: repoRoot,
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: [repoRoot],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)

test('an output flag pointing at plugin runtime state is a write like any other', () => {
  for (const command of [
    'sort -o C:/Users/u/.dsh/history.jsonl in.txt',
    'sort --output=C:/Users/u/.dsh/history.jsonl in.txt',
    'sort -o C:/Users/u/.dsh/history.jsonl in.txt; (:)',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('the redirect spelling of the same target keeps the same verdict', () => {
  assert.equal(shell('printf x > C:/Users/u/.dsh/history.jsonl; (:)').decision, 'deny')
})

test('a bare runtime-state filename is the discriminating target', () => {
  // The plugin repository is itself inside DSH_HOME, so a bare `history.jsonl`
  // resolves into the runtime-state zone: the destructive-target predicate
  // alone does not deny it, the state and in-zone DSH_HOME fuses do.
  for (const command of ['sort -o history.jsonl in.txt', 'sort -o lib/index.js in.txt']) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('routine output flags are not rejected', () => {
  for (const command of ['sort -o /tmp/x in.txt', 'tree -o /tmp/x', 'git diff --output=/tmp/x']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} must not be hard-denied`)
  }
})
