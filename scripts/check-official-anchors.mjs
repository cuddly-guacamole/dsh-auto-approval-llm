#!/usr/bin/env node
// Read-only cross-artifact check between this repository and the installed
// official dsh client packages.
//
// The plugin compiles against four facts that live in official build output:
// the platform seed module table, the official approval button wording, the
// official slot directory, and the official permission preset wording. An
// official release can change all four without breaking the build, so they are
// compared here instead of being assumed.
//
// The official packages are optional: on a clean clone or an offline machine
// the check prints one WARN and exits 0. Only a resolved official tree with a
// real disagreement, or an unreadable part of this repository, exits 1.
//
// Usage: node scripts/check-official-anchors.mjs [--check] [--help]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(HERE, '..')
const SKIP_MESSAGE = 'check-official-anchors: WARN official packages not resolvable; skipped'
const HELP = `check-official-anchors: read-only comparison against the official dsh client artifacts

Usage: node scripts/check-official-anchors.mjs [--check] [--help]

Options:
  --check   default and only mode; the run never writes anything
  --help    print this text

Official package root resolution order:
  1. env DSA_OFFICIAL_ROOT
  2. <dirname(process.execPath)>/../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
  3. <repo>/.official-root (file content) and its ancestor directories

Exit codes: 0 consistent or skipped, 1 at least one item failed.
`

/** Item names as they appear in the report. */
export const ITEMS = {
  seed: 'platform-seed-modules',
  approval: 'approval-button-labels',
  slots: 'slot-directory',
  presets: 'permission-presets',
}

