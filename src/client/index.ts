/**
 * dsh-recover-context client half: registers the rollback / edit affordances
 * into the conversation UI, placed at the USER QUESTION (not the answer):
 *
 *   - `recover-actions` conversation node kind: one small action row under
 *     every user question — `↶ 回退到此` (discard this question and
 *     everything after it, restoring context AND workspace files) and
 *     `✎ 编辑此问题` (same cut, then load the question into the composer
 *     for edit & resubmit; only on the most recent question).
 *   - `conversation.input.left` (list slot): while the agent is still
 *     answering the last question, an "edit this question" button.
 *
 * Both orchestrate through the stock session.fork / workspace.archiveSession
 * RPCs plus the host's /recover-context restore API (see actions.ts).
 */
import type { ClientContext } from './actions.ts'
import { ComposerEdit } from './ComposerEdit.tsx'
import { attachLocale } from './locales.ts'
import { QuestionActions } from './QuestionActions.tsx'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'conversationEvents']

/** Structural mirror of the client context this plugin touches. */
export interface ClientContextLike {
  effect(fn: () => void | (() => void), label?: string): void
  locale: {
    getSnapshot(): { active: string }
    subscribe(fn: () => void): () => void
  }
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  conversationEvents: {
    register(definition: unknown): () => void
  }
}

/** Structural mirror of one session event (subset read by the definition). */
interface EventLike {
  type: string
  seq: number
  time: number
  data: { source?: { kind?: string }; id?: unknown; content?: readonly unknown[]; turn?: number }
}

/** Structural mirror of a Conversation Context (subset read by the definition). */
interface ContextLike {
  key: string
  kind: string
  id: string
  state?: { seq: number; time: number; content: readonly { type?: string; text?: string }[] }
  start?: { location?: unknown }
  matches?: readonly { location?: unknown }[]
}

/**
 * One conversation-node Definition producing a small action row under each
 * real user question. Rendered by the plugin's keyed chat renderer; the
 * default user-message bubble is untouched.
 */
const recoverActionsDefinition = {
  kind: 'recover-actions',
  target: 'chat',
  match: (event: EventLike) => {
    if (event.type !== 'user/message') return null
    if (event.data.source?.kind !== 'user') return null // skip injected context rows
    return { id: String(event.data.id ?? event.seq), role: 'start' }
  },
  start: (_context: ContextLike, match: { event: EventLike }) => ({
    seq: match.event.seq,
    time: match.event.time,
    content: (match.event.data.content ?? []) as { type?: string; text?: string }[],
  }),
  update: (context: ContextLike) => context.state,
  buildViewNode: (context: ContextLike) => {
    if (context.state === undefined) return null
    const location = context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: 'recover-actions',
      id: context.id,
      target: 'chat',
      // Fractional offset (same pattern as the framework's synthetic seqs) so
      // the action row sorts immediately AFTER the question bubble.
      anchorSeq: context.state.seq + 0.1,
      location,
      visibility: 'visible',
      data: context.state,
    }
  },
}

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions, workspaces).
 */
export function apply(ctx: ClientContextLike & ClientContext): void {
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-recover-context] ${phase} error:`, error)
  }

  try {
    ctx.effect(() => attachLocale(ctx.locale), 'dsh-recover-context: locale')
  } catch (error) {
    fail('locale', error)
  }

  // Shared hover chrome for the icon buttons (injected once per page).
  try {
    ctx.effect(() => {
      const style = document.createElement('style')
      style.textContent = [
        '.rc-icon-btn{transition:background .15s ease,opacity .15s ease,color .15s ease}',
        '.rc-icon-btn:hover{background:color-mix(in srgb, currentColor 14%, transparent);opacity:1}',
        '.rc-icon-btn:active{transform:scale(.92)}',
        '.rc-icon-btn:disabled{opacity:.3;cursor:default}',
      ].join('')
      document.head.appendChild(style)
      return () => { style.remove() }
    }, 'dsh-recover-context: icon styles')
  } catch (error) {
    fail('icon styles', error)
  }

  // Question action rows: the conversation node definition + its renderer.
  try {
    ctx.effect(() => ctx.conversationEvents.register(recoverActionsDefinition), 'dsh-recover-context: recover-actions node')
  } catch (error) {
    fail('recover-actions definition', error)
  }
  try {
    ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'recover-actions',
      registrant: 'dsh-recover-context',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { node: unknown; sessionId: string; useSession: unknown }) =>
      QuestionActions({ ...props, ctx } as never))))
  } catch (error) {
    fail('recover-actions renderer', error)
  }

  // Composer affordance for the premature-submit case (running turn).
  try {
    ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: 'dsh-recover-context',
      order: 100,
      registrant: 'dsh-recover-context',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: { session: unknown; sessionId: string }) =>
      ComposerEdit({ ...props, ctx } as never))))
  } catch (error) {
    fail('composer registration', error)
  }

}
