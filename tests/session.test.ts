import { describe, expect, it, vi } from 'vitest'
import type { VoiceEvent } from '../shared/contract'
import type { RealtimeProvider } from '../electron/voice/provider'
import { VoiceSession } from '../electron/voice/session'
import { ToolRegistry, type ToolDefinition } from '../electron/voice/tool-registry'

/** 假 provider：手工投喂事件、记录被调用过什么。 */
class FakeProvider implements RealtimeProvider {
  readonly calls: string[] = []
  readonly toolResults: Array<{ callId: string; text: string }> = []
  private listeners = new Set<(event: VoiceEvent) => void>()

  async start(): Promise<void> {
    this.calls.push('start')
    this.emit({ type: 'connection', state: 'connected', mode: 'demo' })
  }

  sendAudio(): void {}
  commit(): void {}
  interrupt(): void {}

  say(text: string): void {
    this.calls.push(`say:${text}`)
  }

  submitToolResult(callId: string, text: string): void {
    this.calls.push(`submit:${callId}`)
    this.toolResults.push({ callId, text })
  }

  async stop(): Promise<void> {
    this.calls.push('stop')
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const { z } = require('zod') as typeof import('zod')
  return {
    name: 'scan',
    description: '扫点东西',
    parameters: { type: 'object' },
    schema: z.object({}).strict(),
    risk: 'read_only',
    destructive: false,
    execute: () => '扫完了',
    ...overrides
  } as ToolDefinition
}

async function setup(tools: ToolDefinition[]): Promise<{
  session: VoiceSession
  provider: FakeProvider
  events: VoiceEvent[]
}> {
  const provider = new FakeProvider()
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)

