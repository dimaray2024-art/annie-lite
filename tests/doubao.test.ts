import { describe, expect, it } from 'vitest'
import type { VoiceEvent } from '../shared/contract'
import {
  DOUBAO_INPUT_CHUNK_BYTES,
  DoubaoRealtimeProvider,
  describeDoubaoFailure,
  type DoubaoTransport,
  type DoubaoTransportFactory
} from '../electron/voice/doubao'

/**
 * 假 transport：手工控制连接与下行帧。
 * 协议解析是最容易写错、又最难靠手工验证的部分（要真 key、真麦克风、真网络），
 * 把它抽到可注入的 transport 后面，才能在这里逐帧断言。
 */
class FakeTransport implements DoubaoTransport {
  readonly sent: Array<Record<string, unknown>> = []
  closed = false

  private openListener?: () => void
  private messageListener?: (frame: string) => void
  private closeListener?: (code?: number) => void
  private errorListener?: (error: unknown) => void

  send(frame: string): void {
    this.sent.push(JSON.parse(frame) as Record<string, unknown>)
  }

  close(): void {
    this.closed = true
  }

  onOpen(listener: () => void): void {
    this.openListener = listener
  }

  onMessage(listener: (frame: string) => void): void {
    this.messageListener = listener
  }

  onClose(listener: (code?: number) => void): void {
    this.closeListener = listener
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListener = listener
  }

  /** 让连接建立，并自动应答 session.create —— 模拟服务端的握手。 */
  connect(): void {
    this.openListener?.()
    // 握手应答延后一拍，复现真实时序：我们发 session.create 之后才收到 session.created
    setTimeout(() => this.receive({ type: 'session.created', session: { id: 'sess-1' } }), 0)
  }

  receive(frame: Record<string, unknown>): void {
    this.messageListener?.(JSON.stringify(frame))
  }

  fail(error: unknown): void {
    this.errorListener?.(error)
  }

  disconnect(code = 1006): void {
    this.closeListener?.(code)
  }
}

function setup(tools?: Array<Record<string, unknown>>): {
  provider: DoubaoRealtimeProvider
  transport: FakeTransport
  events: VoiceEvent[]
} {
  const transport = new FakeTransport()
  const factory: DoubaoTransportFactory = { create: () => transport }
  const provider = new DoubaoRealtimeProvider({
    apiKey: 'test-key',
    instructions: '测试指令',
    tools,
    transportFactory: factory,
    sessionId: 'fixed-session-id'
  })
  const events: VoiceEvent[] = []
  provider.subscribe((event) => events.push(event))
  return { provider, transport, events }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('DoubaoRealtimeProvider 握手', () => {
  it('发出符合协议的 session.create', async () => {
    const { provider, transport } = setup()
    const started = provider.start()
    transport.connect()
    await started

    const create = transport.sent[0]!
    expect(create.type).toBe('session.create')
    const session = create.session as Record<string, unknown>
    expect(session.model).toBe('1.2.6.1')
    expect(session.id).toBe('fixed-session-id') // 复用会话 id 才能恢复上下文
    expect(session.instructions).toBe('测试指令')

    // 音频格式嵌在 audio.input.format 里，字段名是 format.type —— 文档正文这里和 demo 不一致
    const audio = session.audio as Record<string, Record<string, Record<string, unknown>>>
    expect(audio.input!.format!.type).toBe('pcm')
    expect(audio.input!.format!.rate).toBe(16000)
    expect(audio.output!.format!.type).toBe('pcm')
    expect(audio.output!.format!.rate).toBe(24000)
  })

  it('握手成功后上报 connected', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    expect(events).toContainEqual({ type: 'connection', state: 'connected', mode: 'doubao' })
  })

  it('连接失败时抛出可展示的错误，而不是干挂着', async () => {
    const { provider, transport } = setup()
    const started = provider.start()
    transport.fail(new Error('401 unauthorized'))
    await expect(started).rejects.toThrow(/401/)
    // 抛出去的消息会一路显示到界面上，不能是裸的 401
    await expect(started).rejects.toThrow(/API Key/)
  })
})

describe('失败原因说人话', () => {
  it('握手 401 / 403 翻成"去换 Key"', () => {
    expect(describeDoubaoFailure('401 unauthorized')).toContain('API Key')
    expect(describeDoubaoFailure('403 Forbidden')).toContain('API Key')
  })

  it('额度类错误翻成"去看用量"', () => {
    expect(describeDoubaoFailure('quota exceeded')).toContain('额度')
    expect(describeDoubaoFailure('insufficient balance')).toContain('额度')
    expect(describeDoubaoFailure('429 rate limit')).toContain('额度')
  })

  it('网络类错误翻成"检查网络"', () => {
    expect(describeDoubaoFailure('getaddrinfo ENOTFOUND openspeech.bytedance.com')).toContain('连不上豆包')
    expect(describeDoubaoFailure('ETIMEDOUT')).toContain('连不上豆包')
  })

  // 认不出来的时候绝不能编。编一个错因比不说是更坏的结果——
  // 用户会照着错的提示白折腾半天
  it('认不出来就老实说不知道，并且原文一点不丢', () => {
    const said = describeDoubaoFailure('something we have never seen')
    expect(said).toContain('something we have never seen')
    expect(said).not.toMatch(/API Key|额度|连不上/)
  })

  it('会话闲置太久被断开翻成"重新唤醒"', () => {
    expect(describeDoubaoFailure('sami error: codes=52000033, desc=AudioServerNoAudiolnputTooLongError')).toContain(
      '闲置'
    )
    expect(describeDoubaoFailure('55000000 Abnormal silence audio')).toContain('闲置')
  })

  it('空消息也不吐一句空话', () => {
    expect(describeDoubaoFailure('')).toContain('未知错误')
  })
})

