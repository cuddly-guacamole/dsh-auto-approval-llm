// The session title-bar chip shows a check for a settled allow and a cross for
// a settled reject, in one slot. The check was authored on a 16-unit canvas and
// rendered on a 14-unit viewBox, where the svg's default hidden overflow
// cropped 1.0498u off the long arm's tip; the cross, authored for 14 units, was
// the one glyph that survived intact. Both now sit on the 16-unit canvas the
// shield chip already uses, at one perceived size.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib/client/index.js'), 'utf8')

// Exact bbox for the M/L/H/V/C/Z subset these glyphs use; curve extrema come
// from the derivative of each cubic axis, so no control point can hide outside
// an approximate hull.
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
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
}

function constant(name) {
  const m = new RegExp(`const ${name} = '([^']*)'`).exec(bundle)
  assert.notEqual(m, null, `must locate ${name}`)
  return m[1]
}

// The svg that carries the settled icon, read from the compiled bundle so the
// box under test is the one the renderer gets.
function settledSvg() {
  const at = bundle.indexOf('SETTLED_CHECK_PATH : SETTLED_CLOSE_PATH')
  assert.notEqual(at, -1, 'the settled chip must select between the check and the cross')
  const before = bundle.slice(0, at)
  const start = before.lastIndexOf("createElement('svg'")
  assert.notEqual(start, -1, 'the settled icon must sit in an svg element')
  const open = bundle.slice(start, at)
  const out = {}
  for (const m of open.matchAll(/([a-zA-Z]+)\s*:\s*(?:'([^']*)'|([-\d.]+))/g)) out[m[1]] = m[2] ?? m[3]
  return out
}

test('session status chip: both settled glyphs render on one viewBox', () => {
  const attrs = settledSvg()
  assert.equal(attrs.viewBox, '0 0 16 16', 'the check and the cross must share one coordinate system')
  assert.equal(attrs.width, '14')
  assert.equal(attrs.height, '14')
})

test('session status chip: both settled glyphs fit inside that viewBox', () => {
  const attrs = settledSvg()
  const [vx, vy, vw, vh] = attrs.viewBox.split(/\s+/).map(Number)
  for (const name of ['SETTLED_CHECK_PATH', 'SETTLED_CLOSE_PATH']) {
    const b = pathBBox(constant(name))
    assert.ok(b.x0 >= vx && b.y0 >= vy && b.x1 <= vx + vw && b.y1 <= vy + vh,
      `${name} bbox x[${b.x0.toFixed(4)}, ${b.x1.toFixed(4)}] y[${b.y0.toFixed(4)}, ${b.y1.toFixed(4)}] must be inside viewBox ${attrs.viewBox}`)
  }
})

test('session status chip: the cross kept the size it always rendered at', () => {
  // The cross is the un-cropped glyph, so its rendered size is the baseline.
  // It was authored on 14 units into a 14px box (1 px/unit) and is now 16/14
  // larger units into the same box (14/16 px/unit).
  const b = pathBBox(constant('SETTLED_CLOSE_PATH'))
  const unit = Number(settledSvg().width) / 16
  assert.ok(Math.abs(b.w * unit - 7.2147) < 0.001,
    `the cross must render 7.2147px wide, got ${(b.w * unit).toFixed(4)}px`)
  assert.ok(!bundle.includes('const CLOSE_PATH ='), 'the 14-unit cross constant is replaced, not shadowed')
})

test('session status chip: the check and the cross read as one pair', () => {
  const check = pathBBox(constant('SETTLED_CHECK_PATH'))
  const close = pathBBox(constant('SETTLED_CLOSE_PATH'))
  // Ink widths are equal by construction; the heights differ because the check
  // is a diagonal stroke, which is why width is the sizing axis.
  assert.ok(Math.abs(check.w - close.w) < 0.001,
    `ink widths must match, got check ${check.w.toFixed(4)} vs cross ${close.w.toFixed(4)}`)
  for (const [name, b] of [['check', check], ['cross', close]]) {
    const cx = (b.x0 + b.x1) / 2
    const cy = (b.y0 + b.y1) / 2
    assert.ok(Math.abs(cx - 8) < 0.001 && Math.abs(cy - 8) < 0.001,
      `the ${name} must sit centred on the canvas, got (${cx.toFixed(4)}, ${cy.toFixed(4)})`)
  }
})
