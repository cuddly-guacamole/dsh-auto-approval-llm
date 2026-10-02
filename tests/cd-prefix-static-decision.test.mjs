/**
 * dsh-auto-approval-llm · directory-changer static decision contract.
 *
 * A directory changer (`cd`, `set-location`, `sl`) was deliberately kept out of
 * the static fast paths: it rewrites the working directory for every later
 * segment, so leaving it unrecognized kept any line containing it out of the
 * allow path and routed the whole line to semantic classification. That is a
 * real conservatism with a measured cost — `cd`-prefixed lines are 43% of the
 * shell vector and had a static allow rate of exactly zero.
 *
 * This change replaces "unrecognized ⇒ ask" with the narrower, reasoned claim:
 * a changer writes nothing and reads nothing, so on its own it is not a risk —
 * what it does is move the BASE the rest of the line is judged from. The base is
 * read with the existing `effectiveCwdAfter`, the same resolver the hard-deny
 * plane already used for exactly this purpose, so the two planes resolve a
 * relative target the same way.
 *
 * Every way this can go wrong is a fence, so each is pinned here:
 *
 *   1. the base moves across `&&` ONLY. Across `;` / `|` / `&` reaching the
 *      next segment proves nothing — `cd /nodir; printf x > package.json`
 *      fails its `cd` and still writes into the workspace. Allowing the changer
 *      there while leaving the base put would resolve the rest inside the
 *      workspace and claim the session-artifact deletion exemption for a path
 *      the line never touches, so the changer keeps its unrecognized verdict
 *      there and the line still asks;
 *   2. an unreadable changer never moves the base on a guess. `effectiveCwdAfter`
 *      still refuses a dynamic, globbed or missing target and a
 *      spelling-family mismatch, and every one of those lines keeps asking;
 *   3. recognition is not an opening. A changer into a credential tree, home
 *      outside every opened zone, DSH_HOME or a critical tree keeps asking — the
 *      readable spelling must not buy a protected path;
 *   4. a changer that also redirects is more than a changer (`cd x > out.txt`
 *      writes), so it keeps the existing verdict;
 *   5. nothing outside this file moves. The 53-command non-`cd` corpus below is
 *      pinned verdict-for-verdict against the tree as it stood before the change.
 *
 * Run: node --test tests/cd-prefix-static-decision.test.mjs (tsc + tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { isWithin, normalizePath, resolveRoots } from '../lib/auto/paths.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHELL = readFileSync(join(root, 'src/auto/shell.ts'), 'utf8')

const WORKSPACE = 'C:/ws'
const roots = resolveRoots(WORKSPACE, {})
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'standard'
roots.trustedDirs = []
const owner = { id: 'session' }
const artifacts = new ArtifactRegistry()
artifacts.add(owner, normalizePath(`${WORKSPACE}/scratch.txt`, roots.workspace, roots.home), roots)

const decide = (command) => assessShell(command, 'bash', roots, artifacts, owner)

// ── 1. the base moves, and the remainder is judged ────────────────────────

test('a changer plus a read-only command is decided as that command', () => {
  const verdict = decide('cd C:/ws && ls')
  assert.equal(verdict.decision, 'allow', 'the line is judged, not routed to classification')
  assert.equal(verdict.classifierEligible, false, 'the line no longer waits on the classifier')
  // Precondition: the same remainder without the prefix reaches the same verdict,
  // so what the changer changed is the segment verdict and nothing else.
  assert.equal(decide('ls').decision, 'allow', 'precondition: ls alone is routine')
})

test('a bare changer is a no-effect decision', () => {
  for (const command of ['cd C:/ws', 'cd C:/ws/sub']) {
    const verdict = decide(command)
    assert.equal(verdict.decision, 'allow', `${command}: moves no base and touches nothing`)
    assert.match(String(verdict.reason), /directory changer carries no effect/, `${command}: reason names the changer`)
  }
})

test('the target is judged against the CARRIED base: two that agree, one that must not', () => {
  // The carried base is what makes this test worth having: with the base left at
  // the workspace, all three would resolve `scratch.txt` to the same path and the
  // third would silently become an exempt allow for a file the line never
  // touches. This is the assertion that caught a base that was computed and then
  // dropped instead of carried.
  const bare = decide('rm scratch.txt')
  assert.equal(bare.decision, 'allow', 'precondition: the bare deletion is an exact session artifact')
  assert.equal(bare.sessionArtifactDeletion, true, 'precondition: the exemption is what is at stake')

  // Agreement 1: carrying to the workspace itself names the same artifact.
  const carried = decide('cd C:/ws && rm scratch.txt')
  assert.equal(carried.decision, 'allow', 'a carried base naming the same directory is the same line')
  assert.equal(carried.sessionArtifactDeletion, true, 'the exemption still applies')

  // Must not agree: the base moved, so the target is a different path and must
  // not inherit the workspace's exemption.
  const moved = decide('cd C:/ws/sub && rm scratch.txt')
  assert.equal(moved.decision, 'ask', 'a moved base resolves the deletion to another path')
  assert.notEqual(moved.sessionArtifactDeletion, true, 'the exemption must not follow the base')
  assert.match(String(moved.reason), /c:\\ws\\sub\\scratch\.txt/, 'the reason names the resolved target, not the workspace one')
})

// ── 2. the base must NOT move — the load-bearing section ──────────────────

test('across `;` the changer proves nothing, so the base must not move', () => {
  // `cd /nodir` fails, yet `printf x > package.json` still writes into the
  // workspace. If the base were carried, the write would be judged against a
  // directory the shell never reached.
  const semicolon = decide('cd /nodir; printf x > package.json')
  assert.equal(semicolon.decision, 'ask', 'the whole line stays on the classification path')
  assert.match(String(semicolon.reason), /unrecognized bash command[^\n]*: cd/, 'the changer itself is still the unrecognized segment')

  // The decisive form: the exemption. With the base put but the changer allowed,
  // this line would resolve inside the workspace and claim the artifact deletion
  // exemption for a path it never touches.
  const elsewhere = decide('cd /nodir; rm scratch.txt')
  assert.equal(elsewhere.decision, 'ask', 'no exemption may be claimed across `;`')
  assert.notEqual(elsewhere.sessionArtifactDeletion, true, 'the exemption is the thing that must not leak')
  assert.notEqual(
    elsewhere.decision,
    decide('cd C:/ws && rm scratch.txt').decision,
    'the `;` spelling must not reach the verdict the `&&` spelling reaches',
  )
})

test('across `|` and `&` the base must not move either', () => {
  for (const separator of ['|', '&']) {
    const line = `cd C:/elsewhere ${separator} rm scratch.txt`
    assert.equal(decide(line).decision, 'ask', `${line}: the pipe/background spelling proves nothing`)
    assert.notEqual(decide(line).sessionArtifactDeletion, true, `${line}: no exemption may be claimed`)
  }
  // A pipe carries no base, but the changer is still not an effect: the line asks.
  assert.equal(decide('cd C:/ws | ls').decision, 'ask', 'a piped remainder keeps the line asking')
})

// ── 3. an unreadable changer never moves the base ─────────────────────────

test('a dynamic target keeps asking', () => {
  for (const command of ['cd "$X" && ls', 'cd $(dirname a) && ls', 'cd ~ && ls']) {
    assert.equal(decide(command).decision, 'ask', `${command}: a target that cannot be read statically`)
  }
})

test('a globbed target keeps asking', () => {
  for (const command of ['cd /tmp/* && ls', 'cd C:/* && ls', 'cd ../* && ls']) {
    assert.equal(decide(command).decision, 'ask', `${command}: a glob does not name one directory`)
  }
})

test('a spelling-family mismatch keeps asking', () => {
  // A posix spelling on a win32 workspace cannot be compared against the plugin
  // zone, DSH_HOME or the credential trees, so every fuse would silently miss.
  // Note `/c/…` is NOT this case: `normalizePath` canonicalizes an MSYS spelling
  // to win32 first, so it names a comparable path and is judged on its merits.
  for (const command of ['cd /etc/foo && ls', 'cd /opt/x && ls', 'cd /Users/x && ls']) {
    assert.equal(decide(command).decision, 'ask', `${command}: posix spelling on a win32 workspace`)
  }
})

test('a changer with no target at all keeps asking', () => {
  assert.equal(decide('cd && ls').decision, 'ask', 'a changer with no target names no directory')
})

// ── 4. recognition is not an opening ──────────────────────────────────────

test('a changer into a protected tree does not become an allow', () => {
  const cases = [
    'cd ~/.ssh && ls',
    'cd ~/.aws && ls',
    'cd ~/.gnupg && ls',
    'cd ~/.kube && ls',
    'cd ~/.dsh && ls',
    'cd ~/Documents && ls',
  ]
  for (const command of cases) {
    assert.equal(decide(command).decision, 'ask', `${command}: a readable spelling must not buy a protected path`)
  }
  // The bare form too — a protected changer on its own line is still a risk.
  for (const command of ['cd ~/.ssh', 'cd ~/.aws', 'cd ~/.dsh']) {
    assert.equal(decide(command).decision, 'ask', `${command}: bare changer into a protected tree`)
  }
})

test('a changer that also redirects keeps the existing verdict', () => {
  // `cd x > out.txt` writes; it is not a no-effect segment.
  for (const command of ['cd C:/ws > out.txt && ls', 'cd C:/ws && cat > out.txt']) {
    assert.equal(decide(command).decision, 'ask', `${command}: a segment with a write target is not a bare changer`)
  }
})

test('a DSH_HOME outside the home root is still refused', () => {
  // The home rule cannot be what catches this one: DSH_HOME does not live under
  // the home root here, so a changer landing on it would otherwise read as an
  // ordinary external path and carry. The dedicated check is what holds it.
  const outside = resolveRoots(WORKSPACE, {})
  outside.allowedDshSubpaths = []
  outside.maintenanceDshPaths = []
  outside.mode = 'standard'
  outside.trustedDirs = []
  outside.dshHome = String.raw`c:\dsh`
  assert.ok(!isWithin(outside.home, outside.dshHome), 'precondition: DSH_HOME really is outside the home root')
  for (const command of ['cd C:/dsh && ls', 'cd C:/dsh', 'cd C:/dsh/skills && ls']) {
    const verdict = assessShell(command, 'bash', outside, artifacts, owner)
    assert.equal(verdict.decision, 'ask', `${command}: DSH_HOME is refused outright, not as a home path`)
  }
  assert.equal(
    assessShell('cd C:/ws && ls', 'bash', outside, artifacts, owner).decision,
    'allow',
    'precondition: the workspace is still a trusted base under these roots',
  )
})

// ── 5. nothing outside this file moved ────────────────────────────────────

test('the non-cd corpus is unchanged: 53 commands, verdict for verdict', () => {
  // Captured from the tree as it stood before the change and re-captured after;
  // the two runs were byte-identical. [command, decision, classifierEligible,
  // sessionArtifactDeletion, opaqueLocked].
  const corpus = [
    ['ls -la', 'allow', false, false, false],
    ['pwd', 'allow', false, false, false],
    ['cat notes.txt', 'allow', false, false, false],
    ['head -5 a.txt', 'allow', false, false, false],
    ['rg foo src', 'allow', false, false, false],
    ['wc -l a.txt', 'allow', false, false, false],
    ['echo hi', 'allow', false, false, false],
    ['printf x', 'allow', false, false, false],
    ['date', 'allow', false, false, false],
    ['whoami', 'allow', false, false, false],
    ['git status', 'allow', false, false, false],
    ['git --version', 'allow', false, false, false],
    ['git push origin main', 'ask', true, false, false],
    ['git commit -m x', 'ask', true, false, false],
    ['curl https://x', 'ask', true, false, false],
    ['wget http://x', 'ask', true, false, false],
    ['npm i left-pad', 'ask', true, false, false],
    ['node -e "console.log(1)"', 'ask', true, false, false],
    ['python3 evil.py', 'ask', true, false, false],
    ['node -e "process.exit(1)" && ls', 'ask', true, false, false],
    ['npm run build; ls', 'allow', false, false, false],
    ['rm -rf build', 'ask', true, false, false],
    ['rm scratch.txt', 'allow', false, true, false],
    ['rm nosuch.txt', 'ask', true, false, false],
    ['del x.txt', 'ask', true, false, false],
    ['Remove-Item a.txt', 'ask', true, false, false],
    ['cat ~/.ssh/id_rsa', 'ask', true, false, false],
    ['cat ~/.aws/credentials', 'ask', true, false, false],
    ['cat .env', 'ask', true, false, false],
    ['cat .gitconfig', 'ask', true, false, false],
    ['echo x > out.txt', 'ask', true, false, false],
    ['echo x > ~/notes.txt', 'ask', true, false, false],
    ['cat a.txt | grep x', 'allow', false, false, false],
    ['ls; rm -rf x', 'ask', true, false, false],
    ['ls && rm -rf x', 'ask', true, false, false],
    ['bash -c "rm -rf x"', 'ask', false, false, true],
    ['bash -c "echo ok"', 'ask', true, false, false],
    ['$(echo ls)', 'ask', true, false, false],
    ['ls `pwd`', 'ask', true, false, false],
    ['sudo ls', 'deny', false, false, false],
    ['sudo rm x', 'deny', false, false, false],
    ['date -s "2020-01-01"', 'deny', false, false, false],
    ['find . -name "*.ts"', 'allow', false, false, false],
    ['find . -delete', 'ask', true, false, false],
    ['find . -exec rm {} ;', 'ask', true, false, false],
    ['cat < in.txt', 'allow', false, false, false],
    ['cat a.txt > out.txt', 'ask', true, false, false],
    ['touch new.txt', 'allow', false, false, false],
    ['mkdir sub', 'allow', false, false, false],
    ['scp a x:/y', 'ask', true, false, false],
    ['kubectl get pods', 'ask', true, false, false],
    ['chmod +x run.sh', 'ask', true, false, false],
    ['kill 1', 'ask', true, false, false],
  ]
  assert.equal(corpus.length, 53, 'the corpus itself is the fixture')
  for (const [command, decision, eligible, exemption, locked] of corpus) {
    const verdict = decide(command)
    assert.equal(verdict.decision, decision, `${command}: decision`)
    assert.equal(verdict.classifierEligible, eligible, `${command}: classifierEligible`)
    assert.equal(verdict.sessionArtifactDeletion === true, exemption, `${command}: sessionArtifactDeletion`)
    assert.equal(verdict.opaqueLocked === true, locked, `${command}: opaqueLocked`)
  }
})

// ── 6. the structure, read from the source ────────────────────────────────

test('the assess plane carries the base with the same &&-only rule as the hard-deny plane', () => {
  // Two independent loops, one rule. If either drifts the other, a line can be
  // judged against a base the hard-deny plane did not use.
  const clears = SHELL.match(/if \(segment\.precededBy !== '' && segment\.precededBy !== '&&'\)/g) ?? []
  assert.ok(clears.length >= 2, `both planes clear the base on a non-&& separator (found ${clears.length})`)

  // The hard-deny plane must still run first: the decision plane may only ever
  // see a line the fuse already cleared.
  const entry = SHELL.slice(SHELL.indexOf('export function assessShell('))
  const hardDenyAt = entry.indexOf('hardDenyShellReason(')
  const assessAt = entry.indexOf('assessSegment(')
  assert.ok(hardDenyAt !== -1 && assessAt !== -1, 'both calls are present in assessShell')
  assert.ok(hardDenyAt < assessAt, 'hard deny is still evaluated before any segment is assessed')
})

test('the alias-shadowing residual assumption is still stated, not quietly dropped', () => {
  // `cd` shadowed by an alias makes the segment something other than a changer,
  // and neither the static plane nor this change can see it. The condition the
  // base move rests on is stated in effectiveCwdAfter's own contract; if that
  // sentence is deleted, the assumption it names has been lost.
  const at = SHELL.indexOf('function effectiveCwdAfter(')
  assert.notEqual(at, -1, 'effectiveCwdAfter is declared')
  // The contract is the doc comment immediately above it; slice the block that
  // ENDS at the declaration, not one that starts on it. The JSDoc continuation
  // markers and line breaks are stripped before matching so a re-wrap in the
  // prose cannot turn this scan into a false pass or a spurious failure — the
  // sentences are the contract, the formatting is not.
  const raw = SHELL.slice(SHELL.lastIndexOf('/**', at), at)
  const doc = raw.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ')
  assert.match(doc, /shadowed by an alias is the residual assumption/, 'the residual assumption is still documented')
  assert.match(doc, /only carries a base across `&&`/, 'the &&-only condition is still documented')
  assert.match(doc, /must never move the base on a guess/, 'the unreadable-changer refusal is still documented')
})

test('the changer set is unchanged: the three commands, nothing added', () => {
  const declared = SHELL.match(/const DIRECTORY_CHANGER_COMMANDS = new Set\(\[(.*?)\]\)/)
  assert.ok(declared, 'the set is declared')
  const names = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(names, ['cd', 'set-location', 'sl'], 'no command joins the set, and none leaves it')
  // `pushd`/`popd` stay out: paired, so their net effect is not readable one
  // segment at a time, and `cd -` is a history lookup rather than a literal path.
  for (const name of ['pushd', 'popd', 'chdir']) {
    assert.ok(!names.includes(name), `${name} must stay out of the set`)
  }
})
