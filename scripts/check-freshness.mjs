#!/usr/bin/env node
/**
 * Freshness guard for the link: development shape.
 *
 * The host loads lib/ straight from this working tree, so editing src/
 * without rebuilding leaves the running dsh (and any test that reads the
 * compiled output) looking at stale code. `npm test` rebuilds via pretest,
 * but a restart of dsh does not — this check is for exactly that moment.
 *
 * Exits non-zero when any compiled lib/ artifact is older than the newest
 * source file it depends on:
 *   - lib/index.js  vs src/index.ts + src/auto/*.ts
 *   - lib/client.js vs src/client/*.ts
 * Run: node scripts/check-freshness.mjs
 */
import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function newestMtime(paths) {
  let newest = 0
  let newestPath = ''
  const walk = (p) => {
    const stats = statSync(p)
    if (stats.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry))
      return
    }
    if (stats.mtimeMs > newest) {
      newest = stats.mtimeMs
      newestPath = p
    }
  }
  for (const p of paths) walk(join(root, p))
  return { newest, newestPath }
}

const checks = [
  { artifact: 'lib/index.js', sources: ['src/index.ts', 'src/auto'] },
  { artifact: 'lib/client.js', sources: ['src/client'] },
]

let stale = false
for (const { artifact, sources } of checks) {
  const built = statSync(join(root, artifact)).mtimeMs
  const { newest, newestPath } = newestMtime(sources)
  if (newest > built) {
    stale = true
    console.error(`STALE ${artifact}: source ${newestPath} is newer — run npx tsc -p tsconfig.json && npx tsdown, then restart dsh for host changes`)
  } else {
    console.log(`ok ${artifact}`)
  }
}
process.exit(stale ? 1 : 0)
