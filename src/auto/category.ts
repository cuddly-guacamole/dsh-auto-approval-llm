/**
 * dsh-auto-approval-llm · category tri-state layer (pure, zero fs/network).
 *
 * A thin, fail-closed overlay that labels a tool call / shell command with one
 * of 11 categories and derives a tri-state directive ('inherit' | 'auto' |
 * 'ask' | 'deny') from the live category policy. It never changes the
 * assessment contracts of policy.ts / shell.ts: the layer only *covers* the
 * risk tier at the two wiring points (pre-execute tightening + answerer), and
 * any classification failure degrades to 'unknown' → 'inherit' (current
 * behavior unchanged).
 *
 * Mode semantics (position gate only):
 * - standard (default): effective routine roots = workspace ∪ trustedDirs;
 * - aggressive: the position predicate is relaxed to "anywhere", while the
 *   density fuses (protected / sensitive-name / hard deny / runtime state /
 *   symlink escape) keep their full force.
 *
 * LOCKED categories (delete/protected/privilege/disk) accept only 'ask'
 * explicitly; the decision layer clamps anything else as a backstop even if a
 * mis-clamped config somehow reaches runtime.
 */

import { basename } from 'node:path'
import { isProtectedProjectPath, isWithin, normalizePath } from './paths.js'
import { decomposeCommandLine } from './shell.js'

/** The 11 configurable category keys. */
export type CategoryKey =
  | 'fileEdit' | 'gitLocal' | 'build' | 'readOnly'
  | 'delete' | 'protected' | 'privilege' | 'networkExec'
  | 'gitPush' | 'publish' | 'disk'

export const CATEGORY_KEYS: readonly CategoryKey[] = [
  'fileEdit', 'gitLocal', 'build', 'readOnly',
  'delete', 'protected', 'privilege', 'networkExec',
  'gitPush', 'publish', 'disk',
]

/** Categories that can never be 'auto' (only 'ask', or inherit when unset). */
export const LOCKED_CATEGORIES: readonly CategoryKey[] = ['delete', 'protected', 'privilege', 'disk']

/**
 * Global category merge order for compound commands: the first (highest)
 * category by this order wins. LOCKED classes sit at the top so a compound
 * line can never be dragged down to a lower tier by a trailing segment.
 */
export const CATEGORY_PRECEDENCE: Record<CategoryKey, number> = {
  privilege: 11,
  delete: 10,
  disk: 9,
  protected: 8,
  networkExec: 7,
  gitPush: 6,
  publish: 5,
  gitLocal: 4,
  fileEdit: 3,
  build: 2,
  readOnly: 1,
}

/**
 * Categories that are implicitly 'auto' under aggressive mode while their key
 * is not explicitly configured (explicit configuration always wins).
 */
const AGGRESSIVE_BUILTIN: readonly CategoryKey[] = ['networkExec', 'gitPush', 'publish']

export type CategoryDirective = 'inherit' | 'auto' | 'ask' | 'deny'

/** Minimal config slice the category layer reads (kept as plain data). */
export interface CategoryConfig {
  categoryPolicy?: Record<string, 'auto' | 'ask' | 'deny'>
  categoryMode?: 'standard' | 'aggressive'
}

/** Minimal shapes the category layer consumes (structural, no live objects). */
export interface CategoryRoots {
  workspace: string
  home: string
  dshHome?: string
  tempRoots?: string[]
  allowedDshSubpaths?: string[]
  mode?: 'standard' | 'aggressive'
  trustedDirs?: string[]
}

export interface CategoryExec {
  name?: string
  arguments?: unknown
  agent?: { session?: unknown }
}

interface SegmentWord {
  text: string
  dynamic: boolean
  glob: boolean
  quoted: boolean
}

interface Segment {
  words: SegmentWord[]
  writeTargets: SegmentWord[]
  readTargets: SegmentWord[]
}

// ── sensitive-name fuse (G1) ────────────────────────────────────────────────
// The workspace-scoped isProtectedProjectPath intentionally returns false for
// paths outside the workspace, so an aggressive/trusted-dir relaxation must
// re-fuse the same sensitive basenames at ANY position.

