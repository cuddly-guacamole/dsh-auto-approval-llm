/**
 * A credential DELETE that answers 200 must mean the reviewer key is gone from
 * every source. The shared-credential-file removal used to discard its own
 * verdict, so a failed rewrite still reported success while
 * `resolveReviewerApiKey` kept reading the key out of that file on the next
 * review — the UI showed "cleared" and the key stayed live.
 *
 * Pins the per-file verdict (isolated from this machine's real credential
 * file) and the route's use of it.
 * Run: node --test tests/audit-credential-file-clear.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearReviewerKeyInFile, clearReviewerKeyFromCredentialFile } from '../lib/index.js'

const REF = 'DSH_AUTO_APPROVAL_REVIEWER_API_KEY'

function tempFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-cred-clear-'))
  const file = join(dir, '.credentials.yaml')
  writeFileSync(file, contents)
  return {
    file,
    restore() {
      try { chmodSync(file, 0o666) } catch { /* best effort */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a present key is removed and reported as cleared', () => {
  const home = tempFile(`other: keep\n${REF}: dummy-value\n`)
  try {
    assert.equal(clearReviewerKeyInFile(home.file), 'cleared')
    const text = readFileSync(home.file, 'utf8')
    assert.doesNotMatch(text, new RegExp(REF), 'the reviewer ref must be gone')
    assert.match(text, /other: keep/, 'no other ref line is touched')
  } finally {
    home.restore()
  }
})

test('a file without the key is absent, not a failure', () => {
  const home = tempFile('other: keep\n')
  try {
    assert.equal(clearReviewerKeyInFile(home.file), 'absent')
  } finally {
    home.restore()
  }
})

test('a missing file is absent, not a failure', () => {
  assert.equal(clearReviewerKeyInFile(join(tmpdir(), 'dsa-no-such-credential-file', '.credentials.yaml')), 'absent')
  assert.equal(clearReviewerKeyInFile(''), 'absent')
})

test('a key that cannot be removed is reported as failed', () => {
  const home = tempFile(`${REF}: dummy-value\n`)
  chmodSync(home.file, 0o444)
  try {
    assert.equal(clearReviewerKeyInFile(home.file), 'failed')
    assert.match(readFileSync(home.file, 'utf8'), new RegExp(REF), 'the key really is still there')
  } finally {
    home.restore()
  }
})

test('the wrapper keeps the failed verdict of any candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-cred-wrapper-'))
  const file = join(dir, '.credentials.yaml')
  writeFileSync(file, `${REF}: dummy-value\n`)
  chmodSync(file, 0o444)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    // The second candidate (this machine's real credential file) carries no
    // reviewer ref, so the wrapper must still report the failure it saw.
    assert.equal(clearReviewerKeyFromCredentialFile(), 'failed')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    try { chmodSync(file, 0o666) } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the credential route refuses to answer 200 on a failed file removal', () => {
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.match(lib, /const fileClear = clearReviewerKeyFromCredentialFile\(\)/)
  assert.match(lib, /if \(fileClear === 'failed'\) \{/)
  assert.match(lib, /credential clear failed on the shared credential file/)
})
