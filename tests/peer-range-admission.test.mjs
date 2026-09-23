/**
 * Peer-range admission contract. The five `@deepseek-ai/dsh-*` peers promise one
 * host line — `0.1.7-rc.1`, the line the user actually runs — and a single arm
 * `>=0.1.7-rc.1 <2` expresses it without reaching across a tuple: the floor and
 * the promised line share `0.1.7`, so semver's prerelease rule names the line
 * and every earlier tuple stays refused. Narrowing the floor is what drops
 * `0.1.7-alpha.2` and `0.1.5-rc.2` out of admission; both are pinned false
 * below, so a later relaxation of the range is caught here.
 *
 * Admission is nevertheless NOT a support claim: `<2` is only the range's upper
 * bound, untested lines inside the range are unsupported, and the support claim
 * lives in the one row of `HOST_LINES`.
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
const EXPECTED_RANGE = ">=0.1.7-rc.1 <2"

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
 * floor one tuple below would leave `0.1.7-rc.1` named by no comparator, and the
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
 * `semver` package. `0.1.7-alpha.2` sitting at false is the point of the
 * narrowing: that line is no longer supported, so it must no longer be
 * installable, and a later widening back across the tuple is caught here.
 */
const TRUTH_TABLE = [
  ["0.1.7-rc.1", true],
  ["0.1.7", true],
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

test("the range is one arm; dropping the second arm retired the alpha line", () => {
  assert.equal(EXPECTED_RANGE.split("||").length, 1)
  for (const [name, range] of dshPeers) {
    assert.equal(range.split("||").length, 1, `${name} grew a second arm`)
    assert.equal(satisfies("0.1.7-alpha.2", range), false, `${name} must refuse the retired alpha line`)
    assert.equal(satisfies("0.1.5-rc.2", range), false, `${name} must refuse the retired rc line`)
  }
})

test("the arm is one bounded comparator set whose floor names the promised line", () => {
  assert.match(EXPECTED_RANGE, /^>=[^ ]+ <\d+$/)
  for (const [name, range] of dshPeers) {
    assert.match(range, /^>=[^ ]+ <\d+$/, `${name} is not a single bounded arm`)
  }
  // The floor and the promise are the same host line: a floor that no longer
  // names the row in HOST_LINES would admit a line nobody supports, and a row
  // outside the floor would be refused at install time.
  assert.deepEqual(Object.keys(HOST_LINES), ["rc1"])
  const floor = EXPECTED_RANGE.split(" ")[0].slice(2)
  for (const [name, range] of dshPeers) assert.equal(range.split(" ")[0].slice(2), floor, `${name} floor drifted`)
  assert.equal(floor, HOST_LINES.rc1.version)
})

test("the peer block keeps cordis and schemastery outside the dsh contract", () => {
  assert.equal(manifest.peerDependencies[CORDIS_PEER], ">=4.0.1 <5")
  assert.equal(manifest.peerDependencies["@deepseek-ai/schemastery"], "^3.18.0")
})

test("the promised line is admitted by every peer", () => {
  for (const [name, range] of dshPeers) {
    assert.equal(satisfies(HOST_LINES.rc1.version, range), true, `${name} must admit ${HOST_LINES.rc1.version}`)
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
    for (const version of ["0.1.7-rc.2", "0.1.7", "0.1.9", "1.0.0", "1.9.9"]) {
      assert.equal(satisfies(version, range), true, `${name} must admit ${version}`)
    }
    for (const version of ["0.1.4", "0.1.4-rc.9", "2.0.0"]) {
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
