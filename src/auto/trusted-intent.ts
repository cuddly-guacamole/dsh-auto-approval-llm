/**
 * dsh-auto-approval-llm · the trusted user-intent window.
 *
 * Which user messages and which `ask_user_question` answers count as
 * authorization evidence for the current call.
 */
import { trustedIntentReported } from './approval-state.js'
import { appendAuditLine } from './audit.js'
import { sanitizeClassifierText } from './classifier.js'
import { sessionEventList } from './session-introspect.js'

/**
 * Extract ask_user_question conversations from a session event list and
 * render them as trusted user messages.
 *
 * ask_user_question is a normal tool call: its answers arrive as a tool
 * result, never as a user/message event, so the trusted-message scan alone
 * would miss a decision the user actually made through a question prompt.
 * The user ruling is: the user's ANSWER is their expression (authorization
 * evidence), while the QUESTION text is only context — an agent-crafted
 * question cannot by itself authorize anything, and the answer labels were
 * offered by the asker, so the reviewer still judges the concrete effect.
 *
 * Rendering: `Question "<question>" — user chose: <selected labels>[; custom: <text>]`.
 * Question text rides along only to anchor what the user was answering.
 * Call/result pairing uses the tool-call callId carried on the result's
 * message source. Pure over the event list so the contract is unit-testable.
 */
export interface QuestionAnswerEntry {
  /** Index of the tool/result event this answer came from (time anchor). */
  index: number
  text: string
}

/**
 * Text carried by a `tool/result` message.
 *
 * The message nests the tool's own return value: `createToolResultMessage`
 * (dsh-llm) wraps the result blocks as
 * `{type:'tool-result', toolCallId, content:[{type:'text', text}]}`. Looking for
 * a DIRECT `{type:'text'}` block therefore finds nothing and silently collects
 * no answers — which is exactly how an authorization the user granted through
 * the question panel never reached the trusted intents, leaving a later
 * state-changing call judged as unauthorized.
 *
 * Both shapes are accepted: the nested one is what the host produces, and a
 * direct text block is tolerated so an emitter that flattens the payload cannot
 * silently drop the answers again.
 */
function toolResultText(message: any): string {
  let text = ''
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text += block.text
      continue
    }
    if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner?.type === 'text' && typeof inner.text === 'string') text += inner.text
      }
    }
  }
  return text
}

export function questionAnswerMessages(events: readonly any[]): QuestionAnswerEntry[] {
  const out: QuestionAnswerEntry[] = []
  if (!Array.isArray(events)) return out
  const askCalls = new Map<string, any>()
  for (const event of events) {
    const d = event?.data
    if (event?.type === 'tool/call' && d?.name === 'ask_user_question' && typeof d?.callId === 'string') {
      try {
        const parsed = JSON.parse(String(d.arguments ?? '{}'))
        if (Array.isArray(parsed?.questions)) askCalls.set(d.callId, parsed.questions)
      } catch {
        // Malformed arguments cannot pair; skip the call.
      }
    }
  }
  for (let index = 0; index < events.length; index += 1) {
    const d = events[index]?.data
    const callId = d?.message?.source?.callId
    if (events[index]?.type !== 'tool/result' || typeof callId !== 'string') continue
    const questions = askCalls.get(callId)
    if (!Array.isArray(questions) || questions.length === 0) continue
    const answersText = toolResultText(d?.message)
    let answers: any[] = []
    try {
      const parsed = JSON.parse(answersText)
      if (Array.isArray(parsed?.answers)) answers = parsed.answers
    } catch {
      // Unparseable tool payload cannot be trusted as a structured answer.
    }
    const byId = new Map(questions.map((q: any) => [q?.id, q]))
    for (const answer of answers) {
      if (answer === null || typeof answer !== 'object') continue
      const q = byId.get(answer?.id)
      // An answer whose id matches no asked question is orphaned tool noise
      // (or a replay); it cannot be attributed to any user decision.
      if (q === undefined) continue
      const selected = Array.isArray(answer?.selected)
        ? answer.selected.filter((s: any) => typeof s === 'string' && s.trim() !== '')
        : []
      const custom = typeof answer?.custom === 'string' && answer.custom.trim() !== '' ? answer.custom.trim() : undefined
      if (selected.length === 0 && custom === undefined) continue
      const question = typeof q?.question === 'string' && q.question.trim() !== '' ? q.question.trim() : String(q?.id ?? '')
      const parts: string[] = []
      if (selected.length > 0) parts.push(`user chose: ${selected.join(', ')}`)
      if (custom !== undefined) parts.push(`custom answer: ${custom}`)
      out.push({ index, text: `Question "${question}" — ${parts.join('; ')}.` })
    }
  }
  return out
}

export interface TrustedUserIntent {
  text: string
  /** Which user-authority channel the evidence arrived through. */
  origin: 'user-message' | 'question-answer'
}

export interface TrustedIntentWindow {
  admitted: TrustedUserIntent[]
  /** Candidates the recency/budget window refused: a full 4-slot window or
   *  the 4000-character cap. A repeat of an already-admitted text is no loss
   *  and is not counted. */
  overflow: number
}

export function trustedUserIntents(authority: any): TrustedUserIntent[] {
  return trustedIntentWindow(authority).admitted
}

