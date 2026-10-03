// The Auto glyph must read as one of the official access-mode item glyphs:
// same shield outline, same regular weight, same 14px box. The geometry is
// asserted as hard containment rather than as a string match, because the
// failure this guards is geometric — official 16-unit geometry pushed into a
// 14-unit canvas clips the shield tip at y=14.5779.
//
// Where the pinned constant comes from, and what it does NOT do:
//   - OFFICIAL_SHIELD is a frozen snapshot of the host bundle
//     dist/assets/index-DjTxlw_T.js, the asset the installed
//     @deepseek-ai/dsh-web-frontend shipped at the time this batch ran
//     (2026-10-03). The offset below is a CHARACTER offset, not a byte
//     offset: that file is not pure ASCII, and the two differ by 6 at this
//     point (char 406447 = byte 406453). Slicing by byte would land elsewhere.
//   - This suite deliberately does NOT read the host bundle. It has to run on
//     any machine, and a test coupled to dist turns a host upgrade from a
//     silent staleness into a spurious red. When the host upgrades, re-verify
//     the constant by hand and update this snapshot deliberately.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SHIELD_PATH, BOLT_PATH } from '../lib/client/auto-icon.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconBundle = readFileSync(join(root, 'lib/client/auto-icon.js'), 'utf8')
const indexBundle = readFileSync(join(root, 'lib/client/index.js'), 'utf8')

// The official dsh-web-frontend access-mode shield outline, taken verbatim from
// dist/assets/index-DjTxlw_T.js at CHARACTER offset 406447 (byte offset 406453 —
// that file is not pure ASCII). Regular weight (stroke-width 1).
const OFFICIAL_SHIELD = 'M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z'

