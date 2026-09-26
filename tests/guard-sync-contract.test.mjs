/**
 * tools.guard is a synchronous, non-event hard-deny gate: it is registered as
 * a plain guard function (never wired through a `tools/guard` event), the
 * decision composes the hard-deny and symlink-escape reasons with a nullish
 * fallback (hard-deny first), and the returned reason is terminal — the host
 * turns it into a structured refusal, so a guard hit can never be escalated
 * into an allow (Cedar `forbid` semantics). The docs statement and the
 * compiled expression are pinned together so neither drifts alone.
 * Run: node --test tests/guard-sync-contract.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const built = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
// The composition itself lives in the module that owns guardDenyDecision; the
// entry keeps the guard registration and its call site.
const guardModule = readFileSync(fileURLToPath(new URL('../lib/auto/debug-and-decisions.js', import.meta.url)), 'utf8')
const lifecycle = readFileSync(fileURLToPath(new URL('../docs/02-tool-call-lifecycle.md', import.meta.url)), 'utf8')

test('the guard decision composes hard-deny first, symlink escape second', () => {
  // Exactly once across the whole compiled plugin, not just the entry: the
  // expression could otherwise be duplicated into the module while the entry
  // kept a second copy.
  const hits = `${built}\n${guardModule}`.match(/hardDenyReason\(exec, roots\) \?\? symlinkEscapeReason\(exec, roots, resolveDeepest\)/g) ?? []
  assert.equal(hits.length, 1, 'the composition expression must exist exactly once in the compiled plugin')
})

test('the guard is a registered synchronous function, never an event listener', () => {
  assert.match(host, /anyCtx\.tools\?\.guard\?\.\(/, 'the guard registration must exist')
  assert.doesNotMatch(host, /on\(\s*'tools\/guard'/, 'no tools/guard event listener')
  assert.doesNotMatch(host, /waterfall\(\s*'tools\/guard'/, 'no tools/guard waterfall dispatch')
})

test('docs/02 states the guard contract: synchronous, terminal, Cedar-forbid-like', () => {
  assert.match(lifecycle, /同步注册守卫/)
  assert.match(lifecycle, /不可被升级为放行/)
  assert.match(lifecycle, /Cedar `forbid` 同构/)
})
