/**
 * dsh-auto-approval-llm · empty-value environment prefixes.
 *
 * `NAME=value cmd` prefixes are stripped so the effective command is judged
 * (`BLAH=0 sudo ls` cannot hide `sudo`). The pattern required `.+` after the
 * `=`, so the empty-value spelling (`FOO= sudo ls`, the idiomatic way to clear
 * a variable for one command) kept the prefix as the effective command name
 * and both planes lost the privilege / destructive verdict: the line decayed
 * into a classifier-eligible ask that `timeoutAction=allow` can settle.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
import { categorizeCommand } from '../lib/auto/category.js'

const plainRoots = {
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
const shell = (command) => assessShell(command, 'bash', plainRoots, artifacts, undefined)

test('an empty-value prefix does not hide a privilege escalation', () => {
  for (const command of ['FOO= sudo ls', "FOO='' sudo ls", 'FOO="" doas whoami', 'FOO= su -c id']) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not be LLM-answerable`)
  }
})

test('an empty-value prefix does not hide a destructive command', () => {
  for (const command of ['FOO= rm -rf /', 'FOO= rm -rf ~/.ssh', 'FOO= tee ~/.dsh/history.jsonl', 'FOO= truncate -s 0 ~/.dsh/audit.jsonl']) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not be LLM-answerable`)
  }
})

test('the category plane unwraps the same spellings', () => {
  assert.equal(categorizeCommand('FOO= sudo ls', 'bash', plainRoots).category, 'privilege')
  assert.equal(categorizeCommand('FOO= rm -rf /', 'bash', plainRoots).category, 'delete')
})

test('a plain assignment-looking argument is still not escalation', () => {
  assert.equal(shell('VAR=1 ls').decision, 'allow', 'a non-empty prefix keeps its existing handling')
  assert.equal(shell('echo FOO=').decision, 'allow', 'an argument is not a prefix')
})
