/**
 * GNU tar long-option prefixes must reach the tar write fuses.
 *
 * tarDiskMode and tarWriteTargets matched only the full long spellings, so the
 * unambiguous GNU prefixes (--cr for --create, --extr for --extract, --ge for
 * --get, --fi for --file, --dir for --directory) made the invocation
 * unrecognizable: the destination fuse never saw the archive or the -C target
 * and the command decayed to a classifier-answerable ask, while the full
 * spellings are hard-denied on the same targets.
 *
 * Run: node --test tests/audit-tar-abbrev.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'

const HOME = 'C:/Users/u'
const roots = {
  workspace: 'C:/ws',
  home: HOME,
  dshHome: `${HOME}/.dsh`,
  tempRoots: [],
  allowedDshSubpaths: [],
  trustedDirs: [],
  mode: 'standard',
}
const owner = { id: 'session-tar-abbrev' }
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)
const assess = (command) => assessShell(command, 'bash', roots, artifacts, owner)

test('abbreviated create/extract spellings reach the DSH_HOME destination fuse', () => {
  for (const command of [
    `tar --cr x.tar -C C:/ws . --file=${HOME}/.dsh/x.tar`,
    `tar --creat --fi=${HOME}/.dsh/x.tar -C C:/ws .`,
    `tar --extr x.tar --dir ${HOME}/.dsh`,
    `tar --ge x.tar -C ${HOME}/.dsh`,
  ]) {
    assert.match(String(hardDeny(command)), /DSH_HOME/, `${command} must be hard-denied`)
  }
})

test('the full spellings keep their verdicts (control, unchanged)', () => {
  assert.match(String(hardDeny(`tar -xf x.tar -C ${HOME}/.dsh .`)), /DSH_HOME/)
  assert.match(String(hardDeny(`tar --create --file=${HOME}/.dsh/x.tar -C C:/ws .`)), /DSH_HOME/)
})

test('an ambiguous stem stays unrecognized rather than guessed', () => {
  assert.equal(hardDeny(`tar --c x.tar -C C:/ws . --file=${HOME}/.dsh/x.tar`), undefined,
    '--c is ambiguous (catenate/concatenate/compare/create) and must not fuse as create')
})

test('listing mode stays a read under abbreviations (no over-block)', () => {
  assert.equal(hardDeny('tar --li x.tar'), undefined, 'a listing writes nothing')
  assert.equal(hardDeny('tar --li x.tar --file C:/ws/archive.tar'), undefined)
  const verdict = assess('tar --li C:/ws/archive.tar')
  assert.ok(verdict === undefined || verdict.decision !== 'deny', 'a workspace listing must not be denied')
})
