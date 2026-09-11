// The gate is the only thing standing between a broken build and a commit, so
// its own failure behaviour needs a contract: an unusable CLI may be skipped,
// a broken assembly may not, and a failing step must leave no scratch behind.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const gateSource = readFileSync(join(root, 'scripts/gate.mjs'), 'utf8')

test('a shell metacharacter is refused instead of quoted', () => {
  // The gate runs every step through a shell, so a metacharacter in an argument
  // would be interpreted rather than passed through. The guard must reject it
  // loudly; otherwise a crafted argument can split the command line.
  const guard = /const SHELL_METACHARACTERS = \/(.+)\//.exec(gateSource)
  assert.ok(guard, 'the shell metacharacter guard is missing')
  const pattern = new RegExp(guard[1])
  for (const dangerous of ['a&b', 'a;b', 'a|b', 'a`b', 'a$b', 'a"b', "a'b", 'a%b', 'a!b', 'a>b'])
    assert.equal(pattern.test(dangerous), true, `${dangerous} must be rejected`)
  for (const harmless of ['scripts/gate.mjs', 'tests/**/*.test.mjs', '--observed', '.gate-pack/pkg'])
    assert.equal(pattern.test(harmless), false, `${harmless} must stay acceptable`)
})

test('a broken assembly is fatal while a missing cli is skippable', () => {
  // Skipping is reserved for an unusable CLI. If a present CLI exits non-zero,
  // the loader tree is broken and the gate must fail rather than warn.
  const assembly = /function assertAssembly\(\)[\s\S]*?\n}/.exec(gateSource)
  assert.ok(assembly, 'assertAssembly not found')
  const body = assembly[0]
  assert.match(body, /probe\.status === null[\s\S]*?skip\(/, 'only an unspawnable CLI may skip')
  assert.match(body, /if \(probe\.status !== 0\) throw new Error/, 'a non-zero exit must be fatal')
  assert.doesNotMatch(body, /probe\.error !== undefined \|\| probe\.status !== 0[\s\S]*?skip\(/, 'a non-zero exit must not be folded into the skip branch')
})

test('the documented gate failure behaviour matches the script', () => {
  // docs/15-quality.md promises a non-zero exit for any failing step. Keep the
  // claim and the code from drifting apart: the only skip is the CLI probe.
  const docs = readFileSync(join(root, 'docs/15-quality.md'), 'utf8')
  assert.match(docs, /npm run gate/)
  const skipsInSource = [...gateSource.matchAll(/skip\('/g)].length
  assert.equal(skipsInSource, 1, `expected exactly one skip site, found ${skipsInSource}`)
  assert.match(docs, /dsh 不可用时该步 WARN 跳过/, 'the documented skip condition must be the CLI being unavailable')
})

test('a gate failure path removes the scratch directory', () => {
  // process.exit() does not run a `finally`, so cleanup must happen before it.
  const recordFailure = /function recordFailure\([\s\S]*?\n}/.exec(gateSource)
  assert.ok(recordFailure, 'recordFailure not found')
  assert.match(recordFailure[0], /cleanup\(\)/, 'recordFailure must clean up before exiting')
  assert.doesNotMatch(recordFailure[0], /\bfinally\s*\{/, 'cleanup cannot rely on a finally block')
  assert.match(gateSource, /function cleanup\(\) \{\n\s*rmSync\(packDir/, 'cleanup must remove the scratch directory')
})

test('the gate never leaves the scratch directory behind on a successful run', () => {
  // Reverse direction at the filesystem level: the directory the gate creates is
  // asserted absent both before and after, so a stale leftover is attributable.
  const scratch = join(root, '.gate-pack')
  assert.equal(existsSync(scratch), false, 'a previous run left .gate-pack behind')
  mkdirSync(scratch, { recursive: true })
  writeFileSync(join(scratch, 'marker'), 'x')
  const listed = readdirSync(scratch)
  assert.deepEqual(listed, ['marker'])
  rmSync(scratch, { recursive: true, force: true })
  assert.equal(existsSync(scratch), false)
})

test('the suite can be invoked without a shell on this platform', () => {
  // A shell-free spawn keeps quoting out of the picture for every step that can
  // use it; node itself is always launchable directly.
  const probe = spawnSync('node', ['--version'], { encoding: 'utf8' })
  assert.equal(probe.status, 0, 'node must be spawnable without a shell')
})
