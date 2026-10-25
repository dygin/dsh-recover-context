/**
 * 对 DSH 0.2.1 Chat 快照的结构化读取。
 *
 * ChatSnapshot 由 @deepseek-ai/dsh-client-ui-chat 维护；本文件只读取插件需要
 * 的切片，并以结构化类型声明，避免客户端 bundle 依赖运行时包：
 *
 *   order            可见节点 key 的展示顺序
 *   nodes.get(key)   按 key 读取节点
 *   locations        按轮次读取节点 key
 *   timeline         轮次顺序
 *   legacy.turnEnds  轮次 → turn/end 事件 seq
 */

/** 插件读取的 Chat 快照切片 */
export interface ChatSnapshotLike {
  order: readonly string[]
  nodes: {
    get(key: string): ChatNodeLike | undefined
    values(): readonly ChatNodeLike[]
  }
  locations: {
    getTurn(turn: number): readonly string[]
  }
  timeline: {
    turnOrder: readonly number[]
    turns?: ReadonlyMap<number, unknown>
  }
  legacy: {
    turnEnds: ReadonlyMap<number, number>
  }
}

/** 单个 Chat 视图节点（结构子集） */
export interface ChatNodeLike {
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

/** 获取某个节点所属的轮次编号 */
export function turnOfNode(chat: ChatSnapshotLike, key: string): number | undefined {
  return chat.timeline.turnOrder.find(turn => chat.locations.getTurn(turn).includes(key))
}

/** 某轮中的用户提问节点 */
export function userNodeOfTurn(chat: ChatSnapshotLike, turn: number): ChatNodeLike | undefined {
  for (const key of chat.locations.getTurn(turn)) {
    const node = chat.nodes.get(key)
    if (node?.kind === 'user') return node
  }
  return undefined
}

/**
 * 单个用户问题操作行的分析信息（问题下方的回滚/编辑图标）。
 */
export interface QuestionActionInfo {
  /** 该问题开启的轮次编号 */
  turn: number
  /** 用户消息在事件流中的 seq */
  nodeSeq: number
  /** 用户问题纯文本（载入输入框使用） */
  userText: string
  /** 是否为最近一次用户提问 */
  isLastQuestion: boolean
  /**
   * 截断在该问题之前的锚点序列号：上一完成轮次的 turn/end seq；
   * 若为第一个问题则为 null（代表创建空白子会话并还原初始基线）。
   */
  boundarySeq: number | null
}

/**
 * 根据 Chat 节点 key 分析用户问题节点。
 * @param chat Chat 快照
 * @param nodeKey 插件 `recover-actions` 节点的 key（与其来源用户消息 key 相同）
 */
export function analyzeQuestion(chat: ChatSnapshotLike, nodeKey: string): QuestionActionInfo | null {
  const node = chat.nodes.get(nodeKey)
  if (node === undefined || node.kind !== 'recover-actions') return null
  const turn = turnOfNode(chat, nodeKey)
  if (turn === undefined) return null
  const userNode = userNodeOfTurn(chat, turn)
  const userText = textOfContent(userNode?.data?.content as readonly TextBlockLike[] | undefined)

  const userKeys = chat.order.filter(key => chat.nodes.get(key)?.kind === 'user')
  const lastUserKey = userKeys.at(-1)
  const isLastQuestion = lastUserKey === userNode?.key

  const completed = [...chat.legacy.turnEnds.keys()]
  const previousCompleted = completed
    .filter(candidate => candidate < turn)
    .sort((a, b) => a - b)
    .at(-1)
  const boundarySeq = previousCompleted === undefined
    ? null
    : chat.legacy.turnEnds.get(previousCompleted) ?? null

  return {
    turn,
    nodeSeq: userNode?.anchorSeq ?? node.anchorSeq,
    userText,
    isLastQuestion,
    boundarySeq,
  }
}

/** 输入框编辑操作的分析信息（轮次运行中，最新内容仍是问题） */
export interface ComposerEditInfo {
  userText: string
  /** 截断锚点：运行中轮次之前的最后一个已完成轮次的 end seq，无则为 null */
  boundarySeq: number | null
}

/**
 * 判断输入框是否应提供“编辑上一问题”按钮：
 * 会话正在运行中，且最新可见节点仍是用户的提问。
 */
export function analyzeComposerEdit(chat: ChatSnapshotLike, running: boolean): ComposerEditInfo | null {
  if (!running) return null
  const lastKey = chat.order.at(-1)
  if (lastKey === undefined) return null
  const lastNode = chat.nodes.get(lastKey)
  if (lastNode === undefined || lastNode.kind !== 'user') return null
  const turn = turnOfNode(chat, lastKey)
  if (turn === undefined) return null
  const userText = textOfContent(lastNode.data?.content as readonly TextBlockLike[] | undefined)
  const completed = [...chat.legacy.turnEnds.keys()]
  const previousCompleted = completed
    .filter(candidate => candidate < turn)
    .sort((a, b) => a - b)
    .at(-1)
  const boundarySeq = previousCompleted === undefined
    ? null
    : chat.legacy.turnEnds.get(previousCompleted) ?? null
  return { userText, boundarySeq }
}
