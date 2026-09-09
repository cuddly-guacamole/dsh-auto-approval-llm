/**
 * dsh-auto-approval-llm · find -exec nested non-interpreter bodies hitting
 * denied write/delete targets contract.
 *
 * Fix: findNestedWriteDenyReason only inspected nested INTERPRETER bodies
 * (bash -c / node -e …), so a direct nested command (`find . -exec cp a
 * ~/.dsh/x \;`, `-exec rm ~/.dsh/audit.jsonl \;`, `-exec sed -i …`) with an
 * explicit DSH_HOME / runtime-state / critical target fell through to an
 * LLM-answerable semantic ask while the same command at top level was
 * unconditionally hard-denied. Non-interpreter nested bodies are now judged
 * with the same segment fuses as a standalone command; interpreter bodies
 * keep the source-scan path, and `{}` placeholders / workspace targets are
 * untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'

const plainRoots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const artifacts = { has: () => false }
const shell = (command, roots = plainRoots) => assessShell(command, 'bash', roots, artifacts, undefined)

// ── nested non-interpreter write/delete to denied targets: hard deny ────────
test('assessShell: find -exec non-interpreter bodies hitting DSH_HOME targets hard-deny', () => {
  for (const command of [
    'find . -exec cp notes.txt ~/.dsh/secret.txt \\;',
    'find . -exec cp notes.txt C:/Users/u/.dsh/secret.txt \\;',
    'find . -exec sed -i s/a/b/ ~/.dsh/config \\;',
    'find . -exec tee ~/.dsh/history.jsonl \\;',
    'find . -exec install x ~/.dsh/foo \\;',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(r.classifierEligible, false, `${command} must not degrade into an LLM-answerable ask`)
  }
})

test('assessShell: find -exec nested delete of a DSH_HOME / runtime-state target hard-denies', () => {
  for (const command of [
    'find . -exec rm ~/.dsh/audit.jsonl \\;',
    'find . -exec rm C:/Users/u/.dsh/audit.jsonl \\;',
    'find . -exec rm -r ~/.dsh/skills \\;',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(r.classifierEligible, false, `${command} must not degrade into an LLM-answerable ask`)
  }
})

// ── interpreter bodies keep the existing source-scan deny ───────────────────
test('assessShell: find -exec interpreter bodies writing to denied targets stay hard-denied', () => {
  for (const command of [
    "find . -exec bash -c 'echo x >> ~/.dsh/history.jsonl' \\;",
    "find . -exec sh -c 'cat {} > ~/.ssh/authorized_keys' \\;",
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(r.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

// ── reverse: workspace targets / read-only / placeholder bodies unchanged ───
test('assessShell: find -exec benign nested bodies are not over-blocked', () => {
  // A nested workspace copy is not an unconditional hard deny.
  assert.equal(shell('find . -exec cp notes.txt ./dst.txt \\;').classifierEligible, true)
  // A read-only nested body keeps the static allow.
  assert.equal(shell('find . -exec grep -l foo {} \\;').decision, 'allow')
  // An interpreter body that does not write stays on the semantic boundary.
  assert.equal(shell("find . -exec bash -c 'echo hi' \\;").decision, 'ask')
  // `{}` placeholders are not explicit paths and stay gated, not hard-denied.
  assert.equal(shell('find . -exec rm {} +').classifierEligible, true)
  assert.notEqual(shell('find . -exec rm {} +').decision, 'deny')
})
