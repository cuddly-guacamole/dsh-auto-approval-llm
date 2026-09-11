// The docs state the test counts; this keeps those statements true. The checker
// is read-only, so this test is safe to run inside the suite it counts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DECLARATION_POINTS, check, measuredCounts } from '../scripts/check-doc-numbers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Claims that state a suite-wide count. Anything phrased this way must be
// covered by the checker, otherwise a new sentence reintroduces silent drift.
// Per-file counts ("12 例" for one test file) are deliberately out of scope.
const COUNT_CLAIM =
  /\d+\s*个\s*tests\/\*\.test\.mjs|\d+\s*个测试文件|\d+\s*测试\s*\+|\d+\s*\/\s*\d+\s*(?:全绿|fail 0)|合计\s*\*\*\d+\s*例/

function watchedDocuments() {
  const docs = readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)
  const tracked = [...docs, 'README.md', 'README.en.md', 'AGENTS.md']
  return tracked.filter(name => existsSync(join(root, name)))
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

test('no document states a suite count outside the checked set', () => {
  // A new sentence in an uncovered page would drift exactly like the ones this
  // task repaired, so require every count-shaped claim to belong to a checked
  // declaration point.
  const covered = new Set(DECLARATION_POINTS.map(point => point.file))
  const uncovered = []
  for (const file of watchedDocuments()) {
    if (covered.has(file)) continue
    const source = readFileSync(join(root, file), 'utf8')
    if (COUNT_CLAIM.test(source)) uncovered.push(file)
  }
  assert.deepEqual(uncovered, [], 'these files state a test count but are not checked')
})
