/**
 * The \??\ and \\??\ spellings of a UNC target must resolve like \\?\UNC\.
 *
 * The alias whitelist admitted `\??\UNC\server\share` past the device-namespace
 * fuse, but canonicalization stripped the prefix without restoring the
 * `\\server\share` form: the target collapsed into the cwd-relative `UNC\…`,
 * which every fuse read as an ordinary workspace-relative name, while the
 * `\\?\UNC\` spelling of the same share root is denied as a filesystem root.
 *
 * Run: node --test tests/audit-nt-unc-alias.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeWindowsNamespace, hardDestructiveTargetReason, normalizePath } from '../lib/auto/paths.js'

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

test('the ?? spellings of the UNC prefix restore the server form', () => {
  assert.equal(canonicalizeWindowsNamespace('\\??\\UNC\\srv\\share'), '\\\\srv\\share')
  assert.equal(canonicalizeWindowsNamespace('\\\\??\\UNC\\srv\\share'), '\\\\srv\\share')
  assert.equal(canonicalizeWindowsNamespace('\\\\??\\unc\\srv\\share'), '\\\\srv\\share')
})

test('the collapsed spellings reach the same root fuse as \\\\?\\UNC\\', () => {
  assert.match(String(hardDestructiveTargetReason('\\??\\UNC\\srv\\share', roots)), /root|UNC/i)
  assert.match(String(hardDestructiveTargetReason('\\\\??\\UNC\\srv\\share', roots)), /root|UNC/i)
  const control = hardDestructiveTargetReason('\\\\?\\UNC\\srv\\share', roots)
  assert.match(String(control), /root|UNC/i)
})

test('a path inside the share stays a non-root target (no over-block)', () => {
  assert.equal(hardDestructiveTargetReason('\\??\\UNC\\srv\\share\\docs\\file.txt', roots), undefined,
    'a deep UNC file is not a root; ordinary position gating governs it')
})

test('the drive-letter spellings keep their canonicalization (unchanged)', () => {
  assert.equal(canonicalizeWindowsNamespace('\\??\\C:\\x'), 'C:\\x')
  assert.equal(canonicalizeWindowsNamespace('\\\\??\\C:\\x'), 'C:\\x')
  assert.equal(canonicalizeWindowsNamespace('\\\\?\\C:\\x'), 'C:\\x')
})