describe('上行音频', () => {
  it('长度不是 640 字节就当场报错', async () => {
    const { provider, transport } = setup()
    const started = provider.start()
    transport.connect()
    await started

    expect(() => provider.sendAudio(Buffer.alloc(DOUBAO_INPUT_CHUNK_BYTES - 1))).toThrow(/640/)
    expect(() => provider.sendAudio(Buffer.alloc(DOUBAO_INPUT_CHUNK_BYTES))).not.toThrow()
  })

  it('音频帧只有平铺的 type 与 audio，没有 format', async () => {
    const { provider, transport } = setup()
    const started = provider.start()
    transport.connect()
    await started

    provider.sendAudio(Buffer.alloc(DOUBAO_INPUT_CHUNK_BYTES))
    const frame = transport.sent.at(-1)!
    expect(frame.type).toBe('input_audio_buffer.append')
    expect(Object.keys(frame).sort()).toEqual(['audio', 'type'])
  })
})

describe('转写与打断信号', () => {
  it('非空 delta 才算用户开口，且只上报一次', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.receive({ type: 'conversation.item.input_audio_transcription.started' })
    await tick()
    // 服务端"开始识别"不等于用户说话了（静音也会触发）
    expect(events.filter((e) => e.type === 'input_speech_started')).toHaveLength(0)

    transport.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好' })
    transport.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: '，' })
    await tick()
    expect(events.filter((e) => e.type === 'input_speech_started')).toHaveLength(1)
  })

  it('识别完成时上报结束与最终文本', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好' })
    transport.receive({ type: 'conversation.item.input_audio_transcription.completed', text: '你好，世界' })
    await tick()

    expect(events).toContainEqual({ type: 'input_speech_stopped' })
    expect(events).toContainEqual({ type: 'input_transcript', text: '你好，世界', final: true })
  })

  it('说完之后再次开口会重新触发', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: '一' })
    transport.receive({ type: 'conversation.item.input_audio_transcription.completed', text: '一' })
    transport.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: '二' })
    await tick()

    expect(events.filter((e) => e.type === 'input_speech_started')).toHaveLength(2)
  })
})

describe('下行走音', () => {
  it('音频帧带对采样率与格式', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.receive({ type: 'response.output_audio.delta', delta: 'AAAA', response_id: 'r1' })
    await tick()

    expect(events).toContainEqual({
      type: 'response_audio',
      audioBase64: 'AAAA',
      sampleRate: 24000,
      sampleFormat: 'f32le',
      responseId: 'r1',
      final: false
    })
  })

  it('音频结束发空帧作为收尾信号（触发播放缓冲 flush）', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.receive({ type: 'response.output_audio.done', response_id: 'r1' })
    await tick()

    const last = events.at(-1)!
    expect(last).toMatchObject({ type: 'response_audio', audioBase64: '', final: true })
  })
})

describe('错误与取消', () => {
  it('canceled 上报被打断', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.receive({ type: 'response.canceled' })
    await tick()
    expect(events).toContainEqual({ type: 'interrupted' })
  })

  // 提示要能照做，同时原文得留着——排错时那句英文才是唯一的线索
  it('错误事件转成能照做的提示，并保留原文', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.receive({ type: 'error', error: { message: 'quota exceeded' } })
    await tick()

    const notice = events.find((e) => e.type === 'notice')
    expect(notice).toMatchObject({ level: 'error' })
    const text = (notice as { text: string }).text
    expect(text).toContain('额度')
    expect(text).toContain('quota exceeded')
  })

  it('连接意外关闭会上报 disconnected', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    transport.disconnect()
    await tick()
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'connection', state: 'disconnected', mode: 'doubao' })
    )
  })

  it('主动 stop 之后的连接关闭不再上报（用户自己关的，不是故障）', async () => {
    const { provider, transport, events } = setup()
    const started = provider.start()
    transport.connect()
    await started

    await provider.stop()
    transport.disconnect()
    await tick()

    expect(events.filter((e) => e.type === 'connection' && e.state === 'disconnected')).toHaveLength(0)
  })
})

describe('主动播报', () => {
  // 播报的文字是我们给的，不经过模型，服务端不会回文字增量。
  // provider 不补一条 response_text 的话，界面就是"她说了话但一个字没有"。
  it('播报同时发一份文字事件，界面才不会只有声音没有字', async () => {
    const { provider, transport, events } = await running()
    provider.say('我先到旁边待着。')

    expect(events).toContainEqual({ type: 'response_text', text: '我先到旁边待着。', final: true })
  })

  it('播报仍然按协议发 speech_text_buffer 的两帧', async () => {
    const { provider, transport } = await running()
    provider.say('小明，我在。')

    const append = transport.sent.find((f) => f.type === 'speech_text_buffer.append')
    const commit = transport.sent.find((f) => f.type === 'speech_text_buffer.commit')
    expect(append?.text).toBe('小明，我在。')
    expect(commit?.speech_id).toBe(append?.speech_id)
  })
})

/** 起一个握手完成、可以发帧的 provider。 */
async function running(): Promise<{
  provider: DoubaoRealtimeProvider
  transport: FakeTransport
  events: VoiceEvent[]
}> {
  const context = setup()
  const started = context.provider.start()
  context.transport.connect()
  await started
  return context
}
