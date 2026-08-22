/**
 * Trust-plane predicates for the plugin's web routes.
 *
 * Split out of index.ts into a pure module so the loopback / LAN boundary logic
 * is unit-testable (contract tests import from lib/auto/trust.js).
 */

/** Whether a Host value is a loopback hostname (localhost, 127.*, ::1). */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a TCP peer address is on loopback (incl. IPv4-mapped IPv6). */
export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false
  return ip === '::1' || ip === '127.0.0.1' || /^127\./.test(ip) || ip === '::ffff:127.0.0.1' || /^::ffff:127\./.test(ip)
}

/** Whether a configured trust entry matches the request's Host authority. */
function trustedAuthorityMatches(entry: string, hostUrl: URL): boolean {
  try {
    const entryUrl = new URL(`http://${entry}`)
    // A port-less entry (LAN IP literal, bare --trusted-host) matches any port;
    // an explicit host:port entry matches exactly.
    return entryUrl.port !== '' ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/**
 * Whether a request may reach plugin routes: Host whitelist + same-origin, and
 * — whenever the Host claims to be loopback — an actually-loopback TCP peer.
 *
 * The Host header is HTTP-controlled and can be forged by any client that can
 * reach the port. On a web server bound to 0.0.0.0 with a LAN trust list, a
 * non-loopback peer could otherwise smuggle `Host: localhost` to masquerade as
 * a loopback caller; the socket source-IP check closes that hole unconditionally
 * instead of only on the empty-whitelist (privileged) plane.
 */
export function isTrustedRequest(req: { headers?: any; socket?: any }, trustedHosts: string[]): boolean {
  const host = req.headers?.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const loopbackHost = isLoopbackHostname(hostUrl.hostname)
  if (!loopbackHost) {
    if (!trustedHosts.some(entry => trustedAuthorityMatches(entry, hostUrl))) return false
    // A non-loopback Host that matched the LAN whitelist is trusted by the LAN
    // boundary; only the loopback case demands a loopback peer.
  } else if (!isLoopbackIp(req.socket?.remoteAddress)) {
    return false
  }
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Validate the online-reviewer base URL before any request crosses the
 * network. Bare "host:port" inputs are auto-prefixed with http:// so common
 * configs are not wrongly rejected; http:// is only permitted for loopback
 * (localhost/127.0.0.1/[::1]) so the API key never travels in cleartext over
 * a LAN/Docker bridge. Empty string is accepted (means "follow session
 * route"). Pure so the cleartext/SSRF fence stays contract-testable.
 */
export function validateReviewerBaseUrl(raw: string):
  | { ok: false; reason: string }
  | { ok: true; baseUrl: string; insecure: boolean } {
  const input = String(raw ?? '').trim()
  if (input === '') return { ok: true, baseUrl: '', insecure: false } // follow session route
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`
  const baseUrl = withScheme.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return { ok: false, reason: `reviewerBaseUrl 不是合法 URL：${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `reviewerBaseUrl 仅支持 http/https：${url.protocol}` }
  }
  const host = url.hostname
  // Node's URL.hostname keeps the brackets for IPv6 ("[::1]"), so test both.
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (url.protocol === 'http:' && !isLoopback) {
    return { ok: false, reason: `reviewerBaseUrl 使用明文 http 且非回环地址（${host}）；请改用 https:// 或本机代理` }
  }
  return { ok: true, baseUrl, insecure: url.protocol === 'http:' }
}