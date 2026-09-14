/**
 * Maintenance batch M1 · write-vector family expansion (static layer).
 *
 * The maintenance-period review measured that several heads writing through
 * their own operands were invisible to every static fuse: `ln -sf`, `tar -cf`,
 * `tar -xf -C`, `unzip -d`, in-place `perl -i` and `sponge` landed in the
 * `unknown` category with `classifierEligible=true`, so a write into the plugin
 * state tree or a credential tree was answerable by the LLM reviewer instead of
 * being hard-denied — while the same write through `tee` / `dd of=` / `sed -i`
 * entered the family and was judged by the operand fuses.
 *
 * The fix routes those heads through the existing write-target owners in
 * `shell.ts` (so the hard-deny fuses see the destination, and `category.ts`
 * labels them like a copy/move onto the same target). Read-mode spellings stay
 * outside the family: a listing, a test run or a non-in-place perl edit must not
 * be booked as a write.
 *
 * The residual shape (a head whose destination cannot be named statically, e.g.
 * `unzip` without `-d` or `patch` whose targets live inside the patch file) is
 * pinned here as "unchanged", so a later batch can narrow it deliberately
 * instead of inheriting a silent widening.
 *
 * Run: node --test tests/maint-m1-write-vectors.test.mjs
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
const owner = { id: 'session-m1' }
const cfg = { categoryPolicy: {}, categoryMode: 'aggressive' }

/** Hard-deny reason for one bash line, or undefined when nothing fuses it. */
const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)
/** Category the category layer assigns to one bash line (aggressive, no policy). */
const categoryOf = (command) => categorizeCommand(command, 'bash', roots, cfg).category
/** Static assessment of one bash line. */
const assessmentOf = (command) => assessShell(command, 'bash', roots, new ArtifactRegistry(), owner)

test('sanity: a write into the plugin state tree is hard-denied for an already-covered head', () => {
  assert.match(String(hardDeny(`tee ${HOME}/.dsh/evil.txt`)), /DSH_HOME/)
})

// ---- positive: every newly covered head reaches the destination fuses ----

test('ln writes its link target and now reaches the DSH_HOME fuse', () => {
  assert.match(String(hardDeny(`ln -sf C:/ws/x ${HOME}/.dsh/evil`)), /DSH_HOME/)
})

test('tar create mode books the archive named by -f', () => {
  assert.match(String(hardDeny(`tar -cf ${HOME}/.dsh/out.tar -C C:/ws .`)), /DSH_HOME/)
})

test('tar extract mode books the -C directory, not the archive source', () => {
  assert.match(String(hardDeny(`tar -xf C:/ws/a.tar -C ${HOME}/.dsh/unz`)), /DSH_HOME/)
  assert.equal(hardDeny(`tar -xf ${HOME}/.dsh/a.tar -C C:/ws`), undefined, 'the archive is a read, the -C dir is inside the workspace')
})

test('unzip -d books the extraction directory', () => {
  assert.match(String(hardDeny(`unzip -o C:/ws/a.zip -d ${HOME}/.dsh/unz`)), /DSH_HOME/)
})

test('perl -i books its file operands, not the program text', () => {
  assert.match(String(hardDeny(`perl -pi -e 's/a/b/' ${HOME}/.dsh/state.txt`)), /DSH_HOME/)
  assert.equal(hardDeny(`perl -e 'print 1' ${HOME}/.dsh/state.txt`), undefined, 'without -i perl only reads its operand')
})

test('sponge books its operand', () => {
  assert.match(String(hardDeny(`sponge ${HOME}/.dsh/state.txt`)), /DSH_HOME/)
})

// ---- category layer: the heads label like a copy/move onto the same target ----

test('newly covered heads label as fileEdit and stop being classifier-answerable', () => {
  for (const command of [
    'ln -sf C:/ws/x D:/outside/link.txt',
    'tar -cf D:/outside/a.tar -C C:/ws .',
    'unzip -o C:/ws/a.zip -d D:/outside/unz',
    "perl -i -pe 's/a/b/' D:/outside/f.txt",
    'sponge D:/outside/f.txt',
  ]) {
    assert.equal(categoryOf(command), 'fileEdit', `${command} must label like the covered write heads`)
    assert.equal(assessmentOf(command).classifierEligible, false, `${command} must not stay classifier-answerable`)
  }
})

test('a protected name wins over fileEdit for a newly covered head', () => {
  assert.equal(categoryOf(`sponge ${HOME}/.npmrc`), 'protected')
  assert.equal(categoryOf(`ln -sf C:/ws/x ${HOME}/.env`), 'protected')
})

// ---- negative: read modes and unnamed destinations keep their behavior ----

test('read-mode spellings are never booked as writes', () => {
  assert.equal(hardDeny(`tar -tf ${HOME}/.dsh/a.tar`), undefined, 'tar -t lists')
  assert.equal(hardDeny(`unzip -l C:/ws/a.zip`), undefined, 'unzip -l lists')
  assert.notEqual(categoryOf(`tar -tf C:/ws/a.tar`), 'fileEdit', 'a listing is not a write')
  assert.notEqual(categoryOf(`unzip -l C:/ws/a.zip`), 'fileEdit', 'a listing is not a write')
})

test('an extract without -C (destination is the cwd) stays outside the family', () => {
  assert.equal(hardDeny('tar -xf C:/ws/a.tar'), undefined)
  assert.equal(hardDeny('unzip -o C:/ws/a.zip'), undefined)
})

test('benign workspace writes through the new heads are not hard-denied', () => {
  assert.equal(hardDeny('ln -sf C:/ws/a.txt C:/ws/b.txt'), undefined)
  assert.equal(hardDeny('tar -cf C:/ws/out.tar -C C:/ws .'), undefined)
  assert.equal(hardDeny('sponge C:/ws/out.txt'), undefined)
})
