// Contract for what actually ships: npm pack must contain exactly the files the
// runtime needs, no source-map payload, and no build output left behind by a
// source file that no longer exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The npm invocation used for the pack, derived from the running interpreter.
 *
 * The interpreter owns its npm: `npm-cli.js` sits at
 * `<dirname(process.execPath)>/node_modules/npm/bin/`, and running it through
 * `process.execPath` needs neither a shell nor a PATH lookup, so the copy that
 * runs does not depend on PATH order. When that file is absent the invocation
 * falls back to `npm` from PATH, keeping `shell: true` because on Windows `npm`
 * is a `.cmd` shim that only a shell can execute.
 *
 * The strategy and the resolved path are returned with the argv so a test can
 * assert which npm ran.
 */
function resolveNpm() {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    return { command: process.execPath, prefixArgs: [npmCli], strategy: 'interpreter', npmCli, shell: false }
  }
  return { command: 'npm', prefixArgs: [], strategy: 'path', npmCli: null, shell: process.platform === 'win32' }
}

const npmRun = resolveNpm()

// Anything npm adds implicitly (README.md, LICENSE, package.json) is listed here
// as well so the whitelist is the single statement of the shipped surface.
const SHIPPED_PATTERN =
  /^(lib\/index\.js|lib\/auto\/[^/]+\.js|lib\/client\.js|lib\/types\/.*\.d\.ts|cordis\.patch\.yml|locale\/en\.json|locale\/zh\.json|README\.md|README\.en\.md|LICENSE|package\.json)$/

function packManifest() {
  const res = spawnSync(npmRun.command, [...npmRun.prefixArgs, 'pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', shell: npmRun.shell })
  assert.equal(res.status, 0, `npm pack --dry-run failed: ${res.stderr}`)
  const parsed = JSON.parse(res.stdout)
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  return entry.files.map(file => file.path.split(sep).join('/'))
}

function listFiles(dir, predicate = () => true) {
  const out = []
  if (!existsSync(dir)) return out
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (predicate(full)) out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return out
}

const manifest = packManifest()

test('the pack runs under an npm resolved from this interpreter', t => {
  // The PATH form is accepted only when this interpreter ships no npm of its own.
  assert.ok(['interpreter', 'path'].includes(npmRun.strategy), `unknown npm strategy ${npmRun.strategy}`)
  t.diagnostic(`npm strategy=${npmRun.strategy} command=${npmRun.command} shell=${npmRun.shell}`)
  if (npmRun.strategy === 'interpreter') {
    assert.equal(existsSync(npmRun.npmCli), true, 'the resolved npm-cli.js must exist')
    const owned = relative(dirname(process.execPath), npmRun.npmCli)
    assert.equal(owned.startsWith('..'), false, `npm must belong to this interpreter: ${npmRun.npmCli}`)
    // The interpreter's own layout, not a copy nested under some other package.
    assert.equal(npmRun.npmCli, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  } else {
    assert.equal(existsSync(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')), false,
      'the PATH fallback was taken while the interpreter still ships an npm')
  }
  // The pack is a real invocation, not a stub: npm reported a non-empty manifest,
  // so the assertions below are made against real output.
  assert.ok(manifest.length > 0, 'npm pack --dry-run reported no files')
})

test('the tarball ships no source maps', () => {
  const maps = manifest.filter(path => path.endsWith('.map'))
  assert.deepEqual(maps, [], `source maps must not ship, found ${maps.length}`)
})

test('every shipped path matches the whitelist', () => {
  const unexpected = manifest.filter(path => !SHIPPED_PATTERN.test(path))
  assert.deepEqual(unexpected, [], 'unexpected entries in the tarball')
})

test('the runtime entries are present', () => {
  for (const required of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/types/client/index.d.ts', 'cordis.patch.yml', 'package.json']) {
    assert.ok(manifest.includes(required), `${required} must ship`)
  }
})

test('every host module that exists in src ships its compiled counterpart', () => {
  // Compared as sets, not as counts: a renamed module and a stale build output
  // leave the total unchanged while the tarball mirrors the wrong tree.
  const expected = readdirSync(join(root, 'src/auto'))
    .filter(name => name.endsWith('.ts'))
    .map(name => `lib/auto/${name.replace(/\.ts$/, '.js')}`)
    .sort()
  const shipped = manifest.filter(path => /^lib\/auto\/[^/]+\.js$/.test(path)).sort()
  assert.ok(expected.length > 0, 'src/auto must not be empty')
  assert.deepEqual(shipped, expected, 'lib/auto must mirror src/auto one to one, with no orphan')
})

test('no declaration ships for a source file that no longer exists', () => {
  const orphans = listFiles(join(root, 'lib/types'), file => file.endsWith('.d.ts'))
    .map(path => path.replace(/\.d\.ts$/, '.ts'))
    .filter(path => !existsSync(join(root, 'src', path)))
  assert.deepEqual(orphans, [], 'declaration files without a source file')
})

test('build output outside the shipped layout never reaches the tarball', () => {
  const leaked = manifest.filter(path => /^lib\/.*\.js$/.test(path) && !/^(lib\/index\.js|lib\/auto\/[^/]+\.js|lib\/client\.js)$/.test(path))
  assert.deepEqual(leaked, [], 'compiled client modules must not ship; the bundle is the only client entry')
})

test('the pruned layout does not depend on files the tarball drops', () => {
  // lib/client/*.js are tsc output for the client sources; the shipped client is
  // the tsdown bundle lib/client.js. Assert the bundle is self-contained so the
  // dropped directory is provably unreachable at runtime.
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const local = [...bundle.matchAll(/require\(\s*['"](\.[^'"]*)['"]\s*\)/g)].map(match => match[1])
  assert.deepEqual(local, [], 'the client bundle must not require a relative module')
})

test('the files field states the shipped surface instead of a directory', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.files, ['lib/index.js', 'lib/auto/*.js', 'lib/client.js', 'lib/types/**/*.d.ts', 'cordis.patch.yml', 'locale'])
})
