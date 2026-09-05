/**
 * Shared raw-endpoint text call for the "endpoint" model source (and the
 * endpoint test probe). One implementation owns the protocol routing
 * (OpenAI chat/completions vs Anthropic messages), the SSRF/redirect fence and
 * the response-text extraction, so the reviewer, the classifier and the test
 * probe cannot drift apart on trust checks (2026-09-05 security ruling: a
 * "shared fetch" that only shares the body builder but not the fence would be
 * a vulnerability).
 *
 * The fence mirrors the official dsh-web-fetch-http provider:
 *  - validateEndpointUrl rejects non-http(s) and cleartext http off loopback;
 *  - non-loopback targets resolve once and are refused unless every answer is
 *    public unicast (a configured FQDN that (re)binds to a private/metadata
 *    address can never receive this request or its credential headers);
 *  - redirect:'error' keeps a 302 from steering the request elsewhere;
 *  - the caller owns the timeout via the AbortSignal.
 */
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
  signal?: AbortSignal
}

export type EndpointCallResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; message: string; retryAfterMs?: number }

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
  // Public-address enforcement: resolve once, refuse the whole set when any
  // answer is not public unicast. Loopback stays exempt (local endpoint /
  // mock / Ollama / LM Studio are legitimate admin configurations).
  const host = new URL(baseUrl).hostname
  if (!isLoopbackHostname(host)) {
    const resolved = await resolvePublicReviewerTarget(host)
    if (!resolved.ok) throw new TypeError(resolved.reason)
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.apiKey) {
    if (input.protocol === 'anthropic') headers['x-api-key'] = input.apiKey
    else headers.Authorization = `Bearer ${input.apiKey}`
  }
  const maxTokens = input.maxTokens ?? 256
  if (input.protocol === 'anthropic') {
    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      signal: input.signal,
      redirect: 'error',
      body: JSON.stringify({
        model: input.model || undefined,
        max_tokens: maxTokens,
        ...(input.system ? { system: input.system } : {}),
        messages: input.messages.map((text) => ({ role: 'user', content: text })),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, status: res.status, message: endpointErrorSummary(res.status, body), retryAfterMs: retryAfterMs(res.headers?.get?.("retry-after") ?? null) }
    }
    const json: any = await res.json()
    return { ok: true, text: extractEndpointText('anthropic', json) }
  }
  const openaiMessages: any[] = []
  if (input.system) openaiMessages.push({ role: 'system', content: input.system })
  for (const text of input.messages) openaiMessages.push({ role: 'user', content: text })
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: input.signal,
    redirect: 'error',
    body: JSON.stringify({ model: input.model || undefined, max_tokens: maxTokens, messages: openaiMessages }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, status: res.status, message: endpointErrorSummary(res.status, body), retryAfterMs: retryAfterMs(res.headers?.get?.("retry-after") ?? null) }
  }
  const json: any = await res.json()
  return { ok: true, text: extractEndpointText('openai', json) }
}
