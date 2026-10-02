/**
 * Peer-range admission contract. The five `@deepseek-ai/dsh-*` peers promise one
 * host line per tuple — `0.2.0-rc.2`, the line the user actually runs — through
 * a single arm `>=0.2.0-rc.2 <2`.
 *
 * The host evaluates peers with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
 * (`dsh-app-boot/lib/index.js:300`). The arm used to sit one tuple below the
 * promised line, so the flag was load-bearing: the plain reading — the rule
 * implemented by `satisfies()` below, where a prerelease must be named by a
 * comparator in its own major.minor.patch tuple — refused a promised line whose
 * tuple no comparator carried. The floor is now the promised line itself, which
 * shares its tuple, so both readings admit it and the flag carries nothing for
 * this package. That is asserted here rather than assumed, so widening the arm
 * back across a tuple without re-reading this case is caught.
 *
 * Raising the floor to the promised line is what drops `0.1.7-rc.2`,
 * `0.1.7-rc.1`, `0.1.7-alpha.2` and `0.1.5-rc.2` out of admission; all four are
 * pinned false below, so a later relaxation of the range is caught here.
 *
 * Admission is nevertheless NOT a support claim: `<2` is only the range's upper
 * bound, untested lines inside the range are unsupported, and the support claim
 * lives in the rows of `HOST_LINES`.
 *
 * This file reads the real `package.json` literal instead of a private copy, so
 * that any edit to the peer range must edit this file too. The satisfaction
 * check below is a local implementation of the ordinary semver rule (each
 * comparator set must match, and a prerelease candidate must be named by a
 * comparator whose version carries the same major.minor.patch tuple); it is
 * cross-checked against the installed `semver` package when one is resolvable,
 * so the hand-rolled path cannot drift away from the real resolution rule.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { HOST_LINES } from "../scripts/test-host-lines.mjs"

const ROOT = process.cwd()

/** The admission range promised by the dsh peers. */
const EXPECTED_RANGE = ">=0.2.0-rc.2 <2"

/** Application-level peer that is not a host line and is not part of this contract. */
const CORDIS_PEER = "@deepseek-ai/cordis"

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) =>
  name.startsWith("@deepseek-ai/dsh-"),
)

/** `1`, `1.0` and `1.0.0` all denote the same release; the operators may omit parts. */
const RELEASE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/
const COMPARATOR = /^(>=|<=|>|<|=)?(.*)$/

/**
 * The ordinary semver rule, hand-rolled: a comparator set matches only when
 * every comparator matches, and a prerelease candidate additionally needs one
 * comparator in the set whose version carries the same major.minor.patch tuple.
 * That extra rule is why the floor has to sit inside the promised tuple — a
 * floor one tuple below would leave `0.1.7-rc.2` named by no comparator, and the
 * line would be silently refused at install time.
 */
function satisfies(version, range) {
  const candidate = parse(version)
  return range
    .split("||")
    .map(set => set.trim())
    .some(set => {
      const comparators = set.split(/\s+/).filter(Boolean).map(text => {
        const [, operator, operand] = COMPARATOR.exec(text)
        return { operator: operator ?? "=", target: parse(operand) }
      })
      if (!comparators.every(comparator => matches(candidate, comparator))) return false
      if (candidate.prerelease.length === 0) return true
      const tuple = `${candidate.major}.${candidate.minor}.${candidate.patch}`
      // Both halves are load-bearing: the comparator must carry the same tuple
      // *and* be a prerelease itself. A release bound such as `<2` shares the
      // tuple with `2.0.0-0` but names no prerelease, so it does not admit it.
      return comparators.some(
        comparator =>
          comparator.target.prerelease.length > 0 &&
          `${comparator.target.major}.${comparator.target.minor}.${comparator.target.patch}` === tuple,
      )
    })
}

function parse(text) {
  const match = RELEASE.exec(text)
  if (!match) throw new Error(`unsupported version: ${text}`)
  return {
    major: +match[1],
    minor: match[2] === undefined ? 0 : +match[2],
    patch: match[3] === undefined ? 0 : +match[3],
    prerelease: match[4] === undefined ? [] : match[4].split(".").map(part => (/^\d+$/.test(part) ? +part : part)),
  }
}

