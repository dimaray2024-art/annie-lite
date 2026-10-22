import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskService } from '../electron/tasks/service'
import { PiClient } from '../electron/tasks/pi-client'
import { isSettled, translatePiEvent } from '../electron/tasks/pi-events'

/** 假 pi：手工投喂事件，记录被调用过什么。 */
class FakePiClient extends EventEmitter {
  readonly prompts: string[] = []
  aborted = false
  running = true
  lastText = '任务结果'
  stopError?: Error

  async start(): Promise<void> {}
  async prompt(message: string): Promise<void> {
    this.prompts.push(message)
  }
  async abort(): Promise<void> {
    this.aborted = true
  }
  async getState(): Promise<unknown> {
    if (!this.running) throw new Error('进程已退出')
    return {}
  }
  async getLastAssistantText(): Promise<string | null> {
    return this.lastText
  }
  async stop(): Promise<void> {
    this.running = false
  }

  emitEvent(event: Record<string, unknown>): void {
    this.emit('event', event)
  }
  die(): void {
    this.running = false
    this.emit('exit', { code: 1, signal: null })
  }
}

const runtime = {
  nodePath: '/usr/local/bin/node',
  piEntryPath: '/pi/dist/bundle/cli.js',
  rpcEntryPath: '/pi/dist/bundle/rpc-entry.js',
  pathEnv: '/usr/local/bin:/usr/bin'
}

let dir: string
let fake: FakePiClient
let service: TaskService
let finished: Array<{ number: number; state: string; result: string }>