const SENSITIVE_BASE = (base: string): boolean => {
  if (base === '.gitconfig' || base === '.gitmodules' || base === '.netrc'
    || base === '.npmrc' || base === '.pypirc' || base === '.mcp.json') return true
  if (/^\.bash/.test(base)) return true
  // `.env` and `.env.<suffix>`; `.env.example*` stays a documentation template.
  if (base === '.env') return true
  if (/^\.env\.(?!example(?:\.|$))/.test(base)) return true
  return false
}

const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube'])

/**
 * Whether a normalized path carries a sensitive basename or traverses a
 * sensitive directory at any position (G1). `roots` is accepted for signature
 * symmetry with the policy call sites; the check itself is location-free.
 */
export function sensitiveBasenameAt(normalized: string, roots: CategoryRoots): boolean {
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  const base = parts[parts.length - 1] ?? ''
  if (SENSITIVE_BASE(base)) return true
  return parts.some((part) => SENSITIVE_DIRS.has(part))
}

/**
 * Position predicate for the whitelist routine gates (G2): standard mode
 * accepts workspace ∪ trustedDirs; aggressive mode accepts any target (density
 * fuses still apply separately). With the default `roots.mode='standard'` and
 * no trustedDirs this is byte-identical to `isWithin(roots.workspace, target)`.
 */
export function isEffectiveRoutine(target: string, roots: CategoryRoots): boolean {
  const normalized = normalizePath(target, roots.workspace, roots.home)
  if (roots.mode === 'aggressive') return true
  if ((roots.trustedDirs ?? []).some((root) => isWithin(normalizePath(root, roots.workspace, roots.home), normalized))) return true
  return isWithin(roots.workspace, normalized)
}

/**
 * Escape detection for the symlink guard (G8): when the TEXTUAL target lies in
 * any allowed zone (workspace ∪ plugin zone ∪ trustedDirs) but the RESOLVED
 * realpath leaves every allowed zone, the guard hard-denies. Pure: the caller
 * resolves the realpath and passes both spellings in.
 */
export function realpathCriticalReason(
  textual: string,
  resolved: string,
  roots: CategoryRoots,
  trustedDirs?: string[],
  resolvedWorkspace?: string,
): string | undefined {
  const effective = [...(roots.allowedDshSubpaths ?? []), ...(trustedDirs ?? [])]
  const insideTextual = isWithin(roots.workspace, textual)
    || effective.some((root) => isWithin(normalizePath(root, roots.workspace, roots.home), textual))
  if (!insideTextual) return undefined
  const workspaceAnchor = resolvedWorkspace !== undefined ? resolvedWorkspace : roots.workspace
  const insideResolved = isWithin(workspaceAnchor, resolved)
    || effective.some((root) => isWithin(normalizePath(root, roots.workspace, roots.home), resolved))
  if (!insideResolved) return `target resolves outside the workspace via a symlink: ${resolved}`
  return undefined
}

