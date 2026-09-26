/**
 * dsh-auto-approval-llm · HTTP pipeline shared by every web route.

 * Three things every route handler goes through, in the entry and in
 * `route-installers.ts` alike: the uniform JSON response, the bounded JSON
 * body reader, and the trusted-Host authority list the fetch fence is
 * evaluated against. `trustedHosts` is a live binding with a single writer
 * (`setTrustedHosts`) because ESM forbids assigning to an imported binding:
 * the entry reads it at every fence and refreshes it through the setter.
 */

// Trusted Host authorities for web-route fencing (RISK-01/02); resolved once
// at apply() from webRuntime / --trusted-host / LAN enumeration.
export let trustedHosts: string[] = []

/**
 * The single writer for the trusted-Host authority list. `trustedHosts` is
 * read at every fetch fence, and ESM forbids assigning to an imported
 * binding, so the entry refreshes it here instead of assigning directly.
 */
export function setTrustedHosts(next: string[]): void {
  trustedHosts = next
}

/** JSON response with the plugin's uniform headers; extra headers ride along. */
export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  const bytes = Buffer.from(JSON.stringify(body))
  return new Response(bytes, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  })
}

/** Read a buffered JSON body: content-type must be JSON, ≤ maxBytes, non-empty. */
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<any> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  if (request.body !== null) {
    const reader = request.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        const part = Buffer.from(value)
        bytes += part.length
        if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
        chunks.push(part)
      }
    } finally {
      reader.releaseLock()
    }
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ── web request trust (RISK-01/RISK-02) ────────────────────────────────────
// Mirrors the official dsh-client-connection `isTrustedApiRequest`: a Host
// loopback/LAN-whitelist fence against DNS rebinding, plus same-origin
// enforcement when an Origin header is present. Unlike the old
// `isSameOriginPost`, the Host authority is validated against a whitelist
// (loopback ∪ trusted LAN), so `Host: attacker.com` can never pass even when
// Origin matches it. The settings / reviewer-credential / feedback domains
// are treated as a privileged plane and restricted to loopback-same-origin
// only, matching the official PRIVILEGED_METHODS precedent. The feedback
// route writes approval state keyed by a callId that the review-status
// protocol carries in the open, so it must not be reachable by a LAN peer
// holding an arbitrary callId. Clamping it to loopback costs nothing
// functional: the panel close stays the client's protocol-level respond, and
// a follow state that is not released early is swept by its own TTL.

/**
 * Resolve the trusted Host authorities from the web runtime service, then the
 * `--trusted-host` argv values. The web runtime already folds the bind-bound LAN
 * literals into its snapshot; when no source is present the plane stays
 * loopback-only (fail-closed) instead of probing a web-server service.
 */
export function resolveTrustedHosts(ctx: any): string[] {
  const webRuntime = ctx?.get?.('webRuntime') as { trustedHosts?: string[] } | undefined
  const fromRuntime = webRuntime?.trustedHosts
  if (Array.isArray(fromRuntime) && fromRuntime.length > 0) return [...fromRuntime]
  const argvTrusted: string[] = []
  const args = process.argv
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--trusted-host' && args[index + 1] !== undefined) argvTrusted.push(args[index + 1])
    else if (arg.startsWith('--trusted-host=')) argvTrusted.push(arg.slice('--trusted-host='.length))
  }
  return argvTrusted
}

