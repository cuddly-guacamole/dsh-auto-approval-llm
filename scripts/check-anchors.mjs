#!/usr/bin/env node
/**
 * Anchor guard for the docs site's `<span class="lnum">` source references.
 *
 * Every `docs/*.md` page points at source lines by hand. Those pointers drift
 * the moment the file they name grows or shrinks, and a pointer that is inside
 * the file but aimed at the wrong statement cannot be caught by a human
 * reviewer either. This check resolves each anchor against the working tree and
 * grades it by what it could actually prove:
 *
 *   policy.ts:LassessTool                     `assessTool` must be a unique
 *                                             DECLARATION (function/class/
 *                                             interface/type/const/…).
 *   policy.ts:L"unreadable apply_patch …"     the quoted text must appear as a
 *                                             unique literal in the file.
 *   policy.ts:LreadTools                      the bare token must appear
 *                                             exactly once in the file.
 *   policy.ts:L291-504                        the range must fit inside the
 *                                             file. An in-bounds range aimed
 *                                             at the wrong statement is NOT
 *                                             auto-detectable; it is reported
 *                                             as range-checked, never as
 *                                             verified.
 *   shell.ts#                                 the file must exist. No line
 *                                             claim is made, so nothing drifts.
 *
 * Symbol/literal/token anchors are the drift-resistant forms: they cannot go
 * stale when unrelated code moves, which is exactly why this script only
 * READS. A self-verifying anchor needs no rewrite, and a bare range cannot be
 * repaired without knowing which statement it was meant to point at — so there
 * is no `--write` mode, and the summary always separates the buckets: a green
 * run never claims more than it proved.
 *
 * Usage: node scripts/check-anchors.mjs [--check] [--quiet] [path…]
 *   --check  exit non-zero on any violation (default when no flag is given)
 *   --quiet  print violations and the summary only
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flags = {
  check: args.includes('--check'),
  quiet: args.includes('--quiet'),
}
flags.check = true
const explicitPaths = args.filter((a) => !a.startsWith('--'))

const DOCS = explicitPaths.length > 0
  ? explicitPaths
  : readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).sort().map((name) => join('docs', name))

const SPAN = /<span class="lnum">([^<]*)<\/span>/g
// `file.ts:L123-456`, `file.ts:L123`, `file.ts:Lsymbol`, `file.ts:L"literal"`,
// `file.ts#`, and the older symbol spelling `file.ts:symbol`.
const TOKEN = /([\w./-]+\.[a-z]+):L(\d+(?:-\d+)?|"[^"]+"|'[^']+'|[A-Za-z_$][\w$]*)|([\w./-]+\.[a-z]+)#|([\w./-]+\.[a-z]+):([A-Za-z_$][\w$]*)/g
// Only keyword-led declarations count as a definition: a call site or a
// mention inside a comment must not satisfy a declaration anchor.
const DEFINITION = /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/

const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage', '.vitepress'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|mjs|mts|js|vue)$/.test(name)) out.push(full)
  }
  return out
}

/** basename -> repo-relative paths, so `policy.ts` and `src/auto/policy.ts` both resolve. */
const moduleIndex = new Map()
for (const full of walk(root)) {
  const rel = full.slice(root.length + 1).split('\\').join('/')
  const key = basename(rel)
  if (!moduleIndex.has(key)) moduleIndex.set(key, [])
  moduleIndex.get(key).push(rel)
}

const fileCache = new Map()
function sourceLines(rel) {
  if (!fileCache.has(rel)) {
    fileCache.set(rel, existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8').split('\n') : null)
  }
  return fileCache.get(rel)
}

function resolveModule(token) {
  if (token.includes('/')) {
    const direct = token.replace(/^\.?\//, '')
    if (existsSync(join(root, direct))) return direct
    for (const candidate of [`src/${direct}`, `src/auto/${direct}`, `scripts/${direct}`]) {
      if (existsSync(join(root, candidate))) return candidate
    }
    return null
  }
  const hits = moduleIndex.get(basename(token)) ?? []
  if (hits.length === 0) return null
  // Ambiguous basename: prefer the two-level src/ module the docs point at.
  return hits.find((h) => h.startsWith('src/') && h.split('/').length === 2) ?? hits[0]
}

/** 1-based lines where `needle` matches; `test` decides what counts as a hit. */
function findLine(rel, needle, test) {
  const lines = sourceLines(rel)
  if (lines === null) return []
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle) && test(lines[i], i + 1)) hits.push(i + 1)
  }
  return hits
}

function declarationLines(rel, symbol) {
  return findLine(rel, symbol, (line) => {
    const match = DEFINITION.exec(line)
    return match !== null && match[1] === symbol
  })
}

