/**
 * Structural reads over the conversation snapshot. The snapshot shape is
 * declared by @deepseek-ai/dsh-client-runtime; this file only reads the
 * slices the plugin needs and stays structurally typed so the client bundle
 * needs no runtime dependency on the runtime package.
 */

/** The conversation snapshot slice this plugin reads. */
export interface SnapshotLike {
  removed: boolean
  running: boolean
  chat: {
    order: readonly string[]
    nodes: {
      get(key: string): NodeLike | undefined
      values(): readonly NodeLike[]
    }
    locations: {
      getTurn(turn: number): readonly string[]
    }
    timeline: {
      turnOrder: readonly number[]
    }
  }
  turnEnds: ReadonlyMap<number, number>
}

/** One chat view node (structural subset). */
export interface NodeLike {
  key: string
  kind: string
  anchorSeq: number
  data: Record<string, unknown> | null | undefined
}

/** One text content block. */
interface TextBlockLike {
  type?: string
  text?: string
}

/** Join the text blocks of a message's content. */
export function textOfContent(content: readonly TextBlockLike[] | undefined): string {
  if (content === undefined) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

/**
 * Find the finalized assistant node carrying one messageId.
 *
 * The chat-node dispatch kind for assistant rows is `assistant-step` (the
 * definition kind), NOT `assistant` — so the lookup must not depend on the
 * kind at all and keys purely on the node payload's `finalNode.messageId`
 * (which only assistant nodes carry).
 */
export function assistantByMessageId(snap: SnapshotLike, messageId: string): NodeLike | undefined {
  return snap.chat.nodes.values().find((node) => {
    const finalNode = node.data?.finalNode as { messageId?: string } | undefined
    return finalNode?.messageId === messageId
  })
}

/** The turn that owns a node key, or undefined. */
export function turnOfNode(snap: SnapshotLike, key: string): number | undefined {
  return snap.chat.timeline.turnOrder.find(turn => snap.chat.locations.getTurn(turn).includes(key))
}

/** The last user message node of a turn (the question that opened it). */
export function userNodeOfTurn(snap: SnapshotLike, turn: number): NodeLike | undefined {
  const keys = snap.chat.locations.getTurn(turn)
  for (const key of keys) {
    const node = snap.chat.nodes.get(key)
    if (node?.kind === 'user') return node
  }
  return undefined
}

/** Analysis for one assistant message's action row. */
export interface TurnActionInfo {
  turn: number
  nodeSeq: number
  userText: string
  /** Whether any later turn (running or completed) exists. */
  hasLater: boolean
  /** Whether this is the last turn AND it is completed. */
  isLastCompleted: boolean
  /** Boundary anchor for the edit: previous completed turn's end seq, or null. */
  editBoundarySeq: number | null
}

/** Analyze the snapshot for the assistant message addressed by `messageId`. */
export function analyzeTurnAction(snap: SnapshotLike, messageId: string): TurnActionInfo | null {
  const node = assistantByMessageId(snap, messageId)
  if (node === undefined) return null
  const turn = turnOfNode(snap, node.key)
  if (turn === undefined) return null
  const userText = textOfContent(userNodeOfTurn(snap, turn)?.data?.content as readonly TextBlockLike[] | undefined)
  const turnOrder = snap.chat.timeline.turnOrder
  const hasLater = turnOrder.some(candidate => candidate > turn)
  const completed = [...snap.turnEnds.keys()]
  const maxCompleted = completed.length === 0 ? undefined : Math.max(...completed)
  const isLastCompleted = !hasLater && turn === maxCompleted
  const previousCompleted = completed
    .filter(candidate => candidate < turn)
    .sort((a, b) => a - b)
    .at(-1)
  const editBoundarySeq = previousCompleted === undefined ? null : snap.turnEnds.get(previousCompleted) ?? null
  return { turn, nodeSeq: node.anchorSeq, userText, hasLater, isLastCompleted, editBoundarySeq }
}

/** Analysis for one user question's action row (rollback / edit icons under the question). */
export interface QuestionActionInfo {
  /** The turn the question opened. */
  turn: number
  /** The user message's seq (not used for the fork anchor directly). */
  nodeSeq: number
  /** The question's plain text (for the edit draft). */
  userText: string
  /** Whether this is the most recent user question (nothing asked after it). */
  isLastQuestion: boolean
  /**
   * Fork anchor that cuts BEFORE this question: the previous completed
   * turn's `turn/end` seq, or null when this is the first question (then a
   * blank child + baseline restore is used instead).
   */
  boundarySeq: number | null
}

/**
 * Analyze the snapshot for the question node addressed by its chat node key
 * (rendered by the plugin's own `recover-actions` conversation node).
 */
export function analyzeQuestion(snap: SnapshotLike, nodeKey: string): QuestionActionInfo | null {
  const node = snap.chat.nodes.get(nodeKey)
  if (node === undefined) return null
  const turn = turnOfNode(snap, nodeKey)
  if (turn === undefined) return null
  const userText = textOfContent(node.data?.content as readonly TextBlockLike[] | undefined)
  // Latest user message seq across the window — "is this the last question?".
  const userSeqs = snap.chat.nodes.values()
    .filter(candidate => candidate.kind === 'user')
    .map(candidate => candidate.anchorSeq)
  const maxUserSeq = userSeqs.length === 0 ? undefined : Math.max(...userSeqs)
  const isLastQuestion = maxUserSeq !== undefined && node.anchorSeq >= maxUserSeq
  const completed = [...snap.turnEnds.keys()]
  const previousCompleted = completed
    .filter(candidate => candidate < turn)
    .sort((a, b) => a - b)
    .at(-1)
  const boundarySeq = previousCompleted === undefined ? null : snap.turnEnds.get(previousCompleted) ?? null
  return { turn, nodeSeq: node.anchorSeq, userText, isLastQuestion, boundarySeq }
}

/** Analysis for the composer edit affordance (running turn, last content is the question). */
export interface ComposerEditInfo {
  userText: string
  /** Boundary anchor: last completed turn's end seq before the running turn, or null. */
  boundarySeq: number | null
}

/**
 * Whether the composer should offer "edit last question": the session is
 * running and the newest chat node is still the user's question (the answer
 * has not started finalizing).
 */
export function analyzeComposerEdit(snap: SnapshotLike): ComposerEditInfo | null {
  if (snap.removed || !snap.running) return null
  const order = snap.chat.order
  const lastKey = order.at(-1)
  if (lastKey === undefined) return null
  const lastNode = snap.chat.nodes.get(lastKey)
  if (lastNode === undefined || lastNode.kind !== 'user') return null
  const turn = turnOfNode(snap, lastKey)
  if (turn === undefined) return null
  const userText = textOfContent(lastNode.data?.content as readonly TextBlockLike[] | undefined)
  const completed = [...snap.turnEnds.keys()]
  const previousCompleted = completed
    .filter(candidate => candidate < turn)
    .sort((a, b) => a - b)
    .at(-1)
  const boundarySeq = previousCompleted === undefined ? null : snap.turnEnds.get(previousCompleted) ?? null
  return { userText, boundarySeq }
}
