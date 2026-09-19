/**
 * Cross-line redirect targets must stay fused.
 *
 * bash accepts a redirect whose target is written on the following line
 * (`printf x >\n~/.ssh/authorized_keys` executes as one command). The segment
 * state machine used to drop the pending redirect at the newline, so the target
 * became an ordinary word of the next segment: no fuse saw it, the category
 * layer fell through to the classifier, and an unattended `timeoutAction=allow`
 * could settle it. The single-line spelling of the same command is hard-denied —
 * the newline must not change the verdict.
 *
 * Run: node --test tests/audit-crossline-redirect.test.mjs
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
const owner = { id: 'session-crossline' }
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)
const assess = (command) => assessShell(command, 'bash', roots, artifacts, owner)

test('a redirect target on the next line reaches the same fuses as the single-line spelling', () => {
  const crossLine = 'printf x >\n~/.ssh/authorized_keys'
  const singleLine = 'printf x > ~/.ssh/authorized_keys'
  assert.match(String(hardDeny(singleLine)), /credential|authorized|critical|protected/i)
  assert.match(String(hardDeny(crossLine)), /credential|authorized|critical|protected/i)
})

test('the cross-line spelling never lands on the classifier fast path', () => {
  const verdict = assess('printf x >\n~/.ssh/authorized_keys')
  assert.ok(verdict, 'the assessment must not be a static allow')
  assert.equal(verdict.classifierEligible, false)
})

test('a redirect with no target before end of input stays fail-closed', () => {
  const verdict = assess('printf x >\n')
  assert.ok(verdict, 'an unterminated redirect must not be silently allowed')
  assert.equal(verdict.decision, 'ask')
})

test('ordinary multi-line scripts keep their per-line verdicts (no fuse misfire)', () => {
  const command = 'printf x > C:/ws/a.txt\ntail -f C:/ws/b.log'
  assert.equal(hardDeny(command), undefined, 'routine workspace writes and reads must not hit any hard fuse')
  const verdict = assess(command)
  assert.ok(verdict === undefined || verdict.decision !== 'deny')
})

test('a target already flushed before the newline is not re-applied to the next line', () => {
  const command = 'printf x > C:/ws/a.txt\nls C:/ws'
  assert.equal(hardDeny(command), undefined, 'the second line is an independent command, not a second target')
  assert.equal(hardDeny('printf x >\nC:/ws/a.txt'), undefined, 'the carried target on a routine workspace path stays routine')
})
