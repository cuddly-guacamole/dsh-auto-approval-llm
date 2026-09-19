/**
 * Variable spellings of the plugin runtime root must hit the dynamic-target
 * fuses.
 *
 * `dynamicHomeTarget` recognized `$HOME`-family spellings only, so a write
 * head naming its destination as `$DSH_HOME/…` skipped every destination fuse
 * (the operand loop skips dynamic targets that are not home targets) and fell
 * to `semanticReview` — classifier-answerable — while the same command with
 * `$HOME` is hard-denied. The exfiltration fuse already recognized the
 * `$DSH_HOME` spelling family; the destination fuses now do too.
 *
 * Run: node --test tests/audit-dynamic-dshhome-target.test.mjs
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
const owner = { id: 'session-dynamic-dsh' }
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)
const assess = (command) => assessShell(command, 'bash', roots, artifacts, owner)

test('write heads naming $DSH_HOME are hard-denied like the $HOME spelling', () => {
  for (const command of [
    'cp a $DSH_HOME/config.json',
    'cp a ${DSH_HOME}/config.json',
    'cp a $env:DSH_HOME/config.json',
    'tee $DSH_HOME/audit.jsonl < /dev/null',
    'dd of=$DSH_HOME/history.jsonl if=/dev/null',
  ]) {
    assert.match(String(hardDeny(command)), /DSH_HOME|home/i, `${command} must be hard-denied`)
    const verdict = assess(command)
    assert.ok(verdict, `${command} must not be a static allow`)
    assert.notEqual(verdict.decision, 'allow')
  }
})

test('the same heads with $HOME stay hard-denied (control, unchanged)', () => {
  assert.match(String(hardDeny('cp a $HOME/config.json')), /home/i)
})

test('dynamic DSH_HOME destruction leaves the classifier fast path', () => {
  const verdict = assess('rm -rf $DSH_HOME/auto-approval-llm')
  assert.ok(verdict, 'destructive dynamic target must not be a static allow')
  assert.equal(verdict.classifierEligible, false)
})

test('longer variable names that merely start with the stem behave like the $HOME family (consistent over-block)', () => {
  assert.match(String(hardDeny('cp a $HOME_SUFFIX/config.json')), /home/i)
  assert.match(String(hardDeny('cp a $DSH_HOME_SUFFIX/config.json')), /home/i,
    'the DSH_HOME family must keep the same loose-stem semantics as the HOME family')
})