// ── tool-word helpers (kept local; policy.ts owns the assessment contracts) ──

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function pathArgument(args: unknown): string | undefined {
  const obj = record(args)
  if (obj === undefined) return undefined
  for (const key of ['file_path', 'path', 'cwd', 'workdir']) {
    const value = obj[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function patchTargets(args: unknown): string[] | undefined {
  const obj = record(args)
  const raw = obj?.['patches']
  if (!Array.isArray(raw)) return undefined
  const targets: string[] = []
  for (const patch of raw) {
    const file = record(patch)?.['file_path']
    if (typeof file !== 'string' || file === '') return undefined
    targets.push(file)
  }
  return targets.length > 0 ? targets : undefined
}

const commandName = (token: string): string => basename(token.replaceAll('\\', '/')).toLowerCase()

// ── tool-name classification tables (mirror the assessment contract) ────────

const READ_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'lsp'])
const WRITE_TOOLS = new Set(['write', 'edit'])
const SESSION_STATE_TOOLS = new Set([
  'ask_user_question', 'todo_write', 'get_goal', 'create_goal', 'update_goal',
  'exit_plan_mode', 'skill', 'report',
])
const HARNESS_READ_TOOLS = new Set([
  'job_output', 'job_list', 'schedule_list', 'session_search', 'session_event_search',
  'session_trace', 'session_event_trace', 'session_event_read', 'terminal_read', 'terminal_list',
  'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
])
const OWNER_CONTROL_TOOLS = new Set(['job_kill', 'terminal_signal', 'terminal_close'])
const AGENT_TEAMS_CONTROL_TOOLS = new Set([
  'agent_teams_create', 'agent_teams_add_member', 'agent_teams_remove_member',
  'agent_teams_create_task', 'agent_teams_claim_task', 'agent_teams_update_task',
  'agent_teams_send_message', 'agent_teams_status', 'agent_teams_delete',
])
const ORCHESTRATION_TOOLS = new Set([
  'subagent', 'workflow', 'ralph', 'spawn_agent', 'send_message', 'wait_agent',
  'list_agents', 'interrupt_agent', 'read_thread', 'wait_threads',
])

const RISKY_DESTRUCTIVE = /(?:^|[_-])(?:delete|destroy|remove|erase|purge|drop|truncate|wipe|unlink|rmdir|reset|revoke)(?:$|[_-])/i
const RISKY_EXTERNAL_WRITE = /(?:^|[_-])(?:deploy|publish|push|upload|send|post|release|merge|submit|create[-_]?(?:issue|pull[-_]?request))(?:$|[_-])/i
const RISKY_SECURITY_CHANGE = /(?:^|[_-])(?:chmod|chown|permission|permissions|policy|grant|revoke|role|credential|credentials|secret|secrets|auth)(?:$|[_-])/i

/** Label a registered tool call with its category ('unknown' → inherit). */
export function categorizeTool(exec: CategoryExec, roots: CategoryRoots): CategoryKey | 'harnessInternal' | 'unknown' {
  const name = String(exec?.name ?? '')
  if (name === 'bash' || name === 'pwsh') {
    const command = record(exec?.arguments)?.['command']
    if (typeof command === 'string') return categorizeCommand(command, name, roots).category
    return 'unknown'
  }
  if (SESSION_STATE_TOOLS.has(name) || HARNESS_READ_TOOLS.has(name)
    || OWNER_CONTROL_TOOLS.has(name) || AGENT_TEAMS_CONTROL_TOOLS.has(name)
    || ORCHESTRATION_TOOLS.has(name)) return 'harnessInternal'
  if (READ_TOOLS.has(name)) {
    const path = pathArgument(exec?.arguments)
    if (path !== undefined) {
      const normalized = normalizePath(path, roots.workspace, roots.home)
      if (sensitiveBasenameAt(normalized, roots) || isProtectedProjectPath(normalized, roots)) return 'protected'
    }
    return 'readOnly'
  }
  if (WRITE_TOOLS.has(name)) {
    const path = pathArgument(exec?.arguments)
    if (path === undefined) return 'unknown'
    const normalized = normalizePath(path, roots.workspace, roots.home)
    if (sensitiveBasenameAt(normalized, roots) || isProtectedProjectPath(normalized, roots)) return 'protected'
    return 'fileEdit'
  }
  if (name === 'apply_patch') {
    const targets = patchTargets(exec?.arguments)
    if (targets === undefined) return 'unknown'
    const normalized = targets.map((target) => normalizePath(target, roots.workspace, roots.home))
    if (normalized.some((n) => sensitiveBasenameAt(n, roots) || isProtectedProjectPath(n, roots))) return 'protected'
    return 'fileEdit'
  }
  if (name === 'str_replace_editor') {
    const command = String(record(exec?.arguments)?.['command'] ?? '')
    const path = pathArgument(exec?.arguments)
    if (path === undefined) return 'unknown'
    const normalized = normalizePath(path, roots.workspace, roots.home)
    const fused = sensitiveBasenameAt(normalized, roots) || isProtectedProjectPath(normalized, roots)
    if (command === 'view') return fused ? 'protected' : 'readOnly'
    if (command === 'create' || command === 'str_replace' || command === 'insert') {
      return fused ? 'protected' : 'fileEdit'
    }
    return 'unknown'
  }
  if (name === 'terminal_open' || name === 'terminal_send') return 'privilege'
  if (name === 'web_search' || name === 'web_fetch') return 'networkExec'
  if (name === 'time' || name === 'weather') return 'readOnly'
  if (name === 'git_push') return 'gitPush'
  if (name === 'deploy' || name === 'publish' || name === 'send_email'
    || name === 'create_issue' || name === 'create_pull_request') return 'publish'
  if (RISKY_DESTRUCTIVE.test(name)) return 'delete'
  if (RISKY_EXTERNAL_WRITE.test(name)) return 'publish'
  if (RISKY_SECURITY_CHANGE.test(name)) return 'privilege'
  return 'unknown'
}

// ── shell command classification (segment level, then strict merge) ─────────

const PRIVILEGE_COMMANDS = new Set(['sudo', 'doas', 'su'])
const BASH_READ_ONLY = new Set([
  'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'cat', 'wc', 'od', 'du', 'df', 'stat', 'file', 'which', 'type',
  'echo', 'printf', 'true', 'false', ':', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id',
  'hostname', 'uname', 'printenv', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff', 'cmp', 'jq', 'tree', 'column',
  'md5sum', 'shasum', 'sha1sum', 'sha256sum',
])
const PWSH_READ_ONLY = new Set([
  'get-location', 'get-childitem', 'get-content', 'select-string', 'get-item', 'test-path',
  'write-output', 'write-host', 'measure-object', 'select-object', 'sort-object', 'get-date',
])
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'])
const GIT_LOCAL = new Set([
  'commit', 'merge', 'rebase', 'checkout', 'switch', 'branch', 'tag', 'restore',
  'stash', 'am', 'revert', 'cherry-pick', 'fetch', 'pull',
])
const WRAPPERS = new Set(['env', 'nohup', 'setsid', 'stdbuf', 'command', 'time', 'timeout', 'xargs', 'nice', 'ionice'])
const WRAPPER_VALUE_FLAGS: Record<string, RegExp> = {
  xargs: /^-(?:n|I|i|P|L|s|d|E|a)$/,
  stdbuf: /^-(?:i|o|e)$/,
  nice: /^-(?:n)$/,
  ionice: /^-(?:c|n|p)$/,
}
const NESTED_INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript'])
const NESTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
const NESTED_EVAL = new Set(['eval', 'iex', 'invoke-expression'])
const NESTED_DELEGATE = new Set(['exec', 'source', '.', 'invoke-command', 'start-process'])
const DB_SERVICE_INFRA = /^(?:dropdb|createdb|psql|mysql|mongosh|redis-cli|kubectl|terraform|ansible|systemctl|launchctl|bcdedit|set-executionpolicy|disable-windowsdefender)$/
const DISK_COMMANDS = new Set(['dd', 'clear-disk', 'format-volume', 'remove-partition', 'initialize-disk'])
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'ssh', 'scp', 'rsync'])
const PKG_MANAGERS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'bun'])
const PUSH_COMMANDS = new Set(['docker', 'podman', 'buildah'])
const DELETE_BASH = new Set(['rm', 'rmdir', 'unlink', 'shred'])
const DELETE_PWSH = new Set(['remove-item', 'rm', 'ri', 'rd', 'del', 'erase', 'rmdir'])

