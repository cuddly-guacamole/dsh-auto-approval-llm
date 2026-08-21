const fs = require('fs')
const path = require('path')

function link(from, to) {
  const target = path.resolve(from)
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.symlinkSync(target, to, 'junction')
  const resolved = fs.realpathSync(to)
  console.log(`LINK ${to} -> ${target} (resolved=${resolved})`)
}

const repo = __dirname.replace(/\\/g, '/').replace(/\/scripts$/, '')
const base = 'C:/tmp/dsa-client-packs'
link(path.join(base, 'p1', 'package'), path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives'))
link(path.join(base, 'p2', 'package'), path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots'))
console.log('done')
