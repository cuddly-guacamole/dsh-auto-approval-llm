#!/usr/bin/env node
// Rewrite every declaration point to the measured count. The checker stays the
// single owner of what the numbers mean; this only applies them, so refreshing
// the docs after a batch cannot miss a spot by hand.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, measuredCounts } from './check-doc-numbers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const measured = measuredCounts(root)

const REWRITES = [
  { file: 'docs/15-quality.md', pattern: /(\d+) 个测试文件，合计 \*\*\d+ 例\*\*/, to: match => `${measured.files} 个测试文件，合计 **${measured.cases} 例**` },
  { file: 'docs/15-quality.md', pattern: /# \d+\/\d+ 全绿/, to: () => `# ${measured.cases}/${measured.cases} 全绿` },
  { file: 'docs/15-quality.md', pattern: /\*\d+ tests · runtime proofs\*/, to: () => `*${measured.cases} tests · runtime proofs*` },
  { file: 'docs/index.md', pattern: /\d+ 测试 \+ 运行时验证/, to: () => `${measured.cases} 测试 + 运行时验证` },
  { file: 'AGENTS.md', pattern: /\*\*\d+\/\d+ fail 0\*\*\(\d+ 个 tests/, to: () => `**${measured.cases}/${measured.cases} fail 0**(${measured.files} 个 tests` },
  { file: 'docs/14-code-map.md', pattern: /合计 \d+ 个 tests\/\*\.test\.mjs/, to: () => `合计 ${measured.files} 个 tests/*.test.mjs` },
]

for (const rewrite of REWRITES) {
  const full = join(root, rewrite.file)
  let source
  try {
    source = readFileSync(full, 'utf8')
  } catch {
    console.warn(`sync-doc-numbers: ${rewrite.file} not present, skipped`)
    continue
  }
  if (!rewrite.pattern.test(source)) {
    console.error(`sync-doc-numbers: ${rewrite.file} does not match ${rewrite.pattern} — the wording moved`)
    process.exit(1)
  }
  // Every occurrence, so a page that kept a duplicate cannot end up half
  // rewritten with the checker still complaining about the copy left behind.
  const global = new RegExp(rewrite.pattern.source, `${rewrite.pattern.flags.replace('g', '')}g`)
  writeFileSync(full, source.replace(global, (...args) => rewrite.to(args)))
}

const { problems } = check(measured)
console.log(`sync-doc-numbers: applied ${measured.files} files / ${measured.cases} cases`)
for (const problem of problems) console.error(`sync-doc-numbers: ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