function unwrapWords(words: SegmentWord[]): { words: SegmentWord[]; dynamicInput: boolean } {
  let current = words
  let dynamicInput = false
  while (current.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=.+/.test(current[0]?.text ?? '')) {
    current = current.slice(1)
  }
  for (let depth = 0; depth < 4; depth += 1) {
    const name = commandName(current[0]?.text ?? '')
    if (!WRAPPERS.has(name)) break
    if (name === 'xargs') dynamicInput = true
    const valueFlag = WRAPPER_VALUE_FLAGS[name]
    let index = 1
    while (index < current.length) {
      const token = current[index].text
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }
      if (!token.startsWith('-')) break
      if (valueFlag?.test(token) === true) index += 1
      index += 1
    }
    if (name === 'timeout' && /^[0-9]+(?:\.[0-9]+)?[smhd]?$/.test(current[index]?.text ?? '')) index += 1
    const next = current.slice(index)
    if (next.length === 0) return { words: current, dynamicInput }
    current = next
  }
  return { words: current, dynamicInput }
}

function nestedExecution(name: string, words: SegmentWord[]) {
  if (NESTED_INTERPRETERS.has(name)) {
    const index = words.findIndex((word, wordIndex) => wordIndex > 0 && /^(?:-c|-e|-E|--eval|--exec|--command|--print)$/.test(word.text))
    return index >= 0 ? {} : undefined
  }
  if (NESTED_SHELLS.has(name)) {
    const index = words.findIndex((word, wordIndex) => wordIndex > 0 && /^(?:-c|\/c|--command)$/.test(word.text))
    return {} // a bare outer shell is still a nested-execution boundary
  }
  if (NESTED_EVAL.has(name)) return {}
  if (NESTED_DELEGATE.has(name)) return {}
  return undefined
}

