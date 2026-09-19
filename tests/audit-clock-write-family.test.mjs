/**
 * The clock-write fuse must cover the platform siblings of `date`.
 *
 * `date` has been hard-denied for clock writes since the clock-restore
 * incident: one classifier mistake used to be enough to move the machine
 * clock, because the call is otherwise an ordinary ask that an unattended
 * countdown settles. PowerShell's Set-Date, systemd's timedatectl and hwclock
 * set the same clock and had no fuse at all.
 *
 * Run: node --test tests/audit-clock-write-family.test.mjs
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
const owner = { id: 'session-clock-family' }
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

const hardDeny = (command, shell = 'bash') => hardDenyShellReason(command, shell, roots)
const assess = (command, shell = 'bash') => assessShell(command, shell, roots, artifacts, owner)

test('the clock-write fuse covers the sibling spellings', () => {
  for (const command of [
    'Set-Date -Date "2020-01-01"',
    'set-date "2020-01-01"',
    'timedatectl set-time "2020-01-01"',
    'timedatectl set-ntp false',
    'hwclock --systohc',
    'hwclock --hctosys',
    'hwclock --set --date="2020-01-01"',
  ]) {
    assert.match(String(hardDeny(command)), /clock/i, `${command} must be hard-denied`)
    assert.equal(assess(command)?.decision, 'deny', `${command} must be denied`)
  }
})

test('the date control keeps its verdict (unchanged)', () => {
  assert.match(String(hardDeny('date --set 2020-01-01')), /clock/i)
  assert.match(String(hardDeny('date -s 2020-01-01')), /clock/i)
})

test('query spellings of the same tools stay ordinary commands (no over-block)', () => {
  assert.equal(hardDeny('timedatectl status'), undefined)
  assert.equal(hardDeny('timedatectl list-timezones'), undefined)
  assert.equal(hardDeny('date'), undefined)
  assert.equal(hardDeny('date +%F'), undefined)
})
