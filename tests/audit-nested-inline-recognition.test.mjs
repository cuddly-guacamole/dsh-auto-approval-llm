/**
 * Inline-program interpreter spellings must reach the nested-execution
 * boundary.
 *
 * `nestedExecution` matched one shared inline-flag set (`-c`/`-e`/…), so a
 * batch of spellings fell out of the boundary entirely: php's `-r`, node's
 * `-p`, deno's `eval` subcommand, version-suffixed interpreter names
 * (`python3.11`), fused `-e` clusters (`ruby -pe`), and ruby's in-place mode
 * (which perl has handled since the write-vector batch). Each of those shapes
 * decayed to a classifier-answerable `unknown` while the same program spelled
 * `python -c …` is locked out of the classifier.
 *
 * Run: node --test tests/audit-nested-inline-recognition.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'

const HOME = 'C:/Users/u'
const roots = {
  workspace: 'C:/ws',
  home: HOME,
  dshHome: `${HOME}/.dsh`,
  tempRoots: [],
  allowedDshSubpaths: [],
  trustedDirs: [],
  mode: 'standard',
}
const owner = { id: 'session-nested-inline' }
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

const assess = (command) => assessShell(command, 'bash', roots, artifacts, owner)
const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)

test('the control shape (python -c with a destructive body) stays classifier-ineligible', () => {
  assert.equal(assess("python -c 'rm -rf x'").classifierEligible, false)
})

test('inline-program spellings outside the shared flag set reach the same boundary', () => {
  for (const command of [
    "php -r 'system(\"rm -rf x\")'",
    "node -p 'require(\"fs\").rmSync(\"x\",{recursive:true})'",
    "deno eval 'Deno.removeSync(\"x\",{recursive:true})'",
    "python3.11 -c 'import shutil; shutil.rmtree(\"x\")'",
    "ruby -pe 'rm -rf x' C:/ws/a.txt",
    "perl -pe 'rm -rf x' C:/ws/a.txt",
  ]) {
    assert.equal(assess(command).classifierEligible, false, `${command} must not be classifier-answerable`)
  }
})

test('ruby in-place edits reach the same destination fuses as perl', () => {
  const ruby = hardDeny(`ruby -i -pe '' ${HOME}/.dsh/audit.jsonl`)
  const perl = hardDeny(`perl -i -pe '' ${HOME}/.dsh/audit.jsonl`)
  assert.match(String(perl), /DSH_HOME/)
  assert.match(String(ruby), /DSH_HOME/)
})

test('a destructive body inside an in-place edit stays locked regardless of the write target', () => {
  // The write head owns the target judgment for in-place edits, but the
  // nested danger ladder must still see the program body: a routine
  // workspace target must not turn `perl -i -e 'system("rm -rf …")'` into a
  // static allow (that regression shipped once — the ladder stands down
  // only for the generic classifier fallback, never for the body fuses).
  for (const command of [
    `perl -i -e 'system("rm -rf C:/Users/u/.ssh")' C:/ws/notes.txt`,
    `ruby -i -e 'system("rm -rf C:/Users/u/.ssh")' C:/ws/notes.txt`,
    `perl -i -e 'unlink "C:/Users/u/.ssh/id_rsa"' C:/ws/notes.txt`,
    `perl -i -e 'open(F,">","C:/Users/u/.dsh/x")' C:/ws/notes.txt`,
  ]) {
    const verdict = assess(command)
    assert.ok(verdict, `${command} must not be a static allow`)
    assert.equal(verdict.classifierEligible, false, `${command} must stay out of the classifier`)
  }
})

test('non-inline spellings of the same interpreters keep their verdicts (no over-block)', () => {
  assert.equal(hardDeny('php -f C:/ws/script.php'), undefined)
  assert.equal(hardDeny('deno run C:/ws/script.ts'), undefined)
  assert.equal(hardDeny('node -r node:fs C:/ws/script.js'), undefined, 'node -r is a module preload, not an inline program')
  assert.equal(hardDeny('node C:/ws/script.js'), undefined)
})
