#!/usr/bin/env node
// The published docs state a test count in several places. Those numbers drifted
// independently of each other because nothing recomputed them. This checker owns
// the single source of truth: the counts derived from tests/*.test.mjs. Every
// declaration point must exist and must agree with it.
//
// Read-only by default. `--observed <tests> --observed-pass <pass>` additionally
// requires the counts a real run reported, which is how the release gate uses it
// without running the suite twice.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every place a count is stated publicly. `pattern` must match, otherwise the
 * wording moved and the number silently stopped being checked.
 */
export const DECLARATION_POINTS = [
  {
    file: 'docs/15-quality.md',
    description: 'summary line (files + cases)',
    pattern: /(\d+) 个测试文件，合计 \*\*(\d+) 例\*\*/,
    values: match => ({ files: Number(match[1]), cases: Number(match[2]) }),
  },
  {
    file: 'docs/15-quality.md',
    description: 'acceptance block',
    pattern: /# (\d+)\/(\d+) 全绿/,
    values: match => ({ cases: Number(match[1]), casesAgain: Number(match[2]) }),
  },
  {
    file: 'docs/index.md',
    description: 'documentation landing page',
    pattern: /(\d+) 测试 \+ 运行时验证/,
    values: match => ({ cases: Number(match[1]) }),
  },
  {
    file: 'AGENTS.md',
    description: 'baseline line',
    // The repository tracks a whitelist of paths and this file is not on it, so
    // it exists only in a development checkout. Check it where present; a fresh
    // clone must not fail for a file it never had.
    optional: true,
    pattern: /\*\*(\d+)\/(\d+) fail 0\*\*\((\d+) 个 tests\/\*\.test\.mjs/,
    values: match => ({ cases: Number(match[1]), casesAgain: Number(match[2]), files: Number(match[3]) }),
  },
  {
    file: 'docs/14-code-map.md',
    description: 'test tree footer',
    pattern: /合计 (\d+) 个 tests\/\*\.test\.mjs/,
    values: match => ({ files: Number(match[1]) }),
  },
]

/** Static source of truth: how many test files exist and how many cases they declare. */
export function measuredCounts(root = ROOT) {
  const dir = join(root, 'tests')
  const files = readdirSync(dir).filter(name => name.endsWith('.test.mjs'))
  let cases = 0
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8')
    cases += [...source.matchAll(/^(?:test|it)\(/gm)].length
  }
  return { files: files.length, cases }
}

/**
 * Compare the stated counts against the measured ones.
 * `sources` maps a declared file path to its content; unlisted files are read.
 */
export function check(measured, sources = {}, observed) {
  const problems = []
  const lines = [`measured: ${measured.files} files / ${measured.cases} cases`]
  if (observed?.tests !== undefined) {
    lines.push(`observed run: ${observed.tests} tests / ${observed.pass} passed`)
    if (observed.tests !== measured.cases)
      problems.push(`the run reported ${observed.tests} tests but the static count is ${measured.cases}`)
    if (observed.pass !== observed.tests)
      problems.push(`the run reported ${observed.pass} passed of ${observed.tests}`)
  }
  const readPoint = point => {
    if (Object.hasOwn(sources, point.file)) return sources[point.file]
    const full = join(ROOT, point.file)
    if (existsSync(full)) return readFileSync(full, 'utf8')
    if (point.optional) return undefined
    return null
  }
  for (const point of DECLARATION_POINTS) {
    const source = readPoint(point)
    if (source === undefined) {
      lines.push(`  absent   ${point.file}  (${point.description})`)
      continue
    }
    if (source === null) {
      problems.push(`${point.file}: missing, so the count it states is not checked`)
      lines.push(`  MISSING  ${point.file}  (${point.description})`)
      continue
    }
    // Every occurrence is checked, not just the first: a page can carry the
    // correct sentence in one place and a stale copy of it in another, and a
    // single-match check would report the page as agreeing.
    const matches = [...source.matchAll(new RegExp(point.pattern.source, point.pattern.flags.includes('g') ? point.pattern.flags : `${point.pattern.flags}g`))]
    if (matches.length === 0) {
      problems.push(`${point.file}: ${point.description} not found — the wording moved, so the count is no longer checked`)
      lines.push(`  MISSING  ${point.file}  (${point.description})`)
      continue
    }
    for (const match of matches) {
      const values = point.values(match)
      const wrong = Object.entries(values).filter(([key, value]) => value !== measured[key === 'casesAgain' ? 'cases' : key])
      const shown = Object.entries(values).map(([key, value]) => `${key}=${value}`).join(' ')
      if (wrong.length > 0) {
        problems.push(`${point.file}: ${point.description} says ${shown}; measured ${measured.files}/${measured.cases}`)
        lines.push(`  STALE    ${point.file}  ${shown}`)
      } else {
        lines.push(`  ok       ${point.file}  ${shown}`)
      }
    }
  }
  return { problems, lines }
}

function parseArguments(argv) {
  const options = { observed: undefined, observedPass: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--observed') options.observed = Number(argv[++index])
    else if (name === '--observed-pass') options.observedPass = Number(argv[++index])
    else if (name !== '--check') throw new Error(`unknown argument: ${name}`)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const measured = measuredCounts()
  const observed = options.observed === undefined ? undefined : { tests: options.observed, pass: options.observedPass }
  const { problems, lines } = check(measured, {}, observed)
  for (const line of lines) console.log(line)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-doc-numbers: ${problem}`)
    return 1
  }
  console.log('check-doc-numbers: all declaration points agree')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
