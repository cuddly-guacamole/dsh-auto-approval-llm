/**
 * Shell commands must get the same realpath re-check every structured reader gets.
 *
 * `bash` / `pwsh` were absent from `symlinkGuardTargets`, so a shell command had
 * NO escape re-check at all: with a workspace junction pointing at a credential
 * tree, `cat ext/id_rsa` was statically allowed with no panel, no classifier and
 * no countdown, while `read` of the same path was hard-denied. The official host
 * resolves nothing by itself (it asks the registered guard), so the omission was
 * the whole guard surface for the shell vector — the widest reader there is.
 *
 * The verdict for shell is deliberately NARROWER than for the structured tools:
 * relocating the decision only when the realpath leaves the workspace/trusted
 * zone AND lands on a credential tree, DSH_HOME, or plugin runtime state. The
 * alternative — aligning shell with `read` outright — would hard-deny every
 * ordinary read through a junction, and this repository links its own
 * `node_modules` that way. Both halves of that trade are pinned here: the
 * credential/system/state cases deny, and a junction onto a plain external
 * location keeps its current aggressive behaviour.
 *
 * The narrowed verdict applies in BOTH position modes, so one settings key
 * cannot decide whether an absolute spelling of a protected path is guarded.
 *
 * Run: node --test tests/audit-shell-symlink-guard.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDeepest, symlinkEscapeReason } from '../lib/auto/symlink.js'
import { shellGuardTargets } from '../lib/auto/shell.js'

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

const rootsOf = (workspace, home, mode = 'aggressive', allowedDshSubpaths = []) => ({
  workspace, home, dshHome: join(home, '.dsh'), allowedDshSubpaths, trustedDirs: [], mode,
})

const bash = (command) => ({ name: 'bash', arguments: { command } })
const pwsh = (command) => ({ name: 'pwsh', arguments: { command } })

/**
 * A workspace plus the three landing shapes that matter: a plain external
 * directory, a credential tree (`~/.ssh`, which `isCriticalPath` recognises via
 * the home root), and the plugin's DSH_HOME state directory.
 */
