/**
 * dsh-auto-approval-llm · shell writes into the plugin's own development zone.
 *
 * The package lives under DSH_HOME in the web profile, so a session whose
 * workspace IS the package had every shell write hard-denied by the DSH_HOME
 * fuse while the structured write tools allowed the same target
 * (`allowedDshSubpaths` always carries the plugin zone). This pins the narrowed
 * contract: the fuse extends exactly the plugin's own development zone, and the
 * verdict for a routine zone write matches the verdict the same command gets on
 * a workspace outside DSH_HOME. Every other DSH_HOME target stays hard-denied,
 * and the zone's own runtime-state / execution-code / manifest clamps stay in
 * force.
 *
 * Fixture shape matters: `dshHome` is the package's real ancestor. A fixture
 * whose dshHome does not contain the workspace never reaches this fuse at all,
 * which is how the shape stayed uncovered.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { isPluginDevZoneTarget } from '../lib/auto/paths.js'

const REPO = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const DSH_HOME = REPO.slice(0, REPO.indexOf('/plugins/'))
const HOME = 'C:/Users/u'

/** Real deployment shape: the workspace is the package inside DSH_HOME. */
const devZone = {
  workspace: REPO,
  home: HOME,
  dshHome: DSH_HOME,
  tempRoots: [],
  trustedDirs: [],
  allowedDshSubpaths: [REPO],
  maintenanceDshPaths: [],
  mode: 'aggressive',
}
/** The same commands on a workspace outside DSH_HOME: the verdict to match. */
const plain = {
  ...devZone,
  workspace: 'C:/ws',
  dshHome: `${HOME}/.dsh`,
  allowedDshSubpaths: [],
}
const registry = { has: () => false }
const denyOf = command => hardDenyShellReason(command, 'bash', devZone)
const verdictOf = (command, roots) => assessShell(command, 'bash', roots, registry, undefined)

test('the dev-zone predicate keys on the install root, not on a path name', () => {
  assert.equal(isPluginDevZoneTarget(`${REPO}/src/auto/shell.ts`), true)
  assert.equal(isPluginDevZoneTarget(`${REPO}/lib/auto/paths.js`), true)
  assert.equal(isPluginDevZoneTarget(REPO), true)
  assert.equal(isPluginDevZoneTarget(`${DSH_HOME}/outside.txt`), false)
  assert.equal(isPluginDevZoneTarget(`${DSH_HOME}/sessions/s.jsonl`), false)
  assert.equal(isPluginDevZoneTarget(`${DSH_HOME}/auto-approval-llm/audit.jsonl`), false)
  // A lookalike path elsewhere must not qualify.
  assert.equal(isPluginDevZoneTarget('C:/ws/plugins/dsh-auto-approval-llm/src/a.ts'), false)
})

test('a routine zone write clears the DSH_HOME fuse and matches a normal workspace', () => {
  const routine = [
    'printf x > .agents/out.md',
    'cat > src/a.ts',
    'tee tests/x.mjs',
    'cp ./src/a.ts ./src/b.ts',
    'sort -o ./out.txt ./in.txt',
  ]
  for (const command of routine) {
    assert.equal(denyOf(command), undefined, `${command} must clear the DSH_HOME fuse`)
    const dev = verdictOf(command, devZone)
    const normal = verdictOf(command, plain)
    assert.equal(dev.decision, normal.decision, `${command}: dev zone=${dev.decision} vs normal workspace=${normal.decision}`)
    assert.notEqual(dev.decision, 'deny', `${command} must not be hard-denied inside the zone`)
  }
  // The exact decisions, per command. A relation-only oracle ("same as a normal
  // workspace") is satisfied by two identical wrong answers, in the zone and
  // outside it alike, so it cannot pin the contract on its own.
  for (const [command, expected] of [
    ['printf x > .agents/out.md', 'ask'],
    ['cat > src/a.ts', 'ask'],
    ['tee tests/x.mjs', 'ask'],
    ['cp ./src/a.ts ./src/b.ts', 'allow'],
    ['sort -o ./out.txt ./in.txt', 'ask'],
  ]) {
    assert.equal(verdictOf(command, devZone).decision, expected, `${command} must decide ${expected} inside the zone`)
  }
})

