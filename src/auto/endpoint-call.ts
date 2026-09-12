/**
 * Shared raw-endpoint text call for the "endpoint" model source (and the
 * endpoint test probe). One implementation owns the protocol routing
 * (OpenAI chat/completions vs Anthropic messages), the SSRF/redirect fence and
 * the response-text extraction, so the reviewer, the classifier and the test
 * probe cannot drift apart on trust checks (security ruling: a
 * "shared fetch" that only shares the body builder but not the fence would be
 * a vulnerability).
 *
 * The fence mirrors the official dsh-web-fetch-http provider:
 *  - validateEndpointUrl rejects non-http(s) and cleartext http off loopback;
 *  - non-loopback targets resolve once and are refused unless every answer is
 *    public unicast, and the connection is then PINNED to that validated
 *    address set (a Node `lookup` callback that performs no second resolution),
 *    so a configured FQDN that (re)binds to a private/metadata address can never
 *    receive this request or its credential headers — a pre-flight resolution
 *    alone leaves the window between the check and the connect open;
 *  - no redirect following: node:http(s) never follows one, so a 302 cannot
 *    steer the request elsewhere;
 *  - the response body is bounded before it is buffered;
 *  - the caller owns the timeout via the AbortSignal.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isLoopbackHostname, resolvePublicReviewerTarget, validateReviewerBaseUrl } from './trust.js'

export interface EndpointCallInput {
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
  apiKey?: string
  /** system prompt (openai: system message; anthropic: system field). */
  system?: string
  /** User message(s) text. */
  messages: string[]
  maxTokens?: number
  /** Reasoning-effort control forwarded verbatim to OpenAI-compatible bodies
   * (`reasoning_effort`) when set. ''/absent = no field (provider default).
   * A provider that does not understand the value answers or errors on its
   * own terms — this layer never guesses. */
  reasoningEffort?: string
  signal?: AbortSignal
}

export type EndpointCallResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; message: string; retryAfterMs?: number }

/**
 * Ceiling for one endpoint response body. The sibling native classifier channel
 * bounds its reply as well (dsh-classifier refuses anything over 20k
 * characters); this is deliberately more generous for a review JSON while still
 * keeping a hostile or broken endpoint from growing the host process by the
 * size of its answer.
 */
export const ENDPOINT_RESPONSE_MAX_BYTES = 262_144

function retryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  return undefined
}

/** Extract the text from a protocol response body (openai/anthropic shapes). */
export function extractEndpointText(protocol: 'openai' | 'anthropic', json: any): string {
  if (protocol === 'anthropic') {
    const content = json?.content
    return Array.isArray(content)
      ? content.map((block: any) => (block?.type === 'text' ? block.text ?? '' : '')).join('')
      : ''
  }
  return json?.choices?.[0]?.message?.content ?? ''
}

export function endpointErrorSummary(status: number, text: string): string {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return cleaned ? `HTTP ${status}: ${cleaned}` : `HTTP ${status}`
}

/**
 * Build the Node `lookup` callback that serves a fixed, already-validated
 * address set: the connection performs no resolution of its own, so the address
 * that passed the fence is the address that is connected to. Exported for the
 * contract test that proves the pinning primitive.
 */
export function createPinnedLookup(addresses: { address: string; family: number }[]) {
  return function pinnedLookup(hostname: string, options: any, callback?: any): void {
    const done = typeof options === 'function' ? options : callback
    if (typeof done !== 'function') return
    const family = typeof options === 'object' && options !== null && options.family ? options.family : 0
    const wanted = family === 0 ? addresses[0] : (addresses.find((entry) => entry.family === family) ?? addresses[0])
    if (wanted === undefined) {
      done(new Error(`no validated address for ${hostname}`))
      return
    }
    if (typeof options === 'object' && options !== null && options.all) {
      done(null, addresses.filter((entry) => entry.family === wanted.family))
      return
    }
    done(null, wanted.address, wanted.family)
  }
}

export interface EndpointTransportResult {
  status: number
  /** Response headers, lower-cased keys (Node's own shape). */
  headers: Record<string, any>
  body: string
  /** The body exceeded the byte ceiling and was dropped. */
  tooLarge: boolean
}

/**
 * One POST over node:http(s). Exported for the contract test that proves the
 * pinned connection: with a fake hostname plus a pinned lookup, the request must
 * reach the local server anyway. `lookup` is passed to Node only when the caller
 * validated the address set.
 */
