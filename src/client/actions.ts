/**
 * Client-side orchestration for rollback and edit. Both operations are built
 * on the stock DSH machinery — `session.fork` (the completed-turn prefix
 * fork the built-in fork button already uses) and `workspace.archiveSession`
 * — plus this plugin's host restore API for the "directory records" part:
 *
 *   rollback / rollbackBefore
 *     cancel any running turn → fork a child cut before the target →
 *     restore the workspace to that checkpoint → archive the old session →
 *     open the child. The user then continues in a clean context.
 *
 *   beginEdit (NEW flow)
 *     does NOT cut anything: it loads the question text into the composer
 *     and arms a prompt interceptor. The cut (fork + restore + archive) runs
 *     ONLY when the user actually submits — a refresh before submit leaves
 *     the conversation untouched.
 */
import { callApi, type RestoreResult } from './api.ts'

/** One prompt submission (structural mirror of ISession.prompt's argument/result). */
type PromptContent = readonly { type: string; text?: string }[]
type PromptResult = { ok: boolean; error?: { code: string; message: string } }

/** Structural mirror of a session binding's session face with a patchable prompt. */
interface PatchableSession {
  cancel(): Promise<unknown>
  prompt(content: PromptContent, mode: string): Promise<PromptResult>
}

/** Structural mirror of the client context (subset used here). */
export interface ClientContext {
  get<T>(key: string): T | undefined
  sessions: {
    binding(id: string): { session: PatchableSession } | undefined
    fork(opts: { sessionId: string; atSeq?: number }): Promise<string>
    create(opts: { workspaceId?: string; cwd?: string }): Promise<string>
    open(id: string): void
    scope(id: string): unknown | undefined
    list: {
      getSnapshot(): { byId: Record<string, { cwd?: string }> }
    }
  }
  workspaces: {
    archiveSession(sessionId: string): Promise<void>
    list: {
      getSnapshot(): { items: readonly { id: string; path: string }[] }
    }
  }
}

/** Result of a completed rollback/edit operation. */
export interface RecoverOperationResult {
  childId: string
  restore: RestoreResult
}

/**
 * In-memory armed-edit state per session. Deliberately NOT persisted: a page
 * refresh clears it, so an unsubmitted edit never touches the conversation.
 */
const armedEdits = new Map<string, { boundarySeq: number | null }>()

/**
 * Whether a prompt submission is being redirected by an armed edit
 * (exported for tests).
 */
export function isEditArmed(sessionId: string): boolean {
  return armedEdits.has(sessionId)
}

/** Best-effort cancel of a running turn (never throws). */
async function cancelIfRunning(ctx: ClientContext, sessionId: string): Promise<void> {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) return
  try {
    await binding.session.cancel()
  } catch {
    // best effort — the fork is still safe without it
  }
}

/** Archive the old session (best effort). */
async function archive(ctx: ClientContext, sessionId: string): Promise<void> {
  try {
    await ctx.workspaces.archiveSession(sessionId)
  } catch {
    // archiving is cosmetic — the new session is already what the user sees
  }
}

