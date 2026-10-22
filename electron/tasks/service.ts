/**
 * 任务服务：把「让 pi 干件事」变成一条有编号、有状态、能取消、能回看的记录。
 *
 * 一条纪律贯穿全文：**任务开始时立刻返回，绝不在这里等结果**。
 * 豆包等工具结果有超时（实测十几秒就没反应了），而 pi 动辄跑几十秒；
 * 等下去的结果就是模型那边静默失效。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { TaskEventItem, TaskSummary } from '@shared/contract'
import { atomicWriteJson, readJson } from '../store'
import type { PiRuntime } from '../runtime'
import { PiClient } from './pi-client'
import { isSettled, translatePiEvent, type PiEvent } from './pi-events'

/** 每条任务最多留多少条事件。界面只用于展示，不需要全量。 */
const MAX_EVENTS_PER_TASK = 600
/** 任务索引保留多少条。 */
const MAX_TASKS = 200
/** 探活间隔：子进程崩了不会主动通知，靠周期性的 get_state 发现。 */
const HEARTBEAT_MS = 10_000
/** 重启退避：立刻 → 2s → 10s → 60s，之后不再自动重启。 */
const DEFAULT_RESTART_DELAYS = [0, 2000, 10_000, 60_000]
/** 跑到头的状态。到了这里就不再接受任何改写——包括用户点取消。 */
const TERMINAL_STATES: ReadonlySet<TaskSummary['state']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

export interface TaskServiceEvents {
  onTaskStarted: (summary: TaskSummary) => void
  onTaskEvent: (taskId: string, event: TaskEventItem) => void
  onTaskFinished: (summary: TaskSummary, result: string) => void
  onPiStatus: (state: 'stopped' | 'starting' | 'ready' | 'exited' | 'restarting', detail?: string) => void
}

interface TaskRecord {
  summary: TaskSummary
  events: TaskEventItem[]
  prompt: string
}

export interface TaskServiceOptions {
  runtime: PiRuntime
  dataDir: string
  model?: string
  thinking?: string
  workingDirectory: string
  /** 追加到 pi 的系统提示词：告诉它这轮是语音来的，结果会被念出来。 */
  appendSystemPrompt: string
  events: TaskServiceEvents
  /** 重启退避序列。测试里调小，免得等真时间。 */
  restartDelays?: number[]
  /** 探活间隔，默认 10 秒。 */
  heartbeatMs?: number
  /** 客户端工厂。测试里注入假的——任务编排（排队、完成判定、取消、重启）都在这一层。 */
  createClient?: (options: ConstructorParameters<typeof PiClient>[0]) => PiClient
}

export class TaskService {
  private readonly options: TaskServiceOptions
  private readonly indexFile: string
  private readonly records = new Map<string, TaskRecord>()
  private readonly order: string[] = []
  private client?: PiClient
  private counter = 0
  private heartbeat?: NodeJS.Timeout
  private restartAttempts = 0
  private activeTaskId?: string
  /** 等待执行的任务，FIFO。 */
  private readonly queue: string[] = []
  /** 收尾标记。重启是异步的，没有这个标记的话，退出之后它还会把进程再拉起来。 */
  private disposed = false

  constructor(options: TaskServiceOptions) {
    this.options = options
    this.indexFile = path.join(options.dataDir, 'tasks.json')
    this.load()
  }

  private load(): void {
    const stored = readJson<Array<{ summary: TaskSummary; events: TaskEventItem[]; prompt: string }>>(
      this.indexFile,
      []
    )
    let repaired = false
    for (const record of stored) {
      // 刚启动时不可能有任务在跑，所以磁盘上留着的 queued/running 一定是上次退出时
      // 被掐断的那条。不归位的话它会永远挂在「执行中」——面板上一条不动的僵尸，
      // 点进去也没有下文，用户以为它还在跑。
      //
      // 标成 interrupted 而不是 failed：本来就没出错，只是被打断了，
      // 混进「失败」里会让人以为是 pi 坏了，跑去查一个不存在的问题。
      if (record.summary.state === 'queued' || record.summary.state === 'running') {
        record.summary.state = 'interrupted'
        record.summary.updatedAt = Date.now()
        record.summary.error = '应用退出时中断，结果未知'
        record.events.push({
          at: Date.now(),
          kind: 'status',
          text: '应用退出时被中断，这条任务没有跑完'
        })
        repaired = true
      }
      this.records.set(record.summary.id, record)
      this.order.push(record.summary.id)
      this.counter = Math.max(this.counter, record.summary.number)
    }
    // 只在真的改了东西时写盘：不然每次启动都要动一次这个文件
    if (repaired) this.persist()
  }

