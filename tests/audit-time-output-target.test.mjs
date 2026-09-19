/**
 * The `time` wrapper's output file must reach the write fuses.
 *
 * unwrap drops `time`'s value flags with the rest of the wrapper, so the
 * report file named by `-o`/`--output` reached no fuse at all and
 * `time --output=<outside> ls` was a static read-only allow — while the same
 * target behind `sort -o` is fused. Only the flags before the wrapped command
 * belong to `time`; after it, `-o` belongs to the wrapped command and must not
 * be booked as a `time` target.
 *
 * Run: node --test tests/audit-time-output-target.test.mjs
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
const owner = { id: 'session-time-output' }
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

const assess = (command) => assessShell(command, 'bash', roots, artifacts, owner)
const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)

test('the output file of the time wrapper leaves the static read-only allow', () => {
  for (const command of [
    'time --output=C:/out.txt ls',
    'time --output C:/out.txt ls',
    'time -o C:/out.txt ls',
    'time -oC:/out.txt ls',
    'time -o C:/out.txt --format=%e ls',
  ]) {
    const verdict = assess(command)
    assert.ok(verdict, `${command} must not be a static allow`)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be a static allow`)
  }
})

test('the report file still hits the destructive fuse when the target is critical', () => {
  const fused = assess('time --output C:/Users/u/.dsh/history.jsonl ls')
  assert.match(String(fused?.reason ?? ''), /DSH_HOME/)
  assert.equal(fused?.decision, 'deny')
  const traversal = assess('time --output=C:/ws/../../x ls')
  assert.ok(traversal, 'a traversal target must not be a static allow')
  assert.notEqual(traversal.decision, 'allow')
})

test('the control (sort -o onto a critical path) keeps its deny (unchanged)', () => {
  const control = assess('sort -o C:/Users/u/.ssh/x /dev/null')
  assert.match(String(control?.reason ?? ''), /critical|credential|DSH_HOME/i)
  assert.equal(control?.decision, 'deny')
})

test('flags after the wrapped command belong to it, not to time (no over-block)', () => {
  assert.equal(hardDeny('time ls -o C:/out.txt'), undefined,
    'a wrapped command parses its own flags; time only owns its prefix options')
  const verdict = assess('time ls -o C:/out.txt')
  assert.ok(verdict === undefined || verdict.decision === 'allow' || verdict.decision === 'ask')
})
