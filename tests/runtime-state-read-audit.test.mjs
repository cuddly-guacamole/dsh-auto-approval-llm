/**
 * dsh-auto-approval-llm · runtime-state READS leave a durable audit trail.
 *
 * Plugin runtime-state files (approval history, audit log, debug trail,
 * review modes, latency telemetry, learning allow-list) are hard-denied for
 * WRITES on every vector, but a READ of them used to be visible only in the
 * debug trail — off by default, so reading learning.json (the allow-list an
 * attacker would mirror to forge same-signature calls) left zero durable
 * trace unless debugging was on. F3 promotes that observation to a
 * default-on, non-decision audit event for BOTH planes: a shell reader
 * command (already probed by runtimeStateReadHits) and a structured read
 * tool whose path operand names such a file directly. These contracts pin the
 * shared basename judgment, the pure structured-tool detector, and the host
 * wiring (event type, unconditional append, no verdict/statistics impact).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { structuredRuntimeStateReadHits } from '../lib/auto/policy.js'
import { runtimeStateBasename } from '../lib/auto/paths.js'
import { runtimeStateReadHits } from '../lib/auto/shell.js'

const roots = { workspace: 'D:/work', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
const PLUGIN_ZONE = 'C:/Users/u/.dsh/plugins/dsh-auto-approval-llm'
const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const HOST = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/**
 * Slice from a start marker to the end marker that FOLLOWS it.
 *
 * A counted window (`slice(at, at + N)`) silently stops covering the code it
 * names once the region grows, and a NEGATIVE assertion inside such a window
 * turns that into a false pass rather than a failure: the assertion can no
 * longer see the thing it forbids, so it reports clean. Both markers are
 * mandatory here — a renamed anchor fails loudly instead of producing an empty
 * slice that satisfies every `!includes` check.
 */
