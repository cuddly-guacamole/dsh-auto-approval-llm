/**
 * dsh-auto-approval-llm · line-level diff preview for edit-class approvals.
 *
 * Deterministic, zero-dependency preview of the change an edit-class tool
 * (write / edit / str_replace_editor non-view / apply_patch) is about to make
 * to a workspace file, shown on the human approval panel. Display-only: the
 * preview never influences any decision path and never enters the LLM review
 * input. Full-write operations (write / create) whose target cannot be read —
 * outside the workspace, protected, missing, oversized, non-UTF-8, or
 * directory-shaped — preview the in-args new content as pure additions and
 * never read the target itself. Every other failure (invalid
 * input, compare-class unreadable target, ambiguous edit, oversized input,
 * escape attempt) returns undefined so the caller fails closed by omitting
 * the preview entirely.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { stripCountdownMarkers } from './decision.js'
import { isProtectedProjectPath, isWithin, normalizePath } from './paths.js'

/** Independent args-lookup cap for the diff preview (never maxArgsChars). */
export const EDIT_DIFF_ARGS_MAX_CHARS = 2 * 1024 * 1024

/** Edit-class tool names that can carry a diff preview. */
export const EDIT_DIFF_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])

export type EditDiffLineKind = 'del' | 'add' | 'ctx'
export interface EditDiffLine {
  kind: EditDiffLineKind
  text: string
}

export interface EditDiffResult {
  header: string
  lines: EditDiffLine[]
}

const MAX_SIDE_LINES = 1024
const MAX_LINE_CHARS = 200
const MAX_OUTPUT_LINES = 200
const MAX_OUTPUT_BYTES = 32 * 1024
const MAX_READ_BYTES = 1024 * 1024
const ELLIPSIS = '…'
const TRUNCATED_LINE = '…truncated'
// Same marker the client watcher parses to arm its countdown; any occurrence
// inside a preview line must be inert, so it is removed at block assembly
// (mirror of decision.js stripCountdownMarkers, without its whitespace trim).
const COUNTDOWN_MARKER_PATTERN = /\[dsh-auto-approval-llm\]\s*⏳\s*will auto-(?:approve|reject) in \d+s/g

/** Realpath of the deepest existing ancestor of `input` (probe.ts-style). */
function resolveDeepest(input: string): string | undefined {
  let probe = input
  while (true) {
    try {
      return realpathSync(probe)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return undefined
      probe = parent
    }
  }
}

/**
 * Normalize a target and enforce the read gate: strictly inside the resolved
 * workspace, not a protected project path, and no parent-directory symlink /
 * junction escape to outside the workspace. Returns the normalized absolute
 * path or undefined when the gate fails (fail closed).
 */
function normalizeTarget(path: string, workspaceRoot: string, home?: string): string | undefined {
  const normalized = normalizePath(path, workspaceRoot, home ?? workspaceRoot)
  const wsNorm = normalizePath(workspaceRoot, workspaceRoot, home ?? workspaceRoot)
  if (!isWithin(wsNorm, normalized)) return undefined
  if (isProtectedProjectPath(normalized, { workspace: wsNorm, home: home ?? wsNorm })) return undefined
  const resolved = resolveDeepest(normalized)
  if (resolved === undefined) return undefined
  const realWorkspace = resolveDeepest(wsNorm) ?? wsNorm
  const resolvedNorm = normalizePath(resolved, realWorkspace, realWorkspace)
  const realWorkspaceNorm = normalizePath(realWorkspace, realWorkspace, realWorkspace)
  if (!isWithin(realWorkspaceNorm, resolvedNorm)) return undefined
  return normalized
}

type TargetRead =
  | { state: 'missing' }
  | { state: 'file'; content: string }

/**
 * Read the current regular-file content of a normalized target (lstat without
 * following; a symlink final element is never read through). The size is
 * re-checked on the actual bytes after the read (TOCTOU re-verification) and
 * any failure — missing parent, directory target, oversized, non-UTF-8 / NUL
 * payload — returns undefined (fail closed).
 */
function readTarget(normalized: string): TargetRead | undefined {
  let stat
  try {
    stat = lstatSync(normalized)
  } catch {
    return { state: 'missing' }
  }
  if (!stat.isFile()) return undefined
  if (stat.size > MAX_READ_BYTES) return undefined
  const raw = readFileSync(normalized)
  if (raw.byteLength > MAX_READ_BYTES) return undefined
  const text = raw.toString('utf8')
  if (text.includes('\0')) return undefined
  return { state: 'file', content: text }
}

