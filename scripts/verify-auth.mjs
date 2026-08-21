// Runtime auth-boundary verification for dsh-auto-approval-llm (post-restart).
// Uses node:http (NOT fetch) so a forged Host header is actually sent.
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export const AUTH_HOST = '127.0.0.1'
export const AUTH_PORT = 3080
export const AUTH_ROUTE = '/_dsh/auto-approval-llm'

export const AUTH_CASES = [
  { name: 'loopback allowed (review-status, Host=127.0.0.1:3080)', path: '/review-status', headers: { host: '127.0.0.1:3080' }, expect: 200 },
  { name: 'loopback history allowed', path: '/history', headers: { host: '127.0.0.1:3080' }, expect: 200 },
  { name: 'cross-site sec-fetch-site denied', path: '/review-status', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, expect: 403 },
  { name: 'cross-origin Origin denied', path: '/review-status', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }, expect: 403 },
  { name: 'forged non-loopback Host (not in whitelist) denied', path: '/history', headers: { host: '1.2.3.4:3080' }, expect: 403 },
  { name: 'forged Host + cross-site Origin denied', path: '/history', headers: { host: '1.2.3.4:3080', origin: 'http://9.9.9.9:9999' }, expect: 403 },
]

function get(path, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: AUTH_HOST, port: AUTH_PORT, path: AUTH_ROUTE + path, method: 'GET', headers }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', (e) => resolve('ERR:' + e.message))
    req.end()
  })
}

export async function runAuthChecks(cases = AUTH_CASES) {
  const results = []
  let pass = 0
  let fail = 0
  for (const c of cases) {
    const status = await get(c.path, c.headers)
    const ok = status === c.expect
    results.push({ name: c.name, status, expect: c.expect, ok })
    if (ok) pass++
    else fail++
  }
  return { pass, fail, results }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { pass, fail, results } = await runAuthChecks()
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  -> ${r.status} (expect ${r.expect})`)
  console.log(`\nAUTH SUMMARY: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}
