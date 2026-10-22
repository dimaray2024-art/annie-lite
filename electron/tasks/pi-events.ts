/**
 * 把 pi 的事件翻成界面能显示的一行。
 *
 * 纯函数，没有 IO——翻译规则是这块最容易出错、又最值得单测的地方：
 * 翻错了界面就会显示"已完成"而任务其实还在跑，或者反过来。
 */

import type { TaskEventItem } from '@shared/contract'

/** pi 事件的形状。只声明我们真正读的字段，其余原样忽略。 */
export interface PiEvent {
  type?: string
  willRetry?: boolean
  toolName?: string
  isError?: boolean
  reason?: string
  delta?: string
  assistantMessageEvent?: { type?: string; delta?: string }
  errorMessage?: string
  name?: string
}

export function translatePiEvent(event: PiEvent): Omit<TaskEventItem, 'at'> | null {
  switch (event.type) {
    case 'message_update': {
      const inner = event.assistantMessageEvent
      if (inner?.type === 'text_delta' && inner.delta) return { kind: 'text', text: inner.delta }
      return null
    }

    case 'tool_execution_start':
      return { kind: 'tool', text: `执行 ${event.toolName ?? '工具'}` }

    case 'tool_execution_end':
      return { kind: 'tool', text: `${event.isError ? '失败' : '完成'} ${event.toolName ?? '工具'}` }

    case 'compaction_start':
      return { kind: 'status', text: '上下文过长，正在整理' }

    case 'compaction_end':
      return { kind: 'status', text: '上下文整理完成' }

    case 'auto_retry_start':
      return { kind: 'status', text: `网络不稳，正在重试：${event.errorMessage ?? ''}`.trim() }

    case 'auto_retry_end':
      return { kind: 'status', text: '重试结束' }

    case 'extension_error':
      return { kind: 'error', text: `扩展出错：${event.errorMessage ?? '未知'}` }

    // agent_end 只是"这一次底层运行结束"，之后可能还有重试、压缩或排队的输入。
    // 判成完成会提前收工，所以这里明确忽略——完成只认 agent_settled。
    case 'agent_end':
      return null

    default:
      return null
  }
}

/** 完成信号只此一个：pi 不会再自动做任何事了。 */
export function isSettled(event: PiEvent): boolean {
  return event.type === 'agent_settled'
}
