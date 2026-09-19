/**
 * The tool branch of the signature writer must apply the same skeleton gate as
 * the shell branch.
 *
 * The shell branch refuses templates the load-side validation would reject
 * (characters outside the skeleton whitelist, or a skeleton whose redaction
 * mask leaks outside it); the tool branch only checked the length, so a tool
 * argument name carrying a wildcard/quote/meta character produced a signature
 * that counted in-process but was silently dropped by validateLearningEntry
 * on the next restart — the confirmation count reset with no trace.
 *
 * Run: node --test tests/audit-learning-tool-skeleton.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { signatureFor, validateLearningEntry } from '../lib/auto/learning.js'

test('a tool template outside the skeleton whitelist gets no signature', () => {
  const inside = signatureFor({ kind: 'tool', toolName: 'write', args: { file_path: 'C:/ws/a.txt' } })
  assert.ok(inside, 'a plain template stays learnable')
  const outside = signatureFor({ kind: 'tool', toolName: 'write', args: { 'file*path': 'C:/ws/a.txt' } })
  assert.equal(outside, undefined, 'a wildcard-carrying argument name must not produce a signature')
})

test('whatever the write side produces, the load side accepts (write==load invariant)', () => {
  for (const args of [
    { file_path: 'C:/ws/a.txt' },
    { path: 'C:/ws/b.md', content: 'x' },
    { command: 'ls C:/ws' },
  ]) {
    const sig = signatureFor({ kind: 'tool', toolName: 'write', args })
    if (sig === undefined) continue
    const validated = validateLearningEntry({
      sigVersion: 2,
      workspace: 'C:/ws',
      kind: 'tool',
      skeleton: sig.skeleton,
      count: 1,
      firstAt: 0,
      lastAt: 0,
    }, 0)
    assert.ok(validated, `the load side must accept the write side's skeleton: ${sig.skeleton}`)
  }
})

test('the shell branch keeps its gate (control, unchanged)', () => {
  const sig = signatureFor({ kind: 'shell-bash', command: 'ls C:/ws' })
  assert.ok(sig, 'a plain shell signature stays learnable')
})
