/**
 * Tool exact-list wildcard + recent-tool chips aggregation contract tests.
 *
 * Covers two host additions for the exact-list chips UI:
 *  1. `toolListEntryMatches` — a single trailing `*` turns a list entry into a
 *     prefix wildcard; every other shape (exact name, bare `*`, embedded/multiple
 *     `*`) matches only by exact equality so a malformed entry can never widen
 *     an allow/deny (fail-closed).
 *  2. `aggregateToolStats` / `recordInBucket` — history records are bucketed
 *     into allow / deny / human chips by outcome/source, frequency-sorted.
 * Run: node --test tests/tool-list-wildcard.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toolListEntryMatches, staticListDecision } from '../lib/auto/decision.js'
import { aggregateToolStats, recordInBucket } from '../lib/auto/tool-stats.js'

// ── toolListEntryMatches ───────────────────────────────────────────────────

test('toolListEntryMatches: trailing * is a prefix wildcard', () => {
  assert.equal(toolListEntryMatches('mcp__inkstone__*', 'mcp__inkstone__create_note'), true)
  assert.equal(toolListEntryMatches('mcp__inkstone__*', 'mcp__inkstone__search'), true)
  assert.equal(toolListEntryMatches('bash*', 'bashful'), true)
})

test('toolListEntryMatches: wildcard never matches an empty prefix', () => {
  // A bare `*` would mean "everything" — fail-closed: it matches nothing at
  // all (not even the literal `*`), so a stray `*` entry can never widen an
  // allow/deny to the whole tool namespace.
  assert.equal(toolListEntryMatches('*', 'anything'), false)
  assert.equal(toolListEntryMatches('*', '*'), false)
})

test('toolListEntryMatches: embedded or multiple * degrade to exact match', () => {
  assert.equal(toolListEntryMatches('a*b', 'axb'), false)
  assert.equal(toolListEntryMatches('a*b*c', 'aXbXc'), false)
  assert.equal(toolListEntryMatches('mcp__*__note', 'mcp__inkstone__note'), false)
  assert.equal(toolListEntryMatches('a**', 'ab'), false)
})

test('toolListEntryMatches: exact entries behave exactly as before', () => {
  assert.equal(toolListEntryMatches('bash', 'bash'), true)
  assert.equal(toolListEntryMatches('bash', 'bashful'), false)
  assert.equal(toolListEntryMatches('bash', 'BASH'), false)
  assert.equal(toolListEntryMatches('', ''), true)
  assert.equal(toolListEntryMatches('', 'bash'), false)
})

test('staticListDecision: prefix wildcard applies across all three lists', () => {
  const lists = { denyList: ['mcp__evil__*'], allowlist: ['read', 'mcp__inkstone__*'], humanOnlyList: ['bash', 'terminal_*'] }
  assert.deepEqual(staticListDecision(lists, 'mcp__evil__rm'), { kind: 'reject', source: 'denyList-deny' })
  assert.deepEqual(staticListDecision(lists, 'mcp__inkstone__create_note'), { kind: 'allow', source: 'allowlist-allow' })
  assert.deepEqual(staticListDecision(lists, 'read'), { kind: 'allow', source: 'allowlist-allow' })
  assert.deepEqual(staticListDecision(lists, 'terminal_open'), { kind: 'ask-human' })
})

test('staticListDecision: deny wildcard precedes allow wildcard on the same prefix', () => {
  const lists = { denyList: ['mcp__x__*'], allowlist: ['mcp__x__*'], humanOnlyList: [] }
  assert.deepEqual(staticListDecision(lists, 'mcp__x__one'), { kind: 'reject', source: 'denyList-deny' })
})

// ── aggregateToolStats ─────────────────────────────────────────────────────

const records = [
  // allow bucket (outcome allowed-once; static/classifier/timeout/category all land here)
  { toolName: 'bash', outcome: 'allowed-once', source: 'static-allow' },
  { toolName: 'bash', outcome: 'allowed-once', source: 'classifier-allow' },
  { toolName: 'read', outcome: 'allowed-once', source: 'classifier-allow' },
  // deny bucket (outcome rejected)
  { toolName: 'write', outcome: 'rejected', source: 'classifier-deny' },
  { toolName: 'write', outcome: 'rejected', source: 'timeout-deny' },
  { toolName: 'edit', outcome: 'rejected', source: 'hard-deny' },
  // human bucket (human decided)
  { toolName: 'bash', outcome: 'allowed-once', source: 'human-allow' },
  { toolName: 'read', outcome: 'rejected', source: 'human-deny' },
]

test('aggregateToolStats: buckets by outcome/source and frequency-sorts', () => {
  const stats = aggregateToolStats(records)
  // allow = every allowed-once record (human-allow granted counts too);
  // deny = every rejected record (a human-deny rejection counts too);
  // human = records a human actually adjudicated (grant or denial).
  assert.deepEqual(stats.allow.map((e) => e.name), ['bash', 'read'])
  assert.deepEqual(stats.allow.find((e) => e.name === 'bash')?.count, 3)
  assert.deepEqual(stats.deny.map((e) => e.name), ['write', 'edit', 'read'])
  assert.deepEqual(stats.human.map((e) => e.name), ['bash', 'read'])
})

test('aggregateToolStats: records without toolName are ignored', () => {
  const stats = aggregateToolStats([{ outcome: 'allowed-once', source: 'human-allow' }, { toolName: 'x', outcome: 'allowed-once', source: 'x' }])
  assert.deepEqual(stats.allow.map((e) => e.name), ['x'])
})

test('recordInBucket: human bucket only counts explicit human sources', () => {
  assert.equal(recordInBucket({ toolName: 'x', outcome: 'allowed-once', source: 'human-allow' }, 'human'), true)
  assert.equal(recordInBucket({ toolName: 'x', outcome: 'rejected', source: 'human-deny' }, 'human'), true)
  assert.equal(recordInBucket({ toolName: 'x', outcome: 'allowed-once', source: 'timeout-allow' }, 'human'), false)
  assert.equal(recordInBucket({ toolName: 'x', outcome: 'allowed-once', source: 'static-allow' }, 'human'), false)
  assert.equal(recordInBucket({ toolName: 'x', outcome: 'rejected', source: 'classifier-deny' }, 'human'), false)
})

test('recordInBucket: outcome buckets include their human-decided variants', () => {
  // A granted record shows up in the allow suggestions; a human-denied record
  // shows up in deny. Both additionally appear in the human suggestions (the
  // tab only suggests tools that actually reached a person). Cross-tab
  // presence is intentional — each tab proposes for a different list.
  assert.equal(recordInBucket({ toolName: 'x', outcome: 'allowed-once', source: 'human-allow' }, 'allow'), true)
  assert.equal(recordInBucket({ toolName: 'x', outcome: 'rejected', source: 'human-deny' }, 'deny'), true)
})
