/**
 * 语音会话编排：选 provider、转发事件、处理控制命令。
 *
 * 这里有个贯穿全项目的模式——**代次（generation）校验**：
 * 启动/停止是异步的，用户可能连点两次，旧会话的迟到事件会串到新会话的界面上。
 * 每次 start 递增代次，事件回传前先比一次，不匹配就丢。
 */

import type { VoiceEvent, VoiceStartResult } from '@shared/contract'
import { DemoRealtimeProvider, type RealtimeProvider } from './provider'
import { DoubaoRealtimeProvider } from './doubao'
import type { ToolRegistry } from './tool-registry'

export interface VoiceSessionDeps {
  /** 工具注册表。没有它时工具调用一律回"不可用"，而不是假装成功。 */
  tools?: ToolRegistry
  /**
   * provider 工厂。默认造真实的豆包 provider，测试里注入假的——
   * 工具分发、先出声再执行、结果回传这些编排逻辑都在这一层，值得能单测。
   */
  createProvider?: (options: {
    apiKey: string
    instructions: string
    voice?: string
    tools: Array<Record<string, unknown>>
  }) => RealtimeProvider
  /** 取豆包 API Key；返回 undefined 表示没配置。 */
  getApiKey: () => string | undefined
  keyStatus: () => 'missing' | 'unavailable' | 'unreadable' | 'verified'
  instructions: () => string
  voice?: () => string | undefined
  emit: (event: VoiceEvent) => void
  /**
   * 诊断日志。
   *
   * 工具名和参数不走 emit：UI 不需要，但排错非要不可——
   * 之前日志里只有「事件 tool_started」，用户反馈"她做错了"时
   * 根本查不出她到底调了什么、传了什么参数。
   */
  log?: (message: string, detail?: unknown) => void
}

export class VoiceSession {
  private readonly deps: VoiceSessionDeps
  private provider?: RealtimeProvider
  private unsubscribe?: () => void
  private generation = 0
  /** 上游事件队列的消费任务由 provider 内部驱动，这里只保留订阅句柄。 */

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps
  }

  get active(): boolean {
    return this.provider !== undefined
  }

  async start(): Promise<VoiceStartResult> {
    const generation = ++this.generation
    await this.stopProvider()

    const key = this.deps.getApiKey()
    const status = this.deps.keyStatus()

    if (!key) {
      // 没有可用密钥就降级成演示模式：界面还能用，也能进设置去录 key
      const demo = new DemoRealtimeProvider()
      await this.attach(demo, generation)
      return {
        mode: 'demo',
        credentialIssue: status === 'unreadable' ? 'stored-key-unreadable' : 'no-key'
      }
    }

    const create =
      this.deps.createProvider ??
      ((options) =>
        new DoubaoRealtimeProvider({
          apiKey: options.apiKey,
          instructions: options.instructions,
          voice: options.voice,
          tools: options.tools
        }))
    const provider = create({
      apiKey: key,
      instructions: this.deps.instructions(),
      voice: this.deps.voice?.(),
      tools: this.deps.tools?.doubaoTools() ?? []
    })
    await this.attach(provider, generation)
    return { mode: 'doubao' }
  }

  private async attach(provider: RealtimeProvider, generation: number): Promise<void> {
    const handledCalls = new Set<string>()
    this.unsubscribe = provider.subscribe((event) => {
      // 迟到的旧会话事件直接丢，别污染新会话的界面
      if (generation !== this.generation) return

      if (event.type === 'tool_request') {
        // 同一次调用可能被重复上报，按 callId 去重；否则会执行两遍副作用
        if (handledCalls.has(event.callId)) return
        handledCalls.add(event.callId)
        void this.runTool(provider, generation, event)
        return
      }
      this.deps.emit(event)
    })
    try {
      await provider.start()
    } catch (error) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
      provider.stop().catch(() => undefined)
      throw error
    }
    this.provider = provider
  }

  /**
   * 执行工具并把结果回传给模型。
   *
   * 回传的文本长度直接等于模型要说多久，所以工具自己负责把输出压到"适合念"的长度。
   */
  private async runTool(
    provider: RealtimeProvider,
    generation: number,
    request: { callId: string; name: string; arguments: string }
  ): Promise<void> {
    const registry = this.deps.tools
    this.deps.emit({ type: 'tool_started', name: request.name })
    this.deps.log?.(`调用 ${request.name}`, request.arguments.slice(0, 500))

    // 刻意不在动手前插一句播报。原理上它像是"不占模型回合"，
    // 实测恰恰相反：speech_text_buffer 会被合成成一整轮独立 response，
    // 这一轮里回传的工具结果就再也不会让模型开口——
    // 表现是她说一句「我看一下」，然后彻底没下文。
    // 费时间的活靠两段式解决：工具立刻返回受理，模型先说话，结果跑完单独播报。
    const result = registry
      ? await registry.execute(request)
      : {
          callId: request.callId,
          name: request.name,
          ok: false,
          output: 'unavailable: 工具不可用',
          error: 'unavailable'
        }

    if (generation !== this.generation) return

    this.deps.emit({
      type: 'tool_finished',
      name: result.name,
      ok: result.ok,
      error: result.error,
      message: result.message
    })
    this.deps.log?.(`${result.name} ${result.ok ? '返回' : '失败'}`, result.output.slice(0, 500))

    // 需要用户先确认的工具，等确认完豆包那边早已过了等结果的窗口
    // （实测 8 秒还接得上，20 秒就彻底没反应），所以结果由我们自己念。
    // 回传照发，是为了让模型在后续对话里知道这件事发生过。
    // 受理用语先念：派活类工具立刻返回、活儿在后台跑，
    // 这句是填上"派出去"和"出结果"之间那段空白的，用户不必干等
    if (result.speech) {
      try {
        provider.say(result.speech)
      } catch {
        // 念不出来不影响活已经派出去了
      }
    }

    const definition = registry?.descriptorFor(result.name)
    if (definition?.speakResult) {
      try {
        provider.say(result.ok ? result.output : this.failureSentence(result.error, result.output))
      } catch {
        // 念不出来不影响已经发生的事
      }
    }

    try {
      provider.submitToolResult(result.callId, result.output)
    } catch {
      this.deps.emit({ type: 'notice', level: 'warn', text: '工具已执行，但结果没能回传语音' })
    }
  }

  /**
   * 工具没执行成时念的这句话。
   *
   * 不能直接把 error code 念出来（`approval_cancelled: 用户没有同意执行`）——
   * 那是给日志看的。这里把那几种常见的翻译成人话。
   */
  private failureSentence(code: string | undefined, output: string): string {
    switch (code) {
      case 'approval_cancelled':
        return '你没同意，我没有执行。'
      case 'approval_unavailable':
        return '确认通道不可用，为了安全我没有执行。'
      case 'timeout':
        return '那条命令超时了，我没有执行。'
      default:
        // 剩下的把 code 前缀剥掉，至少别念出来一串英文标识
        return output.replace(/^[a-z_]+:\s*/, '')
    }
  }

  sendAudio(chunk: Buffer): void {
    this.provider?.sendAudio(chunk)
  }

  commit(): void {
    this.provider?.commit()
  }

  interrupt(): void {
    this.provider?.interrupt()
  }

  say(text: string): void {
    this.provider?.say(text)
  }

  async stop(): Promise<void> {
    this.generation += 1
    await this.stopProvider()
  }

  private async stopProvider(): Promise<void> {
    const provider = this.provider
    this.provider = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (provider) await provider.stop().catch(() => undefined)
  }
}
