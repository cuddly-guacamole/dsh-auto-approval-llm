// Runtime auth-boundary verification for dsh-auto-approval-llm.
//
// On the web carrier the plugin's routes live on the official connection Fetch
// registry, and the carrier applies its own Host/Origin fence and browser
// session check BEFORE the plugin handler runs. Without a session a loopback
// request therefore gets 401 (not the plugin's 200), while a forged Host /
// cross-site / cross-origin request is refused with 403 at the carrier. The
// plugin's own Host/Origin predicate is defense-in-depth behind that fence and
// is pinned by tests/trusted-fetch-request.test.mjs.
//
//   node scripts/verify-auth.mjs                        # composed fence, no credentials
//   node scripts/verify-auth.mjs --url '<startup-url>'  # exchange the launch token, expect loopback 200
//   node scripts/verify-auth.mjs --cookie-file <path>   # reuse a cookie the operator exported
//
// The launch token / cookie is only read from the operator's own shell or file;
// this helper never logs it and never writes it anywhere.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const AUTH_HOST = '127.0.0.1'
export const AUTH_PORT = 3080
export const AUTH_ROUTE = '/api/auto-approval-llm'
const DEFAULT_AUTHORITY = `${AUTH_HOST}:${AUTH_PORT}`

/** Parse --url / --cookie-file / --host / --port. */
export function parseAuthArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1]
    if (argv[i] === '--url' && next !== undefined) { out.url = next; i += 1 }
    else if (argv[i] === '--cookie-file' && next !== undefined) { out.cookieFile = next; i += 1 }
    else if (argv[i] === '--host' && next !== undefined) { out.host = next; i += 1 }
    else if (argv[i] === '--port' && next !== undefined) { out.port = Number(next); i += 1 }
  }
  return out
}

/**
 * Exchange the launch URL printed by `dsh web` for the browser session cookie.
 * The response is a redirect; the cookie rides on that first response, so the
 * redirect is not followed here.
 */
export function exchangeToken(startupUrl) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(startupUrl)
    } catch {
      reject(new Error('invalid launch URL'))
      return
    }
    const port = url.port === '' ? 80 : Number(url.port)
    const req = http.request({
      host: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
    }, (res) => {
      const raw = res.headers['set-cookie']
      res.resume()
      res.on('end', () => {
        if (!Array.isArray(raw) || raw.length === 0) {
          reject(new Error('the launch URL did not return a session cookie'))
          return
        }
        const cookie = raw.map((entry) => entry.split(';', 1)[0]).join('; ')
        resolve({ cookie, authority: url.host, host: url.hostname, port })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Read a cookie header value exported by the operator (optionally "Cookie: …"). */
export function readCookieFile(path) {
  const line = readFileSync(path, 'utf8').split(/\r?\n/).find((entry) => entry.trim() !== '')
  if (line === undefined) throw new Error('the cookie file is empty')
  return line.trim().replace(/^cookie:\s*/i, '')
}

/**
 * The cases one run asserts: the composed carrier fence, with the loopback
 * expectation flipped to 200 once a session cookie is supplied.
 */
export function authCases({ authenticated = false, authority = DEFAULT_AUTHORITY } = {}) {
  const loopbackName = authenticated
    ? 'loopback allowed'
    : 'loopback behind the carrier session fence (401)'
  const loopbackExpect = authenticated ? 200 : 401
  return [
    { name: `${loopbackName} (review-status)`, path: '/review-status', headers: { host: authority }, expect: loopbackExpect },
    { name: `${loopbackName} (history)`, path: '/history', headers: { host: authority }, expect: loopbackExpect },
    { name: 'cross-site sec-fetch-site denied at the carrier', path: '/review-status', headers: { host: authority, 'sec-fetch-site': 'cross-site' }, expect: 403 },
    { name: 'cross-origin Origin denied at the carrier', path: '/review-status', headers: { host: authority, origin: 'http://127.0.0.1:9999' }, expect: 403 },
    { name: 'forged non-loopback Host denied at the carrier', path: '/history', headers: { host: '1.2.3.4:3080' }, expect: 403 },
    { name: 'forged Host + cross-site Origin denied at the carrier', path: '/history', headers: { host: '1.2.3.4:3080', origin: 'http://9.9.9.9:9999' }, expect: 403 },
  ]
}

/** Back-compat default: the composed fence without a session. */
export const AUTH_CASES = authCases()

function get({ host, port, path, headers, cookie }) {
  return new Promise((resolve) => {
    const req = http.request({
      host,
      port,
      path,
      method: 'GET',
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
    }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', (e) => resolve('ERR:' + e.message))
    req.end()
  })
}

/**
 * Run the boundary cases against a live carrier. `cookie` (when supplied)
 * switches the loopback expectations from 401 to 200; the forged/cross-site
 * cases stay 403 either way because the carrier fence runs before the session
 * check. `host`/`port` are injectable so a contract test can drive a model
 * carrier on a loopback port.
 */
export async function runAuthChecks(options = {}) {
  const host = options.host ?? AUTH_HOST
  const port = options.port ?? AUTH_PORT
  const cookie = options.cookie
  const authenticated = options.authenticated ?? Boolean(cookie)
  const cases = options.cases ?? authCases({ authenticated, authority: options.authority })
  const results = []
  let pass = 0
  let fail = 0
  for (const c of cases) {
    const status = await get({ host, port, path: AUTH_ROUTE + c.path, headers: c.headers, cookie })
    const ok = status === c.expect
    results.push({ name: c.name, status, expect: c.expect, ok })
    if (ok) pass += 1
    else fail += 1
  }
  return { pass, fail, results, authenticated }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = parseAuthArgs(process.argv.slice(2))
  let cookie
  let authority
  let host = args.host
  let port = args.port
  if (args.url !== undefined) {
    const session = await exchangeToken(args.url)
    cookie = session.cookie
    authority = session.authority
    host = host ?? session.host
    port = port ?? session.port
  } else if (args.cookieFile !== undefined) {
    cookie = readCookieFile(args.cookieFile)
    authority = args.host === undefined ? DEFAULT_AUTHORITY : `${args.host}:${args.port ?? AUTH_PORT}`
  }
  const { pass, fail, results, authenticated } = await runAuthChecks({ host, port, cookie, authority })
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  -> ${r.status} (expect ${r.expect})`)
  console.log(`\nAUTH SUMMARY: ${pass} pass, ${fail} fail (${authenticated ? 'with session' : 'unauth composed fence'})`)
  process.exit(fail === 0 ? 0 : 1)
}
