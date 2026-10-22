/**
 * 破坏性操作的确认。
 *
 * 默认拒绝：问不出去（没接界面、界面关了、用户不答）就不执行。
 * 反过来写（问不出去就放行）会让"忘了接线"变成"静默执行删除"，
 * 而这类错误在语音场景下用户根本来不及发现。
 */

import { randomUUID } from 'node:crypto'

export interface ConfirmationRequest {
  /** 工具名。用户点"一直允许"时按它记住。 */
  action: string
  /** 要做的事，显示在对话框标题上。 */
  target: string
  /** 补充说明，比如命令是想干嘛。 */
  detail?: string
}

/** 等用户回答的上限。超时按拒绝处理——挂着的对话框比拒绝更糟。 */
const DEFAULT_TIMEOUT_MS = 60_000

export interface ConfirmationServiceOptions {
  /** 把问题递到界面上。返回 false 表示递不出去（没有窗口、会话已停）。 */
  ask: (request: ConfirmationRequest & { id: string }) => boolean
  timeoutMs?: number
}

interface Pending {
  action: string
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

export class ConfirmationService {
  private readonly options: ConfirmationServiceOptions
  private readonly pending = new Map<string, Pending>()
  /** 本次会话内点过"一直允许"的工具名。会话结束就清空。 */
  private readonly remembered = new Set<string>()

  constructor(options: ConfirmationServiceOptions) {
    this.options = options
  }

  /** 问一次。已经"一直允许"过的直接放行，不再打扰用户。 */
  async confirm(request: ConfirmationRequest): Promise<boolean> {
    if (this.remembered.has(request.action)) return true

    const id = randomUUID()
    if (!this.options.ask({ ...request, id })) return false

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(false)
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { action: request.action, resolve, timer })
    })
  }

  /** 界面的回答。id 不认识就当没听见（可能已经超时了）。 */
  answer(id: string, approved: boolean, remember = false): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (approved && remember) this.remembered.add(entry.action)
    entry.resolve(approved)
  }

  /** 会话结束：待答的一律按拒绝处理，并忘掉"一直允许"。 */
  reset(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve(false)
    }
    this.pending.clear()
    this.remembered.clear()
  }

  /** 有没有问题正等着回答。 */
  get waiting(): boolean {
    return this.pending.size > 0
  }
}
