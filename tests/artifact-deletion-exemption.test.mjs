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
import { assessTool } from '../lib/auto/policy.js'
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
    /isLockedCategory\(classified\.category, classified\.assessment\?\.sessionArtifactDeletion === true, classified\.assessment\?\.credentialRead === true\)/.test(host),
    'and the flag must actually be passed at the call site',
  )
})

test('every file-creating allow branch in the DSH_HOME zone records its provenance', () => {
  // The exemption rests on the registry knowing what the session created, so
  // every branch that allows a CREATE has to hand its target to `plan()`. A
  // branch that allows without recording leaves the exemption unreachable, and
  // that is not hypothetical: the allowed-DSH_HOME-subtree branches omitted it,
  // so in the plugin's own development zone (a workspace inside DSH_HOME) `rm`
  // of a file the session had just written fell back to a locked countdown. The
  // existing plan/settle test used a tmpdir workspace, which takes the
  // project-local branch, so it stayed green.
  //
  // Behavioural on purpose: asserting "the word plannedCreates appears nearby"
  // is satisfied by a read-only branch that correctly has none, and would not
  // catch a new create-capable branch that forgets it.
  const dshHome = 'C:/Users/u/.dsh'
  const ws = `${dshHome}/plugins/dsh-auto-approval-llm`
  const zoneRoots = { workspace: ws, home: 'C:/Users/u', dshHome, tempRoots: [], allowedDshSubpaths: [ws.toLowerCase()] }
  const target = `${ws}/scratch.txt`
  const expected = [normalizePath(target, ws, 'C:/Users/u')]
  const stub = { has: () => false }

  const creators = [
    ['write', { name: 'write', arguments: { file_path: target, content: 'x' } }],
    ['apply_patch Add File', { name: 'apply_patch', arguments: { patches: [{ file_path: target, content: 'x' }] } }],
    ['str_replace_editor create', { name: 'str_replace_editor', arguments: { command: 'create', path: target, file_text: 'x' } }],
  ]
  for (const [label, exec] of creators) {
    const verdict = assessTool(exec, zoneRoots, stub)
    assert.equal(verdict.decision, 'allow', `${label}: expected allow, got ${verdict.decision}: ${verdict.reason}`)
    assert.deepEqual(verdict.plannedCreates, expected, `${label} must report the create so plan() can register it`)
  }

  // Control: a non-creating mutation of an existing file must NOT claim a create,
  // otherwise the registry would mark files the session merely edited.
  const noCreate = assessTool({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: target, old_str: 'a', new_str: 'b' } }, zoneRoots, stub)
  assert.equal(noCreate.decision, 'allow')
  assert.equal(noCreate.plannedCreates, undefined, 'str_replace cannot create, so it must not report a create')
})

test('the whole chain works in the DSH_HOME zone shape (the live failure)', () => {
  // The live probe that failed: with the workspace inside DSH_HOME (the plugin's
  // own dev zone), a write is allowed by the DSH_HOME branch, so with no
  // plannedCreates the registry stayed empty and `rm` of the just-written file
  // fell to the locked delete countdown. This replays plan -> settle -> rm in
  // that shape, which the tmpdir-based chain test could not catch.
  const dshHome = 'C:/Users/u/.dsh'
  const ws = `${dshHome}/plugins/dsh-auto-approval-llm`
  const zoneRoots = {
    workspace: ws,
    home: 'C:/Users/u',
    dshHome,
    tempRoots: [],
    allowedDshSubpaths: [ws.toLowerCase()],
    maintenanceDshPaths: [],
    mode: 'aggressive',
    trustedDirs: [],
  }
  const registry = new ArtifactRegistry()
  const session = { id: 'zone-session' }
  const target = `${ws}/scratch.txt`

  // The plugin's own wiring: pre-execute asks policy, then plan()s the creates.
  const create = assessTool({ name: 'write', arguments: { file_path: target, content: 'x' } }, zoneRoots, registry)
  assert.equal(create.decision, 'allow', `the zone write must be allowed, got ${create.decision}: ${create.reason}`)
  const exec = { name: 'write', token: 't-zone', agent: { session } }
  registry.plan(exec, create.plannedCreates, zoneRoots)
  registry.settle(exec, { isError: false, value: { operation: 'create', path: target } }, zoneRoots)
  assert.equal(registry.has(session, normalizePath(target, ws, 'C:/Users/u'), zoneRoots), true, 'the create must be registered')

  // And the deletion of it must ride the provenance exemption, not the lock.
  const removal = assessShell('rm scratch.txt', 'bash', zoneRoots, registry, session)
  assert.equal(removal.decision, 'allow', `rm of the session's own file must allow, got ${removal.decision}: ${removal.reason}`)
  assert.equal(removal.sessionArtifactDeletion, true)
  const threaded = categoryDirectiveFor({ name: 'bash', arguments: { command: 'rm scratch.txt' } }, zoneRoots, { categoryPolicy: {}, categoryMode: 'aggressive' }, removal)
  assert.equal(threaded.directive, 'inherit', 'and the clamp must be lifted for it')
})

