/**
 * A whitelisted read-only command can still hand work to another program the
 * caller never wrote on the line. `sort --compress-program=PROG` runs PROG
 * through a shell on the sort temporaries (`sort --help`: "compress temporaries
 * with PROG") and `sort -T DIR` names a directory to write them into, yet both
 * spellings rode the static read-only allow with no approval at all — while the
 * same layer already refuses `rg --pre` for exactly this reason.
 *
 * Pins both directions: the program-executing spellings leave the static allow,
 * and ordinary sort use keeps it.
 *
 * Run: node --test tests/audit-r5-whitelist-exec-flags.test.mjs (tsc first)
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

test('a program-running output option leaves the read-only static allow', () => {
  for (const command of [
    "sort --compress-program=sh in.txt",
    "sort --compress-program 'sh -c id' in.txt",
    'sort --co=rm in.txt',
    'sort --compress-program=rm in.txt',
  ]) {
    const verdict = shell(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be a static allow`)
  }
})

test('a temporary-directory option leaves the read-only static allow', () => {
  for (const command of ['sort -T /tmp in.txt', 'sort -T/tmp in.txt', 'sort --temporary-directory=/tmp in.txt']) {
    const verdict = shell(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be a static allow`)
  }
})

test('ordinary sort use keeps the static allow', () => {
  for (const command of [
    'sort in.txt',
    'sort -n in.txt',
    'sort -k1 in.txt',
    'rg --pre',
    'rg pattern in.txt',
  ]) {
    const verdict = shell(command)
    if (command.startsWith('sort'))
      assert.equal(verdict.decision, 'allow', `${command} is a routine read and must stay a static allow`)
    else
      assert.notEqual(verdict.decision, 'deny', `${command} must not be hard-denied`)
  }
})
