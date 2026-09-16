/**
 * dsh-auto-approval-llm · RUNTIME_STATE_BASENAMES registry test (B3-F4/S3).
 *
 * The fuse list is enumeration-based: a runtime-state file the plugin writes
 * but forgets to register would be writable from agent sessions inside the
 * plugin zone (the zone opening skips the DSH_HOME deny, and only these
 * basenames re-arm it). These tests reconcile the set with the files the plugin
 * actually writes, collected from both the source and the compiled tree, so a
 * seventh state file reddens here instead of shipping as a silent write path —
 * while a registered name no writer uses stays red too, because every entry is
 * unconditional deny surface.
 *
 * Run: node --test tests/runtime-state-registry.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_STATE_BASENAMES } from '../lib/auto/paths.js'
import { RUNTIME_FILENAMES } from '../lib/auto/runtime-paths.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every `.ts`/`.js`/`.mjs` file under `dir`, skipping dependency/agent trees. */
function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (/\.(ts|js|mjs)$/.test(entry.name)) found.push(path)
  }
  return found
}

/** A bare state-file name: no directory part, and a persisted extension. */
const STATE_FILE_SHAPE = /^[\w.-]+\.(?:jsonl|json)$/

/** The runtime path/write helpers that own where a state file lands. */
const RUNTIME_HELPER = String.raw`(?:appendRuntimeLine|writeRuntimeAtomic|resolveRuntimeReadPath|resolveRuntimeWritePath|runtimeFilePath)`

/** The literal forming the first argument of a runtime helper, in any quote style. */
const HELPER_LITERAL = new RegExp(`${RUNTIME_HELPER}\\s*\\(\\s*(['"\`])([^'"\`\\n]+)\\1`, 'g')

/** The identifier forming the first argument of a runtime helper. */
const HELPER_IDENTIFIER = new RegExp(`${RUNTIME_HELPER}\\s*\\(\\s*([A-Za-z_$][\\w$]*)`, 'g')

/** A literal filename joined directly onto the canonical state directory. */
const JOINED_LITERAL = /stateDirPath\(\)\s*,\s*(['"`])([^'"`\n]+)\1/g

/** A `const` declaration whose value is a literal, whatever the name is. */
function declarationOf(identifier) {
  return new RegExp(`(?:export\\s+)?const\\s+${identifier}\\s*=\\s*(['"\`])([^'"\`\\n]+)\\1`, 'g')
}

/**
 * `src` with comment bodies blanked out, character indices preserved.
 *
 * Prose mentions a state filename in backticks (`package.json` appears in a doc
 * comment), and a literal-shaped spell in a comment is not a write. String
 * literals are left intact so real declarations keep their value.
 */
function blankComments(src) {
  const out = [...src]
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1
        i += 1
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      for (let j = i; j < stop; j += 1) out[j] = ' '
      i = stop - 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) break
      for (let j = i; j < end + 2; j += 1) out[j] = ' '
      i = end + 1
    }
  }
  return out.join('')
}

/** The comment-blanked `{ file, code }` sources of both shipped trees. */
function repoSources() {
  return ['src', 'lib']
    .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
    .map((file) => ({ file, code: blankComments(readFileSync(file, 'utf8')) }))
}

/**
 * The state-file names the plugin actually writes, collected from the trees it
 * ships. Both `src/` and `lib/` are scanned so a name added on either side of a
 * build is seen. A name counts when it reaches a runtime path/write helper —
 * either as a literal in any quote style, or as an identifier which is then
 * resolved to its own literal declaration — or when it is joined onto the
 * canonical state directory. The name pattern is deliberately NOT tied to the
 * `*_FILENAME` spelling: `const PENDING_FILE = "pending.json"` is a state file
 * too, and a scan that only recognised `_FILENAME` + single quotes would report
 * the set clean while a seventh file shipped unregistered.
 */
