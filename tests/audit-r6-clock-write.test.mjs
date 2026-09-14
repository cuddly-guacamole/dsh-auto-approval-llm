/**
 * A `date` invocation that sets the system clock is refused outright by the
 * static engine instead of being handed to independent classification.
 *
 * Every other state-mutating shell vector this engine recognizes (privilege,
 * deletion, disk, protected metadata, a write into DSH_HOME) is a hard deny
 * that no classifier and no unattended countdown can settle; the clock write
 * was the one exception. Leaving it at the `ask` tier made the safety property
 * depend on the classifier answering correctly AND on the operator not running
 * `timeoutAction: allow`: a live probe of `date --se=2020-01-01` was classified
 * as a "malformed read-only invocation", auto-allowed, and moved the machine
 * clock. A clock write is also not recoverable by the session that made it —
 * it re-dates every record and can expire credentials and sessions.
 *
 * Pins both directions: every clock-write spelling is denied with no
 * classifier channel, and every read-only `date` spelling keeps the static
 * allow. The grouped spelling pins that the fuse stays reachable on a line the
 * decomposer cannot read.
 *
 * Run: node --test tests/audit-r6-clock-write.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: ['C:/ws'],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)

const CLOCK_WRITE_SPELLINGS = [
  'date -s2020-01-01',
  'date -s 2020-01-01',
  'date --set 2020-01-01',
  'date --set=2020-01-01',
  'date --se=2020-01-01',
  'date --se 2020-01-01',
  'date --s=2020-01-01',
  'date --s 2020-01-01',
  'date -us2020-01-01',
  'date -d @0 -s 2020-01-01',
  'echo hi; date --se=2020-01-01',
  'date --se=2020-01-01; (:)',
]

const READ_ONLY_SPELLINGS = [
  'date',
  'date -u',
  'date +%s',
  'date -R',
  'date -Iseconds',
  'date -Is',
  'date -Ins',
  'date -uIs',
  'date -d @0',
  'date -r f',
  'date --iso-8601=seconds',
  'echo "date -s2020-01-01"',
]

test('a clock write is hard-denied with no classifier channel', () => {
  for (const command of CLOCK_WRITE_SPELLINGS) {
    const result = shell(command)
    assert.equal(result.decision, 'deny', `${command} must be denied, got ${result.decision} (${result.reason})`)
    assert.equal(result.classifierEligible, false, `${command} must not be classifier-answerable`)
    assert.match(result.reason, /system clock/, `${command} must name the clock fuse, got ${result.reason}`)
  }
})

test('read-only date spellings keep the static allow', () => {
  for (const command of READ_ONLY_SPELLINGS) {
    const result = shell(command)
    assert.equal(result.decision, 'allow', `${command} must stay allowed, got ${result.decision} (${result.reason})`)
  }
})

test('the clock fuse is reachable on a line the decomposer cannot read', () => {
  // The grouped spellings are opaque, so they exercise the recovered-target
  // owner rather than the per-segment loop; a fuse that only lived in the
  // segment loop would silently skip them.
  for (const command of ['(date --se=2020-01-01)', '{ date -s 2020-01-01; }']) {
    assert.equal(hardDenyShellReason(command, 'bash', roots), 'the system clock is not settable from agent sessions', command)
  }
  // The quoted-source spelling is decomposed, but the clock write is inside the
  // quoted program: the nested owner reaches it on the assessment path.
  const nested = shell('bash -c "date --se=2020-01-01"')
  assert.equal(nested.decision, 'deny', nested.reason)
  assert.equal(nested.classifierEligible, false)
  assert.match(nested.reason, /system clock/)
})

test('the clock fuse does not misfire on other commands or on clock data', () => {
  const notClockWrites = [
    'echo "date --se=2020-01-01"',
    'printf "%s" "date -s 2020"',
    'git log --format=date',
    'ls -s',
    'rm -rf /tmp/x',
  ]
  for (const command of notClockWrites) {
    assert.equal(hardDenyShellReason(command, 'bash', roots), undefined, `${command} must not hit the clock fuse`)
  }
})
