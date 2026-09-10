const fs = require('fs')
const path = require('path')

// Client build packs are npm-packed and linked separately (link-client-packs.cjs).
const CLIENT_BUILD_PACKS = new Set(['dsh-client-ui-primitives', 'dsh-client-ui-slots'])

const repo = __dirname.replace(/\\/g, '/').replace(/\/scripts$/, '')
const localDir = path.join(repo, 'node_modules', '@deepseek-ai')

// Directory holding the @deepseek-ai packages of the installed dsh CLI, e.g.
// <npm root -g>/@deepseek-ai/dsh/node_modules/@deepseek-ai
// Pointing the plugin's own copies at that tree keeps build-time types and the
// runtime resolution on the very same files instead of a stale local snapshot.
const base = process.env.DSA_DSH_DEPS ?? process.argv[2]
if (!base) {
  console.error('usage: node scripts/link-dsh-deps.cjs <dsh-@deepseek-ai-dir>   (or set DSA_DSH_DEPS)')
  process.exit(1)
}

const names = fs
  .readdirSync(localDir)
  .filter((name) => !CLIENT_BUILD_PACKS.has(name))
  .filter((name) => fs.existsSync(path.join(localDir, name, 'package.json')))

const plan = []
const missing = []
for (const name of names) {
  const target = path.join(base, name)
  if (fs.existsSync(path.join(target, 'package.json'))) plan.push({ name, target })
  else missing.push(name)
}

// Validate the whole set before touching anything: a half-linked tree is worse
// than an untouched one.
if (missing.length > 0) {
  console.error(`not found in the dsh install: ${missing.join(', ')}`)
  process.exit(1)
}

for (const { name, target } of plan) {
  const linkPath = path.join(localDir, name)
  fs.rmSync(linkPath, { recursive: true, force: true })
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  const version = JSON.parse(fs.readFileSync(path.join(linkPath, 'package.json'), 'utf8')).version
  console.log(`LINK ${name}@${version} -> ${target}`)
}
console.log(`done (${plan.length} packages)`)
