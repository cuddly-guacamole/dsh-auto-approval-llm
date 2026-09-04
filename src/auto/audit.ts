/**
 * dsh-auto-approval-llm · append-only approval audit (B2).
 *
 * Distinction from `history.jsonl`: history is the bounded, searchable in-memory
 * window exposed to the settings UI; the audit is a durable append-only JSONL
 * log that "clearing" never silently erases — a clear leaves a tombstone. The
 * audit lives in a plain file (never in user/message session events), so the
 * main model can never read it back as an injection channel.
 */
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_AUDIT_LINES = 5_000

/** Byte cap for audit rotation (must match the stat trigger in appendAuditLine). */
export const MAX_AUDIT_BYTES = 5 * 1024 * 1024

// Compiled to lib/auto/audit.js, so two levels up is the plugin root
// (the same directory that holds history.jsonl).
const AUDIT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'audit.jsonl')

/** Rotate by keeping only the tail (append-mostly; never edits in place). */
export function trimAuditTail(content: string, maxLines = MAX_AUDIT_LINES): string {
  const lines = content.split('\n').filter(Boolean)
  if (lines.length <= maxLines) return content.endsWith('\n') ? content : `${content}\n`
  return `${lines.slice(-maxLines).join('\n')}\n`
}

/**
 * Byte- AND line-bounded rotation: keep the last `maxLines` lines, then — when
 * the tail still exceeds `maxBytes` (long lines) — drop leading tail lines
 * until the kept tail fits, always keeping at least one line. One backward
 * O(n) byte scan, no repeated joining, so every rotate call converges in a
 * single pass: the rotated file sits under `maxBytes` whenever any single
 * line can, and the next append no longer re-triggers a full rewrite (no
 * O(n²) write amplification). A single oversized line is kept whole.
 */
export function auditRotateContent(content: string, maxBytes = MAX_AUDIT_BYTES, maxLines = MAX_AUDIT_LINES): string {
  const lines = content.split('\n').filter(Boolean)
  if (lines.length <= maxLines) {
    const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    if (bytes <= maxBytes) return content.endsWith('\n') ? content : `${content}\n`
  }
  const tail = lines.slice(-maxLines)
  const tailBytes = tail.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
  if (tailBytes <= maxBytes) return `${tail.join('\n')}\n`
  let keep = 0
  let acc = 0
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const add = Buffer.byteLength(tail[i]) + (keep === 0 ? 0 : 1)
    if (acc + add > maxBytes) break
    acc += add
    keep += 1
  }
  if (keep === 0 && tail.length > 0) keep = 1
  return `${tail.slice(-keep).join('\n')}\n`
}

/**
 * Append one JSONL line to the audit file. Returns whether the line was
 * persisted. Fail-closed contract (APPROVAL-07): observational call sites may
 * ignore the result, but every verdict commit (pushHistory) must fail closed
 * to denied when this returns false, so no unaudited allow can take effect.
 * The append itself is the writability check — no separate probe (a probe
 * would only add a TOCTOU window between check and write).
 */
export function appendAuditLine(line: string): boolean {
  try {
    appendFileSync(AUDIT_FILE, `${line}\n`)
    if (statSync(AUDIT_FILE).size > MAX_AUDIT_BYTES) {
      const content = readFileSync(AUDIT_FILE, 'utf8')
      const rotated = auditRotateContent(content)
      if (rotated === content) return true
      // Atomic replace (tmp + rename, same directory) so a crash mid-rotate
      // can never leave a torn audit file; the original survives write errors.
      const tmp = `${AUDIT_FILE}.tmp`
      writeFileSync(tmp, rotated)
      renameSync(tmp, AUDIT_FILE)
    }
    return true
  } catch {
    return false
  }
}

/** Durable tombstone so a UI "clear history" leaves a recoverable trail. */
export function recordAuditClear(cleared: number, at = Date.now()): void {
  appendAuditLine(JSON.stringify({ type: 'clear', at, cleared }))
}

export function auditFilePath(): string {
  return AUDIT_FILE
}
