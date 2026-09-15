/**
 * Maintenance batch M1 · independent-review follow-ups.
 *
 * Two findings from the read-only independent review of this batch are pinned
 * here:
 *
 * 1. `git restore <paths>` rewrites the working tree at those paths, but the git
 *    branch of the category layer returned before the protected-name check, so a
 *    `git restore` of a credential or protected path was labelled `gitLocal` and
 *    stayed an LLM-answerable ask while the identical write through `cp` was
 *    `protected`. The path operands are now judged like a copy/move destination;
 *    `--staged` on its own (index only) keeps its previous handling.
 *
 * 2. The batch normalizes interpreter names on the RESTRICTION lists only. The
 *    review found one allow-list call site (`routineInlineProbe`) had been
 *    normalized too, which let `python.exe -c "import os"` ride the static
 *    routine-probe allow. That call site is back on the raw name so the suffixed
 *    spelling stays the stricter one, as the batch claims.
 *
 * Run: node --test tests/maint-m1-review-fixes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
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
const categoryOf = (command) => categorizeCommand(command, 'bash', roots, cfg).category
const assessmentOf = (command) => assessShell(command, 'bash', roots, new ArtifactRegistry(), { id: 'session-m1-review' })

test('git restore of a credential path is labelled protected, like the same write through cp', () => {
  assert.equal(categoryOf(`git restore ${HOME}/.npmrc`), 'protected')
  assert.equal(categoryOf(`git restore C:/ws/.env`), 'protected')
})

test('git restore of an ordinary workspace path is a file edit', () => {
  assert.equal(categoryOf('git restore C:/ws/notes.txt'), 'fileEdit')
})

test('an index-only restore keeps its previous handling', () => {
  assert.equal(categoryOf(`git restore --staged ${HOME}/.npmrc`), 'gitLocal')
})

test('the routine-inline-probe allow list is not normalized for the exe spelling', () => {
  assert.equal(assessmentOf('python -c "import os"').decision, 'allow', 'the plain spelling is a routine probe')
  assert.notEqual(assessmentOf('python.exe -c "import os"').decision, 'allow', 'the suffixed spelling stays stricter')
})
