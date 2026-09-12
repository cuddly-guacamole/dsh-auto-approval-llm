/**
 * dsh-auto-approval-llm · the planned-create registry must stay bounded.
 *
 * `plan()` runs before the pre-execute handler's first terminal, and only
 * `tools/result` -> `settle()` ever removes an entry. A call the handler
 * refuses (hard deny, denyList, category deny, audit failure) — or one whose
 * execution is aborted — never dispatches, so no result arrives and the entry
 * keeps the execution token and the session object alive for the process
 * lifetime. The registry is now capped with insertion-order eviction; an
 * evicted live call only loses its provenance promotion (the stricter
 * direction), while memory stays bounded.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactRegistry, PENDING_PLAN_CAP } from '../lib/auto/artifacts.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'] }
const exec = (token) => ({ name: 'write', arguments: {}, token, agent: { session: {} } })

test('planned entries never exceed the cap when nothing settles', () => {
  const registry = new ArtifactRegistry()
  for (let i = 0; i < PENDING_PLAN_CAP * 3; i += 1) {
    registry.plan(exec(`t${i}`), [`C:/ws/file-${i}.txt`], roots)
  }
  assert.equal(registry.pending.size, PENDING_PLAN_CAP, 'the registry is bounded by the cap')
})

test('the cap evicts the oldest entry and keeps the newest', () => {
  const registry = new ArtifactRegistry()
  for (let i = 0; i < PENDING_PLAN_CAP + 1; i += 1) {
    registry.plan(exec(`t${i}`), [`C:/ws/file-${i}.txt`], roots)
  }
  assert.equal(registry.pending.has('t0'), false, 'the oldest entry is evicted first')
  assert.equal(registry.pending.has(`t${PENDING_PLAN_CAP}`), true, 'the newest entry survives')
})

test('settle still releases the entry it consumes', () => {
  const registry = new ArtifactRegistry()
  registry.plan(exec('tok'), ['C:/ws/created.txt'], roots)
  assert.equal(registry.pending.size, 1)
  registry.settle(exec('tok'), { isError: false, value: {} }, roots)
  assert.equal(registry.pending.size, 0, 'a settled execution leaves nothing behind')
})
