/**
 * dsh-auto-approval-llm · cordis.patch.yml loader/preset contract.
 *
 * The loader ENTRY exists only because of the `- insert:` row (the profile
 * bundles array supplies patch layers but does not create entries — 2026-08-30
 * regression: losing the insert 404'd every plugin route), and the "auto"
 * preset MUST keep approval: ask (first line of the privilege defense; the
 * runtime guard is the second). The host applyEntryPatches only warns on a
 * missing row, so nothing else would catch a regression. Anchors read the
 * shipped yml (comment lines stripped — the header prose mentions the pinned
 * values); no YAML dependency, only indentation block scanning.
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

test('patch contract: the auto preset keeps approval ask on a danger-full-access sandbox', () => {
  const auto = find(/^\s+auto:\s*$/)
  assert.equal(auto.length, 1, 'exactly one auto preset block')
  const block = blockOf(auto[0].index).join('\n')
  assert.match(block, /sandbox: danger-full-access/, 'auto sandbox is danger-full-access')
  assert.match(block, /approval: ask/, 'auto approval MUST stay ask (never relax to never/auto)')
})

test('patch contract: danger-full-access preset keeps approval never (auto is the guarded tier)', () => {
  const dfa = find(/^\s+danger-full-access:\s*$/)
  assert.equal(dfa.length, 1, 'exactly one danger-full-access preset block')
  assert.match(blockOf(dfa[0].index).join('\n'), /approval: never/)
})

test('patch contract: shipped config pins match the intended defaults', () => {
  const insert = blockOf(find(/^- insert:/)[0].index).join('\n')
  assert.match(insert, /enabled: true/)
  assert.match(insert, /autoSwitchPolicyToAsk: true/, 'the never->ask guard ships ON')
  assert.match(insert, /timeoutAction: reject/)
  assert.match(insert, /allowlist: \[\]/)
  assert.match(insert, /denyList: \[\]/)
  assert.match(insert, /humanOnlyList: \[\]/)
  assert.match(insert, /maxConsecutiveDenials: 3/)
  assert.match(insert, /maxTotalDenials: 20/)
  assert.match(insert, /notifyUser: true/)
})

test('patch contract: the four presets are exactly the shipped set', () => {
  const permission = blockOf(find(/^- id: permission/)[0].index).join('\n')
  for (const preset of ['read-only', 'workspace-write', 'auto', 'danger-full-access']) {
    assert.match(permission, new RegExp(`^\\s+${preset}:\\s*$`, 'm'), `preset ${preset} present`)
  }
})
