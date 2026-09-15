/**
 * Maintenance batch M1 · a here-document fed to a dynamic interpreter is code.
 *
 * `hereDocumentRunsAsCode` decides whether a here-document body must be judged
 * as executed code or as inert data. It read the interpreter name from the
 * segment's first word and compared it to the stdin-interpreter set, so a body
 * fed to an unreadable prefix (`$SHELL <<EOF`, `$(which bash) <<EOF`) fell
 * through: the same document prefixed by the literal name marked the line as
 * code, while the dynamic spelling was classified as an ordinary answerable ask.
 *
 * A prefix that cannot be resolved statically is now treated as code, which is
 * the fail-closed direction the predicate already takes for the delimiter
 * spellings (`<<\EOF`). A document that is not fed to an interpreter at all
 * (`cat <<EOF`) keeps its data treatment, so the tightening does not swallow
 * every heredoc in the workspace.
 *
 * Run: node --test tests/maint-m1-dynamic-interpreter.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
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
const assessmentOf = (command) => assessShell(command, 'bash', roots, new ArtifactRegistry(), { id: 'session-m1-heredoc' })

/** A body that is unambiguously a state-tree deletion if the document runs. */
const body = `rm -rf ${HOME}/.dsh`
const heredoc = (head) => [head, body, 'EOF'].join('\n')

test('a literal interpreter prefix marks the document as code', () => {
  assert.equal(assessmentOf(heredoc('bash <<EOF')).classifierEligible, false)
})

test('a dynamic interpreter prefix is judged as code too', () => {
  for (const head of ['$SHELL <<EOF', '${SHELL} <<EOF', '$(which bash) <<EOF']) {
    assert.equal(assessmentOf(heredoc(head)).classifierEligible, false, `${head} must not stay answerable`)
  }
})

test('the dynamic and literal spellings settle the same way', () => {
  const literal = assessmentOf(heredoc('python <<EOF'))
  for (const head of ['$PYTHON <<EOF', '$(which python) <<EOF']) {
    const dynamic = assessmentOf(heredoc(head))
    assert.equal(dynamic.decision, literal.decision, `${head} must settle like python`)
    assert.equal(dynamic.classifierEligible, literal.classifierEligible)
  }
})

test('a document that is not fed to an interpreter keeps its data treatment', () => {
  assert.equal(assessmentOf(heredoc('cat <<EOF')).classifierEligible, true)
})
