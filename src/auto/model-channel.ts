/**
 * Unified model-channel resolution for the two LLM lanes (fast-decision
 * classifier / deep-review reviewer), replacing the scattered per-lane source
 * switches and the online/offline branch inside the review snapshot.
 *
 * One semantic, three sources (2026-09-05, llm-channel-unify):
 *   session  — follow the current session's provider/model route
 *   preset   — use a provider/model the DSH host has registered (host LLM)
 *   endpoint — use a custom OpenAI/Anthropic-compatible endpoint (raw fetch;
 *              the shared endpoint config is lane-agnostic by design)
 *
 * Half-configuration discipline (user ruling, 2026-09-05): an explicit preset
 * or endpoint choice that is misconfigured fails LOUDLY at the consumer —
 * it is never silently downgraded to the session model (the operator asked for
 * a specific model; a silent fallback would hide the misconfiguration). Only a
 * `session` source carrying leftover garbage values is silently cleaned.
 */
export type ModelSource = 'session' | 'preset' | 'endpoint'

export interface LaneChannel {
  source: ModelSource
  presetProvider: string
  presetModel: string
}

export interface NormalizedLane extends LaneChannel {
  /** Present only when the operator explicitly chose preset but the pair is
   * incomplete. Consumers must fail loudly, never fall back to session. */
  error?: string
}

export interface SharedEndpoint {
  url: string
  model: string
  protocol: 'openai' | 'anthropic'
}

export type Transport =
  | { transport: 'host'; provider: string; model: string }
  | { transport: 'raw'; baseUrl: string; model: string; protocol: 'openai' | 'anthropic' }
  | { transport: 'none'; reason: string }

const nonEmpty = (v: string): boolean => String(v ?? '').trim().length > 0

/**
 * Normalize one lane's source + preset pair. `session` cleans any leftover
 * preset pair away (stale values from an earlier source cannot silently
 * reactivate); `preset` keeps a complete pair and marks an incomplete one with
 * `error` instead of silently degrading. Never throws — schema defaults ('' +
 * 'session') and this normalizer keep hand-written settings from crashing
 * bootstrap (2026-08-26 half-configuration precedent).
 */
export function normalizeLane(raw: Partial<LaneChannel>): NormalizedLane {
  const source = raw.source === 'preset' || raw.source === 'endpoint' ? raw.source : 'session'
  const presetProvider = String(raw.presetProvider ?? '').trim()
  const presetModel = String(raw.presetModel ?? '').trim()
  if (source === 'session') {
    return { source: 'session', presetProvider: '', presetModel: '' }
  }
  if (source === 'preset') {
    if (presetProvider.length === 0 || presetModel.length === 0) {
      return {
        source: 'preset',
        presetProvider,
        presetModel,
        error: 'preset source needs provider and model',
      }
    }
    return { source: 'preset', presetProvider, presetModel }
  }
  // source === 'endpoint': the preset pair is irrelevant to this lane.
  return { source: 'endpoint', presetProvider: '', presetModel: '' }
}

/**
 * Resolve a normalized lane + the shared endpoint config into a concrete
 * transport. Pure and synchronous: the endpoint API key is intentionally NOT
 * resolved here — credentials resolve once at the review-snapshot freeze point
 * (retry-consistency contract), and the classifier resolves per call.
 *
 * `sessionRoute` is the session's live provider/model route; absent for a
 * `session` source the lane has no transport.
 */
export function resolveTransport(
  source: ModelSource,
  lane: NormalizedLane,
  endpoint: SharedEndpoint,
  sessionRoute?: { provider: string; model: string },
): Transport {
  if (source === 'session') {
    if (sessionRoute && nonEmpty(sessionRoute.provider) && nonEmpty(sessionRoute.model)) {
      return { transport: 'host', provider: sessionRoute.provider, model: sessionRoute.model }
    }
    return { transport: 'none', reason: 'no session model route' }
  }
  if (source === 'preset') {
    if (lane.error) return { transport: 'none', reason: lane.error }
    return { transport: 'host', provider: lane.presetProvider, model: lane.presetModel }
  }
  // source === 'endpoint': shared endpoint config, lane-agnostic.
  if (nonEmpty(endpoint.url) && nonEmpty(endpoint.model)) {
    return {
      transport: 'raw',
      baseUrl: endpoint.url.trim(),
      model: endpoint.model.trim(),
      protocol: endpoint.protocol === 'anthropic' ? 'anthropic' : 'openai',
    }
  }
  return { transport: 'none', reason: 'endpoint source needs a URL and model' }
}

/** Shared endpoint normalization: session-like cleaning of empty protocol. */
export function normalizeSharedEndpoint(raw: Partial<SharedEndpoint>): SharedEndpoint {
  return {
    url: String(raw.url ?? '').trim(),
    model: String(raw.model ?? '').trim(),
    protocol: raw.protocol === 'anthropic' ? 'anthropic' : 'openai',
  }
}
