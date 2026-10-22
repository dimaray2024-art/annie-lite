/**
 * 渲染层的音频引擎：采麦克风、分块上行、播放下行、打断。
 *
 * 为什么这些必须留在渲染进程：
 * 1. 只有这里能拿到 `getUserMedia({echoCancellation:true})`——WebRTC 的 AEC3。
 *    它让"播报期间麦克风保持开启、用户随时插话"成立，且不像系统级语音处理那样影响设备音量。
 * 2. AEC 需要知道**本页正在播什么**作为回声参考，所以播放也必须走同一个 AudioContext。
 *    把播放丢给另一个进程（我们最初在 Python 里就是那么干的）会让回声消除失效。
 */

// worklet 放在 public/ 下原样进产物。
// 不能用 import ... ?url：文件小于 Vite 的内联阈值时会被塞成 data URL，
// 而 audioWorklet.addModule 不接受 data URL（抛 AbortError，看起来像"麦克风被拒绝"）。
import {
  Float32Chunker,
  PcmFloat32LeStreamDecoder,
  PcmJitterBuffer,
  PcmResampler,
  RealtimePlaybackGate
} from './pcm'

/** 上行固定 20ms：16kHz × 2 字节 × 0.02 秒 = 640 字节。主进程会断言这个长度。 */
export const UPLINK_CHUNK_BYTES = 640
const UPLINK_SAMPLE_RATE = 16000
const UPLINK_SAMPLES_PER_CHUNK = UPLINK_CHUNK_BYTES / 2

/** 下行：豆包给的是 24kHz 单声道 float32 LE。 */
const DEFAULT_DOWNLINK_SAMPLE_RATE = 24000

export interface VoiceEngineHooks {
  /** 上行音频块（固定 640 字节）。P2 起发给主进程，P1 的闭环测试直接回灌播放。 */
  onUplink(chunk: ArrayBuffer): void
  /** 麦克风电平 0..1，驱动粒子球。 */
  onLevel(level: number): void
  /** 引擎状态变化，用于 UI 提示。 */
  onNotice?(notice: { level: 'info' | 'warn' | 'error'; text: string }): void
}

export interface VoiceEngineOptions extends VoiceEngineHooks {
  /** P1 的验证开关：把采集到的音频直接回灌播放，用来确认 AEC 与分块链路正常。 */
  loopback?: boolean
}

interface ScheduledSource {
  source: AudioBufferSourceNode
  responseId?: string
}

let firstCapture = true

export class BrowserVoiceEngine {
  private readonly options: VoiceEngineOptions
  private context?: AudioContext
  private stream?: MediaStream
  /** 豆包下行音频的 WebRTC 输出轨道，交给 Vidu 做口型驱动。 */
  private assistantDestination?: MediaStreamAudioDestinationNode
  private analyser?: AnalyserNode
  private worklet?: AudioWorkletNode
  private levelTimer?: number

  private readonly decoder = new PcmFloat32LeStreamDecoder()
  private readonly jitter = new PcmJitterBuffer({ prebufferSamples: 2880, blockSamples: 960 })
  private readonly gate = new RealtimePlaybackGate()
  private readonly playing = new Set<ScheduledSource>()
  private playAt = 0

  private resampler?: PcmResampler
  private readonly chunker = new Float32Chunker(UPLINK_SAMPLES_PER_CHUNK)
  private running = false
  private uplinkSent = 0

  constructor(options: VoiceEngineOptions) {
    this.options = options
  }

  get active(): boolean {
    return this.running
  }

