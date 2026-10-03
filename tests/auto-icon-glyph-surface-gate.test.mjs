// Which official surfaces the Auto glyph joins is decided by one structural
// read: the official preset glyph sits in a per-row `<span>` wrapper, while the
// selected row's tick is a bare `<svg>` that is a direct child of the button.
// The old rule counted any `<svg>` under a non-auto row, so the settings
// "权限" dropdown — label-only, but carrying a tick on whichever preset is
// currently selected — was read as a glyph menu and the Auto row ended up the
// only row carrying an icon.
//
// The predicate must also stay structural: the host rebuilds every CSS module
// class hash (`_check_…`, `_itemIcon_…`), so any such coupling expires with the
// next host build.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { menuDrawsPresetGlyphs } from '../lib/client/auto-icon.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib/client/auto-icon.js'), 'utf8')

const PRESETS = ['仅可查看', '工作区内修改', '自动审批', '完全权限']

// The repository ships no DOM library (no jsdom/linkedom/happy-dom/cheerio), so
// these tests hand-build the smallest element tree the predicate reads:
// `textContent` on the row, `children` with `tagName` + `querySelector`, and a
// row-level `querySelector` that reports any svg in its subtree — that last one
// is the reading the old rule used, kept here so the old behaviour is
// reproducible by assertion rather than by a missing method.
function row(label, { glyph = false, tick = false } = {}) {
  const svg = { tagName: 'svg' }
  const children = []
  if (glyph) children.push({ tagName: 'SPAN', textContent: '', querySelector: (s) => (s === 'svg' ? svg : null) })
  children.push({ tagName: 'SPAN', textContent: label, querySelector: () => null })
  // The selected row's tick is a bare <svg> child of the button itself.
  if (tick) children.push(svg)
  return {
    tagName: 'BUTTON',
    textContent: label,
    children,
    querySelector: (s) => (s === 'svg' && (glyph || tick) ? svg : null),
  }
}

test('glyph-surface gate: the selected row tick on a non-auto preset is not a preset glyph', () => {
  // The reproduced defect: the settings dropdown ticks whichever preset is
  // active, and that tick used to be read as an official item glyph.
  const labelOnly = PRESETS.map((label) => row(label, { tick: label === '完全权限' }))
  assert.equal(menuDrawsPresetGlyphs(labelOnly), false,
    'a bare tick <svg> under a non-auto row must not open the gate')
  // The same menu with the tick on the Auto row, for the locale where Auto is
  // the active preset.
  const autoSelected = PRESETS.map((label) => row(label, { tick: label === '自动审批' }))
  assert.equal(menuDrawsPresetGlyphs(autoSelected), false,
    'a tick on the Auto row is still not a preset glyph')
})

test('glyph-surface gate: an official glyph menu (glyph inside a <span>) opens the gate', () => {
  const official = PRESETS.map((label) => row(label, { glyph: true }))
  assert.equal(menuDrawsPresetGlyphs(official), true,
    'the official composer menu wraps each preset glyph in an itemIcon span')
  // One wrapped glyph anywhere is enough — the Auto row itself renders without one.
  const mixed = PRESETS.map((label) => row(label, { glyph: label === '仅可查看' }))
  assert.equal(menuDrawsPresetGlyphs(mixed), true,
    'a single wrapped glyph identifies the surface as glyph-bearing')
})

test('glyph-surface gate: the Auto row never answers the question about itself', () => {
  // Guards the class of fix, not one input: a predicate that merely counted
  // svgs anywhere would reopen the defect after the plugin ever left a glyph on
  // the Auto row.
  const autoGlyphOnly = PRESETS.map((label) => row(label, { glyph: label === '自动审批' }))
  assert.equal(menuDrawsPresetGlyphs(autoGlyphOnly), false,
    'a glyph left on the Auto row by an earlier pass must not keep the gate open')
  assert.equal(menuDrawsPresetGlyphs([]), false, 'an empty menu draws no glyphs')
  assert.equal(menuDrawsPresetGlyphs(PRESETS.map((label) => row(label))), false,
    'a menu with no svg at all is text-only')
})

test('glyph-surface gate: the predicate is exported and reads structure, not host class hashes', () => {
  assert.equal(typeof menuDrawsPresetGlyphs, 'function', 'the predicate is exported for direct tests')
  const start = bundle.indexOf('function menuDrawsPresetGlyphs')
  assert.notEqual(start, -1, 'the predicate must survive compilation')
  const body = bundle.slice(start, start + 700)
  for (const hash of ['_check_', '_itemIcon_', '_item_']) {
    assert.ok(!body.includes(hash), `the predicate must not couple to the host class hash ${hash}`)
  }
  assert.ok(body.includes('SPAN'), 'the wrapper test keys on the element name')
})
