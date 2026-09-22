/**
 * The producer-owned message source this plugin declares for the context it
 * builds and injects.
 *
 * The harness vocabulary carries no shared catch-all `plugin` kind: every
 * producer declares its own `kind` in its own module, and the durable log
 * refuses a message whose source kind is still `plugin`. Messages this plugin
 * builds therefore carry this kind, declared once here and reused everywhere.
 */
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-auto-approval-llm': { kind: 'dsh-auto-approval-llm' } & ContextFormed
  }
}

/** Producer-owned source attached to every message this plugin builds. */
export const PLUGIN_MESSAGE_SOURCE: MessageSource = { kind: 'dsh-auto-approval-llm' }