export function trustedIntentWindow(authority: any): TrustedIntentWindow {
  if (authority === undefined) return { admitted: [], overflow: 0 }
  const events = sessionEventList(authority.session)
  // Steered/interjected prompts live in the agent inbox until the next step
  // consumes them; admit them as trusted user intents (genuine user sources
  // only, never plugin injections).
  const inbox = authority.inbox as { nextStep?: unknown[]; nextTurn?: unknown[] } | undefined
  const inboxTexts: string[] = []
  if (inbox !== undefined) {
    for (const batch of [...(inbox.nextStep ?? []), ...(inbox.nextTurn ?? [])]) {
      const msg: any = Array.isArray(batch) ? batch[0] : batch
      if (msg?.source?.kind !== 'user') continue
      const content = msg.content
      const text = Array.isArray(content)
        ? content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
        : content
      const trimmed = String(text ?? '').trim()
      if (trimmed !== '') inboxTexts.push(sanitizeClassifierText(trimmed))
    }
  }
  // Event-stream intents, newest first: plain user messages plus rendered
  // ask_user_question answers (see questionAnswerMessages), each anchored to
  // its event index so recency is exact.
  const qaByEvent = new Map<number, string>()
  for (const qa of questionAnswerMessages(events)) qaByEvent.set(qa.index, qa.text)
  const eventCandidates: Array<{ seq: number; text: string; origin: TrustedUserIntent['origin'] }> = []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = (event.data.content ?? [])
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n')
      const trimmed = String(text).trim()
      if (trimmed !== '') eventCandidates.push({ seq: i, text: sanitizeClassifierText(trimmed), origin: 'user-message' })
    } else if (event?.type === 'tool/result' && qaByEvent.has(i)) {
      eventCandidates.push({ seq: i, text: qaByEvent.get(i)!, origin: 'question-answer' })
    }
  }
  // Budget: at most 4 messages, newest first; deduped; 4000-char cap. Inbox
  // entries are the newest intents (they arrive after the last event), so
  // they are admitted first and appear last in the oldest-first output.
  // Candidates the window refuses are counted in `overflow` so a denial can
  // say "evidence exists but is older than the window" instead of claiming
  // there was none; repeats of admitted texts are not loss.
  const chosen: TrustedUserIntent[] = []
  const remainingBudget = () => 4_000 - chosen.reduce((sum, t) => sum + t.text.length, 0)
  const tryPick = (intent: TrustedUserIntent): boolean => {
    if (chosen.some((c) => c.text === intent.text)) return true
    if (chosen.length >= 4) return false
    if (intent.text.length > remainingBudget()) return false
    chosen.push(intent)
    return true
  }
  let overflow = 0
  for (const text of inboxTexts) {
    if (!tryPick({ text, origin: 'user-message' })) overflow += 1
  }
  const eventOrdered = eventCandidates.sort((a, b) => b.seq - a.seq)
  for (const c of eventOrdered) {
    if (!tryPick({ text: c.text, origin: c.origin })) overflow += 1
  }
  const inboxChosen = chosen.filter((t) => inboxTexts.includes(t.text))
  const eventChosen = chosen.filter((t) => !inboxTexts.includes(t.text))
  return { admitted: [...eventChosen.reverse(), ...inboxChosen], overflow }
}

export function trustedUserMessages(authority: any) {
  return trustedUserIntents(authority).map((intent) => intent.text)
}

/** Last provenance signature reported per session (the event is deduped). */

/**
 * States whether the deny reason describes a window with no authorization at
 * all or one whose older evidence was dropped: the note is appended after a
 * space and never parsed back — the structured breadcrumb for readers is the
 * `trusted-intents` audit event's `overflowed` flag.
 */
export function withWindowOverflowNote(reason: string, overflow: number): string {
  if (!Number.isFinite(overflow) || overflow <= 0) return reason
  return `${reason} (and ${overflow} earlier user message(s) fell outside the 4-message evidence window — they are not treated as authorization; restate the authorization to cover this action)`
}

/**
 * Observational record of WHICH kinds of authorization evidence the classifier
 * actually received.
 *
 * This class of gap is invisible by construction: when the user's decision never
 * reaches `trustedUserIntents`, the classifier simply sees "no authorization"
 * and denies — no error, no warning, and the audit row is indistinguishable from
 * an ordinary denial. The question-answer channel was broken exactly that way
 * and stayed broken through a previous fix, so the provenance is recorded as a
 * non-decision observation event (default on, never part of a verdict or of the
 * tool statistics).
 *
 * Only the ORIGIN COUNTS are recorded, never the user's text, and the row is
 * deduped per session: it appears when the mix changes — e.g. the first request
 * that finally carries a question answer. `overflowed` states whether older
 * user messages fell outside the 4-message window; it is quantized on purpose
 * (the dropped count only grows within a session, so an exact count in the
 * dedup signature would append one row per user message). The classifier
 * boundary is the right
 * place because it is the reader that authorizes state-changing calls, and it
 * reads the same function as the reviewer.
 */
export function reportTrustedIntentOrigins(sessionId: string | undefined, intents: readonly TrustedUserIntent[], overflowed: boolean): void {
  try {
    const origins: Record<string, number> = {}
    for (const intent of intents) origins[intent.origin] = (origins[intent.origin] ?? 0) + 1
    const signature = `${intents.length}:${Object.entries(origins).sort().map(([k, v]) => `${k}=${v}`).join(',')}:${overflowed ? 'overflow' : 'in-window'}`
    const key = String(sessionId ?? '')
    if (trustedIntentReported.get(key) === signature) return
    trustedIntentReported.set(key, signature)
    appendAuditLine(JSON.stringify({
      type: 'trusted-intents',
      at: Date.now(),
      sessionId: sessionId ?? null,
      count: intents.length,
      origins,
      overflowed,
    }))
  } catch {
    // Observational only: it never touches the decision path.
  }
}
