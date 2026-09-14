#!/usr/bin/env node
// Rewrite every declaration point to the measured count. The checker stays the
// single owner of what the numbers mean; this only applies them, so refreshing
// the docs after a batch cannot miss a spot by hand.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DERIVED_POINTS, check, checkDerived, measuredCounts, measuredDerived } from './check-doc-numbers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The suite-count sentences the published documents state. */
export const SUITE_REWRITES = [
  { file: 'docs/15-quality.md', pattern: /(\d+) 个测试文件，合计 \*\*\d+ 例\*\*/, to: (match, measured) => `${measured.files} 个测试文件，合计 **${measured.cases} 例**` },
  { file: 'docs/15-quality.md', pattern: /# \d+\/\d+ 全绿/, to: (match, measured) => `# ${measured.cases}/${measured.cases} 全绿` },
  { file: 'docs/15-quality.md', pattern: /\*\d+ tests · runtime proofs\*/, to: (match, measured) => `*${measured.cases} tests · runtime proofs*` },
  { file: 'docs/index.md', pattern: /\d+ 测试 \+ 运行时验证/, to: (match, measured) => `${measured.cases} 测试 + 运行时验证` },
  { file: 'AGENTS.md', pattern: /\*\*\d+\/\d+ fail 0\*\*\(\d+ 个 tests/, to: (match, measured) => `**${measured.cases}/${measured.cases} fail 0**(${measured.files} 个 tests` },
  { file: 'docs/14-code-map.md', pattern: /合计 \d+ 个 tests\/\*\.test\.mjs/, to: (match, measured) => `合计 ${measured.files} 个 tests/*.test.mjs` },
]

/**
 * Apply every suite-count rewrite that names this file. A pattern that still
 * does not match after rewriting means the sentence moved, so the file would
 * keep a stale number: the caller must fail rather than write.
 */
export function applySuiteRewrites(source, file, measured) {
  let rewritten = source
  for (const rewrite of SUITE_REWRITES) {
    if (rewrite.file !== file) continue
    if (!rewrite.pattern.test(rewritten)) throw new Error(`${file} does not match ${rewrite.pattern} — the wording moved`)
    // Every occurrence, so a page that kept a duplicate cannot end up half
    // rewritten with the checker still complaining about the copy left behind.
    const global = new RegExp(rewrite.pattern.source, `${rewrite.pattern.flags.replace('g', '')}g`)
    rewritten = rewritten.replace(global, (...args) => rewrite.to(args, measured))
  }
  return rewritten
}

/**
 * Apply every derived-point rewrite that names this file (line counts, module
 * and key counts, route count). The checker owns both the pattern and the
 * rewrite, so the two cannot disagree about what a number means.
 */
export function applyDerivedRewrites(source, file, measured) {
  let rewritten = source
  for (const point of DERIVED_POINTS) {
    if (point.file !== file) continue
    const flags = point.pattern.flags.includes('g') ? point.pattern.flags : `${point.pattern.flags}g`
    const matches = [...rewritten.matchAll(new RegExp(point.pattern.source, flags))]
    if (matches.length === 0) throw new Error(`${file} does not match "${point.description}" — the wording moved`)
    let out = ''
    let cursor = 0
    for (const match of matches) {
      let expected = null
      try {
        expected = point.expect(match, measured)
      } catch {
        expected = null
      }
      if (!Number.isFinite(expected))
        throw new Error(`${file} "${point.description}" (${point.label(match)}) cannot be measured from the source tree`)
      out += rewritten.slice(cursor, match.index) + point.rewrite(match, expected)
      cursor = match.index + match[0].length
    }
    rewritten = out + rewritten.slice(cursor)
  }
  return rewritten
}

export function main() {
  const measured = measuredCounts(root)
  const derived = measuredDerived(root)
  const files = [...new Set([...SUITE_REWRITES.map(rewrite => rewrite.file), ...DERIVED_POINTS.map(point => point.file)])]
  for (const file of files) {
    const full = join(root, file)
    let source
    try {
      source = readFileSync(full, 'utf8')
    } catch {
      // Once a file states a derived number it must exist, otherwise the number
      // it carries is unchecked; a checkout without AGENTS.md is the only case
      // that may be skipped.
      if (DERIVED_POINTS.some(point => point.file === file)) {
        console.error(`sync-doc-numbers: ${file} is missing but states derived numbers`)
        return 1
      }
      console.warn(`sync-doc-numbers: ${file} not present, skipped`)
      continue
    }
    try {
      writeFileSync(full, applyDerivedRewrites(applySuiteRewrites(source, file, measured), file, derived))
    } catch (error) {
      console.error(`sync-doc-numbers: ${error.message}`)
      return 1
    }
  }

  const suiteCheck = check(measured)
  const derivedCheck = checkDerived({}, measuredDerived(root))
  const problems = [...suiteCheck.problems, ...derivedCheck.problems]
  console.log(`sync-doc-numbers: applied ${measured.files} files / ${measured.cases} cases and ${DERIVED_POINTS.length} derived point(s)`)
  for (const problem of problems) console.error(`sync-doc-numbers: ${problem}`)
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
