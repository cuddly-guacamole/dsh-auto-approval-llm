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
    file: 'docs/15-quality.md',
    description: 'page subtitle',
    pattern: /\*(\d+) tests · runtime proofs\*/,
    values: match => ({ cases: Number(match[1]) }),
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

/**
 * Phrasings that state a suite-wide count. Used by the coverage test to notice a
 * new sentence that no declaration point watches. A per-file count ("12 例" for
 * one test file) is deliberately out of scope, so a bare `N 例` never matches on
 * its own — it needs a suite-wide marker next to it.
 */
export const COUNT_CLAIM =
  /\d+\s*个\s*(?:tests\/\*\.test\.mjs|测试文件|测试)|\d+\s*测试\s*(\+|例|\d)|测试\s*\d+\s*例|\d+\s*\/\s*\d+\s*(?:全绿|fail 0|通过|passing)|\d+\s+tests?\b|合计\s*\*{0,2}\d+\s*例|用例总数\s*\d+/

/** Documents whose count claims must be covered by a declaration point. */
export function watchedDocuments(root = ROOT) {
  const docs = readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)
  return [...docs, 'README.md', 'README.en.md', 'AGENTS.md'].filter(name => existsSync(join(root, name)))
}

/** Contents of every watched document, keyed by path. */
export function watchedDocumentSources(root = ROOT) {
  const sources = {}
  for (const file of watchedDocuments(root)) sources[file] = readFileSync(join(root, file), 'utf8')
  return sources
}

/**
 * Count claims in a document that no declaration point checks.
 *
 * Coverage is decided per position rather than per file: a page under watch may
 * still carry a sentence the patterns do not match, and skipping every watched
 * file wholesale would hide exactly the drift this is meant to catch.
 */
export function uncoveredClaims(sources, root = ROOT) {
  const found = []
  const files = Object.keys(sources)
  for (const file of files) {
    const source = sources[file]
    const covered = []
    for (const point of DECLARATION_POINTS) {
      if (point.file !== file) continue
      for (const match of source.matchAll(new RegExp(point.pattern.source, `${point.pattern.flags.replace('g', '')}g`)))
        covered.push([match.index, match.index + match[0].length])
    }
    for (const match of source.matchAll(new RegExp(COUNT_CLAIM.source, 'g'))) {
      const start = match.index
      const end = start + match[0].length
      if (covered.some(([from, to]) => start < to && end > from)) continue
      found.push({ file, text: match[0], line: source.slice(0, start).split('\n').length })
    }
  }
  return found
}

/**
 * Per-file counts a page states inline, e.g. "category.test.mjs 108 例". These
 * drifted silently because nothing tied them to the file they name: the suite
 * total is checked, but one file's share of it is not the same number and moves
 * on its own.
 */
export const PER_FILE_CLAIM = /([a-z0-9-]+)\.test\.mjs`?\s*[，,：:]?\s*(\d+)\s*例/g

/** Count the cases a single test file declares. */
export function countCasesInFile(root, name) {
  const source = readFileSync(join(root, 'tests', `${name}.test.mjs`), 'utf8')
  return [...source.matchAll(/^(?:test|it)\(/gm)].length
}

/** Every inline per-file count in the watched documents, with what it claims and what the file holds. */
export function checkPerFileClaims(sources, root = ROOT) {
  const problems = []
  const lines = []
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(new RegExp(PER_FILE_CLAIM.source, 'g'))) {
      const [, name, claimedText] = match
      const claimed = Number(claimedText)
      let actual
      try {
        actual = countCasesInFile(root, name)
      } catch {
        problems.push(`${file}: "${match[0]}" names a test file that does not exist`)
        continue
      }
      if (claimed !== actual) {
        problems.push(`${file}: "${match[0]}" but tests/${name}.test.mjs declares ${actual}`)
        lines.push(`  STALE    ${file}  ${name}=${claimed} (actual ${actual})`)
      } else {
        lines.push(`  ok       ${file}  ${name}=${claimed}`)
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
  const perFile = checkPerFileClaims(watchedDocumentSources())
  for (const line of lines) console.log(line)
  for (const line of perFile.lines) console.log(line)
  for (const problem of [...problems, ...perFile.problems]) console.error(`check-doc-numbers: ${problem}`)
  if (problems.length + perFile.problems.length > 0) return 1
  console.log('check-doc-numbers: all declaration points agree')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
