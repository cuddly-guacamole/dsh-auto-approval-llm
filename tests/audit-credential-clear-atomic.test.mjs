/**
 * Clearing the reviewer credential must rewrite the shared credentials file
 * through the atomic path.
 *
 * The clear rewrote the whole `~/.dsh/.credentials.yaml` with a plain
 * `writeFileSync`: a crash mid-write could truncate a store that carries every
 * provider's credentials, while the same module already ships the
 * tmp+rename helper for exactly this shape.
 *
 * Run: node --test tests/audit-credential-clear-atomic.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearReviewerKeyInFile } from '../lib/index.js'

test('the clear rewrites through the atomic path (source pin — the atomicity gain itself is not observable in a passing run)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
  const at = source.indexOf('export function clearReviewerKeyInFile')
  assert.ok(at > 0, 'the clear owner is locatable')
  const nextExport = source.indexOf('\nexport function', at + 1)
  const body = source.slice(at, nextExport > 0 ? nextExport : undefined)
  assert.match(body, /atomicWriteFile\(/, 'the clear must use the tmp+rename helper')
  assert.doesNotMatch(body, /\bwriteFileSync\(/, 'a bare in-place rewrite must be gone')
})

test('a cleared store keeps its other providers and leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-clear-atomic-'))
  try {
    const file = join(dir, '.credentials.yaml')
    writeFileSync(file, [
      'other-provider-api-key: sk-other',
      'DSH_AUTO_APPROVAL_REVIEWER_API_KEY: sk-reviewer',
      '',
    ].join('\n'))
    assert.equal(clearReviewerKeyInFile(file), 'cleared')
    const after = readFileSync(file, 'utf8')
    assert.match(after, /sk-other/, 'the unrelated provider must survive the clear')
    assert.doesNotMatch(after, /sk-reviewer/, 'the reviewer line must be gone')
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp')), [],
      'the atomic temp file must not leak into the store directory')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the clear stays honest on the absent and failed shapes (control)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-clear-atomic-'))
  try {
    assert.equal(clearReviewerKeyInFile(join(dir, 'missing.yaml')), 'absent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
