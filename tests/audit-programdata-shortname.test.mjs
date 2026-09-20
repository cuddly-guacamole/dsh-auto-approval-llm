/**
 * Literal `PROGRAM~n` directory names must hit the system-critical fuse.
 *
 * The critical-path regex carried 8.3 forms for the Windows directory
 * (`WINDOW~1`) and Program Files (`PROGRA~1`) but not for other
 * `PROGRAM~n`-shaped literal names. (Correction from the review pass: the
 * 8.3 short name of ProgramData is `PROGRA~3`, already covered by the
 * `progra~\d` alternative — the 8.3 algorithm cannot produce the 9-character
 * `PROGRAM~1`. This fuse now covers the literal `PROGRAM~n` spelling as
 * fail-closed hardening of the family shape, not as a ProgramData alias.)
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

test('the literal PROGRAM~n spellings are system-critical', () => {
  assert.match(String(hardDestructiveTargetReason('C:/PROGRAM~1/x', roots)), /critical/i)
  assert.match(String(hardDestructiveTargetReason('C:/PROGRAM~2/x', roots)), /critical/i)
})

test('the real short names keep their verdicts (control, unchanged)', () => {
  assert.match(String(hardDestructiveTargetReason('C:/ProgramData/x', roots)), /critical/i)
  assert.match(String(hardDestructiveTargetReason('C:/PROGRA~1/x', roots)), /critical/i)
  assert.match(String(hardDestructiveTargetReason('C:/PROGRA~3/x', roots)), /critical/i,
    'the actual 8.3 short name of ProgramData rides the existing progra~ alternative')
})

test('ordinary program-named directories stay non-critical (no over-block)', () => {
  assert.equal(hardDestructiveTargetReason('C:/ws/programdata-like/x', roots), undefined)
  assert.equal(hardDestructiveTargetReason('C:/ws/programs', roots), undefined)
})
