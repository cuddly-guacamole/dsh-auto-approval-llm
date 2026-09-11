/**
 * dsh-auto-approval-llm · per-session review mode (B3).
 *
 * Durable per-session review mode: manual / smart / unattended. `smart` is the
 * default pipeline (LLM review + countdown + breaker); `manual` always hands
 * an ask to a human; `unattended` auto-answers safer levels. Stored in a small
 * plugin-local JSON snapshot (deliberately not wired to the storage-domain
 * facility — see dev doc §7 decision 7: opening a domain there needs a
 * configured backend route, which would add a hard deployment dependency).
 */

import { readFileSync } from 'node:fs'
import { REVIEW_MODE_FILENAME, resolveRuntimeReadPath, writeRuntimeAtomic } from './runtime-paths.js'

export type ReviewMode = 'manual' | 'smart' | 'unattended'

const MODES: ReviewMode[] = ['manual', 'smart', 'unattended']

export function normalizeReviewMode(value: unknown): ReviewMode {
  return MODES.includes(value as ReviewMode) ? (value as ReviewMode) : 'smart'
}

// The runtime location, shared with the other persisted files (see
// ./runtime-paths.ts). The load prefers the canonical path and falls back to the
// pre-move root file, so an upgraded install keeps its per-session modes until
// the snapshot is next written.
export function loadReviewModes(): Map<string, ReviewMode> {
  const map = new Map<string, ReviewMode>()
  try {
    const obj = JSON.parse(readFileSync(resolveRuntimeReadPath(REVIEW_MODE_FILENAME), 'utf8'))
    for (const [key, value] of Object.entries(obj)) {
      map.set(key, normalizeReviewMode(value))
    }
  } catch {
    // Missing or corrupt snapshot is non-fatal; every session falls back to default.
  }
  return map
}

export function persistReviewModes(map: Map<string, ReviewMode>): void {
  const obj: Record<string, string> = {}
  for (const [key, mode] of map) {
    if (mode !== 'smart') obj[key] = mode // default not stored
  }
  // Persistence is best-effort by design (the mode still applies in-process),
  // but total silence meant a read-only DSH_HOME or a corrupt tmp file dropped
  // every session's mode on the next restart with no signal at all — so the
  // failure is surfaced. Relocation to the pre-move root is handled inside
  // runtime-paths.ts; reaching this warning means no location accepted the write.
  if (writeRuntimeAtomic(REVIEW_MODE_FILENAME, JSON.stringify(obj, null, 2), '.tmp')) return
  console.warn('[dsh-auto-approval-llm] review-mode persistence failed: no writable runtime location for review-mode.json')
}
