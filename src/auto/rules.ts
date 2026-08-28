/**
 * dsh-auto-approval-llm · declarative rules (B1).
 *
 * A pure Claude-Code-style declarative rule layer (supersedes the removed
 * legacy `riskRules` regex routes). Line grammar (one rule per line, blank/#-comments ignored):
 *
 *   Tool(pattern) | allow|deny|human [| reason|toolName|arguments]
 *   pattern       | allow|deny|human [| reason|toolName|arguments]
 *
 * Optional scope prefix right before the pattern:
 *
 *   [agent:main|subagent|name*] Tool(pattern) | allow|deny|human [| field]
 *   [workspace:D:/proj-a]       Tool(pattern) | allow|deny|human [| field]
 *   [agent:main,workspace:D:/proj-a] ...        (comma list = AND)
 *
 * - A line starting with `[` is only treated as a scope prefix when every
 *   comma-separated item looks like `key:value`; otherwise the whole line
 *   keeps the legacy interpretation (a regex, e.g. `[a-z]+ | deny`).
 * - `agent` accepts `main`, `subagent`, or a concrete session id (glob `*`
 *   supported); a leading `!` negates the match. `workspace` accepts an
 *   absolute or relative path; relative values name the workspace directory
 *   itself. A rule with a scope only applies when every dimension matches,
 *   otherwise the rule is skipped like a tool-scope mismatch.
 * - `Tool(a)` with a comma list (bash,pwsh) scopes the rule to those tools
 *   (names may contain `*`). Without parentheses the pattern applies to every
 *   tool.
 * - `field` defaults to `arguments` for the new syntax (the `arguments` object
 *   being matched depends on the tool; command tools match their command text).
 * - First matching rule wins; only one policy is returned.
 *
 * Kept pure (no imports) so host enforcement and the browser settings-card
 * live validation share the exact same interpretation.
 */

export type RulePolicy = 'allow' | 'deny' | 'human'
export type RuleField = 'reason' | 'toolName' | 'arguments'
export type AgentKind = 'main' | 'subagent' | 'unknown'

export interface RuleDimensionAgent {
  value: string
  /** `!`-prefixed value: the rule applies when the agent does NOT match. */
  negated: boolean
}

export interface RuleDimensions {
  agent?: RuleDimensionAgent
  workspace?: string
}

export interface DeclaredRule {
  tools?: string[]
  pattern: RegExp
  source: string
  policy: RulePolicy
  field: RuleField
  /** Scope prefix (`[agent:...]` / `[workspace:...]`); absent for legacy lines. */
  dimensions?: RuleDimensions
}

export interface RuleParseError {
  line: number
  message: string
}

export interface RuleSet {
  rules: DeclaredRule[]
  errors: RuleParseError[]
}

/**
 * Classify an agent from its session header origin. Sessions started as
 * subagents carry exactly `'subagent'`; main sessions leave the origin
 * undefined. Any other value is treated as unknown so scoped rules fail
 * closed instead of guessing.
 */
export function agentKind(origin: string | undefined | null): AgentKind {
  if (origin === 'subagent') return 'subagent'
  if (origin === undefined || origin === null) return 'main'
  return 'unknown'
}

function isBoundedPattern(src: string): boolean {
  // Keep authorable rules bounded and reject the most obvious catastrophic
  // signatures. Full ReDoS detection is intentionally not attempted — real
  // static analysis of backtracking complexity is out of scope. We only guard
  // against two unmistakable shapes: a group ending in an unbounded quantifier
  // that is itself quantified again (nested `(a+)+`), and an alternation group
  // wrapped in an outer unbounded quantifier. Anything else, including common
  // anchored patterns like `^git push`, is left untouched.
  if (src.length > 2_000) return false
  // Nested / duplicated unbounded quantifiers: `(a+)+`, `(.*)*`, ...
  if (/\(\s*[^()]*[+*][^()]*\)\s*[+*]/.test(src)) return false
  // Alternation wrapped in an outer unbounded quantifier: `(a|b|c)*`, ...
  if (/\(\s*(?:[^()]*\|[^()]*\|[^()]*)\s*\)\s*[+*]/.test(src)) return false
  // Nested groups each carrying a repeat, at any paren depth: `((a)+)+`,
  // `((ab)*)+` — exhaustive nested-quantifier checks are out of scope, but this
  // unmistakable shape is a classic catastrophic-backtracking signature.
  if (/\(\([^)]*\)\s*[+*?][^)]*\)\s*[+*?]/.test(src)) return false
  // A counted repeat with an unbounded/loose upper bound applied to a group or
  // a repeat (`(a+){0,}`, `(a|b){2,}`, `(ab){5,}`) can still force
  // super-linear backtracking and is not caught by the `[+*]` guards above.
  if (/(?:\)|[*+?])\s*\{\s*\d+\s*,\s*\}/.test(src)) return false
  return true
}

