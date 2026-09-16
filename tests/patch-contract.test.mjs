/**
 * dsh-auto-approval-llm · cordis.patch.yml loader/preset contract.
 *
 * The loader ENTRY exists only because of the `- insert:` row (the profile
 * bundles array supplies patch layers but does not create entries — a missing
 * insert 404s every plugin route), and the "auto-approval" preset MUST keep
 * approval: ask (the plugin restores that spec at runtime). The shipped table
 * must never define a standalone "auto" preset: hosts >= 0.1.6 reserve the name
 * for the upstream auto-review integration and refuse to compose it. The host
 * applyEntryPatches only warns on a missing row, so nothing else would catch a
 * regression. Anchors read the shipped yml (comment lines stripped — the header
 * prose mentions the pinned values); no YAML dependency, only indentation block
 * scanning.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patchPath = new URL('../cordis.patch.yml', import.meta.url)
const lines = readFileSync(patchPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
const indentOf = (line) => line.length - line.trimStart().length
/** Indices of lines matching re, with their indent. */
const find = (re) => lines.map((line, index) => ({ line, index })).filter(({ line }) => re.test(line))
/** Block of a `key:` line: every following line with a deeper indent. */
const blockOf = (index) => {
  const base = indentOf(lines[index])
  const out = []
  for (let i = index + 1; i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > base); i += 1) out.push(lines[i])
  return out
}

test('patch contract: the loader entry insert row exists with the plugin id', () => {
  const insert = find(/^- insert:/)
  assert.equal(insert.length, 1, 'exactly one top-level insert row')
  const block = blockOf(insert[0].index).join('\n')
  assert.match(block, /id: auto-approval-llm/, 'the insert must create the plugin entry')
  assert.match(block, /name: '@quill507\/dsh-auto-approval-llm'/, 'the entry must name the plugin package')
})

test('patch contract: the auto-approval preset keeps approval ask on a danger-full-access sandbox', () => {
  const gated = find(/^\s+auto-approval:\s*$/)
  assert.equal(gated.length, 1, 'exactly one auto-approval preset block')
  const block = blockOf(gated[0].index).join('\n')
  // Anchored to the whole line (a quoted scalar is accepted): a bare substring
  // would also be satisfied by `approval: ask-later` or any value that merely
  // contains the pinned text.
  assert.match(block, /^\s+sandbox:\s+['"]?danger-full-access['"]?\s*$/m, 'auto-approval sandbox is danger-full-access')
  assert.match(block, /^\s+approval:\s+['"]?ask['"]?\s*$/m, 'auto-approval approval MUST stay ask (never relax to never)')
  assert.match(block, /^\s+name:\s+['"]?Auto approval['"]?\s*$/m, 'the display name is the rename contract')
  assert.match(block, /^\s+description:\s+High-privilege execution[^\n]*$/m, 'the description is preserved verbatim')
})

test('patch contract: no standalone auto preset is shipped (reserved name)', () => {
  const auto = find(/^\s+auto:\s*$/)
  assert.equal(auto.length, 0, 'a standalone auto preset would break >=0.1.6 hosts at composition')
})

test('patch contract: danger-full-access preset keeps approval never (auto-approval is the guarded tier)', () => {
  const dfa = find(/^\s+danger-full-access:\s*$/)
  assert.equal(dfa.length, 1, 'exactly one danger-full-access preset block')
  assert.match(blockOf(dfa[0].index).join('\n'), /approval: never/)
})

test('patch contract: shipped config pins match the intended defaults', () => {
  const insert = blockOf(find(/^- insert:/)[0].index).join('\n')
  // Each pin is matched as a whole line so a value that merely starts with the
  // pinned text cannot satisfy it.
  assert.match(insert, /^\s+enabled:\s+['"]?true['"]?\s*$/m)
  assert.doesNotMatch(insert, /autoSwitchPolicyToAsk/, 'the retired guard key is not pinned')
  assert.match(insert, /^\s+timeoutAction:\s+['"]?reject['"]?\s*$/m)
  assert.match(insert, /^\s+allowlist:\s+\[\]\s*$/m)
  assert.match(insert, /^\s+denyList:\s+\[\]\s*$/m)
  assert.match(insert, /^\s+humanOnlyList:\s+\[\]\s*$/m)
  assert.match(insert, /^\s+maxConsecutiveDenials:\s+3\s*$/m)
  assert.match(insert, /^\s+maxTotalDenials:\s+20\s*$/m)
  assert.match(insert, /^\s+notifyUser:\s+['"]?true['"]?\s*$/m)
})

test('patch contract: the four permission presets are exactly the shipped set', () => {
  const permission = blockOf(find(/^- id: permission/)[0].index).join('\n')
  for (const preset of ['read-only', 'workspace-write', 'auto-approval', 'danger-full-access']) {
    assert.match(permission, new RegExp(`^[ ]+${preset}:[ ]*$`, 'm'), `preset ${preset} present`)
  }
  assert.doesNotMatch(permission, /^\s+auto:\s*$/m, 'auto is not a shipped preset row')
})