/** Set the composer draft on a session, retrying until its scope materializes. */
async function setDraftOn(ctx: ClientContext, sessionId: string, text: string): Promise<void> {
  const conversation = ctx.get<{
    input: { for(actx: unknown): { setDraft(text: string): void } }
  }>('conversation')
  if (conversation === undefined) return
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const scope = ctx.sessions.scope(sessionId)
    if (scope !== undefined) {
      try {
        conversation.input.for(scope).setDraft(text)
        return
      } catch {
        // input machine not ready yet — retry
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Shared "cut before a question" operation: fork the session at the previous
 * completed turn (or create a blank child for the very first question),
 * restore the workspace to that point, archive the old session and open the
 * child. Used by both rollback-before-question and edit-question.
 * @param draftText - when set, load it into the child's composer after open.
 */
async function cutBefore(
  ctx: ClientContext,
  sessionId: string,
  boundarySeqOrNull: number | null,
  draftText?: string,
): Promise<RecoverOperationResult> {
  await cancelIfRunning(ctx, sessionId)
  let childId: string
  let restore: RestoreResult
  if (boundarySeqOrNull === null) {
    // The very first question: a completed-turn fork is impossible, so create
    // a fresh blank session on the same workspace and restore the workspace
    // to its pre-work baseline.
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.path === cwd)
    childId = await ctx.sessions.create(workspace !== undefined
      ? { workspaceId: workspace.id }
      : cwd !== undefined ? { cwd } : {})
    restore = await callApi<RestoreResult>('restore', { sessionId, baseline: true, dryRun: false })
  } else {
    childId = await ctx.sessions.fork({ sessionId, atSeq: boundarySeqOrNull })
    restore = await callApi<RestoreResult>('restore', { sessionId, atSeq: boundarySeqOrNull, dryRun: false })
  }
  await archive(ctx, sessionId)
  ctx.sessions.open(childId)
  if (draftText !== undefined && draftText !== '') {
    await setDraftOn(ctx, childId, draftText)
  }
  return { childId, restore }
}

/** Roll back through the turn containing `atSeq`, restore files, archive the old session, open the child. */
export async function rollback(
  ctx: ClientContext,
  sessionId: string,
  atSeq: number,
): Promise<RecoverOperationResult> {
  await cancelIfRunning(ctx, sessionId)
  const childId = await ctx.sessions.fork({ sessionId, atSeq })
  const restore = await callApi<RestoreResult>('restore', { sessionId, atSeq, dryRun: false })
  await archive(ctx, sessionId)
  ctx.sessions.open(childId)
  return { childId, restore }
}

/**
 * Roll back BEFORE one question: discard the question and everything after it
 * (context and workspace files), archive the old session, open the child.
 */
export async function rollbackBefore(
  ctx: ClientContext,
  sessionId: string,
  boundarySeqOrNull: number | null,
): Promise<RecoverOperationResult> {
  return cutBefore(ctx, sessionId, boundarySeqOrNull)
}

/** Preview the restore counts for a rollback point (dry run). */
export function previewRestore(sessionId: string, atSeq: number): Promise<RestoreResult> {
  return callApi<RestoreResult>('restore', { sessionId, atSeq, dryRun: true })
}

/**
 * Begin editing the last question WITHOUT touching the conversation: loads
 * the question text into the composer and arms a prompt interceptor that
 * will, on the NEXT submit, cut the conversation before the question (fork /
 * restore / archive), open the child and deliver the submitted content to
 * it. A page refresh before submit clears the arming and leaves the
 * conversation completely untouched.
 */
export async function beginEdit(
  ctx: ClientContext,
  sessionId: string,
  userText: string,
  boundarySeqOrNull: number | null,
): Promise<void> {
  armEditInterceptor(ctx, sessionId, boundarySeqOrNull)
  if (userText !== '') {
    await setDraftOn(ctx, sessionId, userText)
  }
}

/** Wrap one session's prompt once; armed edits redirect the next submit. */
function armEditInterceptor(
  ctx: ClientContext,
  sessionId: string,
  boundarySeqOrNull: number | null,
): void {
  armedEdits.set(sessionId, { boundarySeq: boundarySeqOrNull })
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) return
  const session = binding.session as PatchableSession & { __recoverEditWrapped?: boolean }
  if (session.__recoverEditWrapped === true) return
  session.__recoverEditWrapped = true
  const originalPrompt = session.prompt.bind(session)
  session.prompt = async (content: PromptContent, mode: string): Promise<PromptResult> => {
    const armed = armedEdits.get(sessionId)
    if (armed === undefined) return originalPrompt(content, mode)
    armedEdits.delete(sessionId)
    try {
      const { childId } = await cutBefore(ctx, sessionId, armed.boundarySeq)
      const child = await resolveChildBinding(ctx, childId)
      if (child === undefined) {
        return { ok: false, error: { code: 'internal', message: 'edit: child session unavailable' } }
      }
      return child.session.prompt(content, mode)
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
    }
  }
}

/** Resolve the child's binding with a short retry (it materializes on fork/open). */
async function resolveChildBinding(
  ctx: ClientContext,
  childId: string,
): Promise<{ session: PatchableSession } | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const binding = ctx.sessions.binding(childId)
    if (binding !== undefined) return binding
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return undefined
}