function isDeletion(name: string, shell: string): boolean {
  return shell === 'bash' ? DELETE_BASH.has(name) : DELETE_PWSH.has(name)
}

function findHasDestructiveAction(words: SegmentWord[]): boolean {
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index].text.toLowerCase()
    if (token === '-delete') return true
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(token)) continue
    const terminator = words.findIndex((word, nestedIndex) => nestedIndex > index && (word.text === ';' || word.text === '+'))
    if (terminator < 0) return false
    const nested = words.slice(index + 1, terminator)
    if (isDeletion(commandName(nested[0]?.text ?? ''), 'bash')) return true
    index = terminator
  }
  return false
}

function versionProbe(name: string, words: SegmentWord[]): boolean {
  const tokens = words.map((word) => word.text)
  return (['node', 'python', 'python3', 'pip', 'pip3', 'pnpm', 'npm', 'yarn', 'bun', 'git', 'cargo', 'rustc'].includes(name)
    && tokens.length === 2 && ['--version', '-v', 'version'].includes(tokens[1]?.toLowerCase() ?? ''))
    || (name === 'go' && tokens.length === 2 && tokens[1]?.toLowerCase() === 'version')
}

function buildOrTest(name: string, words: SegmentWord[]): boolean {
  const tokens = words.map((word) => word.text)
  const first = tokens[1]?.toLowerCase()
  if (PKG_MANAGERS.has(name)) {
    if (first === 'test') return true
    if (first === 'run') return /^(?:build|test|typecheck|check|verify|lint)(?::[\w-]+)?$/.test(tokens[2] ?? '')
    return first === 'exec' || first === 'ci'
  }
  if (['tsc', 'vitest', 'eslint', 'pytest'].includes(name)) return true
  if (['cargo', 'go'].includes(name)) return ['build', 'test', 'check', 'vet'].includes(first ?? '')
  if (name === 'make') return tokens.length === 1 || tokens.slice(1).every((token) => /^(?:build|test|check|verify|lint)$/.test(token))
  return false
}

const looksLikeExplicitPath = (token: string): boolean =>
  token.startsWith('/') || token.startsWith('.') || token.startsWith('~')
  || /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token)

function explicitPaths(words: SegmentWord[], roots: CategoryRoots): { raw: string; normalized: string }[] {
  const out: { raw: string; normalized: string }[] = []
  for (const word of words) {
    if (word.dynamic || word.glob) continue
    if (looksLikeExplicitPath(word.text)) {
      out.push({ raw: word.text, normalized: normalizePath(word.text, roots.workspace, roots.home) })
    }
  }
  return out
}

function readTargetsProtected(targets: SegmentWord[], roots: CategoryRoots): boolean {
  for (const target of targets) {
    if (target.dynamic || target.glob) continue
    if (!looksLikeExplicitPath(target.text)) continue
    const normalized = normalizePath(target.text, roots.workspace, roots.home)
    if (sensitiveBasenameAt(normalized, roots) || isProtectedProjectPath(normalized, roots)) return true
  }
  return false
}

function creationCategory(name: string, words: SegmentWord[], shell: string, roots: CategoryRoots): CategoryKey | 'unknown' {
  let raw: SegmentWord[] = []
  if (shell === 'bash' && (name === 'mkdir' || name === 'touch')) {
    raw = words.slice(1).filter((word) => !word.text.startsWith('-'))
  } else if (shell === 'pwsh' && name === 'new-item') {
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index]
      if (/^-(?:path|literalpath)$/i.test(word.text)) {
        const value = words[index + 1]
        if (value !== undefined) raw.push(value)
        index += 1
      } else if (!word.text.startsWith('-') && !/^(?:file|directory)$/i.test(word.text)) {
        raw.push(word)
      }
    }
  }
  if (raw.length === 0) return 'unknown'
  if (readTargetsProtected(raw, roots)) return 'protected'
  return 'fileEdit'
}

