/**
 * 实时语音 provider 的抽象。
 *
 * 抽这一层不是为了"将来换供应商"，而是为了让豆包协议能被单测覆盖：
 * 测试里注入一个假的 transport 手工喂帧，断言事件序列是否正确，
 * 完全不用碰网络、不用真 key。协议解析是最容易出错、又最难靠手工验证的部分。
 */

import type { VoiceEvent } from '@shared/contract'

export interface RealtimeProvider {
  /** 建立连接并创建会话。失败时抛出可展示的错误。 */
  start(): Promise<void>
  /** 上行音频。长度由实现自己断言——豆包要求固定 640 字节。 */
  sendAudio(chunk: Buffer): void
  /** 用户说完，通知服务端提交这一轮输入。 */
  commit(): void
  /** 打断：取消当前响应。 */
  interrupt(): void
  /** 朗读一段指定文本（模型不参与措辞）。 */
  say(text: string): void
  /**
   * 把工具执行结果回给模型。
   * 注意服务端等待结果**有超时**：实测 0.2 秒内回传模型会接着说，超过十秒就完全没反应，
   * 所以耗时长的任务必须先把活儿接过去，别在这里等。
   */
  submitToolResult(callId: string, text: string): void
  stop(): Promise<void>
  /** 订阅事件，返回取消订阅函数。 */
  subscribe(listener: (event: VoiceEvent) => void): () => void
}

/**
 * 异步事件队列。
 *
 * WebSocket 的回调是同步触发的，而消费端是异步的；中间需要一个有界队列把两边解耦。
 * 队列满了丢最旧的：语音场景下积压的旧事件（几百毫秒前的音频块）已经没有意义，
 * 宁可丢也不要把延迟越堆越大。
 */
export class AsyncEventQueue<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(value: T) => void> = []
  private closed = false
  private readonly limit: number

  constructor(limit = 512) {
    this.limit = limit
  }

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(item)
      return
    }
    this.items.push(item)
    if (this.items.length > this.limit) this.items.shift()
  }

  async next(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift()
    if (this.closed) return undefined
    return new Promise<T>((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) this.waiters.shift()?.(undefined as never)
  }
}

/**
 * 没有 API Key 时的降级实现：什么都不连，只报告状态。
 * 让它存在而不是直接报错，是为了界面还能起来、还能做设置。
 */
export class DemoRealtimeProvider implements RealtimeProvider {
  private readonly listeners = new Set<(event: VoiceEvent) => void>()
  private running = false

  async start(): Promise<void> {
    this.running = true
    this.emit({ type: 'connection', state: 'connected', mode: 'demo' })
    this.emit({
      type: 'notice',
      level: 'info',
      text: '未配置豆包 API Key，当前是演示模式：麦克风和界面可用，但不会真的对话。'
    })
  }

  sendAudio(): void {
    // 演示模式不上行
  }

  commit(): void {}

  interrupt(): void {}

  say(): void {
    // 演示模式没有语音合成
  }

  submitToolResult(): void {
    // 演示模式没有工具调用
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.emit({ type: 'connection', state: 'disconnected', mode: 'demo' })
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
