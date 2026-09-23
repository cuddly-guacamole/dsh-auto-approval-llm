/**
 * Contract for the npm-tree line check in the host-line harness. npm renders an
 * optional peer that was never installed as an empty node — no `version` and no
 * `problem` — so the line check has to skip exactly that shape instead of
 * reading it as a copy that resolved to "undefined". The relaxation is narrow
 * on purpose: a node carrying a `problem` is a real failure and a node carrying
 * a `version` is a resolved copy, so both keep the old verdict. Every case here
 * feeds constructed `npm ls --all --json` data straight into `assertTreeLine`,
 * so no case needs a real install.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { HOST_LINES, assertTreeLine } from "../scripts/test-host-lines.mjs"

const line = HOST_LINES.alpha3
const PEER = "@deepseek-ai/dsh-agent"
const WORKSPACE = "@deepseek-ai/dsh-workspace"
const FOREIGN = "0.1.6-alpha.2"

/** The shape npm emits for an optional peer of the line that is not installed. */
const optionalPeerNode = {}

test("an uninstalled optional peer node is skipped, not read as a foreign copy", () => {
  const tree = {
    dependencies: {
      [PEER]: { version: line.version, dependencies: { [WORKSPACE]: optionalPeerNode } },
      "@deepseek-ai/dsh-session": { version: line.version },
    },
  }
  assert.deepEqual(assertTreeLine(line, tree), [
    "@deepseek-ai/dsh-session@" + line.version,
    PEER + "@" + line.version,
  ].sort())
  // The skip changes nothing else: stripping the version off the top-level node
  // still throws, so the empty node is tolerated only in its exact shape.
  assert.throws(
    () => assertTreeLine(line, { dependencies: { [PEER]: { dependencies: { [WORKSPACE]: optionalPeerNode } } } }),
    /the npm tree carries no @deepseek-ai\/dsh-\* package/,
  )
})

test("an optional peer node carrying a problem still fails the line", () => {
  const tree = {
    dependencies: {
      [PEER]: { version: line.version, dependencies: { [WORKSPACE]: { problem: "missing: @deepseek-ai/dsh-workspace@0.1.7-alpha.1, required by @deepseek-ai/dsh-agent@" + line.version } } },
    },
  }
  assert.throws(
    () => assertTreeLine(line, tree),
    new RegExp(WORKSPACE.replace(/[/@]/g, m => "\\" + m) + " resolves to undefined somewhere in the tree"),
  )
})

test("an unversioned node that is not shaped like a peer node still fails the line", () => {
  const nulled = { dependencies: { [PEER]: { version: line.version, dependencies: { [WORKSPACE]: null } } } }
  assert.throws(() => assertTreeLine(line, nulled), /resolves to (null|undefined) somewhere in the tree/)
  const arrayed = { dependencies: { [PEER]: { version: line.version, dependencies: { [WORKSPACE]: [] } } } }
  assert.throws(() => assertTreeLine(line, arrayed), /resolves to undefined somewhere in the tree/)
})

test("a node with a version off the line still fails the line", () => {
  const nested = {
    dependencies: {
      [PEER]: { version: line.version, dependencies: { [WORKSPACE]: { version: FOREIGN } } },
    },
  }
  assert.throws(() => assertTreeLine(line, nested), /resolves to 0\.1\.6-alpha\.2 somewhere in the tree/)
  // A mismatching copy is not rescued by an explicit `problem: undefined`,
  // which is the value the guard compares against.
  const explicit = {
    dependencies: {
      [PEER]: { version: line.version, dependencies: { [WORKSPACE]: { version: FOREIGN, problem: undefined } } },
    },
  }
  assert.throws(() => assertTreeLine(line, explicit), /resolves to 0\.1\.6-alpha\.2 somewhere in the tree/)
})

test("a node with a version on the line passes alongside the skipped peer node", () => {
  const tree = {
    dependencies: {
      [PEER]: { version: line.version, dependencies: { [WORKSPACE]: optionalPeerNode } },
    },
  }
  assert.deepEqual(assertTreeLine(line, tree), [PEER + "@" + line.version])
})