function classifySegment(segment: Segment, shell: string, roots: CategoryRoots): CategoryKey | 'unknown' {
  if (segment.words.length === 0) return 'unknown'
  const first = segment.words[0]
  if (first.dynamic || first.glob || first.quoted) return 'unknown'
  const unwrapped = unwrapWords(segment.words)
  const name = commandName(unwrapped.words[0]?.text ?? '')
  if (name === '') return 'unknown'
  if (PRIVILEGE_COMMANDS.has(name)) return 'privilege'
  if (nestedExecution(name, unwrapped.words) !== undefined) return 'privilege'
  if (isDeletion(name, shell)) return 'delete'
  if (name === 'find') {
    if (findHasDestructiveAction(unwrapped.words)) return 'delete'
    return 'readOnly'
  }
  if (name === 'git') {
    const sub = unwrapped.words[1]?.text.toLowerCase() ?? ''
    if (GIT_READ_ONLY.has(sub)) return 'readOnly'
    if (sub === 'reset' || sub === 'clean') return 'delete'
    if (sub === 'push') {
      const force = unwrapped.words.slice(2).some((word) => {
        const token = word.text.toLowerCase()
        return token === '--force' || token === '-f' || token.startsWith('--force-with-lease')
      })
      return force ? 'privilege' : 'gitPush'
    }
    if (GIT_LOCAL.has(sub)) return 'gitLocal'
    return 'unknown'
  }
  const readOnly = (shell === 'bash' ? BASH_READ_ONLY : PWSH_READ_ONLY).has(name)
  if (readOnly) {
    const protectedPath = readTargetsProtected([...unwrapped.words.slice(1), ...segment.readTargets], roots)
    if (protectedPath) return 'protected'
    return 'readOnly'
  }
  if (versionProbe(name, unwrapped.words)) return 'build'
  if (buildOrTest(name, unwrapped.words)) return 'build'
  if (PKG_MANAGERS.has(name)) {
    const firstOpt = unwrapped.words[1]?.text.toLowerCase() ?? ''
    if (firstOpt === 'publish') return 'publish'
    if ((firstOpt === 'install' || firstOpt === 'add')
      && unwrapped.words.slice(2).some((word) => word.text === '-g' || word.text === '--global' || word.text === 'global')) {
      return 'privilege'
    }
    return 'unknown'
  }
  if (PUSH_COMMANDS.has(name) && unwrapped.words[1]?.text.toLowerCase() === 'push') return 'publish'
  if (DISK_COMMANDS.has(name) || /^mkfs(?:\.|$)/.test(name)) return 'disk'
  if (NETWORK_COMMANDS.has(name)) return 'networkExec'
  if (DB_SERVICE_INFRA.test(name)) return 'privilege'
  const creation = creationCategory(name, unwrapped.words, shell, roots)
  if (creation !== 'unknown') return creation
  if (shell === 'bash' && (name === 'cp' || name === 'mv')) {
    const paths = explicitPaths(unwrapped.words.slice(1), roots)
    if (paths.some((p) => sensitiveBasenameAt(p.normalized, roots) || isProtectedProjectPath(p.normalized, roots))) return 'protected'
    return 'fileEdit'
  }
  if (segment.writeTargets.length > 0) {
    if (readTargetsProtected(segment.writeTargets, roots)) return 'protected'
    return 'fileEdit'
  }
  return 'unknown'
}

export interface CommandSegmentDecision {
  category: CategoryKey | 'unknown'
  directive: CategoryDirective
}

export interface CommandDecision {
  category: CategoryKey | 'unknown'
  directive: CategoryDirective
}

/**
 * Merge per-segment decisions (Q5 dual-track): the category is the first by
 * global precedence (unknown never drags), and the directive is the strictest
 * of the segment values (deny > ask > auto > inherit).
 */
export function mergeCommandDecisions(segments: CommandSegmentDecision[]): CommandDecision {
  let category: CategoryKey | 'unknown' = 'unknown'
  let best = -1
  let directive: CategoryDirective = 'inherit'
  const strictness: Record<CategoryDirective, number> = { deny: 4, ask: 3, auto: 2, inherit: 1 }
  for (const segment of segments) {
    if (segment.category !== 'unknown') {
      const rank = CATEGORY_PRECEDENCE[segment.category]
      if (rank > best) {
        best = rank
        category = segment.category
      }
    }
    if (strictness[segment.directive] > strictness[directive]) directive = segment.directive
  }
  return { category, directive }
}

/**
 * Classify one command line into per-segment decisions. An opaque line (the
 * decomposition cannot be read statically) degrades to a single unknown
 * segment so the merge never turns it into a directive.
 */