test('every other DSH_HOME target keeps the unconditional deny', () => {
  const commands = [
    `printf x > ${DSH_HOME}/outside.txt`,
    `printf x > ${DSH_HOME}/sessions/s.jsonl`,
    `printf x > ${DSH_HOME}/auto-approval-llm/audit.jsonl`,
    `printf x > ${DSH_HOME}/credentials.json`,
    `cp ./src/a.ts ${DSH_HOME}/outside.txt`,
    `cd ${DSH_HOME} && printf x > outside.txt`,
  ]
  for (const command of commands) {
    const reason = denyOf(command)
    assert.match(reason ?? '', /DSH_HOME/, `${command} got: ${reason}`)
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('operator openings stay structured-tool only; they do not extend to shell', () => {
  const opened = {
    ...devZone,
    allowedDshSubpaths: [REPO, `${DSH_HOME}/opened`],
    maintenanceDshPaths: [`${DSH_HOME}/maint`],
  }
  for (const command of [`printf x > ${DSH_HOME}/opened/x.md`, `printf x > ${DSH_HOME}/maint/x.md`]) {
    assert.match(hardDenyShellReason(command, 'bash', opened) ?? '', /DSH_HOME/, command)
  }
})

test('the zone keeps its runtime-state, execution-code and manifest clamps', () => {
  const cases = [
    [`printf x > ${REPO}/history.jsonl`, /runtime state file/],
    [`printf x > ${REPO}/audit.jsonl`, /runtime state file/],
    [`printf x > ${REPO}/lib/index.js`, /execution code/],
    [`printf x > ${REPO}/node_modules/x/index.js`, /execution code/],
    [`printf x > ${REPO}/package.json`, /contract\/build file/],
    [`printf x > ${REPO}/tsdown.config.ts`, /contract\/build file/],
  ]
  for (const [command, pattern] of cases) {
    const reason = denyOf(command)
    assert.match(reason ?? '', pattern, `${command} got: ${reason}`)
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
})

test('output-flag writes into DSH_HOME still deny on the assessment plane', () => {
  // `hardDenyShellReason` does not own the output-flag fuse; the assess plane
  // does. The narrowed shell fuse must not expose this earlier hole either.
  const reason = hardDenyShellReason(`sort -o ${DSH_HOME}/x.txt in.txt`, 'bash', devZone)
  assert.equal(reason, undefined)
  const verdict = verdictOf(`sort -o ${DSH_HOME}/x.txt in.txt`, devZone)
  assert.equal(verdict.decision, 'deny')
  assert.equal(verdict.classifierEligible, false)
})

test('dynamic and opaque spellings never reach a static allow', () => {
  for (const command of [
    'printf x > "$(echo .agents/out.md)"',
    'f=.agents/out.md; printf x > $f',
    'printf x > .agents/out.md; (:)',
  ]) {
    const verdict = verdictOf(command, devZone)
    assert.notEqual(verdict.decision, 'allow', `${command}: ${verdict.decision}`)
  }
})

test('a cwd changer with an unproven base never widens the zone exception', () => {
  // Independent review found the first cut of this fix could be widened through
  // a cd: the hard-deny plane refuses to advance the base across ;/|/& (the
  // changer may have failed), so a relative name is judged against the
  // workspace. That fallback is a lower bound, not the real target — a name
  // landing in the zone under it can really land in lib/** or another
  // DSH_HOME tree. The exception therefore requires a proven base.
  const denied = [
    `cd ${REPO}/lib; printf x > evil.js`,
    `cd ${REPO}/lib && printf x > evil.js`,
    `cd $HOME/.dsh; printf x > sessions/evil.txt`,
    'cd $(echo ~/.dsh) && printf x > credentials.json',
    `cd ${REPO}/lib; printf x > evil.js; (:)`,
  ]
  for (const command of denied) {
    const reason = denyOf(command)
    assert.ok(reason !== undefined, `${command} must stay hard-denied`)
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // The output-flag owner lives on the assess plane: a changer before it must
  // not let the zone exception reach a fallback resolution there either.
  const sortVerdict = verdictOf(`cd ${REPO}/lib; sort -o evil.txt in.txt`, devZone)
  assert.equal(sortVerdict.decision, 'deny')
  assert.equal(sortVerdict.classifierEligible, false)
  // A chained line no longer gets the opening: only a single, literally
  // readable command can prove the base (see the boundary test below).
  assert.notEqual(denyOf(`cd ${REPO} && printf x > .agents/ok.md`), undefined)
})

test('unreadable and wrapped changers also withhold the zone exception', () => {
  // Re-review round two: a changer can be spelled so the segment head is not
  // the literal `cd` (builtin/eval/source), can hide in a nested interpreter
  // whose outer base is unproven, or can be produced by an expansion. Every
  // shape must keep the strict deny; a nested interpreter also has to inherit
  // the caller's strictness instead of resetting it to trusted.
  const denied = [
    `cd ${REPO}/lib; bash -c 'printf x > evil.js'`,
    `cd ${REPO}/lib && bash -c 'printf x > evil.js'`,
    `cd $HOME/.dsh && bash -c 'printf x > credentials.json'`,
    `eval 'cd ${REPO}/lib'; printf x > evil.js`,
    `eval 'cd $HOME/.dsh'; printf x > credentials.json`,
    `cd ${REPO}/lib; eval 'printf x > evil.js'`,
    `builtin cd ${REPO}/lib; printf x > evil.js`,
    `builtin cd $HOME/.dsh; printf x > credentials.json`,
    'source ./change-cwd.sh; printf x > evil.js',
    `c=cd; $c ${REPO}/lib; printf x > evil.js`,
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
})

test('reserved-word prefixes and fused shorthands cannot hide the changer', () => {
  // Re-review round three: the lexer keeps shell reserved words as their own
  // tokens, so `if cd <zone>/lib; then printf x > evil.js; fi` heads the
  // changer segment with `if`, not `cd`. The detection skips those keywords
  // before reading the effective head. pwsh fuses a relative path onto the
  // cmdlet (`cd..`, `cd~`), which is a changer spelling of its own.
  const bashDenied = [
    `if cd ${REPO}/lib; then printf x > evil.js; fi`,
    `! cd ${REPO}/lib; printf x > evil.js`,
    `while cd ${REPO}/lib; do printf x > evil.js; break; done`,
    `for i in 1; do cd ${REPO}/lib; printf x > evil.js; done`,
    `until ! cd ${REPO}/lib; do printf x > evil.js; break; done`,
    `select x in a; do cd ${REPO}/lib; printf x > evil.js; break; done`,
    `if true; then cd ${REPO}/lib; printf x > evil.js; fi`,
    `if cd ${REPO}/lib && printf x > evil.js; then :; fi`,
    `time ! cd ${REPO}/lib; printf x > evil.js`,
    `if cd $HOME/.dsh; then printf x > sessions/evil.jsonl; fi`,
    `! cd ${REPO}/lib; bash -c 'printf x > evil.js'`,
    `! cd ${REPO}/lib; sort -o evil.js in.txt`,
    `eval 'if cd ${REPO}/lib; then printf x > evil.js; fi'`,
  ]
  for (const command of bashDenied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  for (const command of ['cd..; echo x > evil.js', 'cd.. && echo x > evil.js', 'cd~; echo x > .dsh/sessions/evil.jsonl']) {
    const verdict = assessShell(command, 'pwsh', devZone, registry, undefined)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
})

test('multi-segment, wrapped and nested lines keep the strict fuse by design', () => {
  // The opening needs a PROVEN base: only a single command the lexer reads
  // literally can prove the session workspace is the real cwd. Chained writes,
  // `cd … && write`, wrappers and nested interpreters keep the pre-opening hard
  // deny — the documented boundary of this fix, not an oversight.
  const denied = [
    `cd ${REPO} && printf x > .agents/ok.md`,
    'printf a > .agents/a.md && printf b > .agents/b.md',
    'timeout 5 printf x > .agents/out.md',
    'bash -c "printf x > .agents/out.md"',
    `git -C ${REPO}/lib diff --output=evil.txt`,
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // A single-segment redirect carrier is inside the opening, not outside it.
  for (const command of ['grep -n x src/a.ts > .agents/out.txt', 'npm test > .agents/out.txt', 'mkdir -p .agents/logs']) {
    assert.equal(denyOf(command), undefined, command)
    assert.notEqual(verdictOf(command, devZone).decision, 'deny', command)
  }
})

test('nested find bodies and base-shifting tokens keep the strict deny', () => {
  // Fourth-round review: `find lib -execdir touch ./x ;` is a single segment
  // with no wrapper and no -C flag, yet the action runs in each matched file's
  // directory, so the real target is lib/x while the static read resolves ./x
  // against the workspace. Fifth-round review: a nested `env --ch=lib` (a GNU
  // `--chdir` abbreviation) shifts the body's base the same way. The rule now
  // (a) treats -execdir / -okdir as base-shifting tokens and (b) never lets a
  // nested body inherit the development-zone opening.
  const SEMI = String.fromCharCode(92) + ';'
  const denied = [
    'find lib -execdir touch ./x ' + SEMI,
    'find . -execdir cp {} ./x ' + SEMI,
    'find . -execdir cp {} ./x +',
    'find . -okdir cp {} ./x ' + SEMI,
    'find . -execdir sed -i s/a/b/ ./x ' + SEMI,
    'find . -exec cp {} ./x ' + SEMI,
    'find . -exec env --ch=lib tee ./x ' + SEMI,
    'find . -exec env --c=lib tee ./x ' + SEMI,
    'find . -exec env --ch=../../sessions tee ./x ' + SEMI,
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
})

test('target-directory abbreviations and ln destinations reach the fuses', () => {
  // Sixth-round review: GNU getopt accepts unambiguous abbreviations of
  // --target-directory, and `ln` was not routed through the destination
  // extractor, so the destination stayed inside the flag and the SOURCE was
  // judged as the target — a source inside the zone then rode the opening.
  const denied = [
    'cp --target-dir=lib ./src/auto/shell.ts',
    'cp --target-dir lib ./src/auto/shell.ts',
    'cp --target-d lib ./src/auto/shell.ts',
    'cp --t=lib ./src/auto/shell.ts',
    'mv --target-dir=lib ./src/auto/shell.ts',
    'install --target-dir=lib ./src/auto/shell.ts',
    'ln --target-directory=lib ./src/auto/shell.ts',
    'ln -tlib ./src/auto/shell.ts',
    'ln -t lib ./src/auto/shell.ts',
    `ln --target-dir=$HOME/.dsh ./src/auto/shell.ts`,
    `cp --target-directory=$HOME/.dsh ./src/auto/shell.ts`,
    'ln -s lib link',
    'ln -s ../lib link',
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // A target directory outside DSH_HOME stays routine (dev == plain).
  assert.equal(verdictOf('cp --target-directory=/tmp/x ./src/a.ts', devZone).decision, 'allow')
  // ln is identity-capable (a link reproduces its target for later writes), so
  // it is outside the content-write opening and keeps the strict deny.
  assert.equal(verdictOf('ln -s ./src/a.ts ./src/b.ts', devZone).decision, 'deny')
})

test('short-option clusters and cp link targets reach the fuses', () => {
  // Seventh-round review: `-rt lib` / `-rtlib` / `install -Dt` put `t` inside a
  // short cluster, so the target directory stayed inside the flag and the SOURCE
  // was judged as the target. `cp -s` / `cp -l` also make the source a link
  // target that a later write can reach, so their positionals are all judged.
  const denied = [
    'cp -rt lib ./src/auto/shell.ts',
    'cp -rvt lib ./src/auto/shell.ts',
    'cp -rtlib ./src/auto/shell.ts',
    'cp -itlib ./src/auto/shell.ts',
    'cp -S.bak -rt lib ./src/auto/shell.ts',
    'install -Dt lib ./src/auto/shell.ts',
    'install -bt lib ./src/auto/shell.ts',
    'install -Dtlib ./src/auto/shell.ts',
    'cp -rt ../lib ./src/auto/shell.ts',
    `cp -rt $HOME/.dsh ./src/auto/shell.ts`,
    `cp -l ${REPO}/lib/index.js .agents/hard`,
    `cp -s ${REPO}/lib/index.js .agents/link`,
    `cp --link ${REPO}/lib/index.js .agents/hard`,
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // A suffix value is not a flag cluster: -S.txt must leave the destination in
  // place, so a routine destination stays allow and a lib destination still denies.
  assert.equal(verdictOf('cp -S.txt ./src/a.ts ./src/b.ts', devZone).decision, 'allow')
  assert.equal(verdictOf('cp -S.txt ./src/a.ts lib', devZone).decision, 'deny')
  assert.equal(verdictOf('cp -t /tmp/x ./src/a.ts', devZone).decision, 'allow')
})

test('cp identity options and their GNU abbreviations keep the strict deny', () => {
  // Ninth-round review: the live repository sources are symlinks
  // (node_modules/@deepseek-ai/*), so a copy that preserves the file identity
  // would place a link inside the zone whose target is outside it. The identity
  // options match GNU's unambiguous abbreviations too.
  const denied = [
    'cp --archive node_modules/x .agents/x',
    'cp --arch node_modules/x .agents/x',
    'cp --arc node_modules/x .agents/x',
    'cp --no-dereference node_modules/x .agents/x',
    'cp --no-deref node_modules/x .agents/x',
    'cp --recursive node_modules/x .agents/x',
    'cp --recurs node_modules/x .agents/x',
    'cp -a node_modules/x .agents/x',
    'cp -P node_modules/x .agents/x',
    'cp -d node_modules/x .agents/x',
    'cp -r node_modules/x .agents/x',
    'cp --preserve=links node_modules/x .agents/x',
    'cp --preserve=li node_modules/x .agents/x',
    'cp --preserve=all node_modules/x .agents/x',
    'cp --preserve=al node_modules/x .agents/x',
    'cp --l node_modules/x .agents/x',
    'cp --sy node_modules/x .agents/x',
    'rsync -l node_modules/x .agents/x',
    'rsync -a node_modules/x .agents/x',
    'rsync --links node_modules/x .agents/x',
    'mv node_modules/x .agents/x',
    'ln node_modules/x .agents/x',
    'install node_modules/x .agents/x',
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // Content-only options stay inside the opening.
  for (const command of [
    'cp --preserve=mode node_modules/x .agents/x',
    'cp --preserve=timestamps node_modules/x .agents/x',
    'cp --sparse=always node_modules/x .agents/x',
    'cp --reflink=auto node_modules/x .agents/x',
    'cp ./src/a.ts ./src/b.ts',
  ]) {
    assert.notEqual(verdictOf(command, devZone).decision, 'deny', command)
  }
})

test('preserve option-name abbreviations and pwsh identity cmdlets keep the strict deny', () => {
  // Tenth-round review: GNU abbreviates the option name itself (`--pr=li` is
  // `--preserve=links`), and PowerShell creates filesystem identities with
  // New-Item / Copy-Item / Move-Item (including the inline `-Path:` / `-Target:`
  // spellings) rather than the bash heads.
  const denied = [
    'cp --pr=li node_modules/x .agents/x',
    'cp --pre=all node_modules/x .agents/x',
    'cp --preserv=links node_modules/x .agents/x',
    'cp --pr=l node_modules/x .agents/x',
    'cp --pr=al node_modules/x .agents/x',
    'cp --pr=a node_modules/x .agents/x',
    'cp --archive node_modules/x .agents/x',
    'cp --no-deref node_modules/x .agents/x',
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  const pwshDenied = [
    'New-Item -ItemType SymbolicLink -Path:.agents/x -Target:lib',
    'New-Item -ItemType Junction -Path:.agents/x -Target:lib',
    'New-Item -ItemType HardLink -Path:.agents/hard -Target:lib/index.js',
    'New-Item -ItemType SymbolicLink -Path .agents/x -Target /tmp/benign',
    'Copy-Item node_modules/x .agents/copy -Recurse',
    'Move-Item node_modules/x .agents/moved',
  ]
  for (const command of pwshDenied) {
    const verdict = assessShell(command, 'pwsh', devZone, registry, undefined)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // Content-preserving spellings stay inside the opening.
  assert.equal(verdictOf('cp --pr=mode node_modules/x .agents/x', devZone).decision, 'allow')
  assert.equal(verdictOf('cp --preserve=timestamps node_modules/x .agents/x', devZone).decision, 'allow')
})

test('dynamic words never carry the opening', () => {
  // Eleventh-round review: a dynamic word can expand to a flag the static read
  // cannot see (`cp ${V:---archive}`), so the opening requires every word in the
  // segment to be a literal.
  const denied = [
    'cp ${V:---archive} node_modules/x .agents/x',
    'cp ${V:---link} node_modules/x .agents/x',
    'cp ${V:---symbolic-link} node_modules/x .agents/x',
    'cp --preserve=${V:-links} node_modules/x .agents/x',
    'cp --preserve=${V:-all} node_modules/x .agents/x',
  ]
  for (const command of denied) {
    assert.ok(denyOf(command) !== undefined, `${command} must stay hard-denied`)
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // Unreadable targets stay at the manual/ask tier, never a static allow.
  for (const command of ['printf x > ${d:-lib}/x', 'tee ${d:-lib}/x']) {
    assert.notEqual(verdictOf(command, devZone).decision, 'allow', command)
  }
})

test('separated values of abbreviated long options are not read as destinations', () => {
  // Twelfth-round review: `cp src lib/index.js --suf .agents/x` — `--suf` is an
  // abbreviation of `--suffix`, which consumes `.agents/x`; reading only the
  // full spelling left the value in the positional list and picked it as the
  // destination, so the real target lib/index.js was never judged.
  const denied = [
    'cp ./src/a.ts lib/index.js --suf .agents/x',
    'cp ./src/a.ts lib/index.js --su .agents/x',
    'cp ./src/a.ts lib/index.js --suffi .agents/x',
    'cp ./src/a.ts package.json --suf .agents/x',
    'cp ./src/a.ts node_modules/x/index.js --suf .agents/x',
    'cp ./src/a.ts lib/index.js --sparse always',
    'cp ./src/a.ts lib/index.js --no-preserve links',
    'cp ./src/a.ts lib/index.js --suffix .agents/x',
    'cp ./src/a.ts lib/index.js --suf=.agents/x',
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // The value belongs to the flag, so the last positional stays the destination.
  assert.equal(verdictOf('cp --suf .agents/x ./src/a.ts ./src/b.ts', devZone).decision, 'allow')
})

test('exact no-value options and short-cluster values keep the real destination', () => {
  // Thirteenth-round review: `--strip` is install's exact boolean option, so it
  // must win over the `--strip-program` prefix; and a short cluster that ends in
  // a value-taking option (`-vS`) consumes the next word instead of turning it
  // into the destination.
  const denied = [
    'install C:/tmp/a.ts --strip lib/index.js',
    'install C:/tmp/a.ts --strip package.json',
    'install C:/tmp/a.ts --strip-program /bin/true lib/index.js',
    'cp ./src/a.ts lib/index.js -vS .bak',
    'cp ./src/a.ts lib/index.js -pS .bak',
    'cp ./src/a.ts lib/index.js -fS .bak',
    'cp ./src/a.ts lib/index.js -S.bak',
    'install C:/tmp/a.ts lib/index.js -pm 755',
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // A short-cluster value must not leak into the destination.
  assert.equal(verdictOf('cp -S.txt ./src/a.ts ./src/b.ts', devZone).decision, 'allow')
})

test('short-cluster values follow getopt order, not the last character', () => {
  // Fourteenth-round review: GNU getopt scans a short cluster left to right and
  // the FIRST value-taking option consumes the rest of the cluster, so only a
  // value option in the last position reaches for the next word. Checking the
  // last character alone mis-read `-S.txt` (S takes `.txt`) as `-vS`-style.
  const denied = [
    'cp ./src/a.ts -S.txt lib/index.js',
    'cp ./src/a.ts -S.txt package.json',
    'cp ./src/a.ts -SxS lib/index.js',
    'mv ./src/a.ts -SxS lib/index.js',
    'ln ./src/a.ts -SxS lib/index.js',
    'install ./src/a.ts -SxS lib/index.js',
    'mv ./src/a.ts -t/tmp/S lib/index.js',
    'install ./src/a.ts -ma+t lib/index.js',
  ]
  for (const command of denied) {
    const verdict = verdictOf(command, devZone)
    assert.equal(verdict.decision, 'deny', command)
    assert.equal(verdict.classifierEligible, false, command)
  }
  // A fused short value still leaves the later positional as the destination.
  assert.equal(verdictOf('cp -S.txt ./src/a.ts ./src/b.ts', devZone).decision, 'allow')
})

test('the allow path also resolves abbreviated value options', () => {
  // Fifteenth-round review: the allow path called writeOperandCandidates without
  // the command name, so the value-option tables were lost there and a dynamic
  // destination plus `--suf lib/index.js` could reach a static allow.
  const notAllowed = [
    'cp ./src/a.ts $DEST --suf lib/index.js',
    'cp ./src/a.ts $DEST --suf package.json',
    'install ./src/a.ts $DEST --suf lib/index.js',
    'install ./src/a.ts $DEST --strip-p lib/index.js',
    'install ./src/a.ts $DEST -ma+t',
    'cp ./src/a.ts $DEST --sparse always',
  ]
  for (const command of notAllowed) {
    assert.notEqual(verdictOf(command, devZone).decision, 'allow', command)
  }
})