/** Count literal occurrences (never overlaps). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '' || haystack === '') return 0
  let count = 0
  let from = 0
  let pos = haystack.indexOf(needle, from)
  while (pos !== -1) {
    count += 1
    from = pos + needle.length
    pos = haystack.indexOf(needle, from)
  }
  return count
}

/**
 * Line-level LCS diff between two text blocks. Common head/tail lines are
 * trimmed first (exact optimization), and LCS input is capped at
 * MAX_SIDE_LINES per side — an oversized side omits the whole diff (undefined)
 * so the DP cost stays bounded. Equal texts yield undefined.
 */
/** Display-side split: no trailing phantom empty line (line granularity). */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

function diffPair(oldText: string, newText: string): EditDiffLine[] | undefined {
  if (oldText === newText) return undefined
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  let head = 0
  while (head < oldLines.length && head < newLines.length
    && oldLines[head] === newLines[head]) head += 1
  let tail = 0
  while (tail < oldLines.length - head && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail += 1
  const oldSide = oldLines.slice(head, oldLines.length - tail)
  const newSide = newLines.slice(head, newLines.length - tail)
  if (oldSide.length === 0 && newSide.length === 0) return undefined
  if (oldSide.length > MAX_SIDE_LINES || newSide.length > MAX_SIDE_LINES) return undefined
  return lcsLines(oldSide, newSide)
}

/** Longest-common-subsequence line alignment over two bounded line arrays. */
function lcsLines(oldLines: string[], newLines: string[]): EditDiffLine[] {
  const m = oldLines.length
  const n = newLines.length
  const width = n + 1
  const dp = new Uint16Array((m + 1) * width)
  if (m > 0 && n > 0) {
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        const cell = i * width + j
        dp[cell] = oldLines[i] === newLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
      }
    }
  }
  const out: EditDiffLine[] = []
  // Tie-break for equal LCS continuations: a substitution (the old line does
  // not reappear in the new side) reads "-old / +new"; an insertion (the old
  // line is kept later) reads "+new" first so the tail context survives as
  // ctx instead of being deleted and re-added.
  const newLineSet = new Set(newLines)
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'ctx', text: oldLines[i] })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] > dp[i * width + j + 1]
      || (dp[(i + 1) * width + j] === dp[i * width + j + 1] && !newLineSet.has(oldLines[i]))) {
      out.push({ kind: 'del', text: oldLines[i] })
      i += 1
    } else {
      out.push({ kind: 'add', text: newLines[j] })
      j += 1
    }
  }
  while (i < m) {
    out.push({ kind: 'del', text: oldLines[i] })
    i += 1
  }
  while (j < n) {
    out.push({ kind: 'add', text: newLines[j] })
    j += 1
  }
  return out
}

