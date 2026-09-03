/**
 * Trust-plane predicates for the plugin's web routes.
 *
 * Split out of index.ts into a pure module so the loopback / LAN boundary logic
 * is unit-testable (contract tests import from lib/auto/trust.js).
 */

import { lookup as nodeLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Whether a Host value is a loopback hostname (localhost, 127.*, ::1). */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  // IPv4-mapped IPv6 loopback. `new URL()` rewrites the readable spelling
  // `[::ffff:127.0.0.1]` into the compressed hex form `[::ffff:7f00:1]`, so the
  // dotted spelling never reaches this predicate through a parsed Host — both
  // are accepted anyway, since a Host header can also arrive unparsed.
  // Without this the peer is genuinely on loopback (isLoopbackIp already
  // accepts ::ffff:127.*) while the Host is judged non-loopback, so every
  // plugin route answers 403 to a real local caller.
  if (/^\[?::ffff:(?:7f00:1|127(?:\.\d{1,3}){3})\]?$/i.test(hostname)) return true
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
 * Whether a parsed probe URL may be the target of the online-reviewer
 * connection test. Aligned with the saved-reviewer scheme fence (https
 * anywhere, cleartext http only to loopback): the body-driven test target is
 * muzzled the same way `validateReviewerBaseUrl` muzzles the admin-configured
 * endpoint, so an https intranet host stays an OPTIONAL test target (the live
 * review relay also talks to it) while plaintext http probes of anything but
 * loopback stay closed. Pure so the probe fence is contract-testable.
 */
export function reviewerProbeTargetAllowed(probeUrl: URL): boolean {
  return probeUrl.protocol === 'https:' || isLoopbackHostname(probeUrl.hostname)
}

// ── public-address enforcement (SSRF hardening, mirrors @deepseek-ai/
// dsh-web-fetch-http's isPublicIpAddress; zero new deps, net.isIP + manual
// segment tables) ─────────────────────────────────────────────────────────

/**
 * Whether an IPv4 dotted-quad is globally reachable unicast. Aligned with
 * ipaddr.js `range() === 'unicast'` (verified 2026-09-03 against the official
 * package's own tables): rejects private/link-local/loopback/unspecified/
 * CGNAT/multicast/reserved/documentation/testing 100.64/10, 127/8, 169.254/16,
 * 10/8, 172.16/12, 192.168/16, 198.18/15, 224/4, 240/4, 0/8, and the
 * documentation/test ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
 */
export function isPublicIpv4(text: string): boolean {
  const parts = text.split('.')
  if (parts.length !== 4) return false
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false
    const n = Number(part)
    if (n > 255) return false
    octets.push(n)
  }
  const [a, b, c, d] = octets
  if (a === 0) return false                       // 0.0.0.0/8 unspecified
  if (a === 10) return false                      // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64/10 CGNAT
  if (a === 127) return false                     // 127/8 loopback
  if (a === 169 && b === 254) return false        // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16/12 private
  if (a === 192 && b === 168) return false        // 192.168/16 private
  if (a === 192 && b === 0 && c === 0) return false  // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false  // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // 203.0.113/24 TEST-NET-3
  if (a >= 224) return false                      // 224/4 multicast + 240/4 reserved
  return true
}

/**
 * Whether an IPv6 literal is globally reachable unicast — the mirror of
 * ipaddr.js `range() === 'unicast'` for what this module needs: reject
 * loopback/unspecified/link-local/unique-local/multicast/documentation/
 * mapped/NAT64 prefixes. The official provider additionally discovers
 * deployment DNS64 prefixes; here the well-known RFC 6052 64:ff9b::/96
 * prefix is the conservative baseline.
 */
