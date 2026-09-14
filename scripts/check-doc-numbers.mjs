#!/usr/bin/env node
// The published docs state numbers in several places. Those numbers drifted
// independently of each other because nothing recomputed them. This checker owns
// the single source of truth: the counts derived from tests/*.test.mjs, and the
// numbers derived from the source tree (per-module line counts, the module
// count, the Config schema key count, the host route count). Every declaration
// point must exist and must agree with it.
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
  {
    file: 'docs/13-http-api.md',
    description: 'route count',
    pattern: /全站共 \*\*(\d+) 条/,
    values: match => ({ routes: Number(match[1]) }),
  },
  {
    file: 'docs/index.md',
    description: 'route count (feature table)',
    pattern: /`(\d+) 条`（无 RPC）/,
    values: match => ({ routes: Number(match[1]) }),
  },
  {
    file: 'docs/index.md',
    description: 'route count (nav card)',
    pattern: /<span class="nd">(\d+) 条路由/,
    values: match => ({ routes: Number(match[1]) }),
  },
]

/**
 * Routes the host registers under the plugin prefix: one wiring constant each,
 * the shape the route table and both landing-page statements describe.
 */
export function measuredRouteCount(root = ROOT) {
  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  return [...source.matchAll(/^const [A-Z0-9_]*ROUTE = '/gm)].length
}

/** Static source of truth: how many test files exist and how many cases they declare. */
export function measuredCounts(root = ROOT) {
  const dir = join(root, 'tests')
  const files = readdirSync(dir).filter(name => name.endsWith('.test.mjs'))
  let cases = 0
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8')
    cases += [...source.matchAll(/^(?:test|it)\(/gm)].length
  }
  return { files: files.length, cases, routes: measuredRouteCount(root) }
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
 * its own — it needs a suite-wide marker next to it. Route counts belong here
 * too: they are the other number a page states about the shipped surface, and
 * they drifted the same way until each phrasing had a declaration point.
 */
export const COUNT_CLAIM =
  /\d+\s*个\s*(?:tests\/\*\.test\.mjs|测试文件|测试)|\d+\s*测试\s*(\+|例|\d)|测试\s*\d+\s*例|\d+\s*\/\s*\d+\s*(?:全绿|fail 0|通过|passing)|\d+\s+tests?\b|合计\s*\*{0,2}\d+\s*例|用例总数\s*\d+|\d+\s*条`（无 RPC）|\d+\s*条路由|全站共\s*\*\*\d+\s*条/

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

/**
 * Numbers the docs derive from the source tree rather than from the test suite.
 * Each point scans one document for the shapes that carry such a number, asks
 * the source tree what the number is, and reports every mismatch. The rewrite
 * callback is what `sync-doc-numbers.mjs` applies, so the checker stays the only
 * owner of what the numbers mean.
 *
 * The line counts intentionally pin the published tables to the working tree:
 * prose that states "this file is N lines" is a claim about the source, and
 * leaving it unwatched is how twelve of thirteen rows went stale at once.
 */
export const DERIVED_POINTS = [
  {
    file: 'docs/03-static-engine.md',
    description: 'module line counts',
    pattern: /^(\| `([a-z0-9-]+\.ts)` <span class="lnum">[^<]*<\/span> \| )(\d+)( \|)/gm,
    // The table is a hand-kept subset of src/auto; losing a row would silently
    // drop that module from the gate, so the floor is a ratchet.
    minRows: 13,
    label: match => match[2],
    claimed: match => Number(match[3]),
    expect: (match, measured) => measured.lines(`src/auto/${match[2]}`),
    rewrite: (match, value) => `${match[1]}${value}${match[4]}`,
  },
  {
    file: 'docs/14-code-map.md',
    description: 'auto module line counts',
    pattern: /^(│[ ]+[├└]─[ ]+)([a-z0-9-]+\.ts)([ ]+)(\d+)/gm,
    // This one claims to list the whole layer, so it must hold one row per module.
    minRows: measured => measured.autoFiles,
    label: match => match[2],
    claimed: match => Number(match[4]),
    expect: (match, measured) => measured.lines(`src/auto/${match[2]}`),
    rewrite: (match, value) => `${match[1]}${match[2]}${match[3]}${value}`,
  },
  {
    file: 'docs/14-code-map.md',
    description: 'auto module count',
    pattern: /静态评估纯函数层（(\d+) 文件/,
    label: () => 'src/auto',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.autoFiles,
    rewrite: (match, value) => `静态评估纯函数层（${value} 文件`,
  },
  {
    file: 'docs/14-code-map.md',
    description: 'host wiring route count',
    pattern: /四挂点接线、(\d+) 路由/,
    label: () => 'index.ts routes',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.routes,
    rewrite: (match, value) => `四挂点接线、${value} 路由`,
  },
  {
    file: 'docs/14-code-map.md',
    description: 'host entry line count',
    pattern: /学习接线[ ]+(\d+) 行/,
    label: () => 'src/index.ts',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.lines('src/index.ts'),
    rewrite: (match, value) => match[0].replace(/\d+ 行$/, `${value} 行`),
  },
  {
    file: 'docs/14-code-map.md',
    description: 'client entry line count',
    pattern: /React 客户端主体 (\d+) 行/,
    label: () => 'src/client/index.ts',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.lines('src/client/index.ts'),
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/14-code-map.md',
    description: 'approval module line counts',
    pattern: /^[ ]{5}│[ ]+[├└]─[ ]+(remote|shared)\.ts[ ]+(\d+)[ ]*$/gm,
    minRows: 2,
    label: match => `src/client/approvals/${match[1]}.ts`,
    claimed: match => Number(match[2]),
    expect: (match, measured) => measured.lines(`src/client/approvals/${match[1]}.ts`),
    rewrite: (match, value) => match[0].replace(/\d+[ ]*$/, String(value)),
  },
  {
    file: 'docs/14-code-map.md',
    description: 'permission icon module line count',
    pattern: /权限菜单图标 \+ Auto 风险确认弹窗 (\d+) 行/,
    label: () => 'src/client/auto-icon.ts',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.lines('src/client/auto-icon.ts'),
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/14-code-map.md',
    description: 'locale module line count',
    pattern: /zh\/en 双语 (\d+) 行/,
    label: () => 'src/client/locale.ts',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.lines('src/client/locale.ts'),
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/14-code-map.md',
    description: 'tool chip module line count',
    pattern: /tool-chips\.ts[ ]+(\d+)[ ]+工具芯片/,
    label: () => 'src/client/tool-chips.ts',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.lines('src/client/tool-chips.ts'),
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/12-config.md',
    description: 'config key count (subtitle)',
    pattern: /\*(\d+) keys, one source of truth\*/,
    label: () => 'Config schema',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.configKeys,
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/index.md',
    description: 'config key count (nav card)',
    pattern: /(\d+) 键 schema \+ bundle 覆盖/,
    label: () => 'Config schema',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.configKeys,
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/17-category-switches.md',
    description: 'category module line count',
    pattern: /class="lnum">src\/auto\/category\.ts#<\/span>，(\d+) 行/,
    label: () => 'src/auto/category.ts',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.lines('src/auto/category.ts'),
    rewrite: (match, value) => match[0].replace(/\d+ 行$/, `${value} 行`),
  },
  {
    file: 'docs/01-system-overview.md',
    description: 'audit rotation line cap',
    pattern: />5MB 保尾 (\d+) 行/,
    label: () => 'MAX_AUDIT_LINES',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.auditLines,
    rewrite: (match, value) => match[0].replace(/\d+ 行$/, `${value} 行`),
  },
  {
    file: 'docs/11-data-persistence.md',
    description: 'audit rotation line cap',
    pattern: />5MiB 保尾 (\d+) 行/,
    label: () => 'MAX_AUDIT_LINES',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.auditLines,
    rewrite: (match, value) => match[0].replace(/\d+ 行$/, `${value} 行`),
  },
  {
    file: 'docs/15-quality.md',
    description: 'audit rotation line cap',
    pattern: />(\d+) 行取尾/,
    label: () => 'MAX_AUDIT_LINES',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.auditLines,
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/index.md',
    description: 'audit rotation line cap (core numbers row)',
    pattern: /`200 条 \/ (\d+) 行`/,
    label: () => 'MAX_AUDIT_LINES',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.auditLines,
    rewrite: (match, value) => match[0].replace(/\d+(?= 行)/, String(value)),
  },
  {
    file: 'docs/14-code-map.md',
    description: 'settings sub-card count',
    pattern: /设置卡 (\d+) 子卡/,
    label: () => 'settings sub-cards',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.subcards,
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
  {
    file: 'docs/10-client-ui.md',
    description: 'settings sub-card count',
    pattern: /(\d+) 张可折叠子卡/,
    label: () => 'settings sub-cards',
    claimed: match => Number(match[1]),
    expect: (match, measured) => measured.subcards,
    rewrite: (match, value) => match[0].replace(/\d+/, String(value)),
  },
]

/** Newline count, i.e. the same number `wc -l` reports. */
export function countLines(text) {
  return (text.match(/\n/g) ?? []).length
}

/**
 * Top-level keys of the host Config schema, or null when the block cannot be
 * read. Null is the honest answer: a parser that quietly returned 0 would make
 * every page "agree" with a number nothing measured. The lower bound is a
 * sanity floor — a schema that shrank below a fifth of its size means the parse
 * broke, not that the product did.
 */
export function configKeyCount(source) {
  const marker = 'export const Config: z<Config> = z.object({'
  const start = source.indexOf(marker)
  if (start === -1) return null
  let depth = 1
  let keys = 0
  for (const raw of source.slice(start + marker.length).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
    if (depth === 1 && /^ {2}[A-Za-z_][A-Za-z0-9_]*[ ]*:/.test(line)) keys += 1
    for (const char of line) {
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
    if (depth <= 0) return keys >= 20 ? keys : null
  }
  return null
}

/** A named numeric constant read out of a source file, or null when it is absent. */
function numericConstant(path, pattern) {
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const raw = pattern.exec(source)?.[1]
  return raw === undefined ? null : Number(raw.replace(/_/g, ''))
}

/** How many times a pattern occurs in a source file, or null when it cannot be read. */
function countMatches(path, pattern) {
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const count = [...source.matchAll(pattern)].length
  return count > 0 ? count : null
}

/** What the source tree says the derived numbers are. */
export function measuredDerived(root = ROOT) {
  const cache = new Map()
  const lines = path => {
    if (!cache.has(path)) cache.set(path, countLines(readFileSync(join(root, path), 'utf8')))
    return cache.get(path)
  }
  return {
    lines,
    autoFiles: readdirSync(join(root, 'src', 'auto')).filter(name => name.endsWith('.ts')).length,
    configKeys: configKeyCount(readFileSync(join(root, 'src', 'index.ts'), 'utf8')),
    routes: measuredRouteCount(root),
    auditLines: numericConstant(join(root, 'src', 'auto', 'audit.ts'), /export const MAX_AUDIT_LINES = ([\d_]+)/),
    subcards: countMatches(join(root, 'src', 'client', 'index.ts'), /^[ ]{4}subcard\(/gm),
  }
}

/**
 * Compare every derived declaration point against the source tree.
 * `sources` maps a declared file path to its content; unlisted files are read.
 */
export function checkDerived(sources = {}, measured = measuredDerived()) {
  const problems = []
  const lines = []
  for (const point of DERIVED_POINTS) {
    let source
    if (Object.hasOwn(sources, point.file)) source = sources[point.file]
    else if (existsSync(join(ROOT, point.file))) source = readFileSync(join(ROOT, point.file), 'utf8')
    else source = null
    if (source === null) {
      problems.push(`${point.file}: missing, so the numbers it states are not checked`)
      lines.push(`  MISSING  ${point.file}  (${point.description})`)
      continue
    }
    const flags = point.pattern.flags.includes('g') ? point.pattern.flags : `${point.pattern.flags}g`
    const matches = [...source.matchAll(new RegExp(point.pattern.source, flags))]
    if (matches.length === 0) {
      problems.push(`${point.file}: ${point.description} not found — the wording moved, so the number is no longer checked`)
      lines.push(`  MISSING  ${point.file}  (${point.description})`)
      continue
    }
    // A multi-row point must keep covering every row it claims: one row losing
    // the watched shape would leave that number ungated with nothing reported.
    const floor = point.minRows === undefined ? 1 : (typeof point.minRows === 'function' ? point.minRows(measured) : point.minRows)
    if (Number.isFinite(floor) && matches.length < floor) {
      problems.push(`${point.file}: ${point.description} covers ${matches.length} row(s) but at least ${floor} are expected — a row left the gate`)
      lines.push(`  SHRUNK   ${point.file}  (${point.description}: ${matches.length}/${floor} row(s))`)
    }
    let stale = 0
    for (const match of matches) {
      const claimed = point.claimed(match)
      let expected = null
      try {
        expected = point.expect(match, measured)
      } catch {
        expected = null
      }
      if (!Number.isFinite(expected)) {
        problems.push(`${point.file}: ${point.description} (${point.label(match)}) cannot be measured from the source tree`)
        lines.push(`  UNREADABLE  ${point.file}  ${point.label(match)}`)
        continue
      }
      if (claimed !== expected) {
        stale += 1
        problems.push(`${point.file}: ${point.description} says ${claimed} for ${point.label(match)}; measured ${expected}`)
        lines.push(`  STALE    ${point.file}  ${point.label(match)}=${claimed} (actual ${expected})`)
      }
    }
    if (stale === 0) lines.push(`  ok       ${point.file}  (${point.description}: ${matches.length} row(s))`)
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

/**
 * Run every check family over one set of document sources. `sources` defaults to
 * the watched documents read from disk; passing a copy is how a test drives the
 * failure path (and the exit code built from it) without touching the tree.
 */
export function runChecks(argv = [], sources) {
  const options = parseArguments(argv)
  const documents = sources ?? watchedDocumentSources()
  const measured = measuredCounts()
  const observed = options.observed === undefined ? undefined : { tests: options.observed, pass: options.observedPass }
  const suite = check(measured, documents, observed)
  const perFile = checkPerFileClaims(documents)
  const derived = checkDerived(documents)
  return {
    measured,
    observed,
    suite,
    perFile,
    derived,
    failures: [...suite.problems, ...perFile.problems, ...derived.problems],
  }
}

export function main(argv = process.argv.slice(2)) {
  const { suite, perFile, derived, failures, measured } = runChecks(argv)
  for (const line of suite.lines) console.log(line)
  for (const line of perFile.lines) console.log(line)
  for (const line of derived.lines) console.log(line)
  for (const problem of failures) console.error(`check-doc-numbers: ${problem}`)
  if (failures.length > 0) return 1
  console.log(`check-doc-numbers: all declaration points agree (${measured.files} files / ${measured.cases} cases, ${DECLARATION_POINTS.length} suite point(s), ${derived.lines.filter(line => line.includes('  ok')).length} derived point(s))`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
