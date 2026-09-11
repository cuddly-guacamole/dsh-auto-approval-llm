// The docs state the test counts; this keeps those statements true. The checker
// is read-only, so this test is safe to run inside the suite it counts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COUNT_CLAIM, DECLARATION_POINTS, check, checkPerFileClaims, measuredCounts, uncoveredClaims, watchedDocumentSources, watchedDocuments } from '../scripts/check-doc-numbers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourcesOf(files) {
  const sources = {}
  for (const file of files) {
    try {
      sources[file] = readFileSync(join(root, file), 'utf8')
    } catch {
      // A file the checkout does not have cannot state anything.
    }
  }
  return sources
}

test('the documentation counts match the test suite', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-doc-numbers.mjs')], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `stale or missing counts:\n${result.stdout}${result.stderr}`)
})

test('the checker stays quiet only while the stated count is right', () => {
  // Reverse direction: feed it a wrong statement and require a complaint. Without
  // this, "all agree" could equally come from matching nothing at all.
  const measured = measuredCounts(root)
  const honest = { 'docs/index.md': readFileSync(join(root, 'docs/index.md'), 'utf8') }
  assert.deepEqual(check(measured, honest).problems, [])

  const wrong = measured.cases + 1
  const tampered = { 'docs/index.md': honest['docs/index.md'].replace(/(\d+) 测试 \+ 运行时验证/, `${wrong} 测试 + 运行时验证`) }
  const problems = check(measured, tampered).problems
  assert.ok(problems.some(problem => problem.includes('docs/index.md')), `expected a complaint about docs/index.md, got ${JSON.stringify(problems)}`)
})

test('a declaration point that disappears is reported', () => {
  const measured = measuredCounts(root)
  const gutted = { 'docs/14-code-map.md': readFileSync(join(root, 'docs/14-code-map.md'), 'utf8').replace(/合计 \d+ 个 tests\/\*\.test\.mjs/, '合计若干测试') }
  const problems = check(measured, gutted).problems
  assert.ok(problems.some(problem => problem.includes('docs/14-code-map.md') && problem.includes('not found')), JSON.stringify(problems))
})

test('a stale second copy of the same claim is reported', () => {
  // A page may keep the corrected sentence and an older duplicate; checking only
  // the first match would call that page consistent.
  const measured = measuredCounts(root)
  const honest = readFileSync(join(root, 'docs/index.md'), 'utf8')
  const duplicated = { 'docs/index.md': `${honest}\n另有 ${measured.cases + 7} 测试 + 运行时验证\n` }
  assert.deepEqual(check(measured, { 'docs/index.md': honest }).problems, [])
  const problems = check(measured, duplicated).problems
  assert.ok(problems.length > 0, 'the stale duplicate must be reported')
})

test('no document states a suite count outside the checked set', () => {
  // Positions, not whole files: a watched page can still carry a sentence none of
  // the patterns match, which is how the page subtitle drifted unnoticed.
  const uncovered = uncoveredClaims(sourcesOf(watchedDocuments(root)))
  assert.deepEqual(uncovered, [], 'count claims with no declaration point')
})

test('an unchecked claim inside a watched page is reported', () => {
  // Reverse direction for the coverage scan, on the shape that escaped before:
  // a suite-wide sentence in a page that otherwise only has watched declaration
  // points. The injected wording has no declaration point, so the scan must
  // report it even though the page itself is watched.
  const sources = sourcesOf(watchedDocuments(root))
  const injected = { ...sources, 'docs/15-quality.md': `${sources['docs/15-quality.md']}\n> 用例总数 42\n` }
  const uncovered = uncoveredClaims(injected)
  assert.ok(
    uncovered.some(entry => entry.file === 'docs/15-quality.md'),
    `the scan must report the injected claim, got ${JSON.stringify(uncovered)}`,
  )
  assert.deepEqual(uncoveredClaims(sources), [], 'the real tree must have no uncovered claims')
})

test('the uncovered-claim scan recognises the phrasings a page can use', () => {
  // Per-file counts stay out of scope on purpose; everything else is suite-wide.
  for (const shape of ['1195 个测试', '1194/1194 通过', '合计 1194 例', '1194 个测试文件', '1194 测试 + 运行时验证', '用例总数 1194', '测试 1194 例', '1209 tests'])
    assert.ok(COUNT_CLAIM.test(shape), `the scan misses: ${shape}`)
  assert.equal(COUNT_CLAIM.test('12 例'), false, 'a per-file count is not a suite-wide claim')
})

test('an inline per-file count is checked against the file it names', () => {
  // Per-file counts drift on their own: the suite total can stay right while one
  // file's share is stale, which is exactly what happened to three of them.
  const sources = watchedDocumentSources(root)
  assert.deepEqual(checkPerFileClaims(sources).problems, [], 'the real tree must state per-file counts correctly')

  const stale = { 'docs/index.md': `${sources['docs/index.md']}\n见 category.test.mjs 3 例\n` }
  const problems = checkPerFileClaims(stale).problems
  assert.ok(problems.some(problem => problem.includes('category.test.mjs')), `expected a complaint, got ${JSON.stringify(problems)}`)

  const missing = { 'docs/index.md': '见 no-such-suite.test.mjs 3 例\n' }
  assert.ok(checkPerFileClaims(missing).problems.some(problem => problem.includes('does not exist')))
})

test('every declaration point names a real document', () => {
  const sources = sourcesOf(DECLARATION_POINTS.map(point => point.file))
  for (const point of DECLARATION_POINTS) {
    if (point.optional && sources[point.file] === undefined) continue
    assert.ok(sources[point.file] !== undefined, `${point.file} is declared but missing`)
    assert.ok(point.pattern.test(sources[point.file]), `${point.file} does not contain ${point.description}`)
  }
})