export function requestEndpointText(
  target: URL,
  init: {
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
    lookup?: (hostname: string, options: any, callback?: any) => void
    maxBytes?: number
  },
): Promise<EndpointTransportResult> {
  const maxBytes = init.maxBytes ?? ENDPOINT_RESPONSE_MAX_BYTES
  return new Promise((resolve, reject) => {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    // URL.hostname keeps IPv6 brackets; Node wants the bare address.
    const hostname = target.hostname.replace(/^\[|\]$/g, '')
    let settled = false
    const finish = (value: EndpointTransportResult) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const req = send({
      protocol: target.protocol,
      hostname,
      ...(target.port === '' ? {} : { port: target.port }),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: init.headers,
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      ...(init.lookup === undefined ? {} : { lookup: init.lookup as any }),
    }, (res: any) => {
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false
      res.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > maxBytes) {
          tooLarge = true
          res.destroy()
          finish({ status: res.statusCode ?? 0, headers: res.headers ?? {}, body: '', tooLarge: true })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (tooLarge) return
        finish({ status: res.statusCode ?? 0, headers: res.headers ?? {}, body: Buffer.concat(chunks).toString('utf8'), tooLarge: false })
      })
      res.on('error', (error: unknown) => fail(error))
    })
    req.on('error', (error: unknown) => fail(error))
    if (init.body !== '') req.write(init.body)
    req.end()
  })
}

/**
 * POST one message exchange to the endpoint and return the assistant text.
 * Throws TypeError on a configuration/trust violation (invalid URL, cleartext
 * off loopback, non-public target) — the caller treats those as
 * misconfiguration. HTTP-level failures come back as { ok:false } with the
 * status so each consumer can map to its own error vocabulary.
 */
export async function callEndpointText(input: EndpointCallInput): Promise<EndpointCallResult> {
  const validated = validateReviewerBaseUrl(input.baseUrl)
  if (!validated.ok) throw new TypeError(validated.reason)
  if (validated.baseUrl === '') {
    throw new TypeError('endpoint call needs a base URL')
  }
  const baseUrl = validated.baseUrl
  const baseTarget = new URL(baseUrl)
  const host = baseTarget.hostname
  // Public-address enforcement + connection pinning: resolve once, refuse the
  // whole set when any answer is not public unicast, then hand that very set to
  // the connection so it cannot be re-resolved. Loopback stays exempt (local
  // endpoint / mock / Ollama / LM Studio are legitimate admin configurations)
  // and IP literals need no pinning at all.
  let lookup: ((hostname: string, options: any, callback?: any) => void) | undefined
  if (!isLoopbackHostname(host)) {
    const resolved = await resolvePublicReviewerTarget(host)
    if (!resolved.ok) throw new TypeError(resolved.reason)
    if (isIP(host.replace(/^\[|\]$/g, '')) === 0) lookup = createPinnedLookup(resolved.addresses)
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.apiKey) {
    if (input.protocol === 'anthropic') headers['x-api-key'] = input.apiKey
    else headers.Authorization = `Bearer ${input.apiKey}`
  }
  const maxTokens = input.maxTokens ?? 256
  const openaiMessages: any[] = []
  if (input.protocol === 'openai') {
    if (input.system) openaiMessages.push({ role: 'system', content: input.system })
    for (const text of input.messages) openaiMessages.push({ role: 'user', content: text })
  }
  const path = input.protocol === 'anthropic' ? '/messages' : '/chat/completions'
  const body = input.protocol === 'anthropic'
    ? JSON.stringify({
      model: input.model || undefined,
      max_tokens: maxTokens,
      ...(input.system ? { system: input.system } : {}),
      messages: input.messages.map((text) => ({ role: 'user', content: text })),
    })
    : JSON.stringify({
      model: input.model || undefined,
      max_tokens: maxTokens,
      messages: openaiMessages,
      ...(input.reasoningEffort && input.reasoningEffort !== '' ? { reasoning_effort: input.reasoningEffort } : {}),
    })
  headers['Content-Length'] = String(Buffer.byteLength(body))
  const target = new URL(`${baseUrl}${path}`)
  const response = await requestEndpointText(target, {
    headers,
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(lookup === undefined ? {} : { lookup }),
  })
  if (response.tooLarge) {
    return { ok: false, message: `endpoint response exceeded ${ENDPOINT_RESPONSE_MAX_BYTES} bytes and was dropped` }
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      status: response.status,
      message: endpointErrorSummary(response.status, response.body),
      retryAfterMs: retryAfterMs(response.headers['retry-after'] ?? null),
    }
  }
  const json: any = JSON.parse(response.body)
  return { ok: true, text: extractEndpointText(input.protocol, json) }
}
