/**
 * Maintenance batch M1 · a sort output file or temporary directory is a write.
 *
 * The static engine already steps out of its read-only allow for the
 * `-o`/`-T`/`--t…` spellings, but the DESTINATION never entered any fuse and the
 * category layer kept labelling the line readOnly from its read-only name list.
 * A `sort -T <state tree>` therefore wrote temporaries into the plugin state
 * tree as a statically allowed read-only command, and `sort -o <protected>` wrote
 * wherever it was pointed.
 *
 * The short `-t` is deliberately not a target: in sort it is the field
 * separator, so booking it would turn a delimiter into a path.
 *
 * Run: node --test tests/maint-m1-sort-output.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { categorizeCommand } from '../lib/auto/category.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const HOME = 'C:/Users/u'
const roots = {
  workspace: 'C:/ws',
  home: HOME,
  dshHome: `${HOME}/.dsh`,
  tempRoots: [],
  allowedDshSubpaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const cfg = { categoryPolicy: {}, categoryMode: 'aggressive' }

const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)
const assessmentOf = (command) => assessShell(command, 'bash', roots, new ArtifactRegistry(), { id: 'session-m1-sort' })
const categoryOf = (command) => categorizeCommand(command, 'bash', roots, cfg).category

test('every temporary-directory spelling reaches the state-tree fuse', () => {
  for (const command of [
    `sort -T ${HOME}/.dsh/t C:/ws/in.txt`,
    `sort -T${HOME}/.dsh/t C:/ws/in.txt`,
    `sort --temporary-directory=${HOME}/.dsh/t C:/ws/in.txt`,
    `sort --t=${HOME}/.dsh/t C:/ws/in.txt`,
  ]) {
    assert.match(String(hardDeny(command)), /DSH_HOME/, `${command} must be hard-denied`)
    assert.equal(categoryOf(command), 'fileEdit', `${command} is a write, not a read-only command`)
  }
})

test('every output-file spelling is denied by its own fence and labelled as a write', () => {
  // The output file keeps the fence that already owns it (`assessShell` denies
  // with a reason naming the output flag), so this asserts that owner's verdict
  // plus the label this batch adds, rather than this batch's reason text.
  for (const command of [
    `sort -o ${HOME}/.dsh/out.txt C:/ws/in.txt`,
    `sort -o${HOME}/.dsh/out.txt C:/ws/in.txt`,
    `sort --output=${HOME}/.dsh/out.txt C:/ws/in.txt`,
  ]) {
    const verdict = assessmentOf(command)
    assert.equal(verdict.decision, 'deny', `${command} must be denied (got ${verdict.decision}: ${verdict.reason})`)
    assert.match(String(verdict.reason ?? ''), /output flag/, `${command} keeps the output-flag owner`)
    assert.equal(categoryOf(command), 'fileEdit')
  }
})

test('a protected output name is labelled protected', () => {
  assert.equal(categoryOf(`sort -o ${HOME}/.npmrc C:/ws/in.txt`), 'protected')
})

test('an ordinary workspace output stays unfused', () => {
  assert.equal(hardDeny('sort -o C:/ws/out.txt C:/ws/in.txt'), undefined)
  assert.equal(categoryOf('sort -o C:/ws/out.txt C:/ws/in.txt'), 'fileEdit')
})

test('the field separator and plain invocations stay read-only', () => {
  for (const command of [
    'sort -t : -k1 C:/ws/in.txt',
    'sort -n C:/ws/in.txt',
    'sort --version',
    'sort C:/ws/in.txt',
  ]) {
    assert.equal(categoryOf(command), 'readOnly', `${command} is a read-only invocation`)
    assert.equal(hardDeny(command), undefined)
  }
})
