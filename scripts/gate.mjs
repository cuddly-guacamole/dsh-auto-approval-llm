#!/usr/bin/env node
// Local release gate. Every step runs against the artifacts a user would
// receive, not against the checkout: the suite runs on freshly built output and
// the last steps install the packed tarball into a scratch directory and load
// it the way dsh loads it.
//
// Note for a live development session: the first step removes lib/ and the
// build steps recreate it. The window is short, but a running dsh that links
// this checkout reads those files, so avoid running the gate while an approval
// panel is open.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packDir = join(root, '.gate-pack')

const steps = []
let skipped = 0

/**
 * The npm entry point is a `.cmd` shim on Windows, which could not be spawned
 * without a shell (Node refuses `.cmd` without one), so every step runs through
 * a shell. That makes argument quoting the only injection surface, and quoting
 * is hard to get right: reject anything that a shell could read as syntax
 * instead of trying to escape it. Every argument this script builds is a fixed
 * literal or a path derived from the package name, so a rejection means a real
 * mistake rather than a legitimate input.
 */
const SHELL_METACHARACTERS = /[&^%()!;<>|`$'"\r\n]/
function shellArgument(argument) {
  if (SHELL_METACHARACTERS.test(argument))
    throw new Error(`refusing to pass a shell metacharacter through the gate: ${JSON.stringify(argument)}`)
  return /\s/.test(argument) ? `"${argument}"` : argument
}

/** Remove the scratch directory, including on a failure path. */
function cleanup() {
  rmSync(packDir, { recursive: true, force: true })
}

function run(label, command, args, options = {}) {
  const started = Date.now()
  const line = [command, ...args].map(shellArgument).join(' ')
  const result = spawnSync(line, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    ...(options.capture ? {} : { stdio: 'inherit' }),
  })
  const duration = Date.now() - started
  const ok = result.status === 0
  if (options.capture && !options.quiet) {
    process.stdout.write(result.stdout ?? '')
    if (result.stderr) process.stderr.write(result.stderr)
  }
  if (!ok) {
    cleanup()
    steps.push({ label, ok: false, duration, skipped: false })
    console.error(`gate: FAIL at "${label}" (exit ${result.status}, ${duration}ms)`)
    summarize()
    process.exit(1)
  }
  steps.push({ label, ok: true, duration, skipped: false })
  return result
}

function skip(label, reason) {
  skipped += 1
  steps.push({ label, ok: true, duration: 0, skipped: true })
  console.warn(`gate: WARN skipping "${label}": ${reason}`)
}

function summarize() {
  const failed = steps.filter(step => !step.ok).length
  const done = steps.filter(step => step.ok && !step.skipped).length
  console.log(`gate: pass ${done} steps / fail ${failed} / skipped ${skipped}`)
}

function loadTarball() {
  rmSync(packDir, { recursive: true, force: true })
  mkdirSync(packDir, { recursive: true })

  const packed = run('pack the tarball', 'npm', ['pack', '--json', '--pack-destination', packDir], { capture: true, quiet: true })
  const meta = JSON.parse(packed.stdout)
  const archive = (Array.isArray(meta) ? meta[0] : Object.values(meta)[0]).filename
  const tarball = join(packDir, archive)
  if (!existsSync(tarball)) throw new Error(`npm pack reported ${archive} but it does not exist`)
  process.stdout.write(`gate: packed ${archive}\n`)

  const extractDir = join(packDir, 'pkg')
  mkdirSync(extractDir, { recursive: true })
  // Relative paths on purpose: tar reads a drive-letter archive argument as a
  // remote host specification.
  run('extract the tarball', 'tar', ['--force-local', '-xzf', join('.gate-pack', archive), '-C', join('.gate-pack', 'pkg')])
  const pkg = join(extractDir, 'package')
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
  if (manifest.name !== '@quill507/dsh-auto-approval-llm') throw new Error('unexpected package name in the tarball')
  return pkg
}

async function smokeHostEntry(pkg) {
  // Imported from inside the repository on purpose: the tarball carries no
  // node_modules, so peer dependencies come from the checkout. Loading the
  // packed copy is what proves the shipped files are complete.
  const loaded = await import(pathToFileURL(join(pkg, 'lib/index.js')).href)
  const plugin = loaded.default ?? loaded.plugin ?? loaded
  if (plugin === null || plugin === undefined) throw new Error('the host entry exported nothing')
  if (typeof plugin.apply !== 'function') throw new Error('the host entry has no apply()')
  if (typeof plugin.name !== 'string') throw new Error('the host entry has no name')
  process.stdout.write(`gate: host entry loaded as ${plugin.name}\n`)
}

function smokeClientBundle(pkg) {
  const require = createRequire(join(pkg, 'lib/client.js'))
  const calls = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: registration => calls.push(registration) } }
  try {
    require(join(pkg, 'lib/client.js'))
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  const registration = calls[0]
  if (registration === undefined) throw new Error('the client bundle registered nothing with __ModuleLoader__')
  if (registration.id !== '@quill507/dsh-auto-approval-llm') throw new Error(`the client bundle registered as ${registration.id}`)
  if (typeof registration.factory !== 'function') throw new Error('the client bundle registered a non-function factory')
  process.stdout.write(`gate: client bundle registered ${registration.id}\n`)
}

function checkPatch(pkg) {
  const patch = readFileSync(join(pkg, 'cordis.patch.yml'), 'utf8')
  const meaningful = patch.split('\n').map(line => line.replace(/#.*$/, '')).filter(line => line.trim() !== '')
  if (!meaningful[0]?.trimStart().startsWith('- ')) throw new Error('cordis.patch.yml does not start with a top-level array')
  if (!/^- insert:/m.test(patch)) throw new Error('cordis.patch.yml declares no entry of its own')
  process.stdout.write('gate: cordis.patch.yml is a top-level array with an insert entry\n')
}

function assertAssembly() {
  const probe = spawnSync('dsh --profile web --dump-config', { cwd: root, encoding: 'utf8', shell: true, timeout: 300000 })
  // Only a missing CLI is a reason to skip. A CLI that exists but refuses to
  // dump its config means the assembly is broken — the exact condition this
  // step exists to catch — so any other failure stays fatal.
  if (probe.error !== undefined || probe.status === null) {
    skip('assert the assembly', probe.error?.message ?? 'the dsh CLI could not be spawned')
    return
  }
  if (probe.status !== 0) throw new Error(`dsh --profile web --dump-config exited ${probe.status}: ${(probe.stderr ?? '').trim().slice(0, 400)}`)
  const output = probe.stdout ?? ''
  for (const expected of ['- id: auto-approval-llm', "name: '@quill507/dsh-auto-approval-llm'"]) {
    if (!output.includes(expected)) throw new Error(`the loader tree does not contain ${expected}`)
  }
  process.stdout.write('gate: the loader tree contains the plugin entry\n')
}

run('clean stale build output', 'node', ['scripts/clean-lib.mjs'])
run('typecheck', 'npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'])
run('build the host', 'npx', ['tsc', '-p', 'tsconfig.json'])
run('build the client bundle', 'npx', ['tsdown'])

// The suite is the authority on how many cases ran: capture its TAP output, then
// hand the observed numbers to the document checker so the published counts
// cannot disagree with a real run.
const suite = run('contract tests', 'node', ['--test', '--test-reporter=tap', 'tests/**/*.test.mjs'], { capture: true })
const count = (text, key) => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN)
const observed = { tests: count(suite.stdout, 'tests'), pass: count(suite.stdout, 'pass'), fail: count(suite.stdout, 'fail') }
if (Number.isNaN(observed.tests) || Number.isNaN(observed.pass) || Number.isNaN(observed.fail))
  throw new Error('could not read the TAP summary')
if (observed.fail !== 0) throw new Error(`the suite reported ${observed.fail} failures`)
process.stdout.write(`gate: suite reported ${observed.pass}/${observed.tests}\n`)

run('the packed tarball is complete', 'node', ['--test', 'tests/pack-contents.test.mjs'])
run('the documented counts match', 'node', ['scripts/check-doc-numbers.mjs', '--observed', String(observed.tests), '--observed-pass', String(observed.pass)])
run('the documentation anchors resolve', 'node', ['scripts/check-anchors.mjs'])

function recordFailure(label, error) {
  // Called from a catch, so clean up here rather than in a `finally`: leaving
  // the process through process.exit() would skip that block.
  cleanup()
  steps.push({ label, ok: false, duration: 0, skipped: false })
  console.error(`gate: FAIL at "${label}": ${error instanceof Error ? error.message : String(error)}`)
  summarize()
  process.exit(1)
}

let pkg
try {
  pkg = loadTarball()
} catch (error) {
  recordFailure('pack and extract the tarball', error)
}
try {
  await smokeHostEntry(pkg)
  smokeClientBundle(pkg)
  checkPatch(pkg)
} catch (error) {
  recordFailure('load the packed artifact', error)
}
cleanup()
assertAssembly()

summarize()
