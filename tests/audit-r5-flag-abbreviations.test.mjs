/**
 * GNU getopt accepts any unambiguous abbreviation of a long option, and the
 * abbreviation is an equivalent spelling. The wrapper value-flag table listed
 * full long spellings only, so `env --uns FOO rm -rf /` consumed just `--uns`,
 * left the flag's VALUE `FOO` as the effective command and skipped the
 * privilege, delete, write-operand and find fuses — while
 * `env --unset FOO rm -rf /` is hard-denied. The read-only output-flag table
 * had the same gap in the write direction: `sort --o=package.json` was not a
 * write target at all, so the whole command rode the static read-only allow
 * with no approval and overwrote the plugin's own contract file.
 *
 * Pins both directions: the abbreviated spellings reach the same verdict as
 * their full spellings, and unambiguous non-value options are not over-wrapped.
 *
 * Run: node --test tests/audit-r5-flag-abbreviations.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assessShell } from '../lib/auto/shell.js'
import { categorizeTool } from '../lib/auto/category.js'
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
const category = (command) => categorizeTool({ name: 'bash', arguments: { command } }, roots)

test('an abbreviated wrapper value flag still exposes the effective command', () => {
  for (const command of [
    'env --uns FOO rm -rf /',
    'env --u FOO rm -rf /',
    'env --chd /tmp rm -rf /',
    'timeout --sig KILL 5 rm -rf /',
    'nice --adj 5 rm -rf /',
    'stdbuf --in 0 rm -rf /',
    'xargs --max-a 1 rm -rf /',
    'xargs --arg-f f rm -rf /',
    'time --out /tmp/x rm -rf /',
    'find . -exec env --uns FOO rm -rf / +',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
  assert.equal(category('env --uns FOO rm -rf /'), 'delete')
})

test('an abbreviated wrapper value flag cannot hide privilege escalation', () => {
  for (const command of ['env --uns FOO sudo ls', 'timeout --sig KILL 5 sudo ls', 'env --uns FOO doas ls']) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('unambiguous non-value wrapper options are not mistaken for value flags', () => {
  for (const command of [
    'env --ignore-environment ls',
    'env --version',
    'timeout --foreground 5 ls',
    'nice -n 5 ls',
    'xargs -n 1 echo',
    'stdbuf -o L ls',
  ]) {
    assert.notEqual(shell(command).decision, 'deny', `${command} is routine and must not be denied`)
  }
})

test('an abbreviated output flag is still judged as a write target', () => {
  for (const command of [
    'sort --o=package.json in.txt',
    'sort --out=package.json in.txt',
    'sort --outp=package.json in.txt',
    'sort --output=package.json in.txt',
    'sort --o package.json in.txt',
    'tree --out=package.json',
    'sort --o=package.json in.txt; (:)',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('an output flag pointing at plugin runtime state is a write like any other', () => {
  for (const command of [
    'sort -o C:/Users/u/.dsh/history.jsonl in.txt',
    'sort --o=C:/Users/u/.dsh/history.jsonl in.txt',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('routine output flags and indicator options are not rejected', () => {
  for (const command of [
    'sort --o=/tmp/x in.txt',
    'sort -o /tmp/x in.txt',
    'git diff --output-indicator-new=X HEAD',
    'git diff --output-indicator-old=Y HEAD',
    'git diff HEAD',
  ]) {
    assert.notEqual(shell(command).decision, 'deny', `${command} must not be hard-denied`)
  }
})
