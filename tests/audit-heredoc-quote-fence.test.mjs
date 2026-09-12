/**
 * Heredoc body stripping must only fire on a `<<` that is live shell syntax.
 * Position-blind matching treated `<<` inside quotes and comments as an
 * introducer, so one line like `echo "a << b"` consumed every following line as
 * body — real syntax included — and disarmed the target fuses for the rest of
 * the input (a hard deny degraded to a classifier-answerable ask).
 *
 * Pins both directions: the fence is armed for the quote/comment spellings, and
 * real here-documents (including the quoted delimiter inside a command
 * substitution) keep their body exemption.
 * Run: node --test tests/audit-heredoc-quote-fence.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { hardDenyShellReason } from '../lib/auto/shell.js'

const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const roots = { workspace: repoRoot, home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [repoRoot] }
const deny = (command) => hardDenyShellReason(command, 'bash', roots)

const OPAQUE_REDIRECT = 'printf x > package.json; (:)'
const OPAQUE_DELETE = 'rm -rf C:/Users/u/.dsh; (:)'

test('the fuse control cases still fire without any heredoc noise', () => {
  assert.ok(deny(OPAQUE_REDIRECT) !== undefined, 'opaque redirect must stay denied')
  assert.ok(deny(OPAQUE_DELETE) !== undefined, 'opaque DSH_HOME deletion must stay denied')
})

test('a `<<` inside quotes or a comment no longer swallows the real syntax', () => {
  for (const prefix of [
    'echo "a << b"',
    "echo 'x<<y'",
    'echo "x << y" && echo z',
    '# note <<EOF',
    'echo hi # <<EOF',
    'echo ${x<<1}',
  ]) {
    for (const tail of [OPAQUE_REDIRECT, OPAQUE_DELETE]) {
      const command = `${prefix}\n${tail}`
      assert.ok(deny(command) !== undefined, `${JSON.stringify(prefix)} must not hide ${tail}`)
    }
  }
})

test('real here-document bodies keep their exemption, quoted delimiter included', () => {
  assert.equal(deny("cat <<'EOF'\nsee > package.json for the config\nEOF"), undefined)
  assert.equal(deny(`git commit -m "$(cat <<'EOF'\nfix: mention > package.json in the body\nEOF\n)"`), undefined)
  assert.ok(deny("cat <<'EOF'\nx\nEOF\nprintf x > package.json") !== undefined, 'syntax after the body stays judged')
})

test('a quoted `<<` alone is not a refusal', () => {
  assert.equal(deny('echo "a << b"'), undefined)
  assert.equal(deny("echo 'x<<y'"), undefined)
})
