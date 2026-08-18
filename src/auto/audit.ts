/**
 * dsh-auto-approval-llm · append-only approval audit (B2).
 *
 * Distinction from `history.jsonl`: history is the bounded, searchable in-memory
 * window exposed to the settings UI; the audit is a durable append-only JSONL
 * log that "clearing" never silently erases — a clear leaves a tombstone. The
 * audit lives in a plain file (never in user/message session events), so the
 * main model can never read it back as an injection channel.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_AUDIT_LINES = 5_000

// Compiled to lib/auto/audit.js, so two levels up is the plugin root
// (the same directory that holds history.jsonl).
const AUDIT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'audit.jsonl')

/** Rotate by keeping only the tail (append-mostly; never edits in place). */
export function trimAuditTail(content: string, maxLines = MAX_AUDIT_LINES): string {
  const lines = content.split('\n').filter(Boolean)
  if (lines.length <= maxLines) return content.endsWith('\n') ? content : `${content}\n`
  return `${lines.slice(-maxLines).join('\n')}\n`
}

export function appendAuditLine(line: string): void {
  try {
    appendFileSync(AUDIT_FILE, `${line}\n`)
    if (statSync(AUDIT_FILE).size > 5 * 1024 * 1024) {
      writeFileSync(AUDIT_FILE, trimAuditTail(readFileSync(AUDIT_FILE, 'utf8')))
    }
  } catch {
    // Audit persistence is best-effort and never affects an approval outcome.
  }
}

/** Durable tombstone so a UI "clear history" leaves a recoverable trail. */
export function recordAuditClear(cleared: number, at = Date.now()): void {
  appendAuditLine(JSON.stringify({ type: 'clear', at, cleared }))
}

export function auditFilePath(): string {
  return AUDIT_FILE
}
