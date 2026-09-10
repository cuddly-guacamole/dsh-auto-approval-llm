/**
 * Session-artifact deletion vs the locked `delete` category.
 *
 * The policy plane grants a narrow provenance exemption: deleting a path this
 * session was observed to create is a static allow (`delete exact session-created
 * artifact`). But `delete` is a LOCKED category, and the category layer never
 * saw the artifact registry — it labels every deletion `delete`, which in
 * aggressive mode becomes an ask, intercepts the static allow at pre-execute,
 * and lands on a countdown pinned to reject. The exemption was therefore dead in
 * exactly the mode this deployment runs, so `rm` of the session's own scratch
 * file waited out a countdown and was denied.
 *
 * The fix carries the proven provenance as a structured flag on the assessment.
 * Nothing parses the reason text: the flag is set only where every operand was
 * matched against the registry, and both the category clamp and the answerer's
 * locked predicate read it. These tests pin the exemption, both halves of its
 * wiring, and the boundary — a deletion the session never created must still be
 * locked.
 *
 * Run: node --test tests/artifact-deletion-exemption.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { assessShell } from '../lib/auto/shell.js'
import { categoryDirective, categoryDirectiveFor } from '../lib/auto/category.js'
import { normalizePath, resolveRoots } from '../lib/auto/paths.js'

const WORKSPACE = 'C:/ws'
const roots = resolveRoots(WORKSPACE, {})
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []

const owner = { id: 'session-a' }
const aggressive = { categoryPolicy: {}, categoryMode: 'aggressive' }

/** A path the session created, recorded the way a settled create records it. */
function sessionArtifact(path) {
  const registry = new ArtifactRegistry()
  registry.add(owner, normalizePath(path, roots.workspace, roots.home), roots)
  return registry
}

test('precondition: the policy plane really does exempt a session artifact deletion', () => {
  const registry = sessionArtifact('C:/ws/scratch.txt')
  const verdict = assessShell('rm scratch.txt', 'bash', roots, registry, owner)
  assert.equal(verdict.decision, 'allow', `got ${verdict.decision}: ${verdict.reason}`)
  assert.equal(verdict.sessionArtifactDeletion, true, 'the exemption must advertise itself as a structured flag')
})

test('precondition: an unobserved deletion is not exempt and carries no flag', () => {
  const registry = new ArtifactRegistry()
  const verdict = assessShell('rm scratch.txt', 'bash', roots, registry, owner)
  assert.equal(verdict.decision, 'ask')
  assert.notEqual(verdict.sessionArtifactDeletion, true)
})

test('the locked clamp no longer swallows a proven artifact deletion', () => {
  const flag = { decision: 'allow', classifierEligible: false, sessionArtifactDeletion: true }
  // Aggressive mode is where the bug bit: an unexempted delete clamps to ask.
  assert.equal(categoryDirective(aggressive, 'delete', { decision: 'allow', classifierEligible: false }), 'ask')
  assert.equal(categoryDirective(aggressive, 'delete', flag), 'inherit')
  // Standard mode unconfigured already inherits; the flag must not change that
  // into something tighter either.
  assert.equal(categoryDirective({ categoryPolicy: {}, categoryMode: 'standard' }, 'delete', flag), 'inherit')
})

test('the exemption is scoped to delete: it never unlocks another locked category', () => {
  const flag = { decision: 'allow', classifierEligible: false, sessionArtifactDeletion: true }
  for (const other of ['disk', 'protected', 'privilege']) {
    assert.notEqual(categoryDirective(aggressive, other, flag), 'inherit', `${other} must stay clamped`)
  }
})

test('the flag cannot lift a real deletion: it is read, never inferred', () => {
  // Same category, same mode — the only difference is the structured flag. A
  // consumer that inferred the exemption from the reason text would fail this.
  assert.equal(categoryDirective(aggressive, 'delete', { decision: 'ask', classifierEligible: true }), 'ask')
  assert.equal(categoryDirective(aggressive, 'delete', { sessionArtifactDeletion: false }), 'ask')
  assert.equal(categoryDirective(aggressive, 'delete', {}), 'ask')
})

test('the wire point threads the flag through, end to end', () => {
  const registry = sessionArtifact('C:/ws/scratch.txt')
  const exec = { name: 'bash', arguments: { command: 'rm scratch.txt' }, agent: { session: owner } }
  const assessment = assessShell('rm scratch.txt', 'bash', roots, registry, owner)
  const exempted = categoryDirectiveFor(exec, roots, aggressive, assessment)
  assert.equal(exempted.category, 'delete', 'the label stays honest')
  assert.equal(exempted.directive, 'inherit', 'and the clamp is lifted')

  // Without the provenance the very same call keeps the locked ask.
  const unobserved = assessShell('rm scratch.txt', 'bash', roots, new ArtifactRegistry(), owner)
  const locked = categoryDirectiveFor(exec, roots, aggressive, unobserved)
  assert.equal(locked.category, 'delete')
  assert.equal(locked.directive, 'ask')
})

test('the answerer half is anchored: its locked predicate reads the same flag', () => {
  // Pre-execute handles the exempted call today, but a predicate that disagreed
  // with the category clamp is exactly the cross-plane inconsistency that made
  // the protected read unanswerable. Anchor both halves in the compiled host.
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const predicate = host.slice(host.indexOf('const isLockedCategory = ('))
  const body = predicate.slice(0, predicate.indexOf('\n    }'))
  assert.ok(
    /category === ['"]delete['"] && provenArtifactDeletion/.test(body),
    `the answerer must honour the proven-artifact-deletion flag, got:\n${body}`,
  )
  assert.ok(
    /isLockedCategory\(classified\.category, classified\.assessment\?\.sessionArtifactDeletion === true\)/.test(host),
    'and the flag must actually be passed at the call site',
  )
})

test('the exemption is structured, not parsed out of the reason text', () => {
  // An authorization signal must never be re-derived from free text. Guard the
  // shape: the flag is a field, set where the registry was consulted, and no
  // consumer matches the message.
  const shell = readFileSync(fileURLToPath(new URL('../src/auto/shell.ts', import.meta.url)), 'utf8')
  assert.equal((shell.match(/sessionArtifactDeletion: true/g) ?? []).length, 2, 'set at the segment site and carried by the line rebuild')
  for (const file of ['../src/auto/category.ts', '../src/index.ts']) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    assert.ok(!/session-created artifact/.test(source), `${file} must not match the exemption message text`)
  }
})

test('the flag survives a compound line so a mixed line is not re-locked', () => {
  // The rebuild at the end of assessShell used to construct a fresh assessment,
  // which silently dropped the flag: a line like `rm scratch.txt && echo hi`
  // then looked like an unproven deletion to every downstream consumer.
  const registry = sessionArtifact('C:/ws/scratch.txt')
  const verdict = assessShell('rm scratch.txt && echo hi', 'bash', roots, registry, owner)
  assert.equal(verdict.decision, 'allow')
  assert.equal(verdict.sessionArtifactDeletion, true, 'the line-level verdict must carry the provenance')
})

test('a compound line with any unproven deletion stays locked', () => {
  // `b.txt` was never created by this session, so the line is an ask — and the
  // flag must not appear to wave it past the clamp.
  const registry = sessionArtifact('C:/ws/scratch.txt')
  const verdict = assessShell('rm scratch.txt; rm b.txt', 'bash', roots, registry, owner)
  assert.notEqual(verdict.decision, 'allow', `got ${verdict.decision}: ${verdict.reason}`)
  assert.notEqual(verdict.sessionArtifactDeletion, true)
})