/** Anchor a glob pattern (`*` wildcards) as an anchored case-insensitive regex. */
function toGlobRegExp(pattern: string): RegExp {
  // `?` is escaped as a literal: only `*` is a documented glob character, and
  // an agent value like `?` (which parseDimensionHeader accepts) must never
  // compile into a quantifier — `/^?$/` throws SyntaxError at evaluation time,
  // crashing the approval chain instead of failing the rule closed.
  const source = `^${pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`
  try {
    return new RegExp(source, 'i')
  } catch {
    // A pathological spelling that survives parsing (hand-edited rules text)
    // must never throw inside evaluateRules: a never-matching rule is the
    // fail-closed shape (the rule simply does not apply).
    return new RegExp('(?!)', 'i')
  }
}

/** Path comparison form: separators unified to `/`, trailing slashes dropped, case folded. */
function normalizeRulePath(p: string): string {
  let s = p.replace(/\\/g, '/')
  while (s.endsWith('/')) s = s.slice(0, -1)
  return s.toLowerCase()
}

interface DimensionHeaderParse {
  dimensions?: RuleDimensions
  /** Line content after the `[...]` prefix when the line carries a scope. */
  rest?: string
  error?: string
}

/**
 * Scope-prefix disambiguation for a `[`-starting line (three stages):
 * 1. Every `,`-separated header item must read as `key:value` (letter key,
 *    colon, any value) — otherwise the line keeps its legacy regex reading.
 * 2. A valid `key:value` shape then goes through the semantic stage: keys must
 *    be the lowercase `agent`/`workspace`, values must be legal.
 * 3. Semantic violations are reported per line instead of being silent, so a
 *    mistyped scope can never degrade to an unscoped (widened) rule.
 */
function parseDimensionHeader(line: string): DimensionHeaderParse {
  const head = /^\[([^\]]*)\]\s*(.*)$/.exec(line)
  if (!head) return { dimensions: undefined }
  const items = head[1].split(',')
  const parsed: Array<{ key: string; value: string }> = []
  for (const item of items) {
    if (item === '') return { error: '空的维度项（如尾逗号）' }
    const m = /^([a-zA-Z]+):(.*)$/.exec(item)
    if (!m) return { dimensions: undefined }
    parsed.push({ key: m[1], value: m[2] })
  }
  const dims: RuleDimensions = {}
  for (const { key, value } of parsed) {
    if (key === 'agent') {
      if (dims.agent !== undefined) return { error: '维度 agent 重复' }
      if (value === '') return { error: 'agent 值为空' }
      let negated = false
      let name = value
      if (name.startsWith('!')) {
        negated = true
        name = name.slice(1)
        if (name === '') return { error: 'agent 取反值不能为空' }
        if (name.startsWith('!')) return { error: 'agent 取反值不能为 "!!" 形式' }
        if (name === '*') return { error: 'agent 取反值不能为 "*"' }
        if (name === 'workspace') return { error: 'agent 取反值不能为 "workspace"' }
      }
      dims.agent = { value: name, negated }
      continue
    }
    if (key === 'workspace') {
      if (dims.workspace !== undefined) return { error: '维度 workspace 重复' }
      if (value === '') return { error: 'workspace 值为空' }
      if (value.startsWith('!')) return { error: 'workspace 不接受 "!" 取反' }
      if (value.split(/[\\/]/).includes('..')) return { error: 'workspace 值不能包含 ".."' }
      if (/[\\/]$/.test(value)) return { error: 'workspace 值不能以斜杠结尾' }
      dims.workspace = value
      continue
    }
    return { error: `未知维度 "${key}"（维度 key 必须为小写 agent|workspace）` }
  }
  return { dimensions: dims, rest: head[2] }
}

export function parseRulesText(text: string): RuleSet {
  const rules: DeclaredRule[] = []
  const errors: RuleParseError[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const lineNum = index + 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    let dimensions: RuleDimensions | undefined
    let left = line
    if (line.startsWith('[')) {
      const scope = parseDimensionHeader(line)
      if (scope.error !== undefined) {
        errors.push({ line: lineNum, message: `维度非法：${scope.error}` })
        return
      }
      if (scope.dimensions !== undefined) {
        dimensions = scope.dimensions
        left = scope.rest ?? ''
      }
    }
    const parts = left.split('|').map((p) => p.trim())
    if (parts.length < 2 || parts.length > 3) {
      errors.push({ line: lineNum, message: '格式应为：pattern | allow|deny|human [| field]' })
      return
    }
    const policy = parts[1]
    if (policy !== 'allow' && policy !== 'deny' && policy !== 'human') {
      errors.push({ line: lineNum, message: `未知策略 "${policy}"（应为 allow|deny|human）` })
      return
    }
    let field: RuleField = 'arguments'
    if (parts[2] !== undefined) {
      if (parts[2] !== 'reason' && parts[2] !== 'toolName' && parts[2] !== 'arguments') {
        errors.push({ line: lineNum, message: `未知字段 "${parts[2]}"（应为 reason|toolName|arguments）` })
        return
      }
      field = parts[2]
    }
    const theLeft = parts[0]
    let tools: string[] | undefined
    let patternSource = theLeft
    const scoped = /^([A-Za-z0-9_*,*-]+)\((.*)\)$/.exec(theLeft)
    if (scoped) {
      tools = scoped[1].split(',').map((t) => t.trim()).filter(Boolean)
      patternSource = scoped[2]
    }
    if (patternSource === '') {
      errors.push({ line: lineNum, message: '正则为空' })
      return
    }
    if (!isBoundedPattern(patternSource)) {
      errors.push({ line: lineNum, message: '正则过复杂或疑似灾难性回溯，拒绝' })
      return
    }
    let pattern: RegExp
    try {
      pattern = new RegExp(patternSource, 'i')
    } catch {
      errors.push({ line: lineNum, message: `正则非法：${patternSource}` })
      return
    }
    rules.push({
      ...(tools === undefined ? {} : { tools }),
      pattern,
      source: patternSource,
      policy: policy as RulePolicy,
      field,
      ...(dimensions === undefined ? {} : { dimensions }),
    })
  })
  return { rules, errors }
}

