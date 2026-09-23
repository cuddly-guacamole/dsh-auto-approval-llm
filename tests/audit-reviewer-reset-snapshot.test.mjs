/**
 * The reviewer card's reset saved the configuration and then discarded the
 * new baseline, so the card kept the pre-save revision: the next save from any
 * card was rejected (optimistic concurrency) and the card reported "unsaved"
 * against a value that was no longer stored. Every other save path adopted the
 * new baseline; this one must too.
 *
 * The transport this guard was written against has since changed — the Host
 * form owns the writes and answers with a boolean, so there is no response
 * body to adopt any more. The invariant did not change with it: after a
 * successful write a path must adopt what it wrote (or re-read the route
 * snapshot) BEFORE any later step of its own runs, and the reset path must do
 * it before it clears the credential.
 *
 * Pins the client wiring (a UI state property, not a pure function).
 * Run: node --test tests/audit-reviewer-reset-snapshot.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')

/**
 * The brace-balanced `{…}` body that starts at the first `{` after `marker`.
 *
 * A counted window would silently stop covering a handler as it grows, which
 * turns the NEGATIVE half of these assertions into a false pass. The signature
 * is skipped first: a destructured parameter list carries braces of its own.
 */
function block(source, marker) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `handler marker missing: ${marker}`)
  const signatureEnd = marker.endsWith(')') ? at + marker.length : source.indexOf(')', at + marker.length)
  const open = source.indexOf('{', signatureEnd)
  assert.notEqual(open, -1, `no body after: ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return assert.fail(`unbalanced body after: ${marker}`)
}

/** Every settings save path, by its declaration, so none can quietly drop out. */
const SAVE_PATHS = [
  'const saveCard = async (keys: string[], cardId: string)',
  'const instantSaveKeys = async (patch: Record<string, unknown>)',
  'const resetReviewerCard = async ()',
  'const restoreTopDefaults = async ()',
  'const clearInvalidKeys = async ()',
]

test('the reset path adopts the written baseline before it clears the credential', () => {
  const body = block(src, 'const resetReviewerCard = async ()')
  assert.ok(body.includes('REVIEWER_CREDENTIAL_ROUTE'), 'precondition: this region really is the reset handler')
  const submit = body.indexOf('submit(')
  const adopted = body.indexOf('adoptWrite(', submit)
  const credentialDelete = body.indexOf('REVIEWER_CREDENTIAL_ROUTE', submit)
  assert.ok(submit > 0, 'the reset path writes the settings first')
  assert.ok(adopted > submit, 'the written baseline must be adopted after the write')
  assert.ok(credentialDelete > adopted, 'the baseline must be adopted before the credential delete')
})

test('every settings save path adopts what it wrote', () => {
  for (const marker of SAVE_PATHS) {
    const body = block(src, marker)
    // Only the SUCCESS side counts: a re-read in the failure handler cannot
    // cover for a path that walks away from what it just stored.
    const catchAt = body.search(/\bcatch\s*\(/)
    const accepted = catchAt === -1 ? body : body.slice(0, catchAt)
    assert.ok(
      accepted.includes('adoptWrite(') || accepted.includes('refreshSnapshot()'),
      `${marker} writes settings but never adopts the result, so the next save keeps a stale revision`,
    )
  }
})
