/**
 * 豆包端到端实时语音（Seeduplex）provider。
 *
 * 协议细节以官方 Python demo 为准（文档正文与 demo 有几处不一致，踩过）：
 * - 音频格式嵌在 session.audio.input.format / output.format，字段名是 format.type
 * - input_audio_buffer.append 只有平铺的 {type, audio}，没有 format 也没有 event_id
 * - 下游音频帧字段是 delta（base64），且**不含 response_id**
 * - 工具定义是扁平的（name 与 type 同级，不嵌在 function 里）
 *
 * WebSocket 被抽成 DoubaoTransport，测试里注入假实现即可覆盖全部协议解析。
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { VoiceEvent } from '@shared/contract'
import { AsyncEventQueue, type RealtimeProvider } from './provider'

export const DOUBAO_REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
export const DOUBAO_MODEL = '1.2.6.1'
/** 上行固定 20ms：16kHz × 2 字节 × 0.02 秒。发快了发慢了服务端都会报错。 */
export const DOUBAO_INPUT_CHUNK_BYTES = 640
export const DOUBAO_INPUT_SAMPLE_RATE = 16000
export const DOUBAO_OUTPUT_SAMPLE_RATE = 24000
export const DOUBAO_DEFAULT_VOICE = 'zh_female_xiaohe_jupiter_bigtts'

/** 上游事件名（我们发出去的）。 */
const UP = {
  sessionCreate: 'session.create',
  sessionClose: 'session.close',
  audioAppend: 'input_audio_buffer.append',
  audioCommit: 'input_audio_buffer.commit',
  audioMute: 'input_audio_mute.commit',
  audioUnmute: 'input_audio_unmute.commit',
  speechTextAppend: 'speech_text_buffer.append',
  speechTextCommit: 'speech_text_buffer.commit',
  itemCreate: 'conversation.item.create',
  responseCancel: 'response.cancel'
} as const

/** 下游事件名。 */
const DOWN = {
  sessionCreated: 'session.created',
  sessionClosed: 'session.closed',
  audioCommitted: 'input_audio_buffer.committed',
  speechStarted: 'input_audio_buffer.speech_started',
  speechStopped: 'input_audio_buffer.speech_stopped',
  asrStarted: 'conversation.item.input_audio_transcription.started',
  asrDelta: 'conversation.item.input_audio_transcription.delta',
  asrCompleted: 'conversation.item.input_audio_transcription.completed',
  asrFailed: 'conversation.item.input_audio_transcription.failed',
  textDelta: 'response.output_text.delta',
  textDone: 'response.output_text.done',
  audioStarted: 'response.output_audio.started',
  audioDelta: 'response.output_audio.delta',
  audioDone: 'response.output_audio.done',
  toolCall: 'response.function_call_arguments.done',
  canceled: 'response.canceled',
  responseDone: 'response.done',
  error: 'error'
} as const

// ── 失败原因说人话 ───────────────────────────────────────────────────────

/**
 * 把服务端给的失败原因翻成一句"能照做"的话。
 *
 * 服务端回的不是英文短语（`quota exceeded`）就是裸的握手状态（`401 unauthorized`），
 * 直接透出去，用户看到的是一句既看不懂、也不知道该改哪儿的话。
 *
 * 只翻我们能可靠判断的那几类，判不出来就老实说不知道——**编一个具体错因比不说是更坏的结果**，
 * 用户会照着错误的提示白折腾半天。原文一律保留在括号里，方便排错。
 */
