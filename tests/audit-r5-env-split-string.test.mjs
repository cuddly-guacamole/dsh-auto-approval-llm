/**
 * `env -S/--split-string VALUE` runs VALUE as a command line (the shebang
 * spelling), so the effective command is the first word inside VALUE. The
 * wrapper table consumed VALUE as an opaque flag value, which left `env`
 * itself as the effective command: `env -S "rm -rf /"` stayed a
 * classifier-answerable ask while `rm -rf /`, `sh -c "rm -rf /"`,
 * `stdbuf -o L rm -rf /` and the R4-fixed `env -u FOO rm -rf /` are all hard
 * denied. The split string is spliced back into the word list so every fuse —
 * and the category plane's delete lock — sees the command that really runs.
 *
 * Pins both directions: the destructive/privilege spellings keep the hard
 * deny, and routine split strings stay ordinary read-only commands.
 *
 * Run: node --test tests/audit-r5-env-split-string.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
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

const DESTRUCTIVE_FORMS = [
  'env -S "rm -rf /"',
  "env -S 'rm -rf /'",
  'env -S rm -rf /',
  'env --split-string "rm -rf /"',
  'env --split-string="rm -rf /"',
  'env --s "rm -rf /"',
  'env --sp="rm -rf /"',
  'env -i -S "rm -rf /"',
  'env -u FOO -S "rm -rf /"',
  'env -iS "rm -rf /"',
  'env -vS "rm -rf /"',
  'env -iSrm -rf /',
]

const PRIVILEGE_FORMS = [
  'env -S "sudo ls"',
  'env --split-string="doas ls"',
  'env -C /tmp -S "su -c whoami"',
  'env -iS "sudo ls"',
]

test('a destructive command line hidden in a split string stays hard-denied', () => {
  for (const command of DESTRUCTIVE_FORMS) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
    assert.equal(category(command), 'delete', `${command} must still classify as delete`)
  }
})

test('a privilege command line hidden in a split string stays hard-denied', () => {
  for (const command of PRIVILEGE_FORMS) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(category(command), 'privilege', `${command} must still classify as privilege`)
  }
})

test('the separated spelling the R4 table already covered keeps working', () => {
  for (const command of ['env -u FOO rm -rf /', 'env --unset FOO rm -rf /', 'env --argv0 x rm -rf /']) {
    assert.equal(shell(command).decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(category(command), 'delete', `${command} must still classify as delete`)
  }
})

test('routine split strings are not rejected', () => {
  for (const command of [
    'env -S "ls -la"',
    'env -S "echo hi"',
    'env --split-string="git status"',
    'env -S "node --version"',
    'env FOO=1 ls',
    'env -u FOO ls',
  ]) {
    const verdict = shell(command)
    assert.notEqual(verdict.decision, 'deny', `${command} is a routine read and must not be denied`)
  }
})