// ── path geometry: exact bbox for the M/L/H/V/C/Z subset these glyphs use ──
// Curve extrema come from the derivative of each cubic axis, so a control
// point outside the box can never hide behind an approximate hull.
const TOKEN = /[MmLlHhVvCcZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g

function pathBBox(d) {
  const tokens = d.match(TOKEN) ?? []
  let i = 0
  let cmd = ''
  let x = 0; let y = 0; let sx = 0; let sy = 0
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  const add = (px, py) => {
    if (px < x0) x0 = px
    if (px > x1) x1 = px
    if (py < y0) y0 = py
    if (py > y1) y1 = py
  }
  const n = () => Number(tokens[i++])
  const cubicAxis = (p0, p1, p2, p3) => {
    const a = -p0 + 3 * p1 - 3 * p2 + p3
    const b = 2 * (p0 - 2 * p1 + p2)
    const c = -p0 + p1
    const at = (t) => {
      const u = 1 - t
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
    }
    const roots = []
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) roots.push(-c / b)
    } else {
      const disc = b * b - 4 * a * c
      if (disc >= 0) {
        const sq = Math.sqrt(disc)
        roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a))
      }
    }
    return roots.filter((t) => t > 0 && t < 1).map(at)
  }
  while (i < tokens.length) {
    if (/^[MmLlHhVvCcZz]$/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const c = cmd.toUpperCase()
    if (c === 'Z') { x = sx; y = sy; continue }
    if (c === 'M' || c === 'L') {
      const a = n(); const b = n()
      x = rel ? x + a : a
      y = rel ? y + b : b
      if (c === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L' }
      add(x, y)
      continue
    }
    if (c === 'H') { x = rel ? x + n() : n(); add(x, y); continue }
    if (c === 'V') { y = rel ? y + n() : n(); add(x, y); continue }
    if (c === 'C') {
      const ax = rel ? x + n() : n(); const ay = rel ? y + n() : n()
      const bx = rel ? x + n() : n(); const by = rel ? y + n() : n()
      const cx = rel ? x + n() : n(); const cy = rel ? y + n() : n()
      add(x, y); add(cx, cy)
      for (const v of cubicAxis(x, ax, bx, cx)) add(v, y)
      for (const v of cubicAxis(y, ay, by, cy)) add(x, v)
      x = cx; y = cy
      continue
    }
    throw new Error(`unsupported path command "${cmd}"`)
  }
  return { x0, y0, x1, y1 }
}

// Hard containment: every rendered point of the path lies inside the box.
function assertWithinViewBox(label, d, viewBox) {
  const [vx, vy, vw, vh] = viewBox.split(/\s+/).map(Number)
  assert.ok(vw > 0 && vh > 0, `${label}: the viewBox ${viewBox} must be readable`)
  const b = pathBBox(d)
  assert.ok(b.x0 >= vx && b.y0 >= vy && b.x1 <= vx + vw && b.y1 <= vy + vh,
    `${label} bbox x[${b.x0.toFixed(4)}, ${b.x1.toFixed(4)}] y[${b.y0.toFixed(4)}, ${b.y1.toFixed(4)}] must be inside viewBox ${viewBox}`)
  return b
}

// Reads the attributes of the svg element that carries `needle`, in either
// form the two surfaces use: an innerHTML string tag, or a React props object.
// The anchor is the svg open tag itself, so a `strokeWidth` sitting on a child
// path cannot be mistaken for the svg's own attributes.
function svgAttrs(source, needle) {
  const at = source.indexOf(needle)
  assert.notEqual(at, -1, `must locate ${needle}`)
  const before = source.slice(0, at)
  const anchors = ['<svg', "createElement('svg'", 'createElement("svg"']
    .map((marker) => before.lastIndexOf(marker))
    .filter((p) => p !== -1)
  assert.notEqual(anchors.length, 0, `must locate the svg element carrying ${needle}`)
  const open = source.slice(Math.max(...anchors), at)
  const out = {}
  for (const m of open.matchAll(/([a-zA-Z]+)\s*:\s*(?:'([^']*)'|([-\d.]+))/g)) out[m[1]] = m[2] ?? m[3]
  for (const m of open.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

test('official glyph: the shield outline is the official access-mode outline, verbatim', () => {
  assert.equal(SHIELD_PATH, OFFICIAL_SHIELD, 'SHIELD_PATH must be the official outline byte for byte')
  assert.ok(iconBundle.includes(OFFICIAL_SHIELD), 'the compiled glyph must carry the official outline')
})

test('official glyph: the stroke weight is the host regular weight of 1', () => {
  assert.ok(iconBundle.includes('stroke-width="1"'), 'the menu glyph path is stroked at 1')
  // `1\b` would also match "1.31831", because a dot is a word boundary: the
  // weight has to be rejected before a dot, a digit or a letter follows it.
  assert.ok(/strokeWidth:\s*1(?![.\w])/.test(indexBundle), 'the session chip path is stroked at 1')
  // The retired stroke weight and both retired outline fragments: a second
  // copy of any of them is a geometry drift waiting to happen.
  const offenders = [
    { needle: '1.31831', what: 'stroke weight' },
    { needle: 'M8.20554 0.899994', what: 'pre-alignment shield outline' },
    { needle: 'M8.75 3.65', what: 'pre-alignment bolt outline' },
  ]
  // Only what ships is scanned. This repository git-ignores everything outside
  // a whitelist, so the knowledge base (`.agents`), the harness state and
  // evidence (`.dsh`), the build output (`lib`) and third-party code are off the
  // ship path — and each of them is where the retired values legitimately
  // survive as history rather than as code.
  const notShipped = ['node_modules', 'lib', '.git', '.agents', '.dsh']
  const self = fileURLToPath(import.meta.url)
  for (const { needle, what } of offenders) {
    const hits = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (notShipped.includes(entry)) continue
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (/\.(ts|mjs|js|tsx|json|md|html|css)$/.test(entry) && readFileSync(full, 'utf8').includes(needle)) hits.push(full)
      }
    }
    walk(root)
    // This file names the retired values in order to search for them.
    const live = hits.filter((h) => h !== self)
    assert.deepEqual(live, [], `the retired ${what} must not survive in the shipped tree`)
  }
})

test('official glyph: the menu glyph renders 14x14 on a 16-unit viewBox', () => {
  const attrs = svgAttrs(iconBundle, 'stroke-width="1"')
  assert.equal(attrs.width, '14', 'the menu svg width')
  assert.equal(attrs.height, '14', 'the menu svg height')
  assert.equal(attrs.viewBox, '0 0 16 16', 'a 14-unit viewBox would clip the shield tip at y=14.5779')
  assert.ok(iconBundle.includes('.dsa-autoIcon {'), 'the icon container rule must exist')
  const rule = iconBundle.slice(iconBundle.indexOf('.dsa-autoIcon {'), iconBundle.indexOf('.dsa-autoIcon {') + 220)
  assert.ok(/width:\s*14px/.test(rule), 'the icon container is 14px wide')
  assert.ok(/height:\s*14px/.test(rule), 'the icon container is 14px tall')
  assert.ok(rule.includes('var(--dsw-alias-menu-icon'), 'the glyph takes the official menu-icon color')
  assert.ok(!rule.includes('--dsw-alias-label-tertiary'), 'the retired tertiary label color must be gone')
})

test('official glyph: every glyph path fits inside the viewBox it is rendered on', () => {
  // The box comes from the rendered svg, not from a value typed here, so
  // shrinking the viewBox under the official geometry turns this red.
  const rendered = svgAttrs(iconBundle, 'stroke-width="1"').viewBox
  const shield = assertWithinViewBox('shield', SHIELD_PATH, rendered)
  const bolt = assertWithinViewBox('bolt', BOLT_PATH, rendered)
  // The geometric fact that forces the 16-unit viewBox. If it ever drops to 14
  // the tip is gone, so this is asserted rather than assumed.
  assert.ok(shield.y1 > 14, `the shield tip reaches ${shield.y1.toFixed(4)}, past the 14-unit edge`)
  // The bolt must sit inside the shield outline with room for the 1-unit stroke.
  const cavity = { x0: shield.x0 + 0.5, y0: shield.y0 + 0.5, x1: shield.x1 - 0.5, y1: shield.y1 - 0.5 }
  assert.ok(bolt.x0 >= cavity.x0 && bolt.x1 <= cavity.x1 && bolt.y0 >= cavity.y0 && bolt.y1 <= cavity.y1,
    `the bolt must stay inside the shield cavity x[${cavity.x0.toFixed(4)}, ${cavity.x1.toFixed(4)}] y[${cavity.y0.toFixed(4)}, ${cavity.y1.toFixed(4)}]`)
})

test('official glyph: the session chip renders the same geometry at 14px', () => {
  const at = indexBundle.indexOf('strokeWidth: 1')
  assert.notEqual(at, -1, 'the chip path must be stroked at the regular weight')
  const attrs = svgAttrs(indexBundle, 'strokeWidth: 1')
  assert.equal(attrs.width, '14', 'the chip svg width')
  assert.equal(attrs.height, '14', 'the chip svg height')
  assert.equal(attrs.viewBox, '0 0 16 16', 'the chip keeps the 16-unit viewBox')
  assertWithinViewBox('chip shield', SHIELD_PATH, attrs.viewBox)
  assertWithinViewBox('chip bolt', BOLT_PATH, attrs.viewBox)
})

test('official glyph: the trigger size modifier is retired with the size it pinned', () => {
  // Menu and trigger are both 14px now, so a per-kind size argument and a
  // modifier class that only re-stated 14px would be two owners of one value.
  assert.ok(!iconBundle.includes('dsa-autoIconTrigger'), 'the trigger modifier class must be gone')
  assert.ok(!iconBundle.includes('createAutoGlyph(document,'), 'createAutoGlyph must not take a per-kind size')
  assert.ok(iconBundle.includes("createAutoGlyph(document)"), 'the glyph is built at one size')
})