function sandbox(body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsa-shell-guard-')))
  const ws = join(root, 'ws')
  const external = join(root, 'external')
  const creds = join(root, '.ssh')
  const stateDir = join(root, '.dsh', 'auto-approval-llm')
  mkdirSync(ws)
  mkdirSync(external)
  mkdirSync(creds)
  mkdirSync(stateDir, { recursive: true })
  try {
    return body({ root, ws, external, creds, stateDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── the operand extraction (the actual regression) ─────────────────────────

test('guard targets: a BARE relative shell operand is extracted, not dropped', () => {
  const roots = rootsOf('C:/ws', 'C:/Users/u')
  // The whole point: `ext/id_rsa` carries no leading `/`, `.` or `~`, so the
  // existing explicit-path filter used to discard it and the guard saw nothing.
  assert.deepEqual(shellGuardTargets('cat ext/id_rsa', 'bash', roots), ['c:\\ws\\ext\\id_rsa'])
  // Every equivalent spelling of the same read, including the pwsh separator.
  assert.deepEqual(shellGuardTargets('cat ./ext/id_rsa', 'bash', roots), ['c:\\ws\\ext\\id_rsa'])
  assert.deepEqual(shellGuardTargets('Get-Content ext\\id_rsa', 'pwsh', roots), ['c:\\ws\\ext\\id_rsa'])
  // A relative operand after a changer resolves against the directory the
  // segment really sees, not against the workspace.
  assert.deepEqual(
    shellGuardTargets('cd C:/Users/u/.ssh && cat id_rsa', 'bash', roots),
    ['c:\\users\\u\\.ssh', 'c:\\users\\u\\.ssh\\id_rsa'],
  )
})

test('guard targets: every equivalent spelling of the same read is covered', () => {
  const roots = rootsOf('C:/ws', 'C:/Users/u')
  const expected = ['c:\\users\\u\\.ssh\\id_rsa']
  // Quoted and forward-slash forms survive the bash lexer, pwsh never escapes
  // backslashes, and the RAW scan covers the one family that does not: an
  // unquoted backslash path in bash, which the lexer reduces to
  // `C:Usersu.sshid_rsa` and which therefore used to vanish from the list.
  for (const [shell, command] of [
    ['bash', 'cat "C:\\Users\\u\\.ssh\\id_rsa"'],
    ['bash', "cat 'C:\\Users\\u\\.ssh\\id_rsa'"],
    ['bash', 'cat C:/Users/u/.ssh/id_rsa'],
    ['bash', 'cat C:\\Users\\u\\.ssh\\id_rsa'],
    ['pwsh', 'Get-Content C:\\Users\\u\\.ssh\\id_rsa'],
  ]) {
    const targets = shellGuardTargets(command, shell, roots)
    assert.ok(
      targets !== undefined && targets.includes(expected[0]),
      `${shell} ${command} -> ${JSON.stringify(targets)}`,
    )
  }
})

test('guard targets: a line that cannot be decomposed statically abstains', () => {
  const roots = rootsOf('C:/ws', 'C:/Users/u')
  // Guessing operands on an opaque line would turn the guard into a source of
  // false denials, so it keeps exactly the behaviour it had before this change.
  assert.equal(shellGuardTargets('printf x > package.json; (:)', 'bash', roots), undefined)
  assert.equal(shellGuardTargets('echo $(whoami)', 'bash', roots), undefined)
  assert.equal(shellGuardTargets('cat <<EOF\nhi\nEOF', 'bash', roots), undefined)
  assert.equal(shellGuardTargets('', 'bash', roots), undefined)
})

// ── the verdict ────────────────────────────────────────────────────────────

test('guard: a shell read through a workspace link into a credential tree is refused', () => {
  sandbox(({ ws, creds }) => {
    writeFileSync(join(creds, 'id_rsa'), 'private')
    const link = join(ws, 'ext')
    symlinkSync(creds, link, LINK_TYPE)
    for (const exec of [bash('cat ext/id_rsa'), bash('cat ./ext/id_rsa'), pwsh('Get-Content ext\\id_rsa')]) {
      const reason = symlinkEscapeReason(exec, rootsOf(ws, ws.replace(/[\\/]ws$/, '')), resolveDeepest)
      assert.match(reason ?? '', /protected location/, `expected a refusal for ${JSON.stringify(exec.arguments)}`)
    }
  })
})

test('guard: a relative read after `cd` into a credential tree is refused', () => {
  sandbox(({ ws, root, creds }) => {
    writeFileSync(join(creds, 'id_rsa'), 'private')
    const reason = symlinkEscapeReason(bash(`cd ${creds} && cat id_rsa`), rootsOf(ws, root), resolveDeepest)
    assert.match(reason ?? '', /protected location/)
  })
})

test('guard: reading the plugin runtime state through the shell is refused', () => {
  sandbox(({ ws, root, stateDir }) => {
    const audit = join(stateDir, 'audit.jsonl')
    writeFileSync(audit, '{}\n')
    // The DSH_HOME clause covers it...
    const viaDshHome = symlinkEscapeReason(bash(`cat ${audit}`, 'bash'), rootsOf(ws, root), resolveDeepest)
    assert.match(viaDshHome ?? '', /protected location/)
    // ...and the runtime-state clause covers it independently, for a state
    // directory configured inside an allowed subpath with no link involved.
    const inside = join(ws, 'history.jsonl')
    writeFileSync(inside, '{}\n')
    const viaRuntimeState = symlinkEscapeReason(
      bash(`cat ${inside}`), rootsOf(ws, root, 'aggressive', [ws]), resolveDeepest,
    )
    assert.match(viaRuntimeState ?? '', /runtime state/)
  })
})

test('guard: the narrowed verdict does not depend on the position mode', () => {
  sandbox(({ ws, root, creds }) => {
    writeFileSync(join(creds, 'id_rsa'), 'private')
    const link = join(ws, 'ext')
    symlinkSync(creds, link, LINK_TYPE)
    for (const mode of ['aggressive', 'standard']) {
      const reason = symlinkEscapeReason(bash('cat ext/id_rsa'), rootsOf(ws, root, mode), resolveDeepest)
      assert.match(reason ?? '', /protected location/, `${mode} must refuse the credential read`)
    }
  })
})

test('guard: the resolver really ran on the shell target (the control is not vacuous)', () => {
  sandbox(({ ws, root }) => {
    writeFileSync(join(ws, 'plain.txt'), 'x')
    let calls = 0
    const seen = []
    const counting = (p) => { calls += 1; seen.push(p); return resolveDeepest(p) }
    assert.equal(symlinkEscapeReason(bash('cat plain.txt'), rootsOf(ws, root), counting), undefined)
    // The guard resolves the workspace root AND the target; a bare `calls > 0`
    // would be satisfied by the workspace resolution alone, so require the
    // target itself to have been resolved.
    assert.ok(calls >= 2, `expected the workspace and the target to be resolved, got ${calls}`)
    assert.ok(seen.some((p) => p.includes('plain.txt')), `resolved: ${seen.join(', ')}`)
  })
})

// ── the negative direction: what must NOT be swept in ──────────────────────

test('guard: an ordinary in-workspace shell read is untouched', () => {
  sandbox(({ ws, root }) => {
    writeFileSync(join(ws, 'package.json'), '{}')
    const exec = bash('cat package.json')
    assert.equal(symlinkEscapeReason(exec, rootsOf(ws, root), resolveDeepest), undefined)
    for (const command of ['npm test', 'npx tsc -p tsconfig.json --noEmit', 'git status --porcelain']) {
      assert.equal(symlinkEscapeReason(bash(command), rootsOf(ws, root), resolveDeepest), undefined, command)
    }
  })
})

test('guard: a junction onto a plain external location keeps its current behaviour', () => {
  sandbox(({ ws, root, external, stateDir }) => {
    // This repository links `node_modules` to locations outside the workspace.
    // Aligning shell with the structured readers outright would hard-deny these
    // under the standard preset; the narrowed verdict must not.
    mkdirSync(join(external, 'pkg'), { recursive: true })
    writeFileSync(join(external, 'pkg', 'index.js'), 'x')
    symlinkSync(external, join(ws, 'node_modules'), LINK_TYPE)
    const command = 'cat node_modules/pkg/index.js'
    for (const mode of ['aggressive', 'standard']) {
      assert.equal(symlinkEscapeReason(bash(command), rootsOf(ws, root, mode), resolveDeepest), undefined, mode)
    }
    // The plain external destination of a write stays open too.
    assert.equal(symlinkEscapeReason(bash('printf a > f1.txt'), rootsOf(ws, root), resolveDeepest), undefined)
    // The state directory is not touched just because it exists.
    assert.ok(stateDir.endsWith(join('.dsh', 'auto-approval-llm')))
  })
})

test('guard: a trusted DSH subpath outside the workspace is not swept in by the DSH_HOME clause', () => {
  sandbox(({ ws, root }) => {
    // The multi-workspace shape this repository has been bitten by before: the
    // session's workspace is one plugin, and another plugin's development zone
    // is opened through `allowedDshSubpaths` (both under DSH_HOME). Reading a
    // plain file there must stay allowed — the DSH_HOME clause applies to an
    // ESCAPE, and a trusted zone is not one.
    const trusted = join(root, '.dsh', 'plugins', 'other-plugin')
    mkdirSync(trusted, { recursive: true })
    writeFileSync(join(trusted, 'notes.txt'), 'x')
    const roots = rootsOf(ws, root, 'aggressive', [trusted])
    assert.equal(symlinkEscapeReason(bash(`cat ${join(trusted, 'notes.txt')}`), roots, resolveDeepest), undefined)
    // Control kept honest: the same resolver DOES deny a protected path, so the
    // assertion above is not passing because the guard looked at nothing.
    assert.match(
      symlinkEscapeReason(bash(`cat ${join(root, '.ssh', 'id_rsa')}`), roots, resolveDeepest) ?? '',
      /protected location/,
    )
  })
})

test('guard: an external shell target that is not protected stays open', () => {
  sandbox(({ ws, root }) => {
    // The position/zone rule is not widened into "every external path denies".
    assert.equal(symlinkEscapeReason(bash('cat C:/elsewhere/notes.txt'), rootsOf(ws, root), resolveDeepest), undefined)
  })
})

test('guard: a non-shell tool keeps its own target extraction', () => {
  sandbox(({ ws, root }) => {
    writeFileSync(join(ws, 'a.ts'), 'x')
    assert.equal(symlinkEscapeReason({ name: 'read', arguments: { file_path: join(ws, 'a.ts') } }, rootsOf(ws, root), resolveDeepest), undefined)
    // A shell tool without a string command carries no operand.
    assert.equal(symlinkEscapeReason({ name: 'bash', arguments: {} }, rootsOf(ws, root), resolveDeepest), undefined)
    assert.equal(symlinkEscapeReason({ name: 'bash', arguments: { command: 42 } }, rootsOf(ws, root), resolveDeepest), undefined)
  })
})
