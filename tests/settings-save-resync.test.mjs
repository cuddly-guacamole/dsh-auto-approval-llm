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
  const at = client.indexOf('const refreshSnapshot = async () =>')
  const scope = client.slice(at, at + 700)
  assert.ok(!scope.includes('setDraft('), 'the resync must not clobber unsaved card edits')
})
