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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ReviewMode = 'manual' | 'smart' | 'unattended'

const MODES: ReviewMode[] = ['manual', 'smart', 'unattended']

export function normalizeReviewMode(value: unknown): ReviewMode {
  return MODES.includes(value as ReviewMode) ? (value as ReviewMode) : 'smart'
}

// Compiled to lib/auto/review-mode.js → two levels up is the plugin root.
const REVIEW_MODE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'review-mode.json')

export function loadReviewModes(): Map<string, ReviewMode> {
  const map = new Map<string, ReviewMode>()
  try {
    const obj = JSON.parse(readFileSync(REVIEW_MODE_FILE, 'utf8'))
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
    const tmp = `${REVIEW_MODE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2))
    renameSync(tmp, REVIEW_MODE_FILE)
  } catch {
    // Persistence is best-effort; mode still applies for the current process.
  }
}
