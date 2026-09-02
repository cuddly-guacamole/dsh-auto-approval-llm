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
link(path.join(base, 'p1', 'package'), path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives'))
link(path.join(base, 'p2', 'package'), path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots'))
console.log('done')