test('known interaction: a directory changer in the line costs the exemption', () => {
  // Measured behaviour, pinned so it is a documented limitation rather than a
  // surprise. Directory changers are deliberately kept out of the static fast
  // paths (the analyzer cannot follow the resulting cwd), so a line containing
  // one never reaches the all-allow merge and the segment-level exemption is
  // discarded with it:
  //
  //   rm own.txt                  -> allow (exempted)
  //   rm own.txt && echo done     -> allow (exempted)
  //   cd <dir> && rm own.txt      -> ask   (not exempted)
  //
  // Fail-closed, and arguably right: under a changer a relative target's meaning
  // is uncertain, so withholding a provenance-based allow is conservative. It is
  // still worth pinning, because `cd dir && rm file` is a common idiom and the
  // ask lands on the locked delete countdown, which no reviewer can answer.
  const registry = sessionArtifact('C:/ws/scratch.txt')
  assert.equal(assessShell('rm scratch.txt', 'bash', roots, registry, owner).decision, 'allow')

  const withEcho = assessShell('rm scratch.txt && echo done', 'bash', roots, registry, owner)
  assert.equal(withEcho.decision, 'allow')
  assert.equal(withEcho.sessionArtifactDeletion, true, 'a trailing read-only segment keeps the flag')

  for (const command of ['cd C:/ws && rm scratch.txt', 'cd C:/ws && rm scratch.txt && echo done']) {
    const verdict = assessShell(command, 'bash', roots, registry, owner)
    assert.equal(verdict.decision, 'ask', `${command}: the changer routes the line to classification`)
    assert.notEqual(verdict.sessionArtifactDeletion, true, `${command}: no exemption may be claimed`)
    assert.match(String(verdict.reason), /independent classification/, 'the reason names the changer as the cause')
  }
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

test('the every-operand boundary: one unobserved operand on the same command blocks the flag', () => {
  // This is the boundary that makes the exemption safe, and it is a single
  // segment: `rm a b` with only `a` observed. Flipping the extractor's `every`
  // to `some` would exempt the whole call and delete an unobserved file while
  // every other assertion here stayed green.
  const registry = sessionArtifact('C:/ws/scratch.txt')
  const mixed = assessShell('rm scratch.txt b.txt', 'bash', roots, registry, owner)
  assert.notEqual(mixed.decision, 'allow', `mixed operands must not allow, got ${mixed.decision}: ${mixed.reason}`)
  assert.notEqual(mixed.sessionArtifactDeletion, true, 'an unobserved operand must block the provenance flag')

  // Control: the same shape with every operand observed does carry it, so the
  // assertion above is not passing merely because the command is unrecognised.
  const both = sessionArtifact('C:/ws/scratch.txt')
  both.add(owner, normalizePath('C:/ws/other.txt', roots.workspace, roots.home), roots)
  const all = assessShell('rm scratch.txt other.txt', 'bash', roots, both, owner)
  assert.equal(all.decision, 'allow', `all-observed operands must allow, got ${all.decision}: ${all.reason}`)
  assert.equal(all.sessionArtifactDeletion, true)
})

test('the exemption lifts the hard-locked allowlist gates too', () => {
  // An allowlist entry naming the tool is a name-based channel; the provenance
  // flag is not, so the hard lock must not discard the exemption when the tool
  // name is allowlisted. Both gates are anchored in the compiled host because
  // they are wiring, not pure functions: both name-based channels must consult
  // the shared locked predicate, and the predicate itself must carry the
  // delete+flag exemption.
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const gateRegex = /nameChannelLockRefusal\(\{/g
  const gates = [...host.matchAll(gateRegex)]
  assert.equal(gates.length, 2, 'both name-based gates consult the locked predicate (pre-execute mirror and answerer)')
  for (const gate of gates) {
    const window = host.slice(gate.index, gate.index + 260)
    assert.ok(
      /sessionArtifactDeletion:\s*[\w.?]*assessment\?\.sessionArtifactDeletion === true/.test(window),
      `every name-based gate must pass the proven-artifact-deletion flag, got:\n${window}`,
    )
  }
  assert.ok(
    /if \(input\.category === 'delete' && input\.sessionArtifactDeletion === true\)\s*\n?\s*return undefined/.test(host),
    'the shared predicate must carry the proven-artifact-deletion exemption',
  )
})