function region(src, startMarker, endMarker, from = 0) {
  const a = src.indexOf(startMarker, from)
  assert.notEqual(a, -1, `source marker missing: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  assert.notEqual(b, -1, `region end missing after ${startMarker}: ${endMarker}`)
  assert.ok(b > a, `region end must follow its start: ${startMarker}`)
  return src.slice(a, b)
}

/**
 * The whole audit record emitted for a runtime-state read, delimited by its own
 * append call and the `}))` that closes that same call.
 *
 * The record is the extent the negative assertions below talk about (no
 * verdict/statistics fields), so it is pinned structurally: the event type is
 * the anchor, the enclosing append call plus its balanced tail is the region.
 * A renamed event type reddens through the anchor guard instead of returning an
 * empty slice.
 */
function runtimeStateReadEvent(src) {
  const at = src.indexOf("type: 'runtime-state-read',")
  assert.notEqual(at, -1, "the audit event type 'runtime-state-read' is wired")
  const start = src.lastIndexOf('appendAuditLine(JSON.stringify({', at)
  assert.notEqual(start, -1, 'the durable append wraps the event type')
  return region(src, 'appendAuditLine(JSON.stringify({', '}))', start)
}

// ── shared basename judgment (src/auto/paths.ts) ──────────────────────────

test('runtimeStateBasename: every canonical basename matches, ordinary files never do', () => {
  for (const base of ['history.jsonl', 'audit.jsonl', 'approval-debug.jsonl', 'review-mode.json', 'llm-latency.jsonl', 'learning.json']) {
    assert.equal(runtimeStateBasename(`${PLUGIN_ZONE}/${base}`), base, base)
    assert.equal(runtimeStateBasename(`D:/elsewhere/${base.toUpperCase()}`), base, `${base} is matched case-insensitively`)
  }
  assert.equal(runtimeStateBasename(`${PLUGIN_ZONE}/src/index.ts`), undefined)
  assert.equal(runtimeStateBasename('D:/work/notes.md'), undefined)
})

// ── pure structured read-tool detection (src/auto/policy.ts) ─────────────

test('structured reads: read/read_image file_path naming a state file is reported', () => {
  for (const base of ['history.jsonl', 'audit.jsonl', 'approval-debug.jsonl', 'review-mode.json', 'llm-latency.jsonl', 'learning.json']) {
    assert.deepEqual(structuredRuntimeStateReadHits('read', { file_path: `${PLUGIN_ZONE}/${base}` }, roots), [base], `read ${base}`)
    assert.deepEqual(structuredRuntimeStateReadHits('read_image', { file_path: `${PLUGIN_ZONE}/${base}` }, roots), [base], `read_image ${base}`)
  }
})

test('structured reads: grep path and str_replace_editor view are reported', () => {
  assert.deepEqual(structuredRuntimeStateReadHits('grep', { pattern: 'x', path: `${PLUGIN_ZONE}/learning.json` }, roots), ['learning.json'])
  assert.deepEqual(structuredRuntimeStateReadHits('str_replace_editor', { command: 'view', path: `${PLUGIN_ZONE}/history.jsonl` }, roots), ['history.jsonl'])
})

test('structured reads: ordinary workspace files never match (no false positive)', () => {
  assert.deepEqual(structuredRuntimeStateReadHits('read', { file_path: 'D:/work/notes.md' }, roots), [])
  assert.deepEqual(structuredRuntimeStateReadHits('read', { file_path: 'D:/work/src/index.ts' }, roots), [])
  assert.deepEqual(structuredRuntimeStateReadHits('grep', { pattern: 'x', path: 'D:/work' }, roots), [])
})

test('structured reads: uncovered faces and non-read tools return empty', () => {
  // glob/lsp search a root tree/pattern rather than opening one file.
  assert.deepEqual(structuredRuntimeStateReadHits('glob', { pattern: '**', path: PLUGIN_ZONE }, roots), [])
  assert.deepEqual(structuredRuntimeStateReadHits('lsp', { cwd: PLUGIN_ZONE }, roots), [])
  // Mutation tools are the write plane (hard-denied upstream), never reads.
  for (const name of ['write', 'edit', 'apply_patch']) {
    assert.deepEqual(structuredRuntimeStateReadHits(name, { file_path: `${PLUGIN_ZONE}/learning.json`, patches: [{ file_path: `${PLUGIN_ZONE}/learning.json` }] }, roots), [], name)
  }
  // str_replace_editor only reads under `view`.
  assert.deepEqual(structuredRuntimeStateReadHits('str_replace_editor', { command: 'str_replace', path: `${PLUGIN_ZONE}/learning.json` }, roots), [])
  // Unknown/malformed calls carry no decidable target.
  assert.deepEqual(structuredRuntimeStateReadHits('mcp__x__read', { path: `${PLUGIN_ZONE}/learning.json` }, roots), [])
  assert.deepEqual(structuredRuntimeStateReadHits('read', {}, roots), [])
  assert.deepEqual(structuredRuntimeStateReadHits('read', { file_path: 42 }, roots), [])
  assert.deepEqual(structuredRuntimeStateReadHits('read', undefined, roots), [])
})

test('structured reads: basename-only judgment mirrors the shell detector', () => {
  // Same spelling as the shell probe's `cat learning.json` — normalized
  // against the workspace/home roots, matched purely on basename.
  assert.deepEqual(structuredRuntimeStateReadHits('read', { file_path: 'learning.json' }, roots), ['learning.json'])
  assert.deepEqual(runtimeStateReadHits('cat learning.json', 'bash', roots), ['learning.json'])
  assert.deepEqual(structuredRuntimeStateReadHits('read', { file_path: 'D:/backup/HISTORY.JSONL' }, roots), ['history.jsonl'])
})

// ── host wiring (src/index.ts) ────────────────────────────────────────────

test('host: pre-execute emits a durable appendAuditLine for runtime-state reads', () => {
  // Old code only debugLogged the read; a `type`-keyed appendAuditLine event
  // with sessionId/toolName/files is the new persistent record.
  assert.ok(SRC.includes("appendAuditLine(JSON.stringify({"), 'the durable append exists in the host')
  const event = runtimeStateReadEvent(SRC)
  assert.ok(event.includes("type: 'runtime-state-read',"), 'the record carries the read event type')
  assert.match(event, /appendAuditLine/, 'the event is written through the appendAuditLine gate')
  assert.ok(event.includes("sessionId: authorityKeyFor(exec),"), 'event carries the session key')
  assert.ok(event.includes("toolName: exec.name,"), 'event carries the tool name')
  assert.ok(event.includes('files: stateReads,'), 'event carries the state basenames')
  assert.ok(!event.includes("type: 'decision'"), 'the event is not a decision record')
  assert.ok(!event.includes('pushHistory'), 'the event never enters the history/verdict plane')
})

test('host: the durable event is default-on and independent of the debug switch', () => {
  // debugLog gates on `if (!debugOn) return`; the appendAuditLine emission for
  // runtime-state-read must not live inside that gated function.
  const debugBody = SRC.slice(SRC.indexOf('function debugLog('), SRC.indexOf('// One shared loud path'))
  assert.ok(debugBody.includes('if (!debugOn) return'), 'precondition: debugLog is debug-gated')
  assert.ok(!debugBody.includes('appendAuditLine'), 'the durable append is not inside the debug-gated function')
  const probe = SRC.slice(SRC.indexOf('const stateReads ='), SRC.indexOf('const fetchAuditTarget ='))
  assert.ok(probe.includes("appendAuditLine(JSON.stringify({"), 'the durable append sits in the pre-execute probe block')
  assert.ok(!probe.includes('debugOn'), 'the probe block is not conditional on the debug switch')
})

test('host: one unified probe covers the shell plane and the structured plane', () => {
  assert.ok(SRC.includes("runtimeStateReadHits(exec.arguments.command, exec.name, roots)"), 'shell commands route through the shell detector')
  assert.ok(SRC.includes("structuredRuntimeStateReadHits(exec.name, exec.arguments, roots)"), 'structured tools route through the structured detector')
  assert.ok(HOST.includes("structuredRuntimeStateReadHits"), 'the structured detector is imported into the compiled host')
  const probe = SRC.slice(SRC.indexOf('const stateReads ='), SRC.indexOf('const fetchAuditTarget ='))
  assert.ok(probe.includes('runtimeStateReadHits('), 'the shell detector feeds the same stateReads list')
  assert.ok(probe.includes('structuredRuntimeStateReadHits('), 'the structured detector feeds the same stateReads list')
})

test('host: the event stays observational (no history/verdict fields)', () => {
  const event = runtimeStateReadEvent(SRC)
  assert.ok(!event.includes('outcome:'), 'no verdict outcome is attached to the event')
  assert.ok(!event.includes('source:'), 'no history source is fabricated for the read')
  assert.ok(!event.includes("type: 'decision'"), 'the event is not a decision record')
  const probe = SRC.slice(SRC.indexOf('const stateReads ='), SRC.indexOf('const fetchAuditTarget ='))
  assert.ok(!probe.includes('pushHistory'), 'the probe block never writes a history record')
})
