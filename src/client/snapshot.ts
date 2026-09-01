/**
 * 客户端结构化读取会话快照。
 * 会话快照结构由 @deepseek-ai/dsh-client-runtime 定义；本文件仅作结构化读取。
 */

/** 插件读取的会话快照结构 */
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

/** 单个聊天视图节点（结构子集） */
export interface NodeLike {
  key: string
  kind: string
  anchorSeq: number
  data: Record<string, unknown> | null | undefined
}

/** 文本内容块 */
interface TextBlockLike {
  type?: string
  text?: string
}

/** 拼接消息的所有文本块 */
export function textOfContent(content: readonly TextBlockLike[] | undefined): string {
  if (content === undefined) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

/**
 * 根据 messageId 查找已完成的 Assistant 节点。
 */
export function assistantByMessageId(snap: SnapshotLike, messageId: string): NodeLike | undefined {
  return snap.chat.nodes.values().find((node) => {
    const finalNode = node.data?.finalNode as { messageId?: string } | undefined
    return finalNode?.messageId === messageId
  })
}

/** 获取某个节点所属的轮次编号 */
export function turnOfNode(snap: SnapshotLike, key: string): number | undefined {
  return snap.chat.timeline.turnOrder.find(turn => snap.chat.locations.getTurn(turn).includes(key))
}

/** 获取某轮的用户提问节点（开启该轮的用户消息） */
export function userNodeOfTurn(snap: SnapshotLike, turn: number): NodeLike | undefined {
  const keys = snap.chat.locations.getTurn(turn)
  for (const key of keys) {
    const node = snap.chat.nodes.get(key)
    if (node?.kind === 'user') return node
  }
  return undefined
}

/** 单条 Assistant 消息的操作栏分析信息 */
export interface TurnActionInfo {
  turn: number
  nodeSeq: number
  userText: string
  /** 是否存在后续轮次（运行中或已完成） */
  hasLater: boolean
  /** 是否是最后一轮且已完成 */
  isLastCompleted: boolean
  /** 编辑截断锚点：上一已完成轮次的 turn/end seq，无则为 null */
  editBoundarySeq: number | null
}

/** 根据 messageId 分析 Assistant 消息 */
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

/** 单个用户问题操作行的分析信息（问题下方的回滚/编辑图标） */
export interface QuestionActionInfo {
  /** 该问题开启的轮次编号 */
  turn: number
  /** 用户消息的 seq */
  nodeSeq: number
  /** 用户问题纯文本（载入输入框使用） */
  userText: string
  /** 是否为最近一次提问 */
  isLastQuestion: boolean
  /**
   * 截断在该问题之前的锚点序列号：上一完成轮次的 turn/end seq，
   * 若为第一个问题则为 null（代表创建空白子会话并还原初始基线）。
   */
  boundarySeq: number | null
}

/**
 * 根据聊天节点 key 分析用户问题节点
 */
export function analyzeQuestion(snap: SnapshotLike, nodeKey: string): QuestionActionInfo | null {
  const node = snap.chat.nodes.get(nodeKey)
  if (node === undefined) return null
  const turn = turnOfNode(snap, nodeKey)
  if (turn === undefined) return null
  const userText = textOfContent(node.data?.content as readonly TextBlockLike[] | undefined)
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

/** 输入框编辑操作的分析信息（轮次运行中，最新内容仍是问题） */
export interface ComposerEditInfo {
  userText: string
  /** 截断锚点：运行中轮次之前的最后一个已完成轮次的 end seq，无则为 null */
  boundarySeq: number | null
}

/**
 * 判断输入框是否应提供“编辑上一问题”按钮：
 * 当会话正在运行中且最新的聊天节点仍是用户的提问时呈现。
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