export function describeDoubaoFailure(raw: string): string {
  const text = raw.trim() || '未知错误'
  if (/401|403|unauthor|forbidden|invalid[\s_-]*(api)?[\s_-]*key/i.test(text)) {
    return `豆包说 API Key 无效或已失效（${text}）。去设置里重新填一个。`
  }
  if (/429|quota|exceed|insufficient|balance|rate.?limit|额度|欠费|余额/i.test(text)) {
    return `豆包的额度用完了或者并发超了（${text}）。去火山引擎控制台看一眼用量。`
  }
  if (/52000033|55000000|Audiolnput|Abnormal.?[Ss]ilence|[Nn]o.?[Aa]udio.?[Ii]nput/i.test(text)) {
    return `豆包长时间没有收到音频，已断开（${text}）。如果刚才没有说话，这是会话闲置超时；重新唤醒就能继续。`
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|socket hang up|timed? ?out/i.test(text)) {
    return `连不上豆包（${text}）。检查一下网络，或者稍后再试。`
  }
  return `豆包那边出错了（${text}）。`
}

// ── 可注入的 WebSocket ───────────────────────────────────────────────────

export interface DoubaoTransport {
  send(frame: string): void
  close(): void
  onOpen(listener: () => void): void
  onMessage(listener: (frame: string) => void): void
  onClose(listener: (code?: number) => void): void
  onError(listener: (error: unknown) => void): void
}

export interface DoubaoTransportFactory {
  create(url: string, headers: Record<string, string>): DoubaoTransport
}

export const webSocketTransportFactory: DoubaoTransportFactory = {
  create(url, headers) {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 15_000 })
    return {
      send: (frame) => socket.send(frame),
      close: () => socket.close(),
      onOpen: (listener) => socket.on('open', listener),
      onMessage: (listener) => socket.on('message', (data) => listener(data.toString())),
      onClose: (listener) => socket.on('close', (code) => listener(code)),
      onError: (listener) => socket.on('error', listener)
    }
  }
}

export interface DoubaoProviderOptions {
  apiKey: string
  instructions: string
  voice?: string
  tools?: Array<Record<string, unknown>>
  transportFactory?: DoubaoTransportFactory
  endpoint?: string
  /** 复用同一个会话 id：服务端据此恢复历史上下文（实测断开重连后仍记得之前说过的内容）。 */
  sessionId?: string
}

type Frame = Record<string, unknown>

export class DoubaoRealtimeProvider implements RealtimeProvider {
  private readonly options: Required<Pick<DoubaoProviderOptions, 'apiKey' | 'instructions'>> & DoubaoProviderOptions
  private readonly transportFactory: DoubaoTransportFactory
  private readonly sessionId: string
  private readonly queue = new AsyncEventQueue<VoiceEvent>(512)
  private readonly listeners = new Set<(event: VoiceEvent) => void>()

  private transport?: DoubaoTransport
  private eventSeq = 0
  private inputSpeaking = false
  private stopped = false
  private sessionReady?: () => void

  constructor(options: DoubaoProviderOptions) {
    this.options = options as DoubaoRealtimeProvider['options']
    this.transportFactory = options.transportFactory ?? webSocketTransportFactory
    this.sessionId = options.sessionId ?? randomUUID()
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.stopped = false
    const transport = this.transportFactory.create(this.options.endpoint ?? DOUBAO_REALTIME_URL, {
      'X-Api-Key': this.options.apiKey
    })
    this.transport = transport

    const opened = new Promise<void>((resolve, reject) => {
      transport.onOpen(() => resolve())
      // 连不上/被拒是最常见的翻车（Key 过期），这里就翻成人话再抛。
      // 原文留在消息里，日志和测试都还看得到 401。
      transport.onError((error) => reject(new Error(describeDoubaoFailure(error instanceof Error ? error.message : String(error)))))
      transport.onClose((code) => {
        if (!this.stopped) {
          this.emit({ type: 'connection', state: 'disconnected', mode: 'doubao', detail: `连接关闭 (${code ?? '?'})` })
        }
      })
    })
    transport.onMessage((frame) => this.handleFrame(frame))

    await opened
    this.sendFrame({
      type: UP.sessionCreate,
      event_id: this.nextEventId(),
      session: {
        id: this.sessionId,
        model: DOUBAO_MODEL,
        instructions: this.options.instructions,
        audio: {
          input: { format: { type: 'pcm', rate: DOUBAO_INPUT_SAMPLE_RATE } },
          output: {
            format: { type: 'pcm', rate: DOUBAO_OUTPUT_SAMPLE_RATE },
            voice: this.options.voice ?? DOUBAO_DEFAULT_VOICE
          }
        },
        tools: this.options.tools ?? []
      },
      extension: {
        asr: { extra: {} },
        tts: { extra: {} },
        dialog: { extra: { enable_loudness_norm: true } }
      }
    })

    // 等 session.created，超时说明握手根本没成
    await this.waitForSession(15_000)
    this.emit({ type: 'connection', state: 'connected', mode: 'doubao' })
  }

