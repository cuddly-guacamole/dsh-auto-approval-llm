/**
 * dsh-auto-approval-llm · find's own file-writing actions must be fused.
 *
 * `-fprint`, `-fprintf` and `-fls` write a file named by their operand. The
 * module already classifies them as mutating (`FIND_MUTATING_ACTION`), but the
 * target fuse only consulted `-delete` / `-exec`, and the category plane
 * labels the segment `readOnly` (not LOCKED) — so
 * `find . -fprint ~/.ssh/authorized_keys` reached an answerable countdown that
 * `timeoutAction=allow` can settle, while every other write vector hard-denies
 * the same target.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  trustedDirs: [],
  allowedDshSubpaths: [],
  maintenanceDshPaths: [],
  mode: 'standard',
}
const artifacts = { has: () => false }
const shell = (command) => assessShell(command, 'bash', roots, artifacts, undefined)

test('find output actions naming a critical or runtime-state file are hard-denied', () => {
  for (const command of [
    'find . -fprint C:/Users/u/.ssh/authorized_keys',
    'find . -fprintf C:/Users/u/.ssh/authorized_keys %p',
    'find . -fls C:/Users/u/.dsh/audit.jsonl',
    'find . -fprint C:/Users/u/.dsh/learning.json',
    'find . -fprint /etc/hosts',
    'find . -fprint0 C:/Users/u/.ssh/authorized_keys',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not be LLM-answerable`)
  }
})

test('hardDenyShellReason fuses the same spellings', () => {
  assert.match(hardDenyShellReason('find . -fprint C:/Users/u/.ssh/authorized_keys', 'bash', roots) ?? '', /find/)
})

test('a routine find output target is not over-blocked', () => {
  for (const command of ['find . -fprint ./out.txt', 'find . -fls C:/Temp/list.txt']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} must not be hard-denied`)
  }
})

test('read-only find invocations are unaffected', () => {
  assert.equal(shell('find . -name "*.ts"').decision, 'allow', 'a plain search stays a static allow')
})
