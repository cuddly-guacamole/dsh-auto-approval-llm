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

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolveRuntimeReadPath, resolveRuntimeWritePath, REVIEW_MODE_FILENAME } from './runtime-paths.js'

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
  try {
    const obj: Record<string, string> = {}
    for (const [key, mode] of map) {
      if (mode !== 'smart') obj[key] = mode // default not stored
    }
    const file = resolveRuntimeWritePath(REVIEW_MODE_FILENAME)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2))
    renameSync(tmp, file)
  } catch (error) {
    // Persistence is best-effort (the mode still applies for the current
    // process), but total silence meant a read-only DSH_HOME or a corrupt
    // tmp file dropped every session's mode on the next restart with no
    // signal at all — surface it.
    console.warn('[dsh-auto-approval-llm] review-mode persistence failed:', error instanceof Error ? error.message : error)
  }
}
