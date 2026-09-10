/**
 * dsh-auto-approval-llm · settings save failure resync (compiled bundle).
 *
 * Every settings POST carries expectedRevision from the loaded snapshot. A
 * revision mismatch (another tab, or a save racing an instant capsule) used to
 * leave the stale snapshot in place forever — every later save kept failing
 * until a full page reload. Each save channel's catch must re-sync the
 * snapshot, and the instant channel must roll back its optimistic draft patch
 * so the control reflects the stored value. Run:
 * node --test tests/settings-save-resync.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Slice from a start marker to the end marker that FOLLOWS it.
 *
 * A counted window (`slice(at, at + N)`) silently stops covering the code it
 * names once the region grows, and a NEGATIVE assertion inside such a window
 * turns that into a false pass rather than a failure: the assertion cannot see
 * the thing it forbids any more, so it reports clean. Both markers are
 * mandatory here — a renamed anchor fails loudly instead of producing an empty
 * slice that satisfies every `!includes` check.
 */
function region(src, startMarker, endMarker) {
  const from = src.indexOf(startMarker)
  assert.notEqual(from, -1, `source marker missing: ${startMarker}`)
  const to = endMarker === undefined ? src.length : src.indexOf(endMarker, from + startMarker.length)
  assert.notEqual(to, -1, `region end missing after ${startMarker}: ${endMarker}`)
  assert.ok(to > from, `region end must follow its start: ${startMarker}`)
  return src.slice(from, to)
}

/**
 * The brace-balanced `{…}` body that starts at the first `{` after `marker`.
 *
 * Indentation is the bundler's business (the compiled bundle uses tabs where
 * the source uses spaces), so an end marker written as `"\n  }"` matches the
 * source file and misses the bundle entirely. Counting braces is agnostic to
 * both, and it pins the whole body rather than a character budget. Braces
 * inside string literals are not modelled, so this is only safe where the
 * region has none — the caller's precondition assertion is what proves the
 * extracted region is the intended extent.
 */
function block(src, marker) {
  const at = src.indexOf(marker)
  assert.notEqual(at, -1, `source marker missing: ${marker}`)
  const open = src.indexOf('{', at + marker.length)
  assert.notEqual(open, -1, `no block body after: ${marker}`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return assert.fail(`unbalanced block after: ${marker}`)
}

test('save failure resync: a snapshot refresh helper exists and is wired into every catch', () => {
  assert.ok(client.includes('const refreshSnapshot = async () =>'), 'refreshSnapshot helper is defined')
  // Five save channels: saveCard, instantSaveKeys, resetReviewerCard,
  // restoreTopDefaults, clearInvalidKeys. (The bundler drops the `void`
  // operator, so anchor on the bare call.)
  const calls = client.split('refreshSnapshot()').length - 1
  assert.ok(calls >= 5, `every save channel must resync on failure (found ${calls} call sites)`)
})

test('instant save: the optimistic draft patch rolls back on failure', () => {
  const head = client.indexOf('const prevDraft = draft')
  const rollback = client.indexOf('setDraft(prevDraft)')
  assert.ok(head > 0, 'the previous draft is captured before the optimistic update')
  assert.ok(rollback > head, 'the optimistic patch is rolled back in the catch')
})

test('refresh snapshot keeps the local draft (per-card ownership preserved)', () => {
  const body = block(client, 'const refreshSnapshot = async () =>')
  assert.ok(
    body.includes('setSnapshot('),
    'precondition: the guarded region really is refreshSnapshot (it writes the snapshot)',
  )
  assert.ok(!body.includes('setDraft('), 'the resync must not clobber unsaved card edits')
})
