// The gate is the only thing standing between a broken build and a commit, so
// its own decisions need a contract. These tests call the exported verdict
// functions instead of matching the script's source text: a regex over source
// proves the words are there, not that the step behaves.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHELL_METACHARACTERS, assemblyVerdict, cleanup, composedPresetBlocks, docsBuildVerdict, installSignalCleanup, shellArgument } from '../scripts/gate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const ENTRY = [
  "- id: auto-approval-llm",
  "  name: '@quill507/dsh-auto-approval-llm'",
  '    presets:',
  '      auto-approval:',
  '        sandbox: danger-full-access',
  '        approval: ask',
].join('\n') + '\n'

test('a shell metacharacter is refused instead of quoted', () => {
  // Every step runs through a shell, so a metacharacter in an argument would be
  // interpreted rather than passed through. Refusing is the only safe answer.
  for (const dangerous of ['a&b', 'a;b', 'a|b', 'a`b', 'a$b', 'a"b', "a'b", 'a%b', 'a!b', 'a>b', 'a^b', 'a(b'])
    assert.equal(SHELL_METACHARACTERS.test(dangerous), true, `${dangerous} must be rejected`)
  for (const harmless of ['scripts/gate.mjs', 'tests/**/*.test.mjs', '--observed', '.gate-pack/pkg', 'quill507-dsh-auto-approval-llm-0.0.25.tgz'])
    assert.equal(SHELL_METACHARACTERS.test(harmless), false, `${harmless} must stay acceptable`)
})

test('a harmless argument is quoted only when it contains whitespace', () => {
  assert.equal(shellArgument('scripts/gate.mjs'), 'scripts/gate.mjs')
  assert.equal(shellArgument('tests/**/*.test.mjs'), 'tests/**/*.test.mjs')
  assert.equal(shellArgument('.gate-pack/pkg'), '.gate-pack/pkg')
  assert.equal(shellArgument('scripts/check-doc-numbers.mjs'), 'scripts/check-doc-numbers.mjs')
})

test('a metacharacter reaches the caller as an error, not as a command line', () => {
  assert.throws(() => shellArgument('a&b'), /metacharacter/)
  assert.throws(() => shellArgument('a b&c'), /metacharacter/)
})

test('an absent CLI is the only skippable assembly state', () => {
  assert.deepEqual(assemblyVerdict({ cliPresent: false, status: 1, error: undefined, stdout: '' }).kind, 'skip')
})

test('a hung dump-config is fatal rather than skipped', () => {
  // A dump-config that never returns means the assembly is unusable. Treating it
  // as "the tool is unavailable" would report a broken environment as a pass,
  // which is the opposite of what this step is for.
  const verdict = assemblyVerdict({ cliPresent: true, status: null, error: { code: 'ETIMEDOUT' }, stdout: '' })
  assert.equal(verdict.kind, 'fail')
  assert.match(verdict.reason, /timed out/)
})

test('a present but failing CLI is fatal', () => {
  const verdict = assemblyVerdict({ cliPresent: true, status: 1, error: undefined, stdout: '' })
  assert.equal(verdict.kind, 'fail')
  assert.match(verdict.reason, /exited 1/)
})

test('a CLI that cannot be run at all is fatal', () => {
  assert.equal(assemblyVerdict({ cliPresent: true, status: undefined, error: { code: 'EACCES' }, stdout: '' }).kind, 'fail')
  assert.equal(assemblyVerdict({ cliPresent: true, status: null, error: undefined, stdout: '' }).kind, 'fail')
})

test('a healthy assembly passes only when the loader tree carries the entry', () => {
  assert.equal(assemblyVerdict({ cliPresent: true, status: 0, error: undefined, stdout: ENTRY }).kind, 'ok')
  const missingId = assemblyVerdict({ cliPresent: true, status: 0, error: undefined, stdout: "name: '@quill507/dsh-auto-approval-llm'" })
  assert.equal(missingId.kind, 'fail')
  assert.match(missingId.reason, /id: auto-approval-llm/)
})

