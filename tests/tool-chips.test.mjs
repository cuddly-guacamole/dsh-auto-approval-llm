/**
 * Exact-list chips pure-logic contract tests.
 *
 * Covers src/client/tool-chips.ts (compiled to lib/client/tool-chips.js):
 * prefix detection, the human-deny collapse guard, list-entry dedupe and the
 * exact-before-collapsed ordering. Run: node --test tests/tool-chips.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toolPrefixOf, canCollapse, buildToolChips, applyChipToList } from '../lib/client/tool-chips.js'

test('toolPrefixOf: registers mcp__server__ prefix only', () => {
  assert.equal(toolPrefixOf('mcp__inkstone__create_note'), 'mcp__inkstone__')
  assert.equal(toolPrefixOf('mcp__playwright__browser_click'), 'mcp__playwright__')
  assert.equal(toolPrefixOf('bash'), undefined)
  assert.equal(toolPrefixOf('read'), undefined)
  assert.equal(toolPrefixOf('mcp__x'), undefined) // no trailing __ tool part
  assert.equal(toolPrefixOf('mcp____note'), undefined) // empty server
})

test('canCollapse: a class with a human-denied member is never collapsed', () => {
  assert.equal(canCollapse('mcp__inkstone__', []), true)
  assert.equal(canCollapse('mcp__inkstone__', ['mcp__inkstone__search']), false)
  assert.equal(canCollapse('mcp__inkstone__', ['mcp__playwright__browser_click']), true)
})

test('buildToolChips: a multi-member class collapses into one wildcard chip, sorted by count', () => {
  const stats = [
    { name: 'bash', count: 9 },
    { name: 'mcp__inkstone__create_note', count: 5 },
    { name: 'mcp__inkstone__search', count: 4 },
    { name: 'read', count: 2 },
  ]
  const chips = buildToolChips(stats, [], [])
  // Collapsed class chip REPLACES its two members (bash 9 > inkstone total 9
  // sorts before by name tiebreak? bash=9, class=9 → alphabetical: bash < mcp…)
  assert.deepEqual(chips.map((c) => c.value), [
    'bash', 'mcp__inkstone__*', 'read',
  ])
  const collapsed = chips.find((c) => c.collapsed)
  assert.ok(collapsed)
  assert.deepEqual(collapsed.members, ['mcp__inkstone__create_note', 'mcp__inkstone__search'])
})

test('buildToolChips: list entries are deduped from the candidates', () => {
  const stats = [{ name: 'bash', count: 3 }, { name: 'read', count: 2 }]
  const chips = buildToolChips(stats, [], ['bash'])
  assert.deepEqual(chips.map((c) => c.value), ['read'])
})

test('buildToolChips: wildcard entry already in the list hides the whole class', () => {
  const stats = [{ name: 'mcp__inkstone__create_note', count: 5 }, { name: 'mcp__inkstone__search', count: 4 }]
  const chips = buildToolChips(stats, [], ['mcp__inkstone__*'])
  assert.deepEqual(chips, []) // class fully covered — no member or collapse chip
})

test('buildToolChips: any member listed hides the class collapse (exact intent wins)', () => {
  const stats = [{ name: 'mcp__inkstone__create_note', count: 5 }, { name: 'mcp__inkstone__search', count: 4 }]
  const chips = buildToolChips(stats, [], ['mcp__inkstone__search'])
  // The operator already pinned one member exactly — neither a collapse over
  // the class nor the unlisted sibling is offered (the collapse would delete
  // the pinned member on click, which we never suggest implicitly).
  assert.deepEqual(chips, [])
})

test('buildToolChips: singleton class stays exact (no collapse chip)', () => {
  const stats = [{ name: 'mcp__inkstone__only', count: 3 }]
  const chips = buildToolChips(stats, [], [])
  assert.deepEqual(chips.map((c) => c.value), ['mcp__inkstone__only'])
  assert.equal(chips.some((c) => c.collapsed), false)
})

test('buildToolChips: collapsed chip respects the human-deny guard', () => {
  const stats = [{ name: 'mcp__inkstone__create_note', count: 5 }, { name: 'mcp__inkstone__search', count: 4 }]
  const chips = buildToolChips(stats, ['mcp__inkstone__search'], [])
  // Guarded class is never collapsed; members surface as exact chips instead.
  assert.equal(chips.some((c) => c.collapsed), false)
  assert.deepEqual(chips.map((c) => c.value), ['mcp__inkstone__create_note', 'mcp__inkstone__search'])
})

test('applyChipToList: exact chip appends a line and dedupes', () => {
  assert.equal(applyChipToList('', { value: 'bash', collapsed: false }), 'bash\n')
  assert.equal(applyChipToList('bash\n', { value: 'bash', collapsed: false }), 'bash\n')
  assert.equal(applyChipToList('read\n', { value: 'bash', collapsed: false }), 'read\nbash\n')
})

test('applyChipToList: exact chip under an existing wildcard is a no-op', () => {
  assert.equal(applyChipToList('mcp__inkstone__*\n', { value: 'mcp__inkstone__create_note', collapsed: false }), 'mcp__inkstone__*\n')
})

test('applyChipToList: collapsed chip removes covered members then adds wildcard', () => {
  const next = applyChipToList('mcp__inkstone__create_note\nmcp__inkstone__search\nbash\n', {
    value: 'mcp__inkstone__*', collapsed: true, members: ['mcp__inkstone__create_note', 'mcp__inkstone__search'],
  })
  assert.equal(next, 'bash\nmcp__inkstone__*\n')
})

test('applyChipToList: collapsed chip already present keeps list unchanged', () => {
  const next = applyChipToList('bash\nmcp__inkstone__*\n', { value: 'mcp__inkstone__*', collapsed: true })
  assert.equal(next, 'bash\nmcp__inkstone__*\n')
})