  /** 等 session.created。等不到就说明握手没成，给出可操作的提示而不是干挂着。 */
  private waitForSession(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessionReady = undefined
        reject(new Error('豆包没有返回会话确认，请检查 API Key 与网络'))
      }, timeoutMs)
      this.sessionReady = () => {
        clearTimeout(timer)
        this.sessionReady = undefined
        resolve()
      }
    })
  }

  /**
   * 上行音频。
   *
   * **不要加静音门控。** 实测：一旦在用户不说话时停发，回传工具结果之后
   * 模型就永远不接话——服务端像是靠持续的上行在推进回合。官方 demo 的
   * `while True: 补静音` 就是干这个的。省这点带宽不值当。
   */
  sendAudio(chunk: Buffer): void {
    if (chunk.length !== DOUBAO_INPUT_CHUNK_BYTES) {
      throw new Error(`上行音频必须是 ${DOUBAO_INPUT_CHUNK_BYTES} 字节，收到 ${chunk.length}`)
    }
    this.sendFrame({ type: UP.audioAppend, audio: chunk.toString('base64') })
  }

  commit(): void {
    this.sendFrame({ type: UP.audioCommit, event_id: this.nextEventId() })
  }

  interrupt(): void {
    this.sendFrame({ type: UP.responseCancel, event_id: this.nextEventId() })
    this.emit({ type: 'interrupted' })
  }

  /** 让安妮念一段指定文本。措辞由调用方决定，模型只负责朗读。 */
  say(text: string): void {
    const speechId = randomUUID()
    this.sendFrame({
      type: UP.speechTextAppend,
      event_id: this.nextEventId(),
      speech_id: speechId,
      text
    })
    this.sendFrame({ type: UP.speechTextCommit, event_id: this.nextEventId(), speech_id: speechId, text: '' })

    // 这段文字是我们给的，不经过模型，所以服务端不会回 response.output_text.delta。
    // 不在这里补一条的话，界面上就是"她说了话，一个字都没显示"——
    // 打招呼、告别、任务播报全都走这条路，用户会以为是转写坏了。
    this.emit({ type: 'response_text', text, final: true })
  }

  submitToolResult(callId: string, text: string): void {
    this.sendFrame({
      type: UP.itemCreate,
      event_id: this.nextEventId(),
      items: [{ type: 'message', role: 'tool', call_id: callId, content: [{ type: 'input_text', text }] }]
    })
  }

  setMicMuted(muted: boolean): void {
    this.sendFrame({ type: muted ? UP.audioMute : UP.audioUnmute, event_id: this.nextEventId() })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    try {
      this.sendFrame({ type: UP.sessionClose, event_id: this.nextEventId() })
    } catch {
      // 连接可能已经断了
    }
    this.transport?.close()
    this.transport = undefined
    this.queue.close()
  }

  // ── 协议解析 ────────────────────────────────────────────────────────────

  private handleFrame(raw: string): void {
    let frame: Frame
    try {
      frame = JSON.parse(raw) as Frame
    } catch {
      this.emit({ type: 'notice', level: 'warn', text: '收到无法解析的下行数据' })
      return
    }
    const type = String(frame.type ?? '')

    switch (type) {
      case DOWN.sessionCreated:
        this.sessionReady?.()
        break

      case DOWN.speechStarted:
        this.markSpeechStarted()
        break

      case DOWN.asrStarted:
        // 服务端开始识别不等于用户真的说话了（静音也会触发），
        // 真正的"开口"信号是下面非空的 delta
        break

      case DOWN.asrDelta: {
        const text = typeof frame.delta === 'string' ? frame.delta : ''
        if (text) {
          this.markSpeechStarted()
          this.emit({ type: 'input_transcript', text, final: false })
        }
        break
      }

      case DOWN.asrCompleted:
      case DOWN.speechStopped: {
        const text =
          (typeof frame.text === 'string' && frame.text) ||
          (typeof frame.transcript === 'string' && frame.transcript) ||
          ''
        this.inputSpeaking = false
        this.emit({ type: 'input_speech_stopped' })
        if (text) this.emit({ type: 'input_transcript', text, final: true })
        break
      }

      case DOWN.asrFailed:
        this.emit({ type: 'notice', level: 'warn', text: '这句没听清，再说一次试试' })
        break

      case DOWN.textDelta:
        if (typeof frame.delta === 'string' && frame.delta) {
          this.emit({ type: 'response_text', text: frame.delta, final: false })
        }
        break

      case DOWN.textDone:
        if (typeof frame.text === 'string') {
          this.emit({ type: 'response_text', text: frame.text, final: true })
        }
        break

      case DOWN.audioStarted:
        break

      case DOWN.audioDelta: {
        const delta = typeof frame.delta === 'string' ? frame.delta : ''
        if (delta) {
          this.emit({
            type: 'response_audio',
            audioBase64: delta,
            sampleRate: DOUBAO_OUTPUT_SAMPLE_RATE,
            sampleFormat: 'f32le',
            responseId: typeof frame.response_id === 'string' ? frame.response_id : undefined,
            final: false
          })
        }
        break
      }

      case DOWN.audioDone:
        this.emit({
          type: 'response_audio',
          audioBase64: '',
          sampleRate: DOUBAO_OUTPUT_SAMPLE_RATE,
          sampleFormat: 'f32le',
          responseId: typeof frame.response_id === 'string' ? frame.response_id : undefined,
          final: true
        })
        break

      case DOWN.responseDone:
        this.emit({
          type: 'response_done',
          responseId: typeof frame.response_id === 'string' ? frame.response_id : undefined
        })
        break

      case DOWN.canceled:
        this.emit({ type: 'interrupted' })
        break

      case DOWN.toolCall: {
        // 这里只上报，由 VoiceSession 决定怎么执行、怎么回传
        const items = Array.isArray(frame.items) ? (frame.items as Frame[]) : []
        for (const item of items) {
          this.emit({
            type: 'tool_request',
            callId: String(item.call_id ?? ''),
            name: String(item.name ?? ''),
            arguments: typeof item.arguments === 'string' ? item.arguments : '{}'
          })
        }
        break
      }

      case DOWN.sessionClosed:
        this.emit({ type: 'connection', state: 'disconnected', mode: 'doubao', detail: '会话已结束' })
        break

      case DOWN.error: {
        const detail = frame.error
        const message =
          typeof detail === 'object' && detail !== null
            ? String((detail as Frame).message ?? JSON.stringify(detail))
            : String(detail ?? '未知错误')
        this.emit({ type: 'notice', level: 'error', text: describeDoubaoFailure(message) })
        break
      }

      default:
        break
    }
  }

  /** 用户开口：只在状态翻转时发一次，避免每帧都触发打断。 */
  private markSpeechStarted(): void {
    if (this.inputSpeaking) return
    this.inputSpeaking = true
    this.emit({ type: 'input_speech_started' })
  }

  private sendFrame(frame: Frame): void {
    if (!this.transport) throw new Error('豆包连接尚未建立')
    this.transport.send(JSON.stringify(frame))
  }

  private nextEventId(): string {
    this.eventSeq += 1
    return `event_${this.eventSeq}`
  }

  private emit(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