export function categorizeCommandSegments(source: string, shell: string, roots: CategoryRoots, config: CategoryConfig = {}): CommandSegmentDecision[] {
  const decomposition = decomposeCommandLine(String(source ?? ''), shell)
  const opaque = (decomposition as { kind?: string }).kind === 'opaque'
  if (opaque) return [{ category: 'unknown', directive: 'inherit' }]
  const segments = (decomposition as { segments?: unknown[] }).segments ?? []
  return segments.map((raw) => {
    const segment = raw as Segment
    const category = classifySegment(segment, shell, roots)
    return { category, directive: categoryDirective(config, category, { decision: 'ask', classifierEligible: true }) }
  })
}

/** Classify one command line (merged category + strictest directive). */
export function categorizeCommand(source: string, shell: string, roots: CategoryRoots, config: CategoryConfig = {}): CommandDecision {
  return mergeCommandDecisions(categorizeCommandSegments(source, shell, roots, config))
}

/**
 * Derive the tri-state directive for one category under a config slice.
 * - unknown / harnessInternal → inherit (no configurable key exists)
 * - LOCKED categories: only 'ask' is legal; a mis-clamped auto/deny clamps to
 *   'ask'; unconfigured → 'inherit' (standard) or 'ask' (aggressive builtin)
 * - networkExec/gitPush/publish unconfigured → 'auto' under aggressive
 * - 'auto' only applies to an ask-classified, classifier-eligible call; for
 *   every other assessment it degrades to 'inherit' (manual/opaque never auto)
 * - 'ask'/'deny' flow through for every non-hard-denied assessment (the
 *   pre-execute tightening must also cover static-allow calls)
 */
export function categoryDirective(
  config: CategoryConfig,
  category: string,
  assessment: { decision?: string; classifierEligible?: boolean },
): CategoryDirective {
  if (category === 'unknown' || category === 'harnessInternal') return 'inherit'
  const mode = config.categoryMode === 'aggressive' ? 'aggressive' : 'standard'
  const policy = config.categoryPolicy ?? {}
  const explicit = policy[category]
  const locked = LOCKED_CATEGORIES.includes(category as CategoryKey)
  if (locked) {
    if (explicit !== undefined) return 'ask'
    return mode === 'aggressive' ? 'ask' : 'inherit'
  }
  const value = explicit ?? (AGGRESSIVE_BUILTIN.includes(category as CategoryKey) && mode === 'aggressive' ? 'auto' : 'inherit')
  if (value === 'ask' || value === 'deny') return value
  if (value === 'auto') {
    if (assessment.decision === 'ask' && assessment.classifierEligible === true) return 'auto'
    return 'inherit'
  }
  return 'inherit'
}

export interface CategoryDirectiveForResult {
  /** Tri-state directive for this execution. */
  directive: CategoryDirective
  /** The category label the directive was derived from (for history/audit). */
  category: CategoryKey | 'harnessInternal' | 'unknown'
}

/**
 * Wire-point helper: recompute directive + category label for one tool
 * execution from scratch (no state crosses between the pre-execute and
 * answerer points). Both values come from the same classification so the
 * wiring points never re-derive the label separately.
 */
export function categoryDirectiveFor(exec: CategoryExec, roots: CategoryRoots, config: CategoryConfig): CategoryDirectiveForResult {
  const category = categorizeTool(exec, roots)
  return {
    category,
    directive: categoryDirective(config, category, { decision: 'ask', classifierEligible: true }),
  }
}

export type AppliedRisk = 'DENY' | 'ask-human' | 'LOW' | 'MEDIUM' | 'HIGH'

/**
 * Lower the risk tier by one directive (answerer-side injection):
 * - DENY stays terminal (the hard-deny floor is not configurable)
 * - deny → terminal deny; ask → human ask; auto → LOW but never for a HIGH
 *   tier, and never when the assessment is not an ask-classified,
 *   classifier-eligible call (manual/opaque stay put)
 * - inherit → unchanged
 */
export function applyCategoryDirective(
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'DENY',
  directive: CategoryDirective,
  assessment: { decision?: string; classifierEligible?: boolean },
): AppliedRisk {
  if (risk === 'DENY') return 'DENY'
  if (directive === 'deny') return 'DENY'
  if (directive === 'ask') return 'ask-human'
  if (directive === 'auto') {
    if (assessment.decision === 'ask' && assessment.classifierEligible === true && risk !== 'HIGH') return 'LOW'
    return risk
  }
  return risk
}