function writtenStateNames(sources = repoSources()) {
  const found = new Set()
  const add = (name) => {
    if (STATE_FILE_SHAPE.test(name)) found.add(name)
  }
  const usedIdentifiers = new Set()
  for (const { code } of sources) {
    for (const match of code.matchAll(HELPER_LITERAL)) add(match[2])
    for (const match of code.matchAll(HELPER_IDENTIFIER)) usedIdentifiers.add(match[1])
    for (const match of code.matchAll(JOINED_LITERAL)) add(match[2])
  }
  // Resolve the identifiers the write channels actually use, so the declaration
  // may be named anything and quoted any way.
  for (const identifier of usedIdentifiers) {
    const declaration = declarationOf(identifier)
    for (const { code } of sources) {
      for (const match of code.matchAll(declaration)) add(match[2])
    }
  }
  // Fallback for the module that owns the persisted-name list: any filename
  // literal there is a state name, however the const is named or spelled.
  for (const { file, code } of sources) {
    if (!/[\\/]runtime-paths\.[tj]s$/.test(file)) continue
    for (const match of code.matchAll(/(['"`])([^'"`\n]+)\1/g)) add(match[2])
  }
  return found
}

/** The durable state files the plugin itself writes. */
const KNOWN_STATE_FILES = [
  'history.jsonl',
  'audit.jsonl',
  'approval-debug.jsonl',
  'review-mode.json',
  'llm-latency.jsonl',
  'learning.json',
]

test('the written-name scan sees the shapes it claims to (discriminating counterexample)', () => {
  // Feedback for the collector itself, on synthetic sources, so the claims in its
  // docstring are falsifiable here instead of being asserted only against today's
  // tree. Every line below is invisible to the previous scan (single quotes,
  // `*_FILENAME` names, literal first argument only).
  const synthetic = [
    {
      // The reviewer-visible blind spot: an arbitrary const name, double-quoted,
      // handed to a helper by IDENTIFIER.
      file: 'synthetic/arbitrary.ts',
      code: blankComments('const PENDING_FILE = "pending.json"\nwriteRuntimeAtomic(PENDING_FILE, "{}")\n'),
    },
    {
      // A template-literal declaration in the module that owns the name list,
      // reachable only through its fallback scan.
      file: 'synthetic/auto/runtime-paths.ts',
      code: blankComments('const TELEMETRY = `telemetry.jsonl`\n'),
    },
    {
      // A literal joined straight onto the canonical state directory.
      file: 'synthetic/joined.ts',
      code: blankComments("const p = join(stateDirPath(), 'queue.jsonl')\n"),
    },
    {
      // Control: a filename spelled in prose is not a write.
      file: 'synthetic/doc.ts',
      code: blankComments('// the files sat directly beside `package.json` and `notes.json`\n'),
    },
  ]
  const found = writtenStateNames(synthetic)
  for (const name of ['pending.json', 'telemetry.jsonl', 'queue.jsonl']) {
    assert.ok(found.has(name), `the scan must see ${name}; it found ${[...found].sort().join(', ')}`)
  }
  assert.ok(!found.has('package.json'), 'a filename mentioned in a comment is not a written state file')
  assert.ok(!found.has('notes.json'), 'prose mentions must not be collected')
})

test('RUNTIME_STATE_BASENAMES: every plugin-written state file is registered', () => {
  // The enumeration direction, and the one the previous assertions missed: they
  // compared a hardcoded list against the set, so a seventh file the plugin
  // writes stayed invisible on both sides. Collect the written names instead.
  const written = writtenStateNames()
  for (const name of KNOWN_STATE_FILES) {
    assert.ok(written.has(name), `the scan must see ${name}; it found ${[...written].sort().join(', ')}`)
  }
  for (const name of [...written].sort()) {
    assert.ok(
      RUNTIME_STATE_BASENAMES.has(name),
      `${name} is written as runtime state but is missing from RUNTIME_STATE_BASENAMES: the plugin-zone opening would make it writable from agent sessions`,
    )
  }
  assert.deepEqual(
    [...RUNTIME_FILENAMES].sort(),
    [...KNOWN_STATE_FILES].sort(),
    'the persisted-file list is the same set of files',
  )
})

test('RUNTIME_STATE_BASENAMES: the registry stays minimal and exact', () => {
  // Anything in the set is unconditionally unwritable from agent sessions in
  // the plugin zone — an entry that no state file uses would be dead deny
  // surface. Keep the set exactly the real state files, in both directions.
  assert.deepEqual([...RUNTIME_STATE_BASENAMES].sort(), [...KNOWN_STATE_FILES].sort())
  assert.deepEqual(
    [...RUNTIME_STATE_BASENAMES].sort(),
    [...writtenStateNames()].sort(),
    'the set and the files the plugin writes must name exactly the same files',
  )
})
