/**
 * A whitelisted read-only command that carries its own output flag is a file
 * mutation, exactly like a write redirection: `sort -o out`, `tree -o out` and
 * `git diff --output=out` write a file whose path never appears as a
 * redirection token. The engine only lifted *absolute* flag values into the
 * explicit-path list, so a relative value produced an empty write target set
 * and the segment rode the static read-only allow — `sort -o lib/index.js`
 * rewrote the plugin's own execution code with no panel.
 *
 * Pins the fuse for the plugin zone, the no-allow rule for relative values,
 * and the read-only controls that must keep their fast path.
 * Run: node --test tests/audit-readonly-output-flag.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const WIN = { skip: process.platform !== 'win32' }
const REPO = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const generic = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const inRepo = { ...generic, workspace: REPO, dshHome: REPO.slice(0, REPO.indexOf('/plugins/')), allowedDshSubpaths: [REPO] }
const assess = (command, roots = generic) => assessShell(command, 'bash', roots, new ArtifactRegistry(), undefined)

test('an in-workspace output flag never rides the static read-only allow', () => {
  for (const command of [
    'sort -o out.txt in.txt',
    'sort -oout.txt in.txt',
    'sort --output=out.txt in.txt',
    'sort --output out.txt in.txt',
    'tree -o out.txt',
    'tree --output=out.txt',
    'git diff --output=out.txt',
    'sort -uo out.txt in.txt',
  ]) {
    const verdict = assess(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be statically allowed, got allow (${verdict.reason})`)
  }
})

test('an output flag aimed at the plugin zone hits the existing destructive fuse', WIN, () => {
  for (const command of ['sort -o lib/index.js src/index.ts', 'tree -o package.json', 'git diff --output=package.json']) {
    const verdict = assess(command, inRepo)
    assert.equal(verdict.decision, 'deny', `${command} must be denied, got ${verdict.decision}`)
  }
})

test('a relative output flag that leaves the workspace is not routine', () => {
  for (const command of ['sort -o ../../evil.txt in.txt', 'tree -o sub/../../../evil.txt']) {
    const verdict = assess(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be statically allowed`)
  }
})

test('read-only spellings without an output flag keep their fast path', () => {
  for (const command of [
    'sort src/index.ts',
    'sort -u src/index.ts',
    'sort -rn -k2 numbers.txt',
    'tree',
    'tree -L 2',
    'git diff',
    'git diff --output-indicator-new=+',
    'git status',
    'rg -o needle file.txt',
    'grep -o needle file.txt',
    'cat notes.txt',
  ]) {
    const verdict = assess(command)
    assert.equal(verdict.decision, 'allow', `${command} must stay allowed, got ${verdict.decision} (${verdict.reason})`)
    assert.equal(hardDenyShellReason(command, 'bash', generic), undefined)
  }
})
