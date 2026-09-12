/**
 * An NTFS alternate-data-stream suffix must not defeat a basename fuse.
 * `package.json::$DATA` names the *same* file as `package.json`, but the
 * basename predicates (plugin-zone contract/build files, protected metadata,
 * credential basenames) matched the raw trailing segment, so appending
 * `::$DATA` turned a hard deny into a plain write. Normalizing the default
 * data stream away in the single path normalizer covers every consumer
 * (structured tools, shell write targets, the destructive-target fuse).
 *
 * Run: node --test tests/audit-windows-ads-suffix.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { hardDestructiveTargetReason, normalizePath } from '../lib/auto/paths.js'
import { assessTool } from '../lib/auto/policy.js'
import { hardDenyShellReason, assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const WIN = { skip: process.platform !== 'win32' }
const REPO = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const repoRoots = { ...roots, workspace: REPO, dshHome: REPO.slice(0, REPO.indexOf('/plugins/')), allowedDshSubpaths: [REPO] }
const reg = () => new ArtifactRegistry()
const writeVerdict = (path, useRoots) => assessTool({ name: 'write', arguments: { file_path: path, content: 'x' } }, useRoots, reg()).decision

test('the default data stream normalizes to the file it names', WIN, () => {
  for (const suffix of ['::$DATA', ':$DATA', '::$data', ':$data']) {
    assert.equal(normalizePath(`${REPO}/package.json${suffix}`, REPO), normalizePath(`${REPO}/package.json`, REPO), suffix)
  }
  assert.equal(normalizePath(`${REPO}/package.json.::$DATA`, REPO), normalizePath(`${REPO}/package.json`, REPO))
})

test('the plugin contract file stays denied with the stream suffix', WIN, () => {
  assert.match(hardDestructiveTargetReason(`${REPO}/package.json`, repoRoots) ?? '', /contract\/build file/)
  for (const suffix of ['::$DATA', ':$DATA', '::$data']) {
    const reason = hardDestructiveTargetReason(`${REPO}/package.json${suffix}`, repoRoots)
    assert.match(reason ?? '', /contract\/build file/, `package.json${suffix} must stay fused`)
    assert.equal(writeVerdict(`${REPO}/package.json${suffix}`, repoRoots), 'deny', `package.json${suffix} must stay denied`)
  }
})

test('a credential basename keeps its floor with the stream suffix', WIN, () => {
  assert.equal(writeVerdict('C:/ws/.env', roots), 'ask')
  for (const suffix of ['::$DATA', ':$DATA']) {
    assert.equal(writeVerdict(`C:/ws/.env${suffix}`, roots), 'ask', `.env${suffix} must not drop to allow`)
  }
})

test('a shell write to the stream spelling is still hard-denied', WIN, () => {
  const msys = `/${REPO[0].toLowerCase()}${REPO.slice(2)}`
  // Quoting (or escaping the `$`) is what actually makes the shell reach
  // `<file>::$DATA`; those spellings must stay fused.
  for (const command of [
    `printf x > ${msys}/package.json:\\$DATA`,
    `printf x > '${msys}/package.json::$DATA'`,
  ]) {
    const reason = hardDenyShellReason(command, 'bash', repoRoots)
    assert.match(reason ?? '', /contract\/build file|execution code/, `${command} got: ${reason}`)
  }
  // Unquoted, bash expands `$DATA` away, so the engine reads a dynamic target:
  // it must still fail closed to a human, never to a static allow.
  const dynamic = `printf x > ${msys}/package.json::$DATA`
  assert.equal(hardDenyShellReason(dynamic, 'bash', repoRoots), undefined)
  const verdict = assessShell(dynamic, 'bash', repoRoots, reg(), undefined)
  assert.notEqual(verdict.decision, 'allow')
  assert.equal(verdict.classifierEligible, false, 'a dynamic write target is never handed to the classifier')
})

test('ordinary paths and ordinary streams keep their treatment', WIN, () => {
  assert.equal(hardDestructiveTargetReason(`${REPO}/src/index.ts::$DATA`, repoRoots), undefined)
  assert.equal(writeVerdict('C:/ws/notes.txt', roots), 'allow')
  assert.equal(writeVerdict('C:/ws/notes.txt::$DATA', roots), 'allow')
})
