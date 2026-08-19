/**
 * dsh-auto-approval-llm · declarative rules (B1).
 *
 * A pure Claude-Code-style declarative rule layer (supersedes the removed
 * legacy `riskRules` regex routes). Line grammar (one rule per line, blank/#-comments ignored):
 *
 *   Tool(pattern) | allow|deny|human [| reason|toolName|arguments]
 *   pattern       | allow|deny|human [| reason|toolName|arguments]
 *
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

export interface DeclaredRule {
  tools?: string[]
  pattern: RegExp
  source: string
  policy: RulePolicy
  field: RuleField
}

export interface RuleParseError {
  line: number
  message: string
}

export interface RuleSet {
  rules: DeclaredRule[]
  errors: RuleParseError[]
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
  return true
}

export function parseRulesText(text: string): RuleSet {
  const rules: DeclaredRule[] = []
  const errors: RuleParseError[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const lineNum = index + 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const parts = line.split('|').map((p) => p.trim())
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
    const left = parts[0]
    let tools: string[] | undefined
    let patternSource = left
    const scoped = /^([A-Za-z0-9_*,*-]+)\((.*)\)$/.exec(left)
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
    rules.push({ ...(tools === undefined ? {} : { tools }), pattern, source: patternSource, policy: policy as RulePolicy, field })
  })
  return { rules, errors }
}

export interface RuleSubject {
  toolName: string
  reason?: string
  arguments?: unknown
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
 * First matching rule wins. `tools` undefined matches every tool; otherwise the
 * rule only applies when the tool name matches one of the entries (glob `*`
 * supported). Returns the policy and the rule for audit, or undefined.
 */
export function evaluateRules(rules: DeclaredRule[], subject: RuleSubject): { policy: RulePolicy; rule: DeclaredRule } | undefined {
  for (const rule of rules) {
    if (rule.tools !== undefined) {
      const hit = rule.tools.some((t) => {
        if (t.includes('*')) {
          const re = new RegExp(`^${t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
          return re.test(subject.toolName)
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