function setup(): void {
  fake = new FakePiClient()
  finished = []
  service = new TaskService({
    runtime,
    dataDir: dir,
    workingDirectory: dir,
    appendSystemPrompt: '测试',
    restartDelays: [0, 0, 0],
    heartbeatMs: 20,
    createClient: () => fake as unknown as PiClient,
    events: {
      onTaskStarted: () => undefined,
      onTaskEvent: () => undefined,
      onTaskFinished: (summary, result) => finished.push({ number: summary.number, state: summary.state, result }),
      onPiStatus: () => undefined
    }
  })
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 在同一个数据目录上重开一个服务，模拟「关掉应用再打开」。 */
function reopen(): TaskService {
  return new TaskService({
    runtime,
    dataDir: dir,
    workingDirectory: dir,
    appendSystemPrompt: '测试',
    createClient: () => fake as unknown as PiClient,
    events: {
      onTaskStarted: () => undefined,
      onTaskEvent: () => undefined,
      onTaskFinished: () => undefined,
      onPiStatus: () => undefined
    }
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-tasks-'))
  setup()
})

afterEach(async () => {
  await service.shutdown().catch(() => undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('事件翻译', () => {
  it('文本增量翻成 text', () => {
    expect(
      translatePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } })
    ).toEqual({ kind: 'text', text: '你好' })
  })

  it('工具起止翻成 tool，并区分是否出错', () => {
    expect(translatePiEvent({ type: 'tool_execution_start', toolName: 'bash' })).toEqual({
      kind: 'tool',
      text: '执行 bash'
    })
    expect(translatePiEvent({ type: 'tool_execution_end', toolName: 'bash', isError: true })).toEqual({
      kind: 'tool',
      text: '失败 bash'
    })
  })

  // 这条是这块最容易搞错的地方：agent_end 之后 pi 还可能自动重试或压缩，
  // 判成完成会让界面提前显示"已完成"，而任务其实还在跑
  it('agent_end 不算完成', () => {
    expect(translatePiEvent({ type: 'agent_end', willRetry: false })).toBeNull()
    expect(isSettled({ type: 'agent_end' })).toBe(false)
  })

  it('只有 agent_settled 算完成', () => {
    expect(isSettled({ type: 'agent_settled' })).toBe(true)
  })

  it('未知事件不产生噪声', () => {
    expect(translatePiEvent({ type: 'queue_update' })).toBeNull()
  })
})

describe('任务编排', () => {
  it('提交立刻返回，不等 pi 跑完', async () => {
    const summary = service.submit('分析一下这个项目')
    // 关键：submit 是同步返回的。等下去的话，豆包那边的工具结果早就超时了
    expect(summary.state).toBe('queued')
    expect(summary.number).toBe(1)
    await tick()
    expect(fake.prompts).toHaveLength(1)
  })

  it('任务编号递增，列表按新到旧', async () => {
    service.submit('第一件')
    service.submit('第二件')
    await tick()
    expect(service.list().map((task) => task.number)).toEqual([2, 1])
  })

  it('settled 之后才算完成，并取最后一次助手文本作为结果', async () => {
    const summary = service.submit('做点事')
    await tick()
    fake.lastText = '做完了，改动三处'

    fake.emitEvent({ type: 'agent_end', willRetry: false })
    await tick()
    expect(finished).toHaveLength(0) // 还没有完成

    fake.emitEvent({ type: 'agent_settled' })
    await tick()
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ number: 1, state: 'completed', result: '做完了，改动三处' })
    expect(service.detail(summary.id)?.summary.state).toBe('completed')
  })

  it('取消会把任务标成已取消并调 abort', async () => {
    const summary = service.submit('长活')
    await tick()
    await service.cancel(summary.id)
    expect(fake.aborted).toBe(true)
    expect(service.detail(summary.id)?.summary.state).toBe('cancelled')
  })

  it('pi 中途崩掉：任务标失败，且绝不自动重放', async () => {
    const summary = service.submit('危险的写操作')
    await tick()
    fake.die()
    await tick()

    const detail = service.detail(summary.id)
    expect(detail?.summary.state).toBe('failed')
    expect(detail?.summary.error).toContain('异常退出')
    // 结果未知时重放等于可能把副作用做两遍——这是不能碰的红线
    expect(fake.prompts).toHaveLength(1)
  })

  it('同一时刻只跑一个，后来的排队', async () => {
    service.submit('第一件')
    await tick()
    const second = service.submit('第二件')
    await tick()
    expect(fake.prompts).toHaveLength(1)
    expect(service.detail(second.id)?.events.some((event) => event.text.includes('排队'))).toBe(true)
  })

  it('前一个跑完后，排队的会接着跑（而不是卡死或丢掉）', async () => {
    const first = service.submit('第一件')
    await tick()
    const second = service.submit('第二件')
    await tick()

    // 第一件完成 → 队列里的第二件应该被拉起来
    fake.emitEvent({ type: 'agent_settled' })
    await tick()
    await tick()
    expect(fake.prompts).toHaveLength(2)
    expect(service.detail(first.id)?.summary.state).toBe('completed')
    expect(service.detail(second.id)?.summary.state).toBe('running')
  })

  it('任务记录落盘，重建服务后还在', async () => {
    service.submit('要持久化的任务')
    await tick()
    fake.emitEvent({ type: 'agent_settled' })
    await tick()
    await service.shutdown()

    const restored = reopen()
    expect(restored.list()).toHaveLength(1)
    expect(restored.list()[0]?.state).toBe('completed')
    await restored.shutdown()
  })

  // 关掉应用时正在跑的任务，磁盘上留的是 running，但重启后根本没有进程在跑它。
  // 不归位的话，面板上会永远挂着一条不动的「执行中」——用户以为它还在干活。
  it('重启后把上次没跑完的任务标成已中断，而不是永远停在执行中', async () => {
    const summary = service.submit('跑一半就被关掉的活')
    await tick()
    expect(service.detail(summary.id)?.summary.state).toBe('running')

    // 没有 settled 直接退出：这就是用户点关闭窗口时发生的事
    await service.shutdown()

    const restored = reopen()
    const detail = restored.detail(summary.id)
    expect(detail?.summary.state).toBe('interrupted')
    expect(detail?.summary.error).toContain('中断')
    // 事件流里也要留一句，点进去能看懂为什么它没结果
    expect(detail?.events.some((event) => event.text.includes('中断'))).toBe(true)
    await restored.shutdown()
  })

  // 中断是终点，不是可以再被改写的中间态
  it('已中断的任务不会被取消改写成已取消', async () => {
    const summary = service.submit('跑一半就被关掉的活')
    await tick()
    await service.shutdown()

    const restored = reopen()
    await restored.cancel(summary.id)
    expect(restored.detail(summary.id)?.summary.state).toBe('interrupted')
    await restored.shutdown()
  })
})

describe('心跳探活', () => {
  it('进程死了但没发 exit 时，靠心跳发现', async () => {
    service.submit('会僵住的任务')
    await tick()
    fake.running = false // 模拟被信号杀掉：不触发 exit 事件
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(finished.some((item) => item.state === 'failed')).toBe(true)
  })
})

describe('收尾', () => {
  it('shutdown 之后不会再偷偷把 pi 拉起来', async () => {
    service.submit('任务')
    await tick()
    fake.die() // 触发重启路径
    await service.shutdown()
    const statuses: string[] = []
    await new Promise((resolve) => setTimeout(resolve, 80))
    // 重启是异步的：没有 disposed 标记的话，退出之后它还会再起一个心跳，谁也清不掉
    expect(service.runtimeInfo().entryPath).toBeDefined()
    expect(statuses).toHaveLength(0)
  })
})