  async start(): Promise<void> {
    if (this.running) return

    // 这三项必须显式打开：echoCancellation 是打断能成立的前提
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      })
    } catch (error) {
      const name = error instanceof DOMException ? error.name : 'Error'
      throw new Error(
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在「系统设置 › 隐私与安全性 › 麦克风」里允许本应用'
          : `打开麦克风失败（${name}）：${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.context = new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
    this.assistantDestination = this.context.createMediaStreamDestination()
    this.assistantDestination.channelCount = 1
    this.assistantDestination.channelCountMode = 'explicit'

    // 相对 document.baseURI 解析：开发时指向 dev server，打包后指向 dist 目录
    const workletUrl = new URL('capture-worklet.js', document.baseURI).href
    try {
      await this.context.audioWorklet.addModule(workletUrl)
    } catch (error) {
      // 走到这里说明麦克风已经拿到了，问题在音频处理模块——分开报，否则会查错方向
      await this.stop()
      throw new Error(`音频处理模块加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const source = this.context.createMediaStreamSource(this.stream)
    this.worklet = new AudioWorkletNode(this.context, 'capture-processor')
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.onCapture(event.data)

    // 电平表：直接分析麦克风流，省一路采集
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 1024
    source.connect(this.analyser)
    source.connect(this.worklet)
    // worklet 不接输出——它的目的是采集，不是发声

    this.resampler = new PcmResampler(this.context.sampleRate, UPLINK_SAMPLE_RATE)
    this.chunker.reset()
    this.resampler.reset()
    this.running = true
    this.playAt = 0
    this.startLevelMeter()
    window.assistant?.log('engine', `已启动 context=${this.context.sampleRate}Hz loopback=${this.options.loopback}`)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.levelTimer !== undefined) {
      window.clearInterval(this.levelTimer)
      this.levelTimer = undefined
    }
    this.resetPlayback()
    this.worklet?.port.close()
    this.worklet?.disconnect()
    this.analyser?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    if (this.context) {
      await this.context.close().catch(() => undefined)
      this.context = undefined
    }
    this.assistantDestination = undefined
  }

  /** 返回正在播放的豆包音频轨道，供 Vidu Live 实时驱动口型。 */
  getAssistantAudioTrack(): MediaStreamTrack | undefined {
    return this.assistantDestination?.stream.getAudioTracks()[0]
  }

  /** 返回用户麦克风轨道，供 Vidu Live 独立模式直接接收。 */
  getMicrophoneAudioTrack(): MediaStreamTrack | undefined {
    return this.stream?.getAudioTracks()[0]
  }

  // ── 上行 ────────────────────────────────────────────────────────────────

  private onCapture(block: Float32Array): void {
    if (!this.running || !this.context) return

    if (firstCapture) {
      firstCapture = false
      window.assistant?.log('engine', `首个采集块 ${block.length} 帧`)
    }
    if (this.options.loopback) {
      // 闭环验证：直接把刚采到的声音排进播放队列。
      // 只要扬声器在放音，麦克风就会听到——如果 AEC 生效，听到的只会是自己的说话声。
      this.enqueueBlock(block, this.context.sampleRate, undefined)
      return
    }

    // 采集块通常 128 帧，重采样后约 42 个样本，一块上行要 320 个——
    // 所以必须跨多次回调累积，不能指望每次都有东西发出去
    const resampled = this.resampler?.push(block) ?? block
    for (const chunk of this.chunker.push(resampled)) {
      try {
        this.options.onUplink(chunk.buffer)
        this.uplinkSent += 1
        if (this.uplinkSent === 1 || this.uplinkSent % 500 === 0) {
          window.assistant?.log('engine', `上行 ${this.uplinkSent} 块`)
        }
      } catch (error) {
        window.assistant?.log('engine', `上行失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ── 下行播放 ────────────────────────────────────────────────────────────

  /** 收到一段 base64 音频（豆包下行格式）。 */
  pushAudioBase64(audioBase64: string, sampleRate = DEFAULT_DOWNLINK_SAMPLE_RATE, responseId?: string): void {
    if (!this.gate.accept(responseId)) return
    if (!audioBase64) return

    const binary = atob(audioBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

    const samples = this.decoder.push(bytes)
    this.jitter.push(samples)
    this.drainJitter(sampleRate, responseId)
  }

  /** 一个响应播完了，把残块吐出去。 */
  finishAudio(sampleRate = DEFAULT_DOWNLINK_SAMPLE_RATE, responseId?: string): void {
    const tail = this.jitter.flush()
    if (tail) this.enqueueBlock(tail, sampleRate, responseId)
    this.gate.finish(responseId)
  }

  private drainJitter(sampleRate: number, responseId?: string): void {
    for (;;) {
      const block = this.jitter.take()
      if (!block) return
      this.enqueueBlock(block, sampleRate, responseId)
    }
  }

  private enqueueBlock(block: Float32Array, sampleRate: number, responseId?: string): void {
    const context = this.context
    if (!context || block.length === 0) return

    const buffer = context.createBuffer(1, block.length, sampleRate)
    buffer.getChannelData(0).set(block)

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    // 同一份调度音频同时送扬声器和 Vidu，两个输出共享同一个 AudioContext 时钟，
    // 因而数字人的口型与用户实际听到的豆包声音保持同步。
    this.assistantDestination && source.connect(this.assistantDestination)

    // 留一点前瞻量，避免调度到"已经过去的时间"导致播放被截断
    const when = Math.max(context.currentTime + 0.06, this.playAt)
    source.start(when)
    this.playAt = when + buffer.duration

    const entry: ScheduledSource = { source, responseId }
    this.playing.add(entry)
    source.onended = () => this.playing.delete(entry)
  }

  /**
   * 打断：立刻停止播放并丢弃队列。
   * 调用方（P2 起是主进程的 input_speech_started 事件）应当同时让服务端取消响应。
   */
  interruptPlayback(): void {
    this.gate.cancelActive()
    this.resetPlayback()
  }

  /**
   * 服务端确认取消后放行。
   *
   * 必须调这个：豆包的音频帧不带 response_id，闸门只能用"取消过就一直拦到有 id 为止"
   * 这种兜底。而取消时通常还没有任何音频，闸门于是进入"拦截所有无 id 音频"状态——
   * 不主动放行的话，之后每一句回复都会被丢掉，表现就是"说话完全没声音"。
   */
  releaseGate(): void {
    this.gate.finish(undefined)
  }

  private resetPlayback(): void {
    for (const entry of this.playing) {
      try {
        entry.source.stop()
      } catch {
        // 已经结束的 source 会抛错，忽略
      }
    }
    this.playing.clear()
    this.jitter.reset()
    this.decoder.reset()
    this.playAt = 0
  }

  // ── 电平 ────────────────────────────────────────────────────────────────

  private startLevelMeter(): void {
    const analyser = this.analyser
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)

    this.levelTimer = window.setInterval(() => {
      if (!this.running) return
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (const value of data) sum += value
      const average = sum / data.length / 255
      // 0.42 是上限：再高球会抖得像坏了
      this.options.onLevel(Math.min(0.42, average * 0.72))
    }, 100)
  }
}
