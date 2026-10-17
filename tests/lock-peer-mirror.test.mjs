/**
 * Contract for the lock's mirror of the manifest's peer block.
 *
 * `npm ci` resolves the installation from `package-lock.json`, and for the root
 * package the lock carries its own copy of `packages[""].peerDependencies`. That
 * copy is what the installer enforces: a peer edited in `package.json` alone
 * leaves the lock admitting the old range, so the manifest and the lock can
 * disagree about what this plugin installs against while every other test —
 * which reads the manifest — stays green.
 *
 * The same holds for the two `version` fields the lock repeats (the top-level
 * one and `packages[""].version`): they are the pair the release procedure bumps
 * together, and a lag in either is invisible until somebody publishes.
 *
 * These cases compare the lock against the manifest literally, field by field,
 * so any drift between the two files fails here rather than at install time.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))

/** The dsh peers this plugin declares; the rest of the peer block is out of scope. */
const DSH_PEER_NAMES = Object.keys(manifest.peerDependencies)
  .filter(name => name.startsWith("@deepseek-ai/dsh-"))
  .sort()

test("the lock's root peer block mirrors the manifest verbatim", () => {
  const rootPeers = lock.packages[""] && lock.packages[""].peerDependencies
  assert.ok(rootPeers !== undefined, "the lock's packages[\"\"] carries no peerDependencies block")
  // Verbatim on the whole block, not only the dsh entries: a peer added to the
  // manifest but not to the lock would otherwise pass, and that is exactly the
  // drift that lets `npm ci` admit a range the manifest no longer promises.
  assert.deepEqual(rootPeers, manifest.peerDependencies)
})

test("every dsh peer in the lock is byte-identical to the manifest's", () => {
  assert.equal(DSH_PEER_NAMES.length, 5, "the manifest no longer declares five dsh peers")
  const rootPeers = lock.packages[""] && lock.packages[""].peerDependencies
  assert.ok(rootPeers !== undefined, "the lock's packages[\"\"] carries no peerDependencies block")
  for (const name of DSH_PEER_NAMES) {
    assert.equal(
      rootPeers[name],
      manifest.peerDependencies[name],
      `the lock's ${name} peer disagrees with the manifest`,
    )
  }
  // The promise is one line, so every dsh peer carries one and the same range.
  // Pinned here as well as in the peer-range suite so that a lock edited alone
  // cannot describe a different admission surface than the manifest.
  const ranges = new Set(DSH_PEER_NAMES.map(name => rootPeers[name]))
  assert.deepEqual([...ranges], [manifest.peerDependencies[DSH_PEER_NAMES[0]]])
})

test("the lock's two version fields agree with the manifest", () => {
  // The release procedure bumps `package.json` and both lock fields together.
  // A lock that lags here does not fail `npm ci`, which is why nothing else
  // catches it.
  assert.equal(lock.version, manifest.version, "the lock's top-level version lags the manifest")
  assert.equal(lock.packages[""].version, manifest.version, "the lock's packages[\"\"].version lags the manifest")
})
