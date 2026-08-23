/**
 * dsh-auto-approval-llm · line-level edit-diff preview (buildEditDiff family).
 *
 * Fixture-based (mkdtempSync) tests over the compiled lib. Run:
 * node --test tests/editdiff.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildEditDiff,
  buildEditDiffText,
  EDIT_DIFF_ARGS_MAX_CHARS,
  EDIT_DIFF_TOOLS,
} from '../lib/auto/editdiff.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsa-edit-'))
  const workspace = join(root, 'ws')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  return {
    root,
    workspace,
    outside,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const args = (obj) => JSON.stringify(obj)

// ── write: full-content semantics ─────────────────────────────────────────
test('buildEditDiff: write to a missing file shows the full content as additions', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'new.txt')
    const diff = buildEditDiff('write', args({ file_path: target, content: 'line1\nline2' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `write · ${target} (write): 2 insertions, 0 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'add', text: 'line1' },
      { kind: 'add', text: 'line2' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: write overwrite isolates the changed region (del/add around context)', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'a.txt')
    writeFileSync(target, 'one\ntwo\nthree')
    const diff = buildEditDiff('write', args({ file_path: target, content: 'one\nTWO\nthree' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `write · ${target} (write): 1 insertions, 1 deletions`)
    // Common head/tail lines are trimmed (only LCS-internal context survives).
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'two' },
      { kind: 'add', text: 'TWO' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: write with empty content is legal and renders a full deletion', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'a.txt')
    writeFileSync(target, 'a\nb')
    const diff = buildEditDiff('write', args({ file_path: target, content: '' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `write · ${target} (write): 0 insertions, 2 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'a' },
      { kind: 'del', text: 'b' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: write with byte-identical content is omitted (no change)', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'a.txt')
    writeFileSync(target, 'same')
    assert.equal(buildEditDiff('write', args({ file_path: target, content: 'same' }), f.workspace), undefined)
    // A content that only differs in a trailing newline has no line-level
    // change either (line-granularity preview).
    assert.equal(buildEditDiff('write', args({ file_path: target, content: 'same\n' }), f.workspace), undefined)
    // Writing empty over an empty (missing) path is a no-op too.
    assert.equal(buildEditDiff('write', args({ file_path: join(f.workspace, 'ghost.txt'), content: '' }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

// ── edit: unique-match / ambiguous / replace-all semantics ────────────────
test('buildEditDiff: edit unique match replaces exactly once', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'edit.txt')
    writeFileSync(target, 'line X\nline Y')
    const diff = buildEditDiff('edit', args({ file_path: target, old_string: 'line Y', new_string: 'line Z' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `edit · ${target} (edit): 1 insertions, 1 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'line Y' },
      { kind: 'add', text: 'line Z' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: edit multi-match without replace_all is omitted (mirror FS_AMBIGUOUS_EDIT)', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'multi.txt')
    writeFileSync(target, 'X one\nX two')
    assert.equal(buildEditDiff('edit', args({ file_path: target, old_string: 'X', new_string: 'Y' }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: edit replace_all=true replaces every occurrence, zero match omitted', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'multi.txt')
    writeFileSync(target, 'X one\nX two')
    const diff = buildEditDiff('edit', args({ file_path: target, old_string: 'X', new_string: 'Y', replace_all: true }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `edit · ${target} (edit): 2 insertions, 2 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'X one' },
      { kind: 'del', text: 'X two' },
      { kind: 'add', text: 'Y one' },
      { kind: 'add', text: 'Y two' },
    ])
    assert.equal(buildEditDiff('edit', args({ file_path: target, old_string: 'zzz', new_string: 'y', replace_all: true }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: edit old===new / empty old_string are omitted (official rejects them)', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'e.txt')
    writeFileSync(target, 'abc')
    assert.equal(buildEditDiff('edit', args({ file_path: target, old_string: 'abc', new_string: 'abc' }), f.workspace), undefined)
    assert.equal(buildEditDiff('edit', args({ file_path: target, old_string: '', new_string: 'x' }), f.workspace), undefined)
    assert.equal(buildEditDiff('edit', args({ file_path: target, old_string: 'abc' }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: edit matching is LF-normalized like the official editText', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'crlf.txt')
    writeFileSync(target, 'a\r\nb')
    const diff = buildEditDiff('edit', args({ file_path: target, old_string: 'b', new_string: 'B' }), f.workspace)
    assert.ok(diff)
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
    ])
  } finally {
    f.cleanup()
  }
})

// ── str_replace_editor: str_replace / insert / create semantics ───────────
test('buildEditDiff: str_replace unique match previews the replacement', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 's.txt')
    writeFileSync(target, 'a\nb\nc')
    const diff = buildEditDiff('str_replace_editor', args({ command: 'str_replace', path: target, old_str: 'b', new_str: 'B' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `str_replace · ${target} (str_replace): 1 insertions, 1 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: str_replace multi-match and missing old_str are omitted', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 's.txt')
    writeFileSync(target, 'x\ny\nx')
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'str_replace', path: target, old_str: 'x', new_str: 'z' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'str_replace', path: target, new_str: 'z' }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: str_replace without new_str renders a pure deletion', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 's.txt')
    writeFileSync(target, 'a\nb')
    const diff = buildEditDiff('str_replace_editor', args({ command: 'str_replace', path: target, old_str: 'b' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `str_replace · ${target} (str_replace): 0 insertions, 1 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'b' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: insert uses the official 0-based splice (head / middle / append)', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'i.txt')
    writeFileSync(target, 'a\nb\nc')
    const header = `insert · ${target} (insert): 1 insertions, 0 deletions`
    // All unchanged lines are common head/tail and trimmed; only the
    // inserted line survives in the preview, wherever it lands.
    for (const insertLine of [0, 2, 3]) {
      const diff = buildEditDiff('str_replace_editor', args({ command: 'insert', path: target, insert_line: insertLine, new_str: 'X' }), f.workspace)
      assert.equal(diff.header, header)
      assert.deepEqual(diff.lines, [{ kind: 'add', text: 'X' }])
    }
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: insert out-of-range / non-integer insert_line are omitted; phantom tail line is byte-faithful', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'i.txt')
    writeFileSync(target, 'a\nb')
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'insert', path: target, insert_line: 3, new_str: 'X' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'insert', path: target, insert_line: -1, new_str: 'X' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'insert', path: target, insert_line: 1.5, new_str: 'X' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'insert', path: target, insert_line: 1 }), f.workspace), undefined)
    // "a\n" splits into ["a", ""] officially; inserting at 1 lands after the
    // phantom tail line and the result keeps the trailing newline.
    const phantom = join(f.workspace, 'p.txt')
    writeFileSync(phantom, 'a\n')
    const diff = buildEditDiff('str_replace_editor', args({ command: 'insert', path: phantom, insert_line: 1, new_str: 'X' }), f.workspace)
    assert.ok(diff)
    assert.deepEqual(diff.lines, [
      { kind: 'add', text: 'X' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: create refuses an existing target; gate-failed targets preview the in-args content as a pure addition', () => {
  const f = fixture()
  try {
    const existing = join(f.workspace, 'exists.txt')
    writeFileSync(existing, 'here')
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'create', path: existing, file_text: 'x' }), f.workspace), undefined)
    const fresh = join(f.workspace, 'fresh.txt')
    const diff = buildEditDiff('str_replace_editor', args({ command: 'create', path: fresh, file_text: 'hello' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `create · ${fresh} (create): 1 insertions, 0 deletions`)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'create', path: join(f.workspace, 'empty.txt'), file_text: '' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'create', path: fresh }), f.workspace), undefined)
    // A directory-shaped target already exists, so the official create
    // refuses it: no preview.
    const dir = join(f.workspace, 'dir')
    mkdirSync(dir)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'create', path: dir, file_text: 'x' }), f.workspace), undefined)
    // Out-of-workspace / protected targets are never read, yet the official
    // create would still write them: the in-args content previews as a pure
    // addition and nothing of an existing file ever surfaces.
    const outsideCreate = join(f.outside, 'made.txt')
    const createdOutside = buildEditDiff('str_replace_editor', args({ command: 'create', path: outsideCreate, file_text: 'made' }), f.workspace)
    assert.ok(createdOutside)
    assert.equal(createdOutside.header, `create · ${outsideCreate} (create): 1 insertions, 0 deletions`)
    assert.deepEqual(createdOutside.lines, [{ kind: 'add', text: 'made' }])
    const dotenv = join(f.workspace, '.env')
    writeFileSync(dotenv, 'SECRET=1')
    const createdEnv = buildEditDiff('str_replace_editor', args({ command: 'create', path: dotenv, file_text: 'SECRET=2' }), f.workspace)
    assert.ok(createdEnv)
    assert.equal(createdEnv.header, `create · ${dotenv} (create): 1 insertions, 0 deletions`)
    assert.deepEqual(createdEnv.lines, [{ kind: 'add', text: 'SECRET=2' }])
    assert.ok(!createdEnv.header.includes('SECRET=1'))
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: view commands and invalid commands never preview', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'v.txt')
    writeFileSync(target, 'x')
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'view', path: target }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'wat', path: target }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'view' }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

// ── apply_patch: sequential application, all targets, fail-closed ─────────
test('buildEditDiff: apply_patch applies patches in order (later patches see earlier results)', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'seq.txt')
    writeFileSync(target, 'x\na\nz')
    const diff = buildEditDiff('apply_patch', args({ patches: [
      { file_path: target, old_string: 'a', new_string: 'b' },
      // 'b' exists only after the first patch — proves sequential application.
      { file_path: target, old_string: 'b', new_string: 'c' },
    ] }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `apply_patch · ${target} (patch): 1 insertions, 1 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'c' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: apply_patch covers every target with ctx separators and shares one budget', () => {
  const f = fixture()
  try {
    const one = join(f.workspace, 'one.txt')
    const two = join(f.workspace, 'two.txt')
    writeFileSync(one, 'a')
    writeFileSync(two, 'b')
    const diff = buildEditDiff('apply_patch', args({ patches: [
      { file_path: one, old_string: 'a', new_string: 'A' },
      { file_path: two, old_string: 'b', new_string: 'B' },
      { file_path: one, old_string: 'A', new_string: 'AA' },
    ] }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `apply_patch · 2 files (patch): 2 insertions, 2 deletions`)
    assert.deepEqual(diff.lines, [
      { kind: 'ctx', text: one },
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'AA' },
      { kind: 'ctx', text: two },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
    ])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: apply_patch any patch failure omits the whole preview', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'p.txt')
    writeFileSync(target, 'x\na')
    assert.equal(buildEditDiff('apply_patch', args({ patches: [
      { file_path: target, old_string: 'a', new_string: 'b' },
      { file_path: target, old_string: 'nope', new_string: 'y' },
    ] }), f.workspace), undefined)
    // Ambiguous old_string is a failure too.
    writeFileSync(target, 'x\na\na')
    assert.equal(buildEditDiff('apply_patch', args({ patches: [
      { file_path: target, old_string: 'a', new_string: 'b' },
    ] }), f.workspace), undefined)
    // Missing / malformed patches fail closed.
    assert.equal(buildEditDiff('apply_patch', args({}), f.workspace), undefined)
    assert.equal(buildEditDiff('apply_patch', args({ patches: [] }), f.workspace), undefined)
    assert.equal(buildEditDiff('apply_patch', args({ patches: [{ old_string: 'a', new_string: 'b' }] }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

// ── read gate: write falls back to a full addition, compare-class omits ─────
test('buildEditDiff: write to an out-of-workspace target falls back to a full-addition diff of the in-args content', () => {
  const f = fixture()
  try {
    // A non-existent outside path proves the diff cannot come from any read.
    const outsideGhost = join(f.outside, 'ghost.txt')
    const ghostDiff = buildEditDiff('write', args({ file_path: outsideGhost, content: 'x\ny' }), f.workspace)
    assert.ok(ghostDiff)
    assert.equal(ghostDiff.header, `write · ${outsideGhost} (write): 2 insertions, 0 deletions`)
    assert.deepEqual(ghostDiff.lines, [
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ])
    // An existing outside file with secret content must never surface: the
    // preview shows the args content only, everything is a `+` addition.
    const outsideExisting = join(f.outside, 'secret.txt')
    writeFileSync(outsideExisting, 'occupants-are-secret')
    const diff = buildEditDiff('write', args({ file_path: outsideExisting, content: 'replacement' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `write · ${outsideExisting} (write): 1 insertions, 0 deletions`)
    assert.deepEqual(diff.lines, [{ kind: 'add', text: 'replacement' }])
    assert.ok(!diff.header.includes('occupants'))
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: write to protected project paths (.env, .git/config) falls back to a full-addition diff of the new content only', () => {
  const f = fixture()
  try {
    const dotenv = join(f.workspace, '.env')
    writeFileSync(dotenv, 'SECRET=1')
    const diff = buildEditDiff('write', args({ file_path: dotenv, content: 'SECRET=2' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `write · ${dotenv} (write): 1 insertions, 0 deletions`)
    assert.deepEqual(diff.lines, [{ kind: 'add', text: 'SECRET=2' }])
    assert.ok(!diff.header.includes('SECRET=1'))
    const gitConf = join(f.workspace, '.git', 'config')
    mkdirSync(join(f.workspace, '.git'))
    writeFileSync(gitConf, 'old')
    const gitDiff = buildEditDiff('write', args({ file_path: gitConf, content: 'new' }), f.workspace)
    assert.ok(gitDiff)
    assert.equal(gitDiff.header, `write · ${gitConf} (write): 1 insertions, 0 deletions`)
    assert.deepEqual(gitDiff.lines, [{ kind: 'add', text: 'new' }])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: write to a directory-shaped target (read refusal) falls back to a full-addition diff', () => {
  const f = fixture()
  try {
    const dir = join(f.workspace, 'dir')
    mkdirSync(dir)
    const diff = buildEditDiff('write', args({ file_path: dir, content: 'x' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `write · ${dir} (write): 1 insertions, 0 deletions`)
    assert.deepEqual(diff.lines, [{ kind: 'add', text: 'x' }])
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: compare-class tools (edit / str_replace / insert / apply_patch) stay omitted for unreadable targets', () => {
  const f = fixture()
  try {
    const dir = join(f.workspace, 'dir')
    mkdirSync(dir)
    const outsideTarget = join(f.outside, 'evict.txt')
    writeFileSync(outsideTarget, 'x')
    const dotenv = join(f.workspace, '.env')
    writeFileSync(dotenv, 'SECRET=1')
    const gitConf = join(f.workspace, '.git', 'config')
    mkdirSync(join(f.workspace, '.git'))
    writeFileSync(gitConf, 'x')
    assert.equal(buildEditDiff('edit', args({ file_path: dir, old_string: 'x', new_string: 'y' }), f.workspace), undefined)
    assert.equal(buildEditDiff('edit', args({ file_path: outsideTarget, old_string: 'x', new_string: 'y' }), f.workspace), undefined)
    assert.equal(buildEditDiff('edit', args({ file_path: dotenv, old_string: '1', new_string: '2' }), f.workspace), undefined)
    assert.equal(buildEditDiff('edit', args({ file_path: gitConf, old_string: 'x', new_string: 'y' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'str_replace', path: dotenv, old_str: '1', new_str: '2' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'insert', path: outsideTarget, insert_line: 0, new_str: 'z' }), f.workspace), undefined)
    assert.equal(buildEditDiff('apply_patch', args({ patches: [{ file_path: outsideTarget, old_string: 'x', new_string: 'y' }] }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: symlink/junction escape — write falls back to a full-addition diff, nothing read through the link', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.outside, 'sec.txt'), 'secret')
    let used = ''
    try {
      symlinkSync(join(f.outside, 'sec.txt'), join(f.workspace, 'link-file'), 'file')
      used = 'file'
    } catch {
      symlinkSync(f.outside, join(f.workspace, 'link-dir'), 'junction')
      used = 'junction'
    }
    const link = join(f.workspace, used === 'file' ? 'link-file' : 'link-dir')
    const target = used === 'file' ? link : join(link, 'sec.txt')
    const diff = buildEditDiff('write', args({ file_path: target, content: 'x' }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.header, `write · ${target} (write): 1 insertions, 0 deletions`)
    assert.deepEqual(diff.lines, [{ kind: 'add', text: 'x' }])
    assert.ok(!diff.header.includes('secret'))
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: oversized and non-UTF-8 targets — write falls back to full addition, compare-class stays omitted', () => {
  const f = fixture()
  try {
    const big = join(f.workspace, 'big.txt')
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1))
    const bigWrite = buildEditDiff('write', args({ file_path: big, content: 'tiny' }), f.workspace)
    assert.ok(bigWrite)
    assert.equal(bigWrite.header, `write · ${big} (write): 1 insertions, 0 deletions`)
    assert.deepEqual(bigWrite.lines, [{ kind: 'add', text: 'tiny' }])
    assert.equal(buildEditDiff('edit', args({ file_path: big, old_string: 'tiny', new_string: 'TINY' }), f.workspace), undefined)
    assert.equal(buildEditDiff('str_replace_editor', args({ command: 'str_replace', path: big, old_str: 'tiny', new_str: 'TINY' }), f.workspace), undefined)
    const binary = join(f.workspace, 'bin.dat')
    writeFileSync(binary, Buffer.from([0x00, 0x61, 0x62]))
    const binWrite = buildEditDiff('write', args({ file_path: binary, content: 'x' }), f.workspace)
    assert.ok(binWrite)
    assert.equal(binWrite.header, `write · ${binary} (write): 1 insertions, 0 deletions`)
    assert.deepEqual(binWrite.lines, [{ kind: 'add', text: 'x' }])
    assert.equal(buildEditDiff('edit', args({ file_path: binary, old_string: 'x', new_string: 'y' }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

// ── volume guards: LCS size, line length, output lines and bytes ──────────
test('buildEditDiff: LCS sides beyond 1024 lines omit the preview entirely', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'wide.txt')
    writeFileSync(target, Array.from({ length: 1025 }, (_, i) => `o${i}`).join('\n'))
    const content = Array.from({ length: 1025 }, (_, i) => `n${i}`).join('\n')
    assert.equal(buildEditDiff('write', args({ file_path: target, content }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: lines over 200 chars are ellipsized', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'long.txt')
    writeFileSync(target, 'a')
    const diff = buildEditDiff('write', args({ file_path: target, content: `${'y'.repeat(250)}\nb` }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.lines[1].text, `${'y'.repeat(200)}…`)
    assert.ok(diff.lines[1].text.length <= 201)
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: output capped at 200 lines with the truncated marker', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'many.txt')
    const content = Array.from({ length: 210 }, (_, i) => `add ${i}`).join('\n')
    const diff = buildEditDiff('write', args({ file_path: target, content }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.lines.length, 201)
    assert.equal(diff.lines[200].text, '…truncated')
    assert.equal(diff.lines[200].kind, 'ctx')
  } finally {
    f.cleanup()
  }
})

test('buildEditDiff: total rendered bytes capped at 32 KiB with the truncated marker', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'bytes.txt')
    const content = Array.from({ length: 180 }, () => 'y'.repeat(250)).join('\n')
    const diff = buildEditDiff('write', args({ file_path: target, content }), f.workspace)
    assert.ok(diff)
    assert.equal(diff.lines.at(-1).text, '…truncated')
    const cost = (l) => Buffer.byteLength(`${l.kind === 'del' ? '- ' : l.kind === 'add' ? '+ ' : '· '}${l.text}`, 'utf8')
    const kept = diff.lines.slice(0, -1)
    assert.ok(kept.reduce((sum, l) => sum + cost(l), 0) <= 32 * 1024)
    assert.ok(diff.lines.length < 170)
  } finally {
    f.cleanup()
  }
})

// ── failure matrix and tool gating ────────────────────────────────────────
test('buildEditDiff: invalid inputs and unknown tools return undefined, never throw', () => {
  const f = fixture()
  try {
    assert.equal(buildEditDiff('write', undefined, f.workspace), undefined)
    assert.equal(buildEditDiff('write', 'not json', f.workspace), undefined)
    assert.equal(buildEditDiff('write', args('str'), f.workspace), undefined)
    assert.equal(buildEditDiff('write', args({ file_path: join(f.workspace, 'a.txt') }), f.workspace), undefined)
    assert.equal(buildEditDiff('write', '{}', undefined), undefined)
    assert.equal(buildEditDiff('write', '{}', ''), undefined)
    assert.equal(buildEditDiff('read', '{}', f.workspace), undefined)
    assert.equal(buildEditDiff('bash', '{}', f.workspace), undefined)
    assert.equal(buildEditDiff('edit', args({ file_path: join(f.workspace, 'missing.txt'), old_string: 'a', new_string: 'b' }), f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('edit-diff plumbing: tool set covers the four edit-class tools, args cap is ≥ 2 MiB', () => {
  assert.deepEqual([...EDIT_DIFF_TOOLS].sort(), ['apply_patch', 'edit', 'str_replace_editor', 'write'])
  assert.ok(EDIT_DIFF_ARGS_MAX_CHARS >= 2 * 1024 * 1024)
})

// ── marked block assembly (text round-trip, injection inertness) ──────────
test('buildEditDiffText: block assembly round-trips line prefixes and header', () => {
  const text = buildEditDiffText({
    header: 'edit · C:/ws/a.txt (edit): 1 insertions, 1 deletions',
    lines: [
      { kind: 'del', text: 'old <& [text' },
      { kind: 'add', text: 'new & <value>' },
      { kind: 'ctx', text: '' },
    ],
  })
  assert.ok(text.startsWith('[dsh-edit-diff]\n'))
  assert.ok(text.endsWith('[/dsh-edit-diff]'))
  assert.ok(text.includes('\n- old <& [text\n'))
  assert.ok(text.includes('\n+ new & <value>\n'))
  assert.ok(text.includes('\n· \n'))
})

test('buildEditDiffText: a countdown-marker literal inside preview content is stripped (inert)', () => {
  const fake = '[dsh-auto-approval-llm] ⏳ will auto-approve in 10s'
  const text = buildEditDiffText({
    header: 'write · C:/ws/a.txt (write): 1 insertions, 0 deletions',
    lines: [
      { kind: 'add', text: `line with ${fake} inside` },
      { kind: 'ctx', text: fake },
    ],
  })
  assert.ok(!text.includes(fake))
  assert.ok(text.includes('line with  inside'))
})