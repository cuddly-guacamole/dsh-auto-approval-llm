/**
 * dsh-auto-approval-llm · fused `--target-directory=VALUE` dynamic/glob flag
 * inheritance contract.
 *
 * Fix: the fused spelling (`--target-directory=$HOME/.dsh/x`) slices a new
 * operand out of a single lexer word; the derived operand used to hardcode
 * `dynamic:false, glob:false`, so a `$HOME` destination skipped the
 * dynamic-home hard-deny (segmentHardDenyReason) and the static-allow gate
 * (classifyEffectiveCommand) never saw a dynamic/glob target. `-t DEST` and
 * `--target-directory DEST` (separate words) always preserved the flags; the
 * fused branch must behave identically. The derived operand now inherits
 * `dynamic`/`glob` from its source word.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'

const plainRoots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const artifacts = { has: () => false }
const shell = (command, roots = plainRoots) => assessShell(command, 'bash', roots, artifacts, undefined)

// ── fused dynamic $HOME destination: unconditional hard deny ───────────────
test('assessShell: fused --target-directory=$HOME destination is hard-denied like the -t form', () => {
  for (const command of [
    'cp ./x --target-directory=$HOME/.ssh/authorized_keys',
    'cp ./x --target-directory="$HOME/.ssh/authorized_keys"',
    'mv ./x --target-directory=$HOME/.dsh/skills/SKILL.md',
    'install ./x --target-directory=$HOME/.gnupg/gpg.conf',
    'cp ./x --target-directory="$HOME/.dsh/history.jsonl"',
    'cp ./x --target-directory=$HOME/../../etc/passwd',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must be hard-denied`)
    assert.match(r.reason ?? '', /dynamic/, `${command} reason should name the dynamic target`)
    assert.equal(r.classifierEligible, false, `${command} must not degrade into an LLM-answerable ask`)
  }
  // The -t separate-word spelling keeps its own deny (parity control).
  assert.equal(shell('cp ./x -t "$HOME/.ssh/authorized_keys"').decision, 'deny')
})

// ── fused non-home dynamic destination: static allow unreachable ────────────
test('assessShell: fused --target-directory=$VAR loses the static allow (semantic review)', () => {
  for (const command of [
    'cp ./x --target-directory=$DEST',
    'mv ./x --target-directory="$TARGET"',
    'install ./x --target-directory=$DEST',
  ]) {
    const r = shell(command)
    assert.notEqual(r.decision, 'allow', `${command} must not be statically allowed`)
    assert.equal(r.classifierEligible, true, `${command} may be answered by semantic review`)
  }
})

// ── fused glob destination: static allow unreachable (glob flag inherited) ─
test('assessShell: fused --target-directory with a glob spelling loses the static allow', () => {
  for (const command of ['cp ./x --target-directory=*/dest', 'mv ./x --target-directory=C:/ws/*/d']) {
    const r = shell(command)
    assert.notEqual(r.decision, 'allow', `${command} must not be statically allowed`)
    assert.equal(r.classifierEligible, true, `${command} may be answered by semantic review`)
  }
})

// ── static fused destinations keep prior semantics (no over-block) ──────────
test('assessShell: static fused destinations keep prior allow/deny semantics', () => {
  assert.equal(shell('cp ./x --target-directory=C:/ws/dir').decision, 'allow', 'in-workspace explicit fused destination stays static')
  assert.equal(shell('cp ./x --target-directory=./plain-dir').decision, 'allow', 'in-workspace relative fused destination stays static')
  // Explicit absolute DSH_HOME fused spelling was already denied pre-fix and
  // must stay denied (regression guard).
  assert.equal(shell('cp ./x --target-directory=C:/Users/u/.dsh/history.jsonl').decision, 'deny')
  assert.equal(shell('cp ./x --target-directory=C:/Users/u/.dsh/history.jsonl').classifierEligible, false)
})
