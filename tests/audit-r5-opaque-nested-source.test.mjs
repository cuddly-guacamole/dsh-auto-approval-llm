/**
 * An interpreter boundary inside a line that cannot be decomposed used to lose
 * both its fuse and its tier: `(bash -c "rm -rf /")`, `{ bash -c "rm -rf /"; }`
 * and `(bash -c "cp a.txt ~/.dsh/history.jsonl")` stayed classifier-answerable
 * asks while the same text without the grouping is hard-denied (or, for a bare
 * script invocation, needs a human). The opaque branch now recognises the
 * interpreter boundary with a quote-aware word split and hands the source to
 * the owners that already govern it.
 *
 * Pins both directions: the grouping spelling reaches the same tier as the
 * plain spelling, and quoted *data* that is never executed stays reviewable.
 *
 * Run: node --test tests/audit-r5-opaque-nested-source.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: ['C:/ws'],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)
const DSH = 'C:/Users/u/.dsh'

test('a grouped interpreter source reaches the same hard deny as the plain spelling', () => {
  for (const command of [
    `(bash -c "cp a.txt ${DSH}/history.jsonl")`,
    `(bash -c "printf a > ${DSH}/history.jsonl")`,
    `(bash -c "sort -o ${DSH}/history.jsonl in.txt")`,
    '(sh -c "sudo ls")',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('a grouped destructive body keeps the plain spelling manual-review tier', () => {
  const plain = shell('bash -c "rm -rf /"')
  assert.equal(plain.classifierEligible, false, 'the plain spelling needs a human')
  for (const command of [
    '(bash -c "rm -rf /")',
    '{ bash -c "rm -rf /"; }',
    'echo hi && (bash -c "rm -rf /")',
    '(sh -c "rm -rf /")',
  ]) {
    const verdict = shell(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be allowed`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('a grouped script invocation keeps the manual-review tier of the plain spelling', () => {
  const plain = shell('sh build.sh')
  assert.equal(plain.classifierEligible, false, 'the plain spelling needs a human')
  for (const command of ['(sh build.sh)', '(bash script.sh)']) {
    const verdict = shell(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be allowed`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('quoted data that is only printed is not hard-denied', () => {
  for (const command of ['(echo "rm -rf /")', '(printf a > /tmp/x)', '(echo "sudo ls")', '(ls -la)']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} is not destructive and must not be denied`)
  }
})

test('an opaque line cannot hide privilege escalation behind a wrapper', () => {
  for (const command of [
    '(env sudo ls)',
    '(/usr/bin/sudo ls)',
    '$(env sudo ls)',
    '(A=1 sudo ls)',
    '(timeout 5 sudo ls)',
    '{ env sudo ls; }',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
  for (const command of ['(env echo hi)', '(echo sudo)']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} carries no privilege payload and must not be denied`)
  }
})

test('the opaque word split keeps a quoted operand whole', () => {
  for (const command of [
    'cp a.txt "/etc/my dir/f"; (:)',
    'tee "/etc/my dir/f"; (:)',
    'mkdir "/etc/my dir/f"; (:)',
    `(python -c "open('${DSH}/x', 'w').write('y')")`,
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})