  private persist(): void {
    const rows = this.order
      .map((id) => this.records.get(id))
      .filter((record): record is TaskRecord => record !== undefined)
      .slice(-MAX_TASKS)
    atomicWriteJson(this.indexFile, rows)
  }

  list(): TaskSummary[] {
    return this.order
      .map((id) => this.records.get(id)?.summary)
      .filter((summary): summary is TaskSummary => summary !== undefined)
      .reverse()
  }

  detail(taskId: string): { summary: TaskSummary; events: TaskEventItem[] } | null {
    const record = this.records.get(taskId)
    if (!record) return null
    return { summary: record.summary, events: [...record.events] }
  }

  /**
   * 起一个任务。**立刻返回**任务摘要，不等 pi 跑完。
   */
  submit(prompt: string, title?: string): TaskSummary {
    this.counter += 1
    const summary: TaskSummary = {
      id: randomUUID(),
      number: this.counter,
      title: title?.trim() || prompt.slice(0, 40),
      state: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const record: TaskRecord = { summary, events: [], prompt }
    this.records.set(summary.id, record)
    this.order.push(summary.id)
    this.persist()
    this.options.events.onTaskStarted(summary)

    void this.run(summary.id)
    return summary
  }

  private async run(taskId: string): Promise<void> {
    const record = this.records.get(taskId)
    if (!record) return

    // 同一时刻只跑一个：pi 的会话是一条线，并发提交会互相插队。
    // 排队必须用真的队列——用 promise 链自己调自己的话，前一个还占着位置时
    // 它会立刻重新入队，形成微任务死循环，进程永远不会空闲。
    if (this.activeTaskId) {
      this.appendEvent(taskId, 'status', '前面还有任务在跑，排队中')
      this.queue.push(taskId)
      return
    }
    this.activeTaskId = taskId

    try {
      await this.ensureClient()
      this.setState(taskId, 'running')
      await this.client!.prompt(record.prompt)
    } catch (error) {
      this.finish(taskId, false, error instanceof Error ? error.message : String(error))
    }
  }

  private async ensureClient(): Promise<void> {
    if (this.disposed || this.client?.running) return
    this.options.events.onPiStatus(this.restartAttempts > 0 ? 'restarting' : 'starting')

    const create = this.options.createClient ?? ((options) => new PiClient(options))
    const client = create({
      runtime: this.options.runtime,
      cwd: this.options.workingDirectory,
      model: this.options.model,
      thinking: this.options.thinking,
      appendSystemPrompt: this.options.appendSystemPrompt
    })
    client.on('event', (event: PiEvent) => this.onPiEvent(event))
    client.on('exit', () => this.onPiExit())
    client.on('error', (error: Error) => this.appendEvent(this.activeTaskId ?? '', 'error', error.message))
    await client.start()
    this.client = client
    // 刻意不在这里清零重试计数：进程可能刚起来就死，那样会变成"起来了→死了→再起来"
    // 的无限循环。只有成功跑完一个任务，才算这次真的好了。
    this.options.events.onPiStatus('ready', this.options.runtime.version)
    this.startHeartbeat()
  }

  private onPiEvent(event: PiEvent): void {
    const taskId = this.activeTaskId
    if (!taskId) return

    if (isSettled(event)) {
      void this.settle(taskId)
      return
    }
    const translated = translatePiEvent(event)
    if (translated) this.appendEvent(taskId, translated.kind, translated.text)
  }

  /** 任务真正结束：拿最后一次的助手文本作为结果。 */
  private async settle(taskId: string): Promise<void> {
    let result = ''
    try {
      result = (await this.client?.getLastAssistantText()) ?? ''
    } catch {
      result = ''
    }
    this.finish(taskId, true, result)
  }

  private onPiExit(): void {
    this.stopHeartbeat()
    const taskId = this.activeTaskId
    if (taskId) {
      // 退出时任务还在跑：结果未知，绝不重放——重放等于可能把副作用做两遍
      this.appendEvent(taskId, 'error', 'pi 进程异常退出，任务结果未知')
      this.finish(taskId, false, 'pi 进程异常退出')
      void this.scheduleRestart()
      return
    }
    this.options.events.onPiStatus('exited')
  }

  private async scheduleRestart(): Promise<void> {
    if (this.disposed) return
    const delays = this.options.restartDelays ?? DEFAULT_RESTART_DELAYS
    this.restartAttempts += 1

    // 退避到头就停手。一直重试会把日志刷满、还占着资源，
    // 而用户真正需要的是知道"pi 起不来"这件事，然后自己去修。
    if (this.restartAttempts > delays.length) {
      this.options.events.onPiStatus('exited', 'pi 反复启动失败，已停止自动重试')
      return
    }

    const delay = delays[this.restartAttempts - 1]!
    this.options.events.onPiStatus('restarting', `第 ${this.restartAttempts} 次重试`)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    // 等待期间可能已经被 shutdown 了，这里再确认一次
    if (this.disposed) return
    await this.ensureClient().catch(() => undefined)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.disposed) return
      const client = this.client
      if (!client) return

      // 两种情况都要当成"死了"：进程已经没了但没发 exit 事件（被信号杀掉时常见），
      // 以及进程还在但没响应（getState 超时）。
      // 早先这里写成了 `if (!client.running) return`——判断写反，
      // 结果是悄悄死掉的进程永远不会被发现，任务一直挂在"执行中"
      if (!client.running) {
        this.onPiExit()
        return
      }
      void client.getState().catch(() => this.onPiExit())
    }, this.options.heartbeatMs ?? HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  async cancel(taskId: string): Promise<void> {
    const record = this.records.get(taskId)
    if (!record) return
    if (taskId === this.activeTaskId) {
      await this.client?.abort().catch(() => undefined)
    }
    this.finish(taskId, false, '已取消')
  }