function tokenLines(rel, token) {
  const lines = sourceLines(rel)
  if (lines === null) return []
  const hits = []
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`)
  for (let i = 0; i < lines.length; i++) if (word.test(lines[i])) hits.push(i + 1)
  return hits
}

function literalLines(rel, literal) {
  return findLine(rel, literal, () => true)
}

const buckets = { declaration: 0, literal: 0, token: 0, range: 0, whole: 0 }
const violations = []
const unresolved = []

function parseTokens(body) {
  const tokens = []
  TOKEN.lastIndex = 0
  let token
  while ((token = TOKEN.exec(body)) !== null) {
    const [full, ranged, value, whole, plainFile, legacySymbol] = token
    if (ranged !== undefined) {
      if (/^\d/.test(value)) tokens.push({ file: ranged, claim: `L${value}`, kind: 'range' })
      else if (value.startsWith('"') || value.startsWith("'")) tokens.push({ file: ranged, claim: `L${value}`, kind: 'literal', needle: value.slice(1, -1) })
      else tokens.push({ file: ranged, claim: `L${value}`, kind: 'symbol', needle: value })
    } else if (whole !== undefined) {
      tokens.push({ file: whole, claim: '#', kind: 'whole' })
    } else {
      tokens.push({ file: plainFile, claim: `L${legacySymbol}`, kind: 'symbol', needle: legacySymbol })
    }
    TOKEN.lastIndex = token.index + full.length
    void full
  }
  return tokens
}

function scanDoc(rel) {
  const text = readFileSync(join(root, rel), 'utf8')
  const anchors = []
  SPAN.lastIndex = 0
  let span
  while ((span = SPAN.exec(text)) !== null) {
    const body = span[1].trim()
    const docLine = text.slice(0, span.index).split('\n').length
    const tokens = parseTokens(body)
    if (tokens.length === 0) {
      unresolved.push(`${rel}:${docLine}  no parsable anchor in ${JSON.stringify(body)}`)
      continue
    }
    if (/L\d/.test(body.replace(TOKEN, ''))) {
      unresolved.push(`${rel}:${docLine}  a second line claim in the same span is not checked: ${JSON.stringify(body)}`)
    }
    for (const t of tokens) anchors.push({ ...t, doc: rel, docLine, offset: span.index, body })
  }
  return anchors
}

const dupReported = new Set()
for (const doc of DOCS) {
  for (const anchor of scanDoc(doc)) {
    const rel = resolveModule(anchor.file)
    if (rel === null) {
      violations.push(`${anchor.doc}:${anchor.docLine}  unknown module ${anchor.file}  (${anchor.body})`)
      continue
    }
    const total = sourceLines(rel).length
    const label = anchor.claim === '#' ? '#' : anchor.claim
    const where = `${anchor.doc}:${anchor.docLine}  ${rel}:${label}`

    if (anchor.kind === 'whole') {
      buckets.whole++
      continue
    }

    if (anchor.kind === 'range') {
      const [start, end] = anchor.claim.slice(1).split('-').map(Number)
      const upper = end ?? start
      if (start < 1 || upper > total || start > upper) {
        violations.push(`${where}  out of bounds: ${rel} has ${total} lines  (${anchor.body})`)
      } else {
        buckets.range++
      }
      continue
    }

    const grade = anchor.kind === 'symbol' ? 'declaration' : anchor.kind
    // A bare identifier is matched as a declaration first; quoted text and
    // display-ready needles are matched as written.
    const plain = /^[A-Za-z_$][\w$]*$/.test(anchor.needle)
    const finders = anchor.kind === 'symbol'
      ? [['declaration', plain ? anchor.needle : ''], ['literal', anchor.needle], ['token', anchor.needle]]
      : [[grade, anchor.needle]]

    let found = null
    for (const [kind, needle] of finders) {
      if (needle === '') continue
      const hits = kind === 'declaration' ? declarationLines(rel, needle)
        : kind === 'literal' ? literalLines(rel, needle)
          : tokenLines(rel, needle)
      if (hits.length > 0) {
        found = { kind, hits, needle }
        break
      }
    }
    if (found === null) {
      violations.push(`${where}  not found in ${rel}: no declaration, literal, or unique token matches ${JSON.stringify(anchor.needle)}  (${anchor.body})`)
      continue
    }
    if (found.hits.length > 1) {
      const key = `${rel}:${anchor.needle}:${found.kind}`
      if (!dupReported.has(key)) {
        dupReported.add(key)
        violations.push(`${where}  ${found.kind} anchor is ambiguous: ${anchor.needle} matches ${found.hits.length} lines in ${rel} (${found.hits.join(', ')}); use an explicit range instead`)
      }
      continue
    }
    buckets[found.kind]++
  }
}

for (const line of unresolved) console.log(`UNVERIFIED ${line}`)
for (const line of violations) console.error(`VIOLATION ${line}`)

// Every anchor that was examined, so the count cannot fall when a check
// fails: a violating anchor used to be left out of the total, which made a run
// with violations look like it had inspected fewer anchors than the document
// contains. `unresolved` spans are reported separately (partial verification,
// not a violation).
const failed = violations.length
const totalChecked = buckets.declaration + buckets.literal + buckets.token + buckets.range + buckets.whole + failed
if (!flags.quiet) {
  console.log(
    `check-anchors: ${DOCS.length} doc(s), ${totalChecked} anchor(s) resolved — `
    + `${buckets.declaration} declaration-verified, `
    + `${buckets.literal} literal-verified (unique quoted text located), `
    + `${buckets.token} token-verified (unique identifier located), `
    + `${buckets.range} range-checked only (in-bounds; a wrong-code range is not auto-detectable), `
    + `${buckets.whole} whole-file (existence only), `
    + `${failed} failed`,
  )
  if (unresolved.length > 0) console.log(`check-anchors: ${unresolved.length} span(s) only partially verified (listed above)`)
  console.log(violations.length > 0 ? `check-anchors: ${violations.length} violation(s)` : 'check-anchors: ok')
}

if (flags.check && violations.length > 0) process.exit(1)
process.exit(0)