function readText(file) {
  return readFileSync(file, 'utf8')
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function firstExisting(candidates) {
  return candidates.find(candidate => typeof candidate === 'string' && existsSync(candidate))
}

/** Directory containing the official `dsh-*` client packages, or undefined. */
export function resolveOfficialRoot(repoRoot) {
  const marked = process.env.DSA_OFFICIAL_ROOT
  if (marked !== undefined && marked.trim() !== '') {
    // An explicit override is honoured as written: a wrong value must surface
    // as "not resolvable" instead of silently falling back to autodiscovery.
    const candidate = resolve(marked.trim())
    return isDirectory(candidate) ? candidate : undefined
  }
  // npm global layouts: the official packages live under the npm prefix, not
  // next to the node binary. Windows keeps that prefix in %APPDATA%\npm, POSIX
  // at <node>/../lib/node_modules; a Windows install may also keep them beside
  // the binary. Try each candidate before giving up.
  const suffixes = [
    ['@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'],
    ['@deepseek-ai', 'dsh'],
  ]
  const prefixes = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : undefined,
    join(dirname(process.execPath), 'node_modules'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules'),
    resolve(dirname(process.execPath), '..', 'node_modules'),
  ].filter((prefix) => typeof prefix === 'string')
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const candidate = join(prefix, ...suffix)
      if (isDirectory(candidate)) return candidate
    }
  }
  let current = repoRoot
  for (let depth = 0; depth < 8; depth += 1) {
    const pointer = join(current, '.official-root')
    if (existsSync(pointer)) {
      const pointed = resolve(current, readText(pointer).trim())
      if (isDirectory(pointed)) return pointed
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * The seed bundle file name carries a content hash, so the assets directory is
 * scanned for a script that actually contains the seed table.
 */
function findSeedBundle(root) {
  const assets = join(root, 'dsh-web-frontend', 'dist', 'assets')
  if (!isDirectory(assets)) return undefined
  const names = []
  try {
    for (const name of readdirSync(assets)) {
      if (name.endsWith('.js')) names.push(join(assets, name))
    }
  } catch {
    return undefined
  }
  let fallback
  for (const candidate of names) {
    let text
    try {
      text = readText(candidate)
    } catch {
      continue
    }
    if (!text.includes('staticModules')) continue
    if (findSeedTable(text) !== undefined) return candidate
    fallback ??= candidate
  }
  return fallback
}

/**
 * Extract the seed module table. The boot facade calls it as
 * `staticModules: <fn>()`, so the function named there is located and its own
 * returned object literal is read. Scanning the declaration instead of
 * matching the whole function shape with one regular expression keeps the
 * parse working for minified and formatted output alike.
 */
export function findSeedTable(source) {
  const names = []
  for (const match of source.matchAll(/staticModules\s*:\s*([A-Za-z_$][\w$]*)\s*\(/g)) names.push(match[1])
  const inline = /staticModules\s*:\s*\{/.exec(source)
  if (inline !== null) {
    const body = braceBody(source, source.indexOf('{', inline.index))
    if (body !== undefined) return tableKeys(body)
  }
  const candidates = names.map(name => objectReturnedBy(source, name)).filter(body => body !== undefined)
  if (candidates.length === 0) return undefined
  let chosen = candidates[0]
  for (const body of candidates) {
    if (tableKeys(body).length > tableKeys(chosen).length) chosen = body
  }
  return tableKeys(chosen)
}

/**
 * Object literal body returned by the named function. The `return` is taken
 * from inside the declaration so minified (`return{`) and formatted
 * (`return {`) output both resolve.
 */
function objectReturnedBy(source, name) {
  const declared = new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\(`).exec(source)
  if (declared === null) return undefined
  for (const from of [declared.index + declared[0].length, 0]) {
    const at = source.indexOf('return', from)
    if (at < 0) continue
    const open = source.indexOf('{', at)
    if (open < 0) continue
    // `return` must be followed by the object literal itself, not by another
    // statement that happens to contain a brace.
    if (!/^[\s(]*$/.test(source.slice(at + 'return'.length, open))) continue
    const body = braceBody(source, open)
    if (body !== undefined && tableKeys(body).length > 0) return body
  }
  return undefined
}

/** Balanced-brace body starting at `open`, or undefined when unbalanced. */
function braceBody(source, open) {
  if (open < 0 || source[open] !== '{') return undefined
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return undefined
}

/**
 * Property names of an object literal body. A quoted string counts as a name
 * only when a colon follows it, so a quoted VALUE does not swallow the name
 * that comes after it.
 */
function tableKeys(body) {
  const keys = []
  for (const match of body.matchAll(/"([^"]*)"\s*:|'([^']*)'\s*:|([A-Za-z_$][\w$]*)\s*:/g)) {
    const key = match[1] ?? match[2] ?? match[3]
    if (key !== undefined && key !== '') keys.push(key)
  }
  return [...new Set(keys)]
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `const NAME = [ ... ]` from a TypeScript source file, literal style only. */
export function literalArray(source, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source)
  if (match === null) return undefined
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(entry => entry[1] ?? entry[2])
}

/** Object literal keys and quoted values of `export const NAME = { ... }`. */
export function literalObjectOfArrays(source, name) {
  const start = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=`).exec(source)
  if (start === null) return undefined
  const open = source.indexOf('{', start.index + start[0].length)
  const body = braceBody(source, open)
  if (body === undefined) return undefined
  const entries = new Map()
  for (const match of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\[([^\]]*)\]/g)) {
    entries.set(match[1], [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map(entry => entry[1] ?? entry[2]))
  }
  return entries.size === 0 ? undefined : entries
}

/** Read the tsdown client bundle shape: outDir, entry name and never-bundled deps. */
export function bundlerShape(source) {
  const outDir = /outDir\s*:\s*['"]([^'"]+)['"]/.exec(source)?.[1] ?? 'lib'
  const entry = /entry\s*:\s*\{\s*([A-Za-z_$][\w$]*)\s*:/.exec(source)?.[1] ?? 'client'
  const externals = literalArray(source, 'CLIENT_EXTERNALS') ?? []
  return { outDir, entry, externals }
}

/** Module specifiers the built bundle resolves through its `require` argument. */
export function requiredSpecifiers(bundle) {
  const factory = /factory\s*:\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(bundle)
  const names = factory === null ? [] : [factory[1]]
  if (!names.includes('require')) names.push('require')
  const found = new Set()
  for (const name of names) {
    for (const match of bundle.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g'))) {
      if (!match[1].startsWith('.')) found.add(match[1])
    }
  }
  return [...found]
}

/** Button labels the plugin matches against the official approval panel. */
export function expectedButtonLabels(source) {
  const labels = new Set()
  for (const match of source.matchAll(/\^\(([^)]*)\)\$/g)) {
    for (const part of match[1].split('|')) {
      const label = part.trim()
      if (label !== '' && !/[\\[\](){}]/.test(label)) labels.add(label)
    }
  }
  return [...labels]
}

/** Slot names this repository registers. */
export function registeredSlots(source) {
  const slots = new Set()
  for (const match of source.matchAll(/\bslots\s*\.\s*inject\s*\(\s*(['"])([^'"]+)\1/g)) slots.add(match[2])
  for (const match of source.matchAll(/\bslots\s*\.\s*register\s*\(\s*\{\s*name\s*:\s*(['"])([^'"]+)\1/g)) slots.add(match[2])
  return [...slots]
}

/** Quoted slot names of the official client slot directory. */
export function officialSlots(source) {
  const slots = new Set()
  const pattern = /['"]((?:conversation|settings|sidebar|workspace|status|dialog|panel|composer)[a-zA-Z]*(?:\.[a-zA-Z]+)+)['"]/g
  for (const match of source.matchAll(pattern)) slots.add(match[1])
  return [...slots]
}

/** Label-like quoted text of an official client bundle. */
export function officialLabels(source) {
  const labels = new Set()
  for (const match of source.matchAll(/"([^"\\]{1,64})"|'([^'\\]{1,64})'/g)) {
    const value = (match[1] ?? match[2] ?? '').trim()
    if (value === '' || value.includes('.') || value.includes('/') || value.includes('#') || value.includes('_')) continue
    const hasCjk = /[\u4e00-\u9fff]/.test(value)
    const words = value.split(/\s+/)
    const latinLabel = words.length > 1 && words.every(word => /^[A-Za-z][A-Za-z'-]*$/.test(word))
    const cjkLabel = hasCjk && /^[\u4e00-\u9fff\s，。？！、：；（）“”]+$/.test(value) && value.length <= 24
    if (latinLabel || cjkLabel) labels.add(value)
  }
  return labels
}

/** Official preset identifiers, reported alongside the label match. */
export function officialPresetIds(source) {
  const ids = new Set()
  for (const match of source.matchAll(/z\$\d+\.literal\(\s*"([a-z][a-z-]*)"\s*\)/g)) ids.add(match[1])
  const enumMatch = /z\$\d+\.enum\(\s*\[([^\]]*)\]/.exec(source)
  if (enumMatch !== null) {
    for (const entry of enumMatch[1].matchAll(/"([a-z][a-z-]*)"/g)) ids.add(entry[1])
  }
  for (const match of source.matchAll(/['"](read-only|workspace-write|danger-full-access|custom|auto)['"]/g)) ids.add(match[1])
  return ids
}

/**
 * `name:` values of the preset rows in an installed patch layer. A deployment
 * may add a preset the official packages do not carry, so the wording of such a
 * preset exists only in the patch layer of the installed dsh tree.
 */
export function configuredPresetNames(source) {
  const names = new Set()
  for (const match of source.matchAll(/^\s*name\s*:\s*(.+?)\s*$/gm)) {
    const value = match[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
    // Package specifiers and paths are loader entries, not preset labels.
    if (value === '' || value.startsWith('@') || value.includes('/') || value.includes(':')) continue
    names.add(value)
  }
  return names
}

function result(name, status, detail) {
  return { name, status, detail }
}

/**
 * Item 1: every externalised platform specifier the bundle really requires must
 * be seeded by the platform boot facade or declared in `dsh.client.inject`.
 */
function checkSeedModules(repoRoot, root) {
  const bundlePath = findSeedBundle(root)
  if (bundlePath === undefined) {
    return result(ITEMS.seed, 'WARN', 'no official web frontend bundle with a staticModules table was found')
  }
  const table = findSeedTable(readText(bundlePath))
  if (table === undefined || table.length === 0) {
    return result(ITEMS.seed, 'WARN', `the seed module table in ${bundlePath} could not be parsed`)
  }
  let packageJson
  let tsdown
  try {
    packageJson = JSON.parse(readText(join(repoRoot, 'package.json')))
    tsdown = readText(join(repoRoot, 'tsdown.config.ts'))
  } catch (error) {
    return result(ITEMS.seed, 'FAIL', `repository sources unreadable: ${error.message}`)
  }
  const shape = bundlerShape(tsdown)
  const declared = new Set(packageJson?.dsh?.client?.inject ?? [])
  const bundleFile = join(repoRoot, shape.outDir, `${shape.entry}.js`)
  if (!existsSync(bundleFile)) {
    return result(ITEMS.seed, 'WARN', `built bundle ${shape.outDir}/${shape.entry}.js is missing; run the build before this check`)
  }
  const required = new Set(requiredSpecifiers(readText(bundleFile)))
  const seed = new Set(table)
  const missing = shape.externals.filter(spec => required.has(spec) && !seed.has(spec) && !declared.has(spec))
  if (missing.length > 0) {
    return result(ITEMS.seed, 'FAIL', `externalised and required but neither seeded nor declared: ${missing.join(', ')}`)
  }
  return result(ITEMS.seed, 'ok', `${seed.size} seeded specifiers, ${required.size} required, none unseeded and undeclared`)
}

/** Item 2: the button wording the approval guard matches must exist in the official panel. */
function checkApprovalLabels(repoRoot, root) {
  const artifact = firstExisting([join(root, 'dsh-client-ui-approval', 'lib', 'client.js')])
  let expected
  try {
    expected = expectedButtonLabels(readText(join(repoRoot, 'src', 'client', 'approvals', 'shared.ts')))
  } catch (error) {
    return result(ITEMS.approval, 'FAIL', `src/client/approvals/shared.ts is unreadable: ${error.message}`)
  }
  if (expected.length === 0) {
    return result(ITEMS.approval, 'WARN', 'no button literals were found in src/client/approvals/shared.ts; the matching form may have changed')
  }
  if (artifact === undefined) {
    return result(ITEMS.approval, 'WARN', 'no official approval client bundle was found')
  }
  const text = readText(artifact)
  const missing = expected.filter(label => !text.includes(label))
  if (missing.length > 0) {
    return result(ITEMS.approval, 'FAIL', `expected button labels missing from ${artifact}: ${missing.join(', ')}`)
  }
  return result(ITEMS.approval, 'ok', `all ${expected.length} expected button labels present: ${expected.join(', ')}`)
}

/** Item 3: every slot this repository registers must still exist in the official directory. */
function checkSlots(repoRoot, root) {
  const artifact = firstExisting([
    join(root, 'dsh-cordis-client-runner', 'lib', 'client.js'),
    join(root, 'dsh-client-ui-conversation', 'lib', 'client.js'),
  ])
  let registered
  try {
    registered = registeredSlots(readText(join(repoRoot, 'src', 'client', 'index.ts')))
  } catch (error) {
    return result(ITEMS.slots, 'FAIL', `src/client/index.ts is unreadable: ${error.message}`)
  }
  if (registered.length === 0) {
    return result(ITEMS.slots, 'WARN', 'no slot names were found in src/client/index.ts; the registration form may have changed')
  }
  if (artifact === undefined) {
    return result(ITEMS.slots, 'WARN', 'no official slot directory bundle was found')
  }
  const directory = new Set(officialSlots(readText(artifact)))
  if (directory.size === 0) {
    return result(ITEMS.slots, 'WARN', `no slot names could be parsed from ${artifact}`)
  }
  const missing = registered.filter(name => !directory.has(name))
  if (missing.length > 0) {
    return result(ITEMS.slots, 'FAIL', `registered slots absent from the official directory: ${missing.join(', ')}`)
  }
  return result(ITEMS.slots, 'ok', `all ${registered.length} registered slots present in a directory of ${directory.size}: ${registered.join(', ')}`)
}

/**
 * Item 4: each permission tier label must still intersect the official preset
 * wording. Three tiers are named by the official client dictionaries; the
 * `auto` tier is a preset the deployment adds, so its wording is read from the
 * installed patch layer and from this repository's own patch layer.
 */
function checkPermissionPresets(repoRoot, root) {
  const source = firstExisting([join(root, 'dsh-client-ui-permission-presets', 'lib', 'client.js')])
  let tiers
  try {
    tiers = literalObjectOfArrays(readText(join(repoRoot, 'src', 'client', 'auto-icon.ts')), 'PERMISSION_LABEL_SETS')
  } catch (error) {
    return result(ITEMS.presets, 'FAIL', `src/client/auto-icon.ts is unreadable: ${error.message}`)
  }
  if (tiers === undefined) {
    return result(ITEMS.presets, 'FAIL', 'PERMISSION_LABEL_SETS could not be parsed from src/client/auto-icon.ts')
  }
  if (source === undefined) {
    return result(ITEMS.presets, 'WARN', 'no official permission preset client bundle was found')
  }
  const labels = officialLabels(readText(source))
  const presetIds = new Set()
  const serverFile = join(root, 'dsh-permission-presets', 'lib', 'index.js')
  if (existsSync(serverFile)) for (const id of officialPresetIds(readText(serverFile))) presetIds.add(id)
  const patchFiles = [join(root, 'dsh-base', 'cordis.patch.yml'), join(repoRoot, 'cordis.patch.yml')].filter(file => existsSync(file))
  const configured = new Set()
  for (const file of patchFiles) for (const name of configuredPresetNames(readText(file))) configured.add(name)
  if (labels.size === 0 && configured.size === 0) {
    return result(ITEMS.presets, 'WARN', `no preset wording could be parsed from ${source}`)
  }
  const unmatched = []
  const matched = []
  for (const [tier, variants] of tiers) {
    if (variants.some(variant => labels.has(variant) || configured.has(variant))) matched.push(tier)
    else unmatched.push(tier)
  }
  if (unmatched.length > 0) {
    const detail = unmatched
      .map(tier => `${tier} (wants ${tiers.get(tier).map(variant => JSON.stringify(variant)).join(' or ')})`)
      .join('; ')
    return result(ITEMS.presets, 'FAIL', `no official wording matches: ${detail}`)
  }
  return result(
    ITEMS.presets,
    'ok',
    `${matched.length}/${tiers.size} tiers matched preset wording (${labels.size} client labels, ${configured.size} patch names; ${presetIds.size} official preset ids present)`,
  )
}

export function runChecks(repoRoot, root) {
  const checks = [
    () => checkSeedModules(repoRoot, root),
    () => checkApprovalLabels(repoRoot, root),
    () => checkSlots(repoRoot, root),
    () => checkPermissionPresets(repoRoot, root),
  ]
  const results = []
  for (const check of checks) {
    try {
      results.push(check())
    } catch (error) {
      results.push(result('unknown', 'FAIL', error instanceof Error ? error.message : String(error)))
    }
  }
  return { results }
}

function repoRootFromEnvironment() {
  const override = process.env.DSA_ANCHOR_REPO_ROOT
  return override !== undefined && override.trim() !== '' ? resolve(override.trim()) : DEFAULT_REPO_ROOT
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }
  const unknown = argv.filter(argument => argument !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`check-official-anchors: unknown argument ${unknown[0]}\n`)
    return 1
  }
  const repoRoot = repoRootFromEnvironment()
  const root = resolveOfficialRoot(repoRoot)
  if (root === undefined) {
    process.stdout.write(`${SKIP_MESSAGE}\n`)
    return 0
  }
  process.stdout.write(`check-official-anchors: reading official packages from ${root}\n`)
  const { results } = runChecks(repoRoot, root)
  let failed = 0
  for (const entry of results) {
    if (entry.status === 'FAIL') failed += 1
    process.stdout.write(`check-official-anchors: ${entry.status}  ${entry.name}  ${entry.detail}\n`)
  }
  if (failed > 0) {
    process.stdout.write(`check-official-anchors: FAIL ${failed} item(s)\n`)
    return 1
  }
  process.stdout.write('check-official-anchors: ok\n')
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}
