/**
 * Hard cap on a free-text reason accepted from a model, in characters. Not a
 * user setting: it bounds what a reviewer endpoint can push into
 * history/audit/UI regardless of configuration. `parseClassifierDecision`
 * rejects a longer reason outright (its response schema is strict);
 * `parseReview` truncates instead, because dropping a decisive reviewer
 * verdict over a long explanation would turn a DENY into an ESCALATE.
 */
export const MODEL_REASON_MAX_CHARS = 1_000

/**
 * The direct-human-approval tool name: an agent calls this to ask that a
 * follow-up operation be reviewed by a human instead of the LLM classifier.
 * Single source of truth shared by the policy layer (policy.ts forces the
 * call onto the pure-human ask plane) and the host answerer (index.ts routes
 * the ask through the confirmation-learning hook with the target signature).
 * The name deliberately avoids the destructive / external-write /
 * security-change risk patterns so the policy sees it as an ordinary ask.
 */
export const DIRECT_HUMAN_TOOL = 'dsa_request_user'

/**
 * Tools that the policy layer statically allows WITHOUT inspecting arguments
 * (the unconditional-allow plane of assessTool): session/control tools,
 * read-only Harness services, owner-scoped lifecycle control, AgentTeams
 * coordination, read-only external lookups and orchestration calls. These are
 * shown in the settings「默认放行工具」list. Conditionally-allowed tools
 * (read/write/bash/web_fetch on sensitive paths etc.) are intentionally NOT
 * here — their allow depends on path/argument inspection. This is the single
 * source of truth for both the policy allow plane and the settings-card
 * display, so the shown list can never drift from what the policy actually
 * allows.
 */
export const DEFAULT_ALLOW_TOOL_GROUPS: ReadonlyArray<{ label: string; tools: readonly string[] }> = [
  {
    label: 'Session & control',
    tools: ['ask_user_question', 'todo_write', 'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'skill'],
  },
  {
    label: 'Read-only Harness',
    tools: [
      'job_output', 'job_list', 'schedule_list',
      'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
      'terminal_read', 'terminal_list',
      'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
    ],
  },
  {
    label: 'Owner lifecycle control',
    tools: ['job_kill', 'terminal_signal', 'terminal_close'],
  },
  {
    label: 'AgentTeams coordination',
    tools: [
      'agent_teams_create', 'agent_teams_add_member', 'agent_teams_remove_member',
      'agent_teams_create_task', 'agent_teams_claim_task', 'agent_teams_update_task',
      'agent_teams_send_message', 'agent_teams_status', 'agent_teams_delete',
    ],
  },
  {
    label: 'Read-only external lookup',
    tools: ['web_search', 'web_fetch', 'time', 'weather'],
  },
  {
    label: 'Orchestration',
    tools: ['subagent', 'workflow', 'ralph', 'spawn_agent', 'send_message', 'wait_agent', 'list_agents', 'interrupt_agent', 'read_thread', 'wait_threads'],
  },
]

/** Flat, de-duplicated tool names of every {@link DEFAULT_ALLOW_TOOL_GROUPS}. */
export const DEFAULT_ALLOW_TOOLS: readonly string[] = [
  ...new Set(DEFAULT_ALLOW_TOOL_GROUPS.flatMap((g) => [...g.tools])),
]



/**
 * Single source of truth for numeric threshold defaults. The host Config
 * schema, host fallbacks and the client settings draft/reset values all
 * reference these so one change lands everywhere at once.
 */
export const THRESHOLD_DEFAULTS = {
  lowRiskSeconds: 5,
  mediumRiskSeconds: 8,
  highRiskSeconds: 10,
  maxConsecutiveDenials: 3,
  maxTotalDenials: 20,
  maxArgsChars: 4_000,
  breakerAntiHijackMs: 0,
  classifierTimeoutMs: 8_000,
  classifierMaxOutputTokens: 1_024,
  reviewMaxRetries: 1,
  /** Per-attempt wait for one reviewer response, in seconds. */
  reviewWaitSeconds: 5,
  /** Cap for rule text injected into the reviewer system prompt. */
  rulesSummaryMaxChars: 2_000,
  /** Human confirmations (default) before a same-signature call may auto-allow. */
  learningThreshold: 3,
  /** Learning entries expire after this many days without a confirmation. */
  learningTtlDays: 30,
  /** Hard ceiling on stored learning entries (LRU by lastAt evicts). */
  learningMaxEntries: 100,
  /** Learned allows per root session before the learning layer sleeps. */
  learningSessionAllowCap: 50,
} as const