function matches(candidate, comparator) {
  const order = compare(candidate, comparator.target)
  switch (comparator.operator) {
    case ">=":
      return order >= 0
    case "<=":
      return order <= 0
    case ">":
      return order > 0
    case "<":
      return order < 0
    default:
      return order === 0
  }
}

function compare(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = typeof a === "number"
    const bNumeric = typeof b === "number"
    if (aNumeric && bNumeric) return a < b ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

/**
 * The truth table the single arm must produce, measured against the installed
 * `semver` package. `0.1.7-rc.2` — the line the promise used to span alongside
 * `0.2.0` — sitting at false is the point of the raise: it is not promised any
 * more, so it must not stay installable, and a later lowering back across the
 * tuple is caught here.
 */
const TRUTH_TABLE = [
  ["0.2.0-rc.2", true],
  ["0.1.7-rc.2", false],
  ["0.1.7-rc.1", false],
  ["0.1.7", false],
  ["0.2.0", true],
  ["1.9.9", true],
  ["0.1.7-alpha.2", false],
  ["0.1.7-alpha.1", false],
  ["0.1.6", false],
  ["0.1.6-alpha.1", false],
  ["2.0.0", false],
  ["0.1.5-rc.2", false],
]

test("the five dsh peers carry the promised single-arm admission range", () => {
  assert.equal(dshPeers.length, 5)
  assert.deepEqual(
    dshPeers.map(([name]) => name).sort(),
    [
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-permission-presets",
      "@deepseek-ai/dsh-session",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-user-approval",
    ],
  )
  for (const [name, range] of dshPeers) {
    assert.equal(range, EXPECTED_RANGE, `${name} peer range drifted`)
  }
})

test("the range is one arm; dropping the second arm retired the lines below the floor", () => {
  assert.equal(EXPECTED_RANGE.split("||").length, 1)
  for (const [name, range] of dshPeers) {
    assert.equal(range.split("||").length, 1, `${name} grew a second arm`)
    // `0.1.7-rc.2` left the promise with this range: the floor rose onto the
    // promised `0.2.0` line, so the line it used to sit below is now refused.
    assert.equal(satisfies("0.1.7-rc.2", range), false, `${name} must refuse the dropped 0.1.7 line`)
    assert.equal(satisfies("0.1.7-alpha.2", range), false, `${name} must refuse the retired alpha line`)
    assert.equal(satisfies("0.1.5-rc.2", range), false, `${name} must refuse the retired rc line`)
  }
})

test("the arm is one bounded comparator set whose floor names the lowest promised line", () => {
  assert.match(EXPECTED_RANGE, /^>=[^ ]+ <\d+$/)
  for (const [name, range] of dshPeers) {
    assert.match(range, /^>=[^ ]+ <\d+$/, `${name} is not a single bounded arm`)
  }
  // The floor is the *lowest* promised line, not every promised line. It is the
  // only one here, so the two coincide — but the rule is what is pinned: a
  // floor that rose above a promised line would refuse it at install time; a
  // promised line below the floor is the same failure seen from the other side.
  const floor = EXPECTED_RANGE.split(" ")[0].slice(2)
  for (const [name, range] of dshPeers) assert.equal(range.split(" ")[0].slice(2), floor, `${name} floor drifted`)
  const promised = Object.values(HOST_LINES).map(line => line.version)
  assert.equal(floor, promised.slice().sort()[0], "the floor is not the lowest promised line: " + promised.join(", "))
  for (const version of promised) {
    assert.ok(compare(parse(version), parse(floor)) >= 0, version + " is promised but sits below the floor " + floor)
  }
})

test("the floor is the promised line, so the plain reading admits it without the flag", () => {
  // The host calls `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
  // The promise used to sit a tuple above the floor, which made that flag
  // load-bearing: the plain rule — the one implemented above, and the one any
  // consumer that forgets the flag would apply — refused the promised line. The
  // floor is now the promised line itself, so it shares the floor's tuple and
  // the plain rule admits it too. Asserted rather than assumed: a future line
  // appended in a higher tuple makes `plainOnly` non-empty and turns this case
  // red until the arm is widened to name that tuple or the fact is re-stated.
  const require_ = createRequire(join(ROOT, "package.json"))
  const reference = (() => {
    try {
      return require_("semver")
    } catch {
      return null
    }
  })()
  const promised = Object.values(HOST_LINES).map(line => line.version)
  const plainOnly = promised.filter(version => !satisfies(version, EXPECTED_RANGE))
  assert.deepEqual(
    plainOnly,
    [],
    "a promised line is refused by the plain reading; the arm no longer spans the promise by the flag alone",
  )
  for (const [name, range] of dshPeers) {
    for (const version of promised) {
      assert.equal(satisfies(version, range), true, `${name} must admit ${version} without the flag`)
      if (reference === null) continue
      assert.equal(reference.satisfies(version, range), true, `${name}: semver admits ${version} without the flag`)
      // The host's own reading stays pinned for every promised line, so a host
      // that stopped passing the flag is a red suite rather than a refused
      // install nobody sees.
      assert.equal(
        reference.satisfies(version, range, { includePrerelease: true }),
        true,
        `${name} must admit the promised line ${version} under the host's flagged reading`,
      )
    }
  }
  // The flag is real, not decorative: a prerelease in a tuple no comparator
  // names is admitted only because the host passes it. Nothing is promised in
  // that tuple today, so this is a property of the range, not a support claim.
  if (reference === null) return
  for (const [name, range] of dshPeers) {
    assert.equal(reference.satisfies("0.3.0-alpha.1", range, { includePrerelease: true }), true, `${name} must admit a higher-tuple prerelease under the flagged reading`)
    assert.equal(satisfies("0.3.0-alpha.1", range), false, `${name} must refuse a higher-tuple prerelease under the plain reading`)
  }
})

test("the peer block keeps cordis and schemastery outside the dsh contract", () => {
  assert.equal(manifest.peerDependencies[CORDIS_PEER], ">=4.0.1 <5")
  assert.equal(manifest.peerDependencies["@deepseek-ai/schemastery"], "^3.18.0")
})

test("every promised line is admitted by every peer under the host's reading", () => {
  const require_ = createRequire(join(ROOT, "package.json"))
  let reference = null
  try {
    reference = require_("semver")
  } catch {
    return
  }
  for (const [name, range] of dshPeers) {
    for (const line of Object.values(HOST_LINES)) {
      assert.equal(
        reference.satisfies(line.version, range, { includePrerelease: true }),
        true,
        `${name} must admit ${line.version} the way the host evaluates peers`,
      )
    }
  }
})

test("the single arm admits the promised line and the releases above it", () => {
  for (const [name, range] of dshPeers) {
    for (const [version, expected] of TRUTH_TABLE) {
      assert.equal(satisfies(version, range), expected, `${name} must ${expected ? "admit" : "refuse"} ${version}`)
    }
    assert.equal(satisfies("0.1.7-alpha.2", range), false, `${name} must not admit the retired alpha line`)
  }
})

test("the refused prerelease tuples below the floor stay refused", () => {
  for (const [name, range] of dshPeers) {
    for (const version of ["0.1.7-rc.0", "0.1.7-beta.1", "0.1.6-rc.1", "1.9.9-alpha.1", "2.0.0-0"]) {
      assert.equal(satisfies(version, range), false, `${name} must refuse ${version}`)
    }
  }
})

test("the range admits untested middle lines; admission is not support", () => {
  for (const [name, range] of dshPeers) {
    for (const version of ["0.2.0", "0.2.1", "1.0.0", "1.9.9"]) {
      assert.equal(satisfies(version, range), true, `${name} must admit ${version}`)
    }
    for (const version of ["0.1.9", "0.1.7-rc.2", "0.1.4", "0.1.4-rc.9", "1.9.9-alpha.1", "2.0.0"]) {
      assert.equal(satisfies(version, range), false, `${name} must refuse ${version}`)
    }
  }
})

test("the local satisfaction check agrees with the installed semver package", () => {
  const require_ = createRequire(join(ROOT, "package.json"))
  let reference = null
  try {
    reference = require_("semver")
  } catch {
    return
  }
  const versions = [
    ...TRUTH_TABLE.map(([version]) => version),
    "0.1.7-rc.0",
    "0.1.7-rc.2",
    "0.1.7-beta.1",
    "0.1.6-rc.1",
    "0.1.4",
    "0.1.4-rc.9",
    "0.1.9",
    "1.0.0",
    "1.9.9-alpha.1",
    "2.0.0-0",
  ]
  for (const version of versions) {
    for (const [name, range] of dshPeers) {
      assert.equal(
        satisfies(version, range),
        reference.satisfies(version, range),
        `satisfies(${version}) disagrees with semver for ${name}`,
      )
    }
  }
})