export interface RuleSubject {
  toolName: string
  reason?: string
  arguments?: unknown
  /** Session id of the requesting agent (needed for concrete/glob agent scopes). */
  agentName?: string
  /** Classification of the requesting agent ('unknown' fails closed). */
  agentKind?: AgentKind
  /** Workspace root of the requesting agent (needed for workspace scopes). */
  workspaceRoot?: string
}

/**
 * Field projection for rule matching: command-like tools expose their actual
 * command text under command/script/code/prompt/text/content keys. Matching
 * against the raw argument JSON envelope would defeat anchored patterns like
 * `^git push`. Extract the command/code text first; fall back to the full
 * serialized arguments when no text field exists.
 */
export function extractRuleTarget(args: unknown): string {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed !== null && typeof parsed === 'object') {
        const text = commandText(parsed)
        if (text !== undefined) return text
      }
    } catch {
      // not JSON — fall through and use the raw string
    }
    return args
  }
  if (args !== null && typeof args === 'object') {
    const text = commandText(args as Record<string, unknown>)
    if (text !== undefined) return text
    try {
      return JSON.stringify(args)
    } catch {
      return ''
    }
  }
  return String(args ?? '')
}

function commandText(obj: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'script', 'code', 'prompt', 'text', 'content']) {
    const value = obj[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function renderSubject(rule: DeclaredRule, subject: RuleSubject): string {
  if (rule.field === 'toolName') return subject.toolName
  if (rule.field === 'reason') return subject.reason ?? ''
  if (rule.field === 'arguments') return extractRuleTarget(subject.arguments)
  return ''
}

/**
 * Scope matching evaluates before tools/pattern and is fail-closed: a keyword
 * scope (`main`/`subagent`) needs a determined agentKind, a concrete/glob
 * scope needs agentName, a workspace scope needs workspaceRoot — any missing
 * input makes the rule skip rather than guess.
 */
function matchDimensions(dimensions: RuleDimensions, subject: RuleSubject): boolean {
  const agent = dimensions.agent
  if (agent !== undefined) {
    const name = subject.agentName
    if (agent.value === 'main' || agent.value === 'subagent') {
      const kind = subject.agentKind
      if (kind !== 'main' && kind !== 'subagent') return false
      const hit = kind === agent.value
      if (hit === agent.negated) return false
    } else {
      if (name === undefined) return false
      const hit = toGlobRegExp(agent.value).test(name)
      if (hit === agent.negated) return false
    }
  }
  const workspace = dimensions.workspace
  if (workspace !== undefined) {
    const root = subject.workspaceRoot
    if (root === undefined || root === '') return false
    // Absolute values match the workspace root directly; relative values name
    // the workspace directory itself, resolved against the root's parent.
    const absolute = workspace.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(workspace)
    const anchor = absolute
      ? normalizeRulePath(workspace)
      : normalizeRulePath(`${normalizeRulePath(root).replace(/\/[^/]*$/, '')}/${workspace}`)
    const target = normalizeRulePath(root)
    if (target !== anchor && !target.startsWith(`${anchor}/`)) return false
  }
  return true
}

/**
 * First matching rule wins. Scope dimensions gate first (a mismatch skips the
 * rule, same level as the tool scope); `tools` undefined matches every tool;
 * otherwise the rule only applies when the tool name matches one of the
 * entries (glob `*` supported). Returns the policy and the rule for audit, or
 * undefined.
 */
export function evaluateRules(rules: DeclaredRule[], subject: RuleSubject): { policy: RulePolicy; rule: DeclaredRule } | undefined {
  for (const rule of rules) {
    if (rule.dimensions !== undefined && !matchDimensions(rule.dimensions, subject)) continue
    if (rule.tools !== undefined) {
      const hit = rule.tools.some((t) => {
        if (t.includes('*')) {
          return toGlobRegExp(t).test(subject.toolName)
        }
        return subject.toolName.toLowerCase() === t.toLowerCase()
      })
      if (!hit) continue
    }
    if (rule.pattern.test(renderSubject(rule, subject))) {
      return { policy: rule.policy, rule }
    }
  }
  return undefined
}