/**
 * dsh-auto-approval-llm · dynamic/glob write-target fuse contracts.
 *
 * Fix: write-vector heads (cp/mv/install/tee/sed -i/truncate/dd) used to
 * skip dynamic and globbed destination operands in both the hard-deny loop
 * and the static-allow path, so `cp ./x "$HOME/.ssh/authorized_keys"` and
 * `tee ./a "$HOME/.dsh/history.jsonl"` were statically allowed with no fuse
 * and no review. Dynamic `$HOME` spellings are now hard-denied like the
 * redirection/deletion branches; every other dynamic/glob destination loses
 * the static allow and reaches semantic review.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'

const plainRoots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const artifacts = { has: () => false }
const shell = (command, roots = plainRoots) => assessShell(command, 'bash', roots, artifacts, undefined)

// ── dynamic $HOME write targets: unconditional hard deny ────────────────────
test('assessShell: dynamic $HOME write targets are hard-denied across write-vector heads', () => {
  for (const command of [
    'cp ./x "$HOME/.ssh/authorized_keys"',
    'cp ./x "$HOME/../../etc/passwd"',
    'mv ./x "$HOME/.aws/credentials"',
    'install ./x "$HOME/.gnupg/gpg.conf"',
    'tee ./a "$HOME/.dsh/history.jsonl"',
    'sed -i.bak s/a/b/ "$HOME/.ssh/authorized_keys"',
    'truncate -s 0 "$HOME/.dsh/history.jsonl"',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must be hard-denied`)
    assert.match(r.reason ?? '', /dynamic/, `${command} reason should name the dynamic target`)
    assert.equal(r.classifierEligible, false, `${command} must not degrade into an LLM-answerable ask`)
  }
})

// ── non-home dynamic destinations: static allow must be unreachable ─────────
test('assessShell: non-home dynamic write targets lose the static allow (semantic review)', () => {
  for (const command of ['cp ./x "$DEST"', 'tee ./a "$FOO"', 'mv ./x "$TARGET"', 'sed -i.bak s/a/b/ "$FILE"']) {
    const r = shell(command)
    assert.notEqual(r.decision, 'allow', `${command} must not be statically allowed`)
    assert.equal(r.classifierEligible, true, `${command} may be answered by semantic review`)
  }
})

// ── static write targets keep their static allow (no over-block) ────────────
test('assessShell: static write targets keep their static allow (no over-block)', () => {
  for (const command of ['cp ./a ./b', 'cp -r C:/ws/src C:/ws/dst', 'tee ./out.txt', 'mv ./a ./b', 'truncate -s 0 ./log.bin']) {
    assert.equal(shell(command).decision, 'allow', `${command} stays static`)
  }
})

// ── explicit operands ride the same destructive fuse as redirections ────────
// The redirection branch hard-denies `echo x > ~/.ssh/authorized_keys`; the
// operand branches (cp/mv/install/tee/sed -i/truncate/dd) previously only
// fused runtime-state and DSH_HOME targets, so the same destination arrived
// as an LLM-answerable ask instead of the unconditional deny.
test('assessShell: explicit critical-path write operands hard-deny across write-vector heads', () => {
  for (const command of [
    'cp ./x ~/.ssh/authorized_keys',
    'mv ./x ~/.ssh/authorized_keys',
    'install ./x ~/.ssh/authorized_keys',
    'tee ~/.ssh/authorized_keys ./x',
    'sed -i s/a/b/ ~/.ssh/authorized_keys',
    'truncate -s 0 ~/.ssh/authorized_keys',
    'cp ./x ~/.bashrc',
    'truncate -s 0 ~/.bashrc',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must hard-deny like the redirection form`)
    assert.equal(r.classifierEligible, false, `${command} must never reach the classifier`)
  }
})

// Boundary note (deliberate): workspace CONTENT writes stay routine while
// PATH deletion is gated. Truncation is not special-cased into an ask because
// the same destruction rides `tee file < /dev/null` or `cp /dev/null file` —
// gating truncate alone would only move the operator, not close the class.
test('assessShell: workspace content-write vs path deletion boundary stays explicit', () => {
  assert.equal(shell('truncate -s 0 ./log.bin').decision, 'allow', 'emptying workspace content is a routine write')
  assert.equal(shell('tee ./log.bin').decision, 'allow', 'the equivalent overwrite rides the same routine class')
  const deletion = shell('rm ./log.bin')
  assert.notEqual(deletion.decision, 'allow', 'path deletion of a pre-session file stays gated')
})