  const events: VoiceEvent[] = []
  const session = new VoiceSession({
    getApiKey: () => 'fake-key',
    keyStatus: () => 'verified',
    instructions: () => '测试',
    tools: registry,
    createProvider: () => provider,
    emit: (event) => events.push(event)
  })
  await session.start()
  return { session, provider, events }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('工具调用的编排', () => {
  // 执行工具前不能插任何播报。豆包会把 speech_text_buffer 合成成一整轮独立
  // response，这一轮里回传的工具结果再也不会让模型开口——用户听到的是
  // 「我看一下」，然后彻底没下文。这条断言守的就是这个坑，别再好心加回去。
  it('执行前后都不出声，直接把结果回传给模型', async () => {
    const { provider } = await setup([makeTool({ execute: () => '结果在这' })])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    expect(provider.calls.filter((call) => call.startsWith('say:'))).toHaveLength(0)
    expect(provider.toolResults[0]).toEqual({ callId: 'c1', text: '结果在这' })
  })

  it('同一次调用被重复上报时只执行一次', async () => {
    const execute = vi.fn(() => '结果')
    const { provider } = await setup([makeTool({ execute })])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    // 不去重的话有副作用的工具会被执行两遍
    expect(execute).toHaveBeenCalledOnce()
  })

  it('工具失败时把错误码回传给模型，而不是假装成功', async () => {
    const { provider } = await setup([
      makeTool({
        execute: () => {
          const error = new Error('越界') as Error & { code: string }
          error.code = 'outside_authorized_roots'
          throw error
        }
      })
    ])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    expect(provider.toolResults[0]?.text).toContain('outside_authorized_roots')
  })

  it('tool_request 不下发渲染层（界面只看 tool_started / tool_finished）', async () => {
    const { provider, events } = await setup([makeTool()])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    expect(events.some((event) => event.type === 'tool_request')).toBe(false)
    expect(events.some((event) => event.type === 'tool_started')).toBe(true)
    expect(events.some((event) => event.type === 'tool_finished')).toBe(true)
  })

  it('没有注册表时回 unavailable，不说成功', async () => {
    const provider = new FakeProvider()
    const session = new VoiceSession({
      getApiKey: () => 'fake-key',
      keyStatus: () => 'verified',
      instructions: () => '测试',
      createProvider: () => provider,
      emit: () => undefined
    })
    await session.start()

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    expect(provider.toolResults[0]?.text).toContain('unavailable')
  })
})

describe('会话生命周期', () => {
  it('代次校验：停止后旧会话的事件不再外发', async () => {
    const { session, provider, events } = await setup([makeTool()])
    await session.stop()

    const before = events.length
    provider.emit({ type: 'notice', level: 'info', text: '迟到的消息' })
    await tick()

    expect(events).toHaveLength(before)
  })

  it('没有密钥时降级成演示模式，而不是报错崩掉', async () => {
    const provider = new FakeProvider()
    const session = new VoiceSession({
      getApiKey: () => undefined,
      keyStatus: () => 'missing',
      instructions: () => '测试',
      createProvider: () => provider,
      emit: () => undefined
    })
    const result = await session.start()
    expect(result.mode).toBe('demo')
    expect(result.credentialIssue).toBe('no-key')
  })
})

describe('结果由我们自己念的工具', () => {
  // 要用户先确认的工具（run_command）必然等超过豆包等结果的窗口
  // （实测 8 秒还接得上，20 秒就没了），那一轮模型已经死了。
  // 所以这类工具的结果必须在回传之前由我们自己念出来。
  it('speakResult 的工具：先念结果，再回传给模型', async () => {
    const { provider } = await setup([makeTool({ name: 'scan', speakResult: true, execute: () => '命令跑完了' })])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    const said = provider.calls.indexOf('say:命令跑完了')
    const submitted = provider.calls.indexOf('submit:c1')
    expect(said).toBeGreaterThanOrEqual(0)
    expect(submitted).toBeGreaterThan(said)
  })

  it('没标 speakResult 的工具不抢模型的话头', async () => {
    const { provider } = await setup([makeTool({ execute: () => '结果在这' })])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    expect(provider.calls.filter((call) => call.startsWith('say:'))).toHaveLength(0)
  })

  // 失败时念的是人话，不是错误码。`execution_failed: 执行失败` 这种是给日志看的
  it('失败时也念，但把错误码换成能听懂的话', async () => {
    const { provider } = await setup([
      makeTool({ name: 'scan', speakResult: true, execute: () => Promise.reject(new Error('炸了')) })
    ])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()
    await tick()

    const said = provider.calls.find((call) => call.startsWith('say:')) ?? ''
    expect(said).toContain('执行失败')
    expect(said).not.toContain('execution_failed')
  })

  it('用户没同意时，念的是"我没执行"，而不是错误码', async () => {
    const { provider } = await setup([
      makeTool({ name: 'scan', speakResult: true, destructive: true, execute: () => '不该跑到这里' })
    ])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()
    await tick()

    // 没有确认钩子 → 工具层直接拒绝
    expect(provider.calls).toContain('say:确认通道不可用，为了安全我没有执行。')
  })
})

describe('派活类工具的受理用语', () => {
  // 交给模型说的话它不一定开口——实测派出去之后一个字都没说，
  // 用户就在沉默里干等。所以这句由我们自己念。
  it('返回里带了 speech 就先念它', async () => {
    const { provider } = await setup([
      makeTool({ name: 'scan', execute: () => ({ output: '已受理', speech: '好，我去办，办好告诉你。' }) })
    ])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    const said = provider.calls.indexOf('say:好，我去办，办好告诉你。')
    expect(said).toBeGreaterThanOrEqual(0)
    expect(provider.calls.indexOf('submit:c1')).toBeGreaterThan(said)
    // 回传给模型的仍然是工单语气那句，两句本就不一样
    expect(provider.toolResults[0]).toEqual({ callId: 'c1', text: '已受理' })
  })

  it('没带 speech 的工具不抢话', async () => {
    const { provider } = await setup([makeTool({ execute: () => '结果在这' })])

    provider.emit({ type: 'tool_request', callId: 'c1', name: 'scan', arguments: '{}' })
    await tick()

    expect(provider.calls.filter((call) => call.startsWith('say:'))).toHaveLength(0)
  })
})
