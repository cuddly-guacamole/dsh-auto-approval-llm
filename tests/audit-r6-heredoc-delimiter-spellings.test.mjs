/**
 * Here-document delimiter spellings fed to an interpreter that reads its
 * program from stdin.
 *
 * A here-document delimiter may be bare (`<<EOF`), single-quoted (`<<'EOF'`),
 * double-quoted (`<<"EOF"`) or backslash-escaped (`<<\EOF`), and shell rules
 * make all four name the same document. The body-stripping owner
 * (`stripHeredocBodies`) already recognized the escaped spelling, but the
 * stdin-interpreter owner only accepted quotes, so `python3 <<\EOF … EOF`
 * stripped its body as data AND failed the interpreter test: an execution
 * shape whose program is invisible to the static engine fell back to the
 * classifier tier, which an unattended `timeoutAction: allow` settles by
 * running it.
 *
 * Pins the tier for every spelling (manual, no classifier) and keeps the
 * opposite direction: a body no interpreter runs stays a reviewable ask.
 *
 * Run: node --test tests/audit-r6-heredoc-delimiter-spellings.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: ['C:/ws'],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)

// The payload is deliberately inert: the tier must come from the SHAPE, not
// from a destructiveness word list.
const BODY = ['', 'import os', 'print(os.getcwd())', 'EOF', ''].join('\n')

const MANUAL_SPELLINGS = [
  "python3 <<'EOF'",
  'python3 <<EOF',
  'python3 <<"EOF"',
  'python3 <<-EOF',
  'python3 <<\\EOF',
  'python3 <<-\\EOF',
  'python3 - <<\\EOF',
  'node <<\\EOF',
  'ruby <<\\EOF',
  'perl <<\\EOF',
  'cat <<\\EOF | node',
  'cat <<\\EOF | python3',
]

test('every delimiter spelling of an interpreter here-document keeps the manual tier', () => {
  for (const prefix of MANUAL_SPELLINGS) {
    const verdict = shell(prefix + BODY)
    assert.equal(verdict.decision, 'ask', `${prefix}: expected ask, got ${verdict.decision} (${verdict.reason})`)
    assert.equal(verdict.classifierEligible, false, `${prefix}: must not be classifier-answerable`)
  }
})

test('the shell interpreter spelling stays refused on its own clause', () => {
  for (const prefix of ['bash <<\\EOF', 'sh -s <<\\EOF']) {
    const verdict = shell(prefix + BODY)
    assert.equal(verdict.decision, 'ask', prefix)
    assert.equal(verdict.classifierEligible, false, prefix)
  }
})

test('a here-document no interpreter runs stays reviewable, and a commit message stays ordinary', () => {
  const piped = shell('cat <<\\EOF' + BODY)
  assert.equal(piped.decision, 'ask', piped.reason)
  assert.equal(piped.classifierEligible, true, 'a data here-document must stay classifier-answerable')

  const commit = shell("git commit -m \"$(cat <<'EOF'\\nnote\\nEOF\\n)\"")
  assert.equal(commit.decision, 'ask', commit.reason)
  assert.equal(commit.classifierEligible, true, 'a commit message is not a program')
})
