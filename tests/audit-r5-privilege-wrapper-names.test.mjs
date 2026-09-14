/**
 * The hard-deny tiers are keyed by command name, so a privilege wrapper or an
 * applet dispatcher that no table lists keeps only a classifier-answerable ask:
 * `pkexec ls`, `runuser -u root -- ls`, `runas /user:Administrator cmd` and
 * `busybox rm -rf /` all reached the LLM while `sudo`/`doas`/`su` and
 * `rm -rf /` are hard-denied. The two planes also carried the privilege list
 * as three copies (two Sets plus a hand-written regex literal), so the fix
 * converges the whole-line fuse onto the Set that the per-segment check
 * already uses.
 *
 * Pins both directions: the new spellings keep the deny and their category,
 * routine applet use is not rejected, and the two planes cannot drift.
 *
 * Run: node --test tests/audit-r5-privilege-wrapper-names.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assessShell } from '../lib/auto/shell.js'
import { categorizeTool } from '../lib/auto/category.js'
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
const category = (command) => categorizeTool({ name: 'bash', arguments: { command } }, roots)

test('privilege wrappers outside the old set are hard-denied with their category', () => {
  for (const command of [
    'pkexec ls',
    'pkexec rm -rf /',
    'runuser -u root -- ls',
    'runas /user:Administrator cmd',
    'echo hi; pkexec ls',
    'BLAH=0 runuser -u root -- ls',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
  assert.equal(category('pkexec ls'), 'privilege')
  assert.equal(category('runuser -u root -- ls'), 'privilege')
})

test('an applet dispatcher is unwrapped so the applet keeps its own tier', () => {
  for (const command of ['busybox rm -rf /', 'toybox rm -rf /']) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(category(command), 'delete', `${command} must still classify as delete`)
  }
  const nested = shell('busybox sh -c "rm -rf /"')
  assert.notEqual(nested.decision, 'allow', 'an applet shell must not be allowed')
  assert.equal(nested.classifierEligible, false, 'an applet shell must not reach the classifier')
})

test('routine applet use is not rejected', () => {
  for (const command of ['busybox ls', 'busybox --list', 'busybox echo hi', 'busybox cat package.json']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} is routine and must not be denied`)
  }
})

function setOf(libPath, name) {
  const source = readFileSync(fileURLToPath(new URL(libPath, import.meta.url)), 'utf8')
  const at = source.indexOf(`const ${name} = new Set([`)
  assert.ok(at > 0, `${libPath} declares ${name}`)
  const block = source.slice(at, source.indexOf(']', at) + 1)
  return [...block.matchAll(/'([a-z0-9._-]+)'/g)].map((match) => match[1]).sort()
}

test('the two planes keep the privilege and wrapper name sets in step', () => {
  assert.deepEqual(setOf('../lib/auto/category.js', 'PRIVILEGE_COMMANDS'), setOf('../lib/auto/shell.js', 'PRIVILEGE_COMMANDS'))
  assert.deepEqual(setOf('../lib/auto/category.js', 'WRAPPERS'), setOf('../lib/auto/shell.js', 'WRAPPERS'))
})

test('the whole-line privilege fuse is derived from the set, not a second literal', () => {
  const source = readFileSync(fileURLToPath(new URL('../lib/auto/shell.js', import.meta.url)), 'utf8')
  assert.ok(source.includes('PRIVILEGE_COMMAND_PATTERN'), 'the fuse pattern is built from the set')
  assert.ok(!/\|\(\?:sudo\|doas\|su\)/.test(source), 'no hand-written duplicate of the privilege alternation remains')
})
