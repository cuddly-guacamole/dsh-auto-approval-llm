/**
 * The clock-write guard for the read-only `date` whitelist matches the mutating
 * flag family, but it treated any short option cluster containing `s` as
 * `--set`: `date -Iseconds`, `date -Is`, `date -uIs` and `date -Ins` are
 * ordinary read-only format spellings (`-I[FMT]` carries a fused optional
 * value) and lost the static allow — a review prompt for a command the
 * whitelist exists to pass.
 *
 * Pins both directions: every read-only spelling keeps the static allow, and
 * every GNU spelling of the clock write still leaves it.
 *
 * Run: node --test tests/audit-r5-date-readonly-spellings.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
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

test('the read-only date spellings keep the static allow', () => {
  for (const command of [
    'date',
    'date -u',
    'date +%s',
    'date -d @0',
    'date -Iseconds',
    'date -Is',
    'date -Ins',
    'date -uIs',
    'date -R',
    'date --iso-8601=seconds',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'allow', `${command} is read-only and must stay statically allowed`)
    assert.equal(verdict.classifierEligible, false, `${command} must stay off the classifier`)
  }
})

test('every clock-write spelling still leaves the read-only allow', () => {
  for (const command of [
    'date -s2020-01-01',
    'date -s 2020-01-01',
    'date -us2020-01-01',
    'date --set=2020-01-01',
    'date --set 2020-01-01',
    'date --se=2020-01-01',
    'date --se 2020-01-01',
    'date --s=2020-01-01',
    'date -u -s2020-01-01',
  ]) {
    const verdict = shell(command)
    assert.notEqual(verdict.decision, 'allow', `${command} writes the clock and must not be statically allowed`)
  }
})