export function isPublicIpv6(text: string): boolean {
  const stripped = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  const lower = stripped.toLowerCase()
  // IPv4-mapped (::ffff:a.b.c.d, also 0:0:0:0:0:ffff:...) → judge the embedded IPv4.
  const mapped = lower.match(/^(?:0+:)*0*ffff:([0-9.]+)$/)
  if (mapped) return isPublicIpv4(mapped[1])
  if (lower === '::' || lower === '::1') return false
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return false // fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false // fc00::/7
  if (lower.startsWith('ff')) return false // ff00::/8 multicast
  if (lower.startsWith('2001:db8')) return false // documentation
  if (lower.startsWith('64:ff9b')) return false // well-known NAT64 prefix
  // Teredo (2001:0000::/32) — second hextet all-zero, in any compression
  // (2001::1, 2001:0:1, …). ORCHID (2001:10::/28) and benchmarking
  // (2001:2::/48) are separate specific blocks; 2001:4860 etc stay public.
  const hextets = lower.split(':')
  if (hextets[0] === '2001' && (hextets[1] === undefined || hextets[1] === '' || /^0+$/.test(hextets[1]))) return false
  if (lower.startsWith('2001:10:') || lower.startsWith('2001:2:')) return false
  if (lower.startsWith('2002:')) return false // 6to4
  if (lower.startsWith('3fff:')) return false // documentation analog
  return /^[0-9a-f:]+$/i.test(lower)
}

/**
 * Whether a text address (IPv4 or IPv6, brackets tolerated) is globally
 * reachable unicast — the single predicate the reviewer fetch path uses.
 */
export function isPublicIpAddress(text: string): boolean {
  const stripped = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  const family = isIP(stripped)
  if (family === 4) return isPublicIpv4(stripped)
  if (family === 6) return isPublicIpv6(stripped)
  return false
}

/**
 * Resolve a hostname once and reject the complete answer set if any address
 * is not public unicast — mirrors `resolvePublicAddresses` from the official
 * dsh-web-fetch-http provider. IP literals skip DNS and are judged directly.
 * @param hostname - URL hostname (bracketed IPv6 tolerated).
 * @param resolver - lookup override, injectable in contract tests.
 * @returns the validated address set, or a { ok:false, reason } refusal.
 */
export async function resolvePublicReviewerTarget(
  hostname: string,
  resolver: (hostname: string) => Promise<{ address: string; family: number }[]> = systemLookupAll,
): Promise<{ ok: true; addresses: { address: string; family: number }[] } | { ok: false; reason: string }> {
  const stripped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const literalFamily = isIP(stripped)
  let resolved: { address: string; family: number }[]
  if (literalFamily === 0) {
    try {
      resolved = await resolver(stripped)
    } catch (error: unknown) {
      return { ok: false, reason: `hostname 解析失败：${error instanceof Error ? error.message : String(error)}` }
    }
  } else {
    resolved = [{ address: stripped, family: literalFamily }]
  }
  if (resolved.length === 0) return { ok: false, reason: `hostname "${hostname}" 未解析出任何地址` }
  // Fake-IP proxy takeover (Clash/Surge/TUN): every hostname resolves into
  // 198.18.0.0/15 and the proxy routes by domain, so the local answer set is
  // meaningless for SSRF — the official provider skips these checks on its
  // proxied hop for the same reason. Exemption requires the WHOLE set to be
  // fake-IP; any real private address (10/8, 192.168/16, 169.254, …) still
  // refuses. 198.18/15 is the IETF benchmarking block and carries no real
  // public service, so a mixed set is anomalous and stays rejected.
  const allFakeIp = resolved.length > 0 && resolved.every((entry) =>
    entry.family === 4 && isFakeIpv4(entry.address),
  )
  if (!allFakeIp) {
    for (const entry of resolved) {
      if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) === 0) {
        return { ok: false, reason: `hostname "${hostname}" 解析出非法地址` }
      }
      if (!isPublicIpAddress(entry.address)) {
        return { ok: false, reason: `hostname "${hostname}" 解析到非公网地址（${entry.address}）；已阻止，防止 SSRF` }
      }
    }
  }
  return { ok: true, addresses: resolved }
}

/** Whether an IPv4 sits in the 198.18.0.0/15 block (fake-IP proxy pool). */
function isFakeIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const a = Number(parts[0])
  const b = Number(parts[1])
  return a === 198 && (b === 18 || b === 19)
}

/** Default resolver: Node's system DNS, all addresses verbatim. */
export async function systemLookupAll(hostname: string): Promise<{ address: string; family: number }[]> {
  const entries = await nodeLookup(hostname, { all: true, verbatim: true })
  return entries.map((e) => ({ address: e.address, family: e.family as number }))
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