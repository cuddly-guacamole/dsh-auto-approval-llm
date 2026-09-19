/**
 * ProgramData's 8.3 short name (PROGRAM~1) must hit the system-critical fuse.
 *
 * The critical-path regex carried 8.3 forms for the Windows directory
 * (`WINDOW~1`) and Program Files (`PROGRA~1`) but not for ProgramData — whose
 * short name is `PROGRAM~1`, one letter too long for the `progra~\d`
 * alternative — so `C:\PROGRAM~1\…` escaped the system-critical fuse while
 * `C:\ProgramData\…` is denied.
 *
 * Run: node --test tests/audit-programdata-shortname.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { hardDestructiveTargetReason } from '../lib/auto/paths.js'

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

test('the 8.3 short name of ProgramData is system-critical', () => {
  assert.match(String(hardDestructiveTargetReason('C:/PROGRAM~1/x', roots)), /critical/i)
  assert.match(String(hardDestructiveTargetReason('C:/PROGRAM~2/x', roots)), /critical/i)
})

test('the long spelling and the sibling short names keep their verdicts (control)', () => {
  assert.match(String(hardDestructiveTargetReason('C:/ProgramData/x', roots)), /critical/i)
  assert.match(String(hardDestructiveTargetReason('C:/PROGRA~1/x', roots)), /critical/i)
})

test('ordinary program-named directories stay non-critical (no over-block)', () => {
  assert.equal(hardDestructiveTargetReason('C:/ws/programdata-like/x', roots), undefined)
  assert.equal(hardDestructiveTargetReason('C:/ws/programs', roots), undefined)
})