test('only an absent vitepress skips the docs build', () => {
  // The step exists to catch a page that does not build. Skipping when the
  // dependency IS present would turn that into a silent pass, so the two states
  // must not collapse into one.
  const absent = docsBuildVerdict({ vitepressPresent: false })
  assert.equal(absent.kind, 'skip')
  assert.match(absent.reason, /vitepress is not installed/)
  assert.equal(docsBuildVerdict({ vitepressPresent: true }).kind, 'run')
})

test('an interrupted run leaves no scratch directory behind', () => {
  // Calls the gate's own signal path with a fake target instead of signalling a
  // real process: the handler must remove the scratch directory before exiting.
  const scratch = join(root, '.gate-pack')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  assert.equal(existsSync(scratch), true)

  const handlers = new Map()
  let exitCode
  installSignalCleanup({
    on: (signal, handler) => handlers.set(signal, handler),
    exit: code => {
      exitCode = code
    },
  })
  assert.deepEqual([...handlers.keys()].sort(), ['SIGINT', 'SIGTERM'])
  handlers.get('SIGINT')()
  assert.equal(existsSync(scratch), false, 'the scratch directory must be gone')
  assert.equal(exitCode, 130)
  rmSync(scratch, { recursive: true, force: true })
})

test('cleanup removes a populated scratch directory', () => {
  const scratch = join(root, '.gate-pack')
  mkdirSync(join(scratch, 'pkg'), { recursive: true })
  writeFileSync(join(scratch, 'pkg', 'marker'), 'x')
  cleanup()
  assert.equal(existsSync(scratch), false)
})

test('the count checker fails a run whose observed numbers disagree', () => {
  // End-to-end failure path of a real gate step, without running the whole gate.
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-doc-numbers.mjs'), '--observed', '1', '--observed-pass', '1'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1, `expected a non-zero exit:\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /the run reported 1 tests/)
})

test('the count checker accepts a matching run', () => {
  // The same step must pass when the numbers agree, otherwise the failure above
  // could come from any complaint at all.
  const measured = spawnSync(process.execPath, [join(root, 'scripts/check-doc-numbers.mjs')], { cwd: root, encoding: 'utf8' })
  assert.equal(measured.status, 0, measured.stderr)
  const cases = Number(/(\d+) cases/.exec(measured.stdout)?.[1] ?? NaN)
  assert.ok(Number.isInteger(cases) && cases > 0, 'the checker must report a case count')
  const agreed = spawnSync(process.execPath, [join(root, 'scripts/check-doc-numbers.mjs'), '--observed', String(cases), '--observed-pass', String(cases)], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(agreed.status, 0, agreed.stderr)
})

test('the gate keeps its verdict logic outside main so it stays reachable', () => {
  // Refactor guard, not a behaviour check: if the decisions moved back inside
  // main(), the cases above would silently stop covering them. The behavioural
  // assertions are the ones above; this only notices the move.
  const source = readFileSync(join(root, 'scripts/gate.mjs'), 'utf8')
  assert.match(source, /export function assemblyVerdict/)
  assert.match(source, /export function shellArgument/)
})

test('composedPresetBlocks reads the preset keys of each presets: block', () => {
  const dump = [
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '      auto-approval:',
    '        approval: ask',
    '    other:',
    '      auto:',
  ].join('\n')
  assert.deepEqual(composedPresetBlocks(dump), [['read-only', 'auto-approval']])
  assert.deepEqual(composedPresetBlocks(''), [])
})

test('the composed permission table must carry auto-approval and must not define auto', () => {
  assert.equal(assemblyVerdict({ cliPresent: true, status: 0, error: undefined, stdout: ENTRY }).kind, 'ok')
  const withAuto = ENTRY.replace('      auto-approval:', '      auto-approval:\n      auto:')
  const standalone = assemblyVerdict({ cliPresent: true, status: 0, error: undefined, stdout: withAuto })
  assert.equal(standalone.kind, 'fail')
  assert.match(standalone.reason, /standalone auto preset/)
  const missing = assemblyVerdict({
    cliPresent: true,
    status: 0,
    error: undefined,
    stdout: "- id: auto-approval-llm\n  name: '@quill507/dsh-auto-approval-llm'\n",
  })
  assert.equal(missing.kind, 'fail')
  assert.match(missing.reason, /does not define the auto-approval preset/)
})
