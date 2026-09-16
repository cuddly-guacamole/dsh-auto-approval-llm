/**
 * Host-line contract: the peer range promises 0.1.5-rc.2 (legacy shape) and
 * 0.1.6-alpha.1 (modern shape). This file pins the promised table, the exact
 * version pinning, the reverse controls that make a wrong-tree acceptance
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

test("the promised line table separates the legacy and modern shapes", () => {
  assert.deepEqual(Object.keys(HOST_LINES).sort(), ["alpha1", "rc2"])
  assert.equal(HOST_LINES.rc2.version, "0.1.5-rc.2")
  assert.equal(HOST_LINES.rc2.capability, "legacy")
  assert.equal(HOST_LINES.alpha1.version, "0.1.6-alpha.1")
  assert.equal(HOST_LINES.alpha1.capability, "modern")
})

test("every declared dsh peer is pinned exactly on both lines", () => {
  const peers = dshPeers()
  assert.ok(peers.length > 0, "the manifest declares no dsh peer")
  for (const line of Object.values(HOST_LINES)) {
    const manifest = scratchManifest(line, peers)
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), peers.slice().sort())
    assert.deepEqual(manifest.dependencies, manifest.overrides)
    for (const name of peers) assert.equal(manifest.dependencies[name], line.version)
  }
})

test("the installed-tree check rejects the other line and an empty tree", () => {
  const good = {
    "@deepseek-ai/cordis": "4.0.2",
    "@deepseek-ai/dsh-llm": HOST_LINES.rc2.version,
    "@deepseek-ai/dsh-session": HOST_LINES.rc2.version,
  }
  assert.deepEqual(assertInstalledLine(HOST_LINES.rc2, good), [
    "@deepseek-ai/dsh-llm@" + HOST_LINES.rc2.version,
    "@deepseek-ai/dsh-session@" + HOST_LINES.rc2.version,
  ].sort())
  mustReject("a tree on the other line", () => assertInstalledLine(HOST_LINES.rc2, { "@deepseek-ai/dsh-session": HOST_LINES.alpha1.version }))
  mustReject("a tree with no dsh package", () => assertInstalledLine(HOST_LINES.rc2, { "@deepseek-ai/cordis": "4.0.2" }))
})

test("the npm-tree check rejects problems and nested foreign copies", () => {
  const good = { dependencies: { "@deepseek-ai/dsh-session": { version: HOST_LINES.rc2.version } } }
  assert.deepEqual(assertTreeLine(HOST_LINES.rc2, good), ["@deepseek-ai/dsh-session@" + HOST_LINES.rc2.version])
  const nested = {
    dependencies: {
      "@deepseek-ai/dsh-tools": {
        version: HOST_LINES.rc2.version,
        dependencies: { "@deepseek-ai/dsh-session": { version: HOST_LINES.alpha1.version } },
      },
    },
  }
  mustReject("a nested copy on the other line", () => assertTreeLine(HOST_LINES.rc2, nested))
  mustReject("an npm problem list", () => assertTreeLine(HOST_LINES.rc2, { problems: ["extraneous: @deepseek-ai/dsh-llm"], dependencies: good.dependencies }))
  mustReject("an empty npm tree", () => assertTreeLine(HOST_LINES.rc2, { dependencies: {} }))
})

test("the capability check rejects the other branch", () => {
  assert.equal(assertCapability(HOST_LINES.alpha1, "modern"), "modern")
  mustReject("a legacy reading on the modern line", () => assertCapability(HOST_LINES.alpha1, "legacy"))
  mustReject("a modern reading on the legacy line", () => assertCapability(HOST_LINES.rc2, "modern"))
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
  assert.equal(observed.gateNames.includes("auto"), line.capability === "legacy")
  assert.equal(observed.gateNames.includes("auto-approval"), true)
})