  private finish(taskId: string, ok: boolean, result: string): void {
    const record = this.records.get(taskId)
    if (!record || TERMINAL_STATES.has(record.summary.state)) return
    record.summary.state = ok ? 'completed' : result === '已取消' ? 'cancelled' : 'failed'
    record.summary.updatedAt = Date.now()
    record.summary.resultPreview = result.slice(0, 200)
    if (!ok) record.summary.error = result
    // 跑完一个任务说明 pi 是健康的，重试计数可以归零了
    if (ok) this.restartAttempts = 0
    if (ok) this.appendEvent(taskId, 'result', result)
    this.persist()
    this.options.events.onTaskFinished(record.summary, result)

    if (this.activeTaskId === taskId) {
      this.activeTaskId = undefined
      this.pump()
    }
  }

  /** 一个任务腾出位置后，把队首拉起来跑。 */
  private pump(): void {
    if (this.activeTaskId || this.queue.length === 0) return
    const next = this.queue.shift()
    if (next) void this.run(next)
  }

  private setState(taskId: string, state: TaskSummary['state']): void {
    const record = this.records.get(taskId)
    if (!record) return
    record.summary.state = state
    record.summary.updatedAt = Date.now()
    this.persist()
  }

  private appendEvent(taskId: string, kind: TaskEventItem['kind'], text: string): void {
    const record = this.records.get(taskId)
    if (!record) return
    const event: TaskEventItem = { at: Date.now(), kind, text }
    record.events.push(event)
    if (record.events.length > MAX_EVENTS_PER_TASK) record.events.splice(0, record.events.length - MAX_EVENTS_PER_TASK)
    this.options.events.onTaskEvent(taskId, event)
  }

  /** 退出时收尾：关 stdin 让 pi 有序退出，超时再强杀。 */
  async shutdown(): Promise<void> {
    this.disposed = true
    this.queue.length = 0
    this.stopHeartbeat()
    await this.client?.stop()
    this.persist()
  }

  /** 供设置面板显示 pi 版本与路径。 */
  runtimeInfo(): { version?: string; entryPath: string; workingDirectory: string } {
    return {
      version: this.options.runtime.version,
      entryPath: this.options.runtime.rpcEntryPath,
      workingDirectory: this.options.workingDirectory
    }
  }
}

/** 任务期间的数据目录不存在时先建好，避免第一次提交就失败。 */
export function ensureTaskDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}
