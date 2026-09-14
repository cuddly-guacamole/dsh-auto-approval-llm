/**
 * Static-allow spellings of the `date` whitelist member.
 *
 * The routine-read whitelist grants a zero-approval static allow, and whitelist
 * members with mutating spellings keep only their read-only forms (`date`
 * without `-s`/`--set`, `rg` without `--pre`, bare `hostname`). The date guard
 * compared whole tokens, so only the space-separated spellings left the static
 * allow: GNU's fused short form (`date -s2020-01-01`, clustered `-us2020-01-01`)
 * and the long form carrying its value with `=` (`date --set=2020-01-01`) still
 * reached the static allow with `classifierEligible === false` — a system-clock
 * write with no approval at all, not even a classifier review.
 *
 * The guard now matches the flag family in one place, and that family is
 * terminal (see tests/audit-r6-clock-write.test.mjs): a recognized clock write
 * is refused instead of being reviewed. Display-only spellings must keep their
 * static allow (a false reject here would turn every routine timestamp read into
 * an approval prompt).
 *
 * Run: node --test tests/audit-r4-date-set-spellings.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { assessShell } from '../lib/auto/shell.js'
import { resolveRoots } from '../lib/auto/paths.js'

const WORKSPACE = 'C:/ws'
const roots = resolveRoots(WORKSPACE, {})
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []

const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)

test('date: every --set / -s spelling is refused outright', () => {
  for (const command of [
    "date -s '2020-01-01 00:00:00'",
    'date -s2020-01-01',
    'date -s=2020-01-01',
    'date -us2020-01-01',
    'date --set 2020-01-01',
    'date --set=2020-01-01',
    'date --set=2020-01-01T00:00:00',
  ]) {
    const verdict = shell(command)
    // The clock write left the static allow first, and is now a terminal refuse
    // (see tests/audit-r6-clock-write.test.mjs): the safety property used to
    // rest on the classifier answering correctly and on the operator not
    // running an unattended allow countdown.
    assert.equal(verdict.decision, 'deny', `${command} must be refused outright`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach semantic review`)
  }
})

test('date: display-only spellings keep the static allow', () => {
  for (const command of [
    'date',
    'date -u',
    'date +%s',
    'date +%H:%M',
    'date -d yesterday',
    'date --date=@1700000000',
    'date --iso-8601',
    'date -R',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'allow', `${command} must stay a static allow`)
    assert.equal(verdict.classifierEligible, false, `${command} must not be sent to the classifier`)
  }
})

test('date: the guard keys on the flag family, not on one literal spelling', () => {
  const source = readFileSync(new URL('../src/auto/shell.ts', import.meta.url), 'utf8')
  const guard = source.slice(source.indexOf("if (name === 'date')"), source.indexOf("if (name === 'hostname')"))
  assert.match(guard, /isDateClockWriteFlag/, 'the date guard must key on the shared flag-family predicate')
})
