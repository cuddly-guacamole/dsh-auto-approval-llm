const fs = require('fs')
const path = require('path')

function link(from, to) {
  const target = path.resolve(from)
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.symlinkSync(target, to, process.platform === 'win32' ? 'junction' : 'dir')
  const resolved = fs.realpathSync(to)
  console.log(`LINK ${to} -> ${target} (resolved=${resolved})`)
}

const repo = __dirname.replace(/\\/g, '/').replace(/\/scripts$/, '')
// Base directory holding the packed client bundles (p1/package, p2/package).
// No machine-specific default: pass it as argv[2] or set DSA_CLIENT_PACKS.
const base = process.env.DSA_CLIENT_PACKS ?? process.argv[2]
if (!base) {
  console.error('usage: node scripts/link-client-packs.cjs <packs-dir>   (or set DSA_CLIENT_PACKS)')
  process.exit(1)
}
const plan = [
  { from: path.resolve(base, 'p1', 'package'), to: path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives') },
  { from: path.resolve(base, 'p2', 'package'), to: path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots') },
]

// Validate every pack before touching any link: a symlink to a directory that
// is gone is created happily and only fails later, at resolution time.
const missing = plan.filter(({ from }) => !fs.existsSync(from)).map(({ from }) => from)
if (missing.length > 0) {
  console.error(`not found under the packs dir ${base}: ${missing.join(', ')}`)
  console.error('nothing was linked; unpack the packs (npm pack + extract) or pass the directory that holds p1/ and p2/')
  process.exit(1)
}

for (const { from, to } of plan) link(from, to)
console.log('done')
