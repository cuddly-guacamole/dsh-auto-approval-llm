/**
 * Host-line contract: the peer range promises the 0.1.7-alpha.1 line (the peer
 * floor) and the 0.1.7-alpha.2 line, both of the modern shape (`catalog` +
 * `registerAuto`). This file pins the promised table, the exact version
 * pinning, the reverse controls that make a wrong-tree acceptance
 * impossible, and the shipped preset composition. The last case drives the
 * locally installed host line through the real permission-presets service, so
 * the harness itself cannot rot into a pure fake.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  HOST_LINES,
  ROOT,
  assertCapability,
  assertInstalledLine,
  assertTreeLine,
  dshPeers,
  installedVersions,
  mustReject,
  packageEntry,
  presetTableFromPatch,
  probeInstalledLine,
  scratchManifest,
} from "../scripts/test-host-lines.mjs"

const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8")

/** A host line the manifest no longer promises; every reverse control uses it. */
const FOREIGN_LINE = { version: "0.1.6-alpha.2", capability: "modern" }

test("the promised line table carries the modern shape only", () => {
  assert.deepEqual(Object.keys(HOST_LINES).sort(), ["alpha3", "alpha4"])
  assert.equal(HOST_LINES.alpha3.version, "0.1.7-alpha.1")
  assert.equal(HOST_LINES.alpha3.capability, "modern")
  assert.equal(HOST_LINES.alpha4.version, "0.1.7-alpha.2")
  assert.equal(HOST_LINES.alpha4.capability, "modern")
})

test("every declared dsh peer is pinned exactly on the promised line", () => {
  const peers = dshPeers()
  assert.ok(peers.length > 0, "the manifest declares no dsh peer")
  for (const line of Object.values(HOST_LINES)) {
    const manifest = scratchManifest(line, peers)
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), peers.slice().sort())
    assert.deepEqual(manifest.dependencies, manifest.overrides)
    for (const name of peers) assert.equal(manifest.dependencies[name], line.version)
  }
})

test("a transitively floated dsh package is pinned by an override only", () => {
  const peers = dshPeers()
  const floated = "@deepseek-ai/dsh-agent"
  const manifest = scratchManifest(HOST_LINES.alpha3, peers, [floated])
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), peers.slice().sort())
  assert.equal(manifest.dependencies[floated], undefined)
  assert.equal(manifest.overrides[floated], HOST_LINES.alpha3.version)
  for (const name of peers) assert.equal(manifest.overrides[name], HOST_LINES.alpha3.version)
})

test("the installed-tree check rejects a foreign line and an empty tree", () => {
  const good = {
    "@deepseek-ai/cordis": "4.0.3",
    "@deepseek-ai/dsh-llm": HOST_LINES.alpha3.version,
    "@deepseek-ai/dsh-session": HOST_LINES.alpha3.version,
  }
  assert.deepEqual(assertInstalledLine(HOST_LINES.alpha3, good), [
    "@deepseek-ai/dsh-llm@" + HOST_LINES.alpha3.version,
    "@deepseek-ai/dsh-session@" + HOST_LINES.alpha3.version,
  ].sort())
  mustReject("a tree on the dropped line", () => assertInstalledLine(HOST_LINES.alpha3, { "@deepseek-ai/dsh-session": FOREIGN_LINE.version }))
  mustReject("a tree with no dsh package", () => assertInstalledLine(HOST_LINES.alpha3, { "@deepseek-ai/cordis": "4.0.3" }))
})

test("the npm-tree check rejects problems and nested foreign copies", () => {
  const good = { dependencies: { "@deepseek-ai/dsh-session": { version: HOST_LINES.alpha3.version } } }
  assert.deepEqual(assertTreeLine(HOST_LINES.alpha3, good), ["@deepseek-ai/dsh-session@" + HOST_LINES.alpha3.version])
  const nested = {
    dependencies: {
      "@deepseek-ai/dsh-tools": {
        version: HOST_LINES.alpha3.version,
        dependencies: { "@deepseek-ai/dsh-session": { version: FOREIGN_LINE.version } },
      },
    },
  }
  mustReject("a nested copy on a foreign line", () => assertTreeLine(HOST_LINES.alpha3, nested))
  mustReject("an npm problem list", () => assertTreeLine(HOST_LINES.alpha3, { problems: ["extraneous: @deepseek-ai/dsh-llm"], dependencies: good.dependencies }))
  mustReject("an empty npm tree", () => assertTreeLine(HOST_LINES.alpha3, { dependencies: {} }))
})

test("the capability check rejects the retired legacy reading", () => {
  assert.equal(assertCapability(HOST_LINES.alpha3, "modern"), "modern")
  mustReject("a legacy reading on the promised line", () => assertCapability(HOST_LINES.alpha3, "legacy"))
})

test("the preset table is read from the shipped composition", () => {
  const table = presetTableFromPatch(patch)
  assert.deepEqual(Object.keys(table), ["read-only", "workspace-write", "auto-approval", "danger-full-access"])
  assert.equal(table["auto-approval"].sandbox, "danger-full-access")
  assert.equal(table["auto-approval"].approval, "ask")
  assert.equal(table["auto-approval"].name, "Auto approval")
  assert.equal(table["danger-full-access"].sandbox, "danger-full-access")
  assert.equal(table["danger-full-access"].approval, "never")
  assert.equal(typeof table["auto-approval"].description, "string")
})

test("the locally installed host line drives the real service", async () => {
  const versions = installedVersions(ROOT)
  const local = versions["@deepseek-ai/dsh-permission-presets"]
  assert.ok(local !== undefined, "no @deepseek-ai/dsh-permission-presets is installed in the checkout")
  const line = Object.values(HOST_LINES).find(row => row.version === local)
  assert.ok(line !== undefined, "the installed dsh-permission-presets line is not promised: " + local)
  const observed = await probeInstalledLine({
    line,
    contextEntry: packageEntry(ROOT, "@deepseek-ai/cordis"),
    serviceEntry: packageEntry(ROOT, "@deepseek-ai/dsh-permission-presets"),
    migrationEntry: join(ROOT, "lib", "auto", "preset-migration.js"),
    presetTable: presetTableFromPatch(patch),
  })
  assert.equal(observed.capability, line.capability)
  assert.equal(observed.outcome, "migrated")
  assert.equal(observed.neverOutcome, "skipped")
  assert.deepEqual([...observed.gateNames], ["auto-approval"])
})