function ellipsize(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}${ELLIPSIS}` : text
}

/**
 * Apply the output guards: per-line ellipsis, ≤MAX_OUTPUT_LINES lines, and a
 * total rendered byte budget of MAX_OUTPUT_BYTES. Any cap breach truncates
 * the tail and appends the `…truncated` marker line.
 */
function capOutput(lines: EditDiffLine[]): EditDiffLine[] {
  const ellipsized = lines.map((l) => ({ kind: l.kind, text: ellipsize(l.text) }))
  let out = ellipsized
  let truncated = false
  if (out.length > MAX_OUTPUT_LINES) {
    out = out.slice(0, MAX_OUTPUT_LINES)
    truncated = true
  }
  const kept: EditDiffLine[] = []
  let bytes = 0
  for (const line of out) {
    const cost = Buffer.byteLength(`${linePrefix(line.kind)}${line.text}`, 'utf8')
    if (bytes + cost > MAX_OUTPUT_BYTES) {
      truncated = true
      break
    }
    bytes += cost
    kept.push(line)
  }
  if (truncated) kept.push({ kind: 'ctx', text: TRUNCATED_LINE })
  return kept
}

function linePrefix(kind: EditDiffLineKind): string {
  return kind === 'del' ? '- ' : kind === 'add' ? '+ ' : '· '
}

/**
 * Assemble the final result from an op-specific line diff: count insertions /
 * deletions on the full diff, then apply the output caps. Returns undefined
 * when there are no changes to show.
 */
function buildResult(op: string, displayPath: string, lines: EditDiffLine[] | undefined): EditDiffResult | undefined {
  if (lines === undefined || lines.length === 0) return undefined
  const insertions = lines.filter((l) => l.kind === 'add').length
  const deletions = lines.filter((l) => l.kind === 'del').length
  return {
    header: `${op} · ${displayPath} (${op}): ${insertions} insertions, ${deletions} deletions`,
    lines: capOutput(lines),
  }
}

function writeDiff(args: any, workspaceRoot: string, home?: string): EditDiffResult | undefined {
  const path = args?.file_path
  const content = args?.content
  if (typeof path !== 'string' || path.trim() === '' || typeof content !== 'string') return undefined
  const normalized = normalizeTarget(path, workspaceRoot, home)
  if (normalized !== undefined) {
    const read = readTarget(normalized)
    if (read?.state === 'file') return buildResult('write', path, diffPair(read.content, content))
  }
  // An unreadable target (outside the workspace, protected, missing,
  // oversized, non-UTF-8, or directory-shaped) has no old content to show:
  // the write replaces the whole target, so the fully in-args new content is
  // previewed as a pure addition — the target is never read and nothing
  // external or protected ever surfaces on the panel.
  return buildResult('write', path, diffPair('', content))
}

function editDiff(args: any, workspaceRoot: string, home?: string): EditDiffResult | undefined {
  const path = args?.file_path
  const oldStr = args?.old_string
  const newStr = args?.new_string
  if (typeof path !== 'string' || path.trim() === '' || typeof oldStr !== 'string' || oldStr === ''
    || typeof newStr !== 'string') return undefined
  if (oldStr === newStr) return undefined
  const normalized = normalizeTarget(path, workspaceRoot, home)
  if (normalized === undefined) return undefined
  const read = readTarget(normalized)
  if (read === undefined || read.state !== 'file') return undefined
  // Mirror the official literal-edit semantics: matching happens on
  // LF-normalized content; a non-unique match without replace_all aborts
  // (FS_AMBIGUOUS_EDIT) and a zero match aborts (FS_EDIT_NOT_FOUND).
  const content = read.content.replaceAll('\r\n', '\n')
  const oldNorm = oldStr.replaceAll('\r\n', '\n')
  const occurrences = countOccurrences(content, oldNorm)
  if (occurrences === 0) return undefined
  if (occurrences > 1 && args.replace_all !== true) return undefined
  const after = content.split(oldNorm).join(newStr.replaceAll('\r\n', '\n'))
  return buildResult('edit', path, diffPair(content, after))
}

function strReplaceEditorDiff(args: any, workspaceRoot: string, home?: string): EditDiffResult | undefined {
  const command = args?.command
  if (command !== 'create' && command !== 'str_replace' && command !== 'insert') return undefined
  const path = args?.path
  if (typeof path !== 'string' || path.trim() === '') return undefined
  const normalized = normalizeTarget(path, workspaceRoot, home)
  if (command === 'create') {
    // Official create refuses an existing target; an empty file_text is legal
    // but then there is nothing to show. An out-of-workspace / protected
    // target passes the read gate without ever being touched, yet the
    // official create would still write it: the in-args content previews as a
    // pure addition, with nothing read from the target.
    if (typeof args?.file_text !== 'string') return undefined
    if (normalized === undefined) return buildResult('create', path, diffPair('', args.file_text))
    const read = readTarget(normalized)
    if (read === undefined || read.state === 'file') return undefined
    return buildResult('create', path, diffPair('', args.file_text))
  }
  if (normalized === undefined) return undefined
  const read = readTarget(normalized)
  if (read === undefined || read.state !== 'file') return undefined
  const before = read.content
  if (command === 'str_replace') {
    // Official str_replace: old_str must be unique, new_str defaults to an
    // empty string (pure deletion), matching runs against the verbatim bytes.
    const oldStr = args?.old_str
    if (typeof oldStr !== 'string' || oldStr === '') return undefined
    const newStr = args?.new_str ?? ''
    if (typeof newStr !== 'string') return undefined
    const occurrences = countOccurrences(before, oldStr)
    if (occurrences === 0 || occurrences > 1) return undefined
    const offset = before.indexOf(oldStr)
    const after = `${before.slice(0, offset)}${newStr}${before.slice(offset + oldStr.length)}`
    return buildResult('str_replace', path, diffPair(before, after))
  }
  // insert: 0-based splice into split("\n") — N=0 is the file head, N=lines.length
  // appends, and the phantom trailing empty line from a trailing newline is
  // reproduced byte-for-byte like the official tool.
  const insertLine = args?.insert_line
  const newStr = args?.new_str
  if (typeof newStr !== 'string' || !Number.isInteger(insertLine)) return undefined
  const lines = before.split('\n')
  if (insertLine < 0 || insertLine > lines.length) return undefined
  const after = [
    ...lines.slice(0, insertLine),
    ...newStr.split('\n'),
    ...lines.slice(insertLine),
  ].join('\n')
  return buildResult('insert', path, diffPair(before, after))
}

function applyPatchDiff(args: any, workspaceRoot: string, home?: string): EditDiffResult | undefined {
  const patches = args?.patches
  if (!Array.isArray(patches) || patches.length === 0) return undefined
  const files: string[] = []
  const initial = new Map<string, string>()
  const current = new Map<string, string>()
  // Apply every patch in order against the running content so a later patch
  // sees the earlier ones' results; any patch failure omits the whole preview.
  for (const patch of patches) {
    const p = patch ?? {}
    if (typeof p.file_path !== 'string' || p.file_path === ''
      || typeof p.old_string !== 'string' || p.old_string === ''
      || typeof p.new_string !== 'string') return undefined
    const normalized = normalizeTarget(p.file_path, workspaceRoot, home)
    if (normalized === undefined) return undefined
    if (!current.has(normalized)) {
      const read = readTarget(normalized)
      if (read === undefined || read.state !== 'file') return undefined
      initial.set(normalized, read.content)
      current.set(normalized, read.content)
      files.push(p.file_path)
    }
    const before = current.get(normalized)!
    const occurrences = countOccurrences(before, p.old_string)
    if (occurrences === 0 || occurrences > 1) return undefined
    current.set(normalized, before.replace(p.old_string, p.new_string))
  }
  const all: EditDiffLine[] = []
  const multi = files.length > 1
  for (const displayPath of files) {
    const normalized = normalizeTarget(displayPath, workspaceRoot, home)
    if (normalized === undefined) return undefined
    const pair = diffPair(initial.get(normalized)!, current.get(normalized)!)
    if (pair === undefined) continue
    if (multi) all.push({ kind: 'ctx', text: displayPath })
    all.push(...pair)
  }
  if (all.length === 0) return undefined
  const insertions = all.filter((l) => l.kind === 'add').length
  const deletions = all.filter((l) => l.kind === 'del').length
  const display = multi ? `${files.length} files` : files[0]
  return {
    header: `apply_patch · ${display} (patch): ${insertions} insertions, ${deletions} deletions`,
    lines: capOutput(all),
  }
}

/**
 * Build the line-level diff preview for one edit-class tool call.
 *
 * `rawArgs` is the full tool-call arguments JSON text recovered from the
 * session log with an independent (≥2MiB) lookup cap; `workspaceRoot` anchors
 * the read gate. Invalid input, compare-class unreadable targets, ambiguous
 * edits, and oversized inputs return undefined (fail closed) so the caller
 * can omit the preview; full-write operations fall back to a pure-addition
 * preview of the in-args content when the target cannot be read.
 */
export function buildEditDiff(
  toolName: string,
  rawArgs: string | undefined,
  workspaceRoot: string | undefined,
  home?: string,
): EditDiffResult | undefined {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '' || typeof rawArgs !== 'string') return undefined
  let args: any
  try {
    args = JSON.parse(rawArgs)
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  if (toolName === 'write') return writeDiff(args, workspaceRoot, home)
  if (toolName === 'edit') return editDiff(args, workspaceRoot, home)
  if (toolName === 'str_replace_editor') return strReplaceEditorDiff(args, workspaceRoot, home)
  if (toolName === 'apply_patch') return applyPatchDiff(args, workspaceRoot, home)
  return undefined
}

/**
 * Assemble the marked diff block appended to the ask reason. The block is
 * plain line-prefixed text (`- `/`+ `/`· `), and every countdown-marker
 * literal inside it is stripped so preview content can never arm the client
 * auto-answer.
 */
export function buildEditDiffText(diff: EditDiffResult): string {
  const block = [
    '[dsh-edit-diff]',
    diff.header,
    ...diff.lines.map((l) => `${linePrefix(l.kind)}${l.text}`),
    '[/dsh-edit-diff]',
  ].join('\n')
  return block.replace(COUNTDOWN_MARKER_PATTERN, '')
}

/**
 * Assemble the final ask-human reason: strip client-parseable countdown
 * markers from the model-controlled base text, append the host notes, then —
 * when an edit-diff block is available — append it last. With no diff block
 * the output is byte-identical to the historical inline assembly.
 */
export function buildAskReason(baseReason: unknown, extra: string, editDiff?: string): string {
  const cleaned = typeof baseReason === 'string' ? stripCountdownMarkers(baseReason) : baseReason
  const joined = cleaned ? `${cleaned}${extra}` : extra
  if (editDiff === undefined || editDiff === '') return joined
  return `${joined}\n\n${editDiff}`
}