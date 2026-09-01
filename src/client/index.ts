/**
 * dsh-recover-context 客户端入口：在会话界面中注册回滚/编辑交互入口，
 * 入口放置在【用户问题】下方（而非助手回复）：
 *
 *   - `recover-actions` 对话节点：在每个用户问题下方渲染操作行 —
 *     `↶ 回退到此`（丢弃该问题及其之后的所有内容，恢复上下文和工作区文件）
 *     `✎ 编辑此问题`（截断相同范围，将问题载入输入框；仅在最近一个问题提供）。
 *   - `conversation.input.left`（输入框工具栏插槽）：在模型还在回答最后一条提问时提供“编辑此问题”快捷入口。
 */
import type { ClientContext } from './actions.ts'
import { ComposerEdit } from './ComposerEdit.tsx'
import { attachLocale } from './locales.ts'
import { QuestionActions } from './QuestionActions.tsx'

/** 依赖注入的服务 */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'conversationEvents']

/** 客户端上下文镜像接口 */
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

/** 单个会话事件镜像 */
interface EventLike {
  type: string
  seq: number
  time: number
  data: { source?: { kind?: string }; id?: unknown; content?: readonly unknown[]; turn?: number }
}

/** 会话上下文镜像 */
interface ContextLike {
  key: string
  kind: string
  id: string
  state?: { seq: number; time: number; content: readonly { type?: string; text?: string }[] }
  start?: { location?: unknown }
  matches?: readonly { location?: unknown }[]
}

/**
 * 用户问题下方的操作行节点定义
 */
const recoverActionsDefinition = {
  kind: 'recover-actions',
  target: 'chat',
  match: (event: EventLike) => {
    if (event.type !== 'user/message') return null
    if (event.data.source?.kind !== 'user') return null // 跳过系统注入的消息
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
      // 微小偏移以排在用户问题气泡之后
      anchorSeq: context.state.seq + 0.1,
      location,
      visibility: 'visible',
      data: context.state,
    }
  },
}

/**
 * 客户端插件主入口
 */
export function apply(ctx: ClientContextLike & ClientContext): void {
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-recover-context] ${phase} 错误:`, error)
  }

  try {
    ctx.effect(() => attachLocale(ctx.locale), 'dsh-recover-context: locale')
  } catch (error) {
    fail('locale', error)
  }

  // 按钮悬浮样式
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

  // 注册问题操作行定义与渲染组件
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

  // 注册输入框左侧快捷编辑按钮
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
