/**
 * `sort` spellings that hand work to a program or a directory the caller never
 * named on the line.
 *
 * GNU accepts any unambiguous abbreviation of a long option, and the shortest
 * abbreviation of `--temporary-directory` is `--t` — only the short-option
 * spelling `-t` shares that letter, and that one is the field separator. A
 * guard matching `--te` caught `--te=`/`--temp=`/`--tempor=` and `-T`, but let
 * `sort --t=/tmp in.txt` keep the static allow. With a routine temporary
 * directory that is a silent allow: whether it writes anywhere depends on
 * whether the sort spills to disk, and the target is chosen by the caller.
 *
 * Pins the whole family (long abbreviations, short fused/separate spellings)
 * and the read-only direction (`-t:` is the field separator).
 *
 * Run: node --test tests/audit-r6-sort-option-abbreviations.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shellWith = (roots, command) => assessShell(command, 'bash', roots, registry, owner)

// A workspace whose temporary root makes /tmp a routine location: this is the
// shape in which the missing abbreviation was a silent allow rather than a
// reviewable ask.
const routineRoots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/ws/tmp'],
  allowedDshSubpaths: ['C:/ws'],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}

const LEAVES_STATIC_ALLOW = [
  'sort --t=C:/ws/tmp/in in.txt',
  'sort --t C:/ws/tmp/in in.txt',
  'sort --te=C:/ws/tmp/in in.txt',
  'sort --temp=C:/ws/tmp in.txt',
  'sort --tempor=C:/ws/tmp in.txt',
  'sort --temporary-directory=C:/ws/tmp in.txt',
  'sort -T C:/ws/tmp in.txt',
  'sort -TC:/ws/tmp in.txt',
  'sort --comp=sh in.txt',
  'sort --co=sh in.txt',
  'sort --compress-program=sh in.txt',
]

const STAYS_STATIC_ALLOW = [
  'sort in.txt',
  'sort -n in.txt',
  'sort -k1 in.txt',
  'sort -t: -k1 in.txt',
  'sort -t : -k1 in.txt',
  'sort --check in.txt',
  'sort --c=sh in.txt',
]

test('every sort spelling that names a temporary directory or a program leaves the static allow', () => {
  for (const command of LEAVES_STATIC_ALLOW) {
    const verdict = shellWith(routineRoots, command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not stay a static allow (${verdict.reason})`)
    assert.equal(verdict.classifierEligible, true, `${command} must reach a reviewable tier, not a blind ask`)
  }
})

test('the field separator and the plain read-only spellings keep the static allow', () => {
  for (const command of STAYS_STATIC_ALLOW) {
    const verdict = shellWith(routineRoots, command)
    assert.equal(verdict.decision, 'allow', `${command} must stay allowed (${verdict.reason})`)
    assert.equal(verdict.classifierEligible, false, command)
  }
})

test('the shortest abbreviation is judged the same in a real workspace shape too', () => {
  const real = {
    workspace: 'C:/Users/u/.dsh/plugins/dsh-auto-approval-llm',
    home: 'C:/Users/u',
    dshHome: 'C:/Users/u/.dsh',
    tempRoots: ['C:/Temp'],
    allowedDshSubpaths: ['C:/Users/u/.dsh/plugins/dsh-auto-approval-llm'],
    maintenanceDshPaths: [],
    trustedDirs: [],
    mode: 'aggressive',
  }
  for (const command of ['sort --t=C:/Temp/in in.txt', 'sort --t C:/Temp/in in.txt']) {
    const verdict = shellWith(real, command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not stay a static allow`)
  }
})
