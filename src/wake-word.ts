/**
 * 待机唤醒词的采集端。
 *
 * 与正式会话是**时分互斥**的：两路都开麦克风在 macOS 上会互相干扰，
 * 所以进入会话前必须先停下这一路，会话结束再开回来。
 *
 * 待机音频只在本机做检测，不上传——这是"唤醒词"相对"一直听着云端"的全部意义。
 */

import { PcmResampler } from './pcm'

const WAKE_SAMPLE_RATE = 16000
/** 100ms 一片。太小会让 IPC 次数过多，太大会让唤醒变迟钝。 */
const WAKE_CHUNK_SAMPLES = 1600

export interface WakeWordEngineHooks {
  /** 采集失败时上报；命中事件由主进程通过事件通道推送，不走这里。 */
  onError: (message: string) => void
}

export class BrowserWakeWordEngine {
  private readonly hooks: WakeWordEngineHooks
  private context?: AudioContext
  private stream?: MediaStream
  private worklet?: AudioWorkletNode
  private resampler?: PcmResampler
  private pending: number[] = []
  private running = false
  /** start() 已经开场、还没结束。用来挡重复启动。 */
  private starting = false
  /**
   * 已经停止过。start() 里有三个 await，每跨过一个都要重新确认一次：
   * 否则 stop() 抢先跑完后，start() 会继续把麦克风和 AudioContext 建起来，
   * 而且再也没人关得掉它。
   */
  private disposed = false

  constructor(hooks: WakeWordEngineHooks) {
    this.hooks = hooks
  }

  get active(): boolean {
    return this.running
  }

  /**
   * 启动待机采集。
   *
   * 每个 await 之后的 disposed 检查都不是多余的。React StrictMode 在开发模式下
   * 会「挂载→卸载→再挂载」，stop() 会插在 start() 的 await 中间跑：
   * 那时 stream 还没赋值，stop() 关不掉任何东西，而 start() 醒来后照样把
   * 麦克风建起来。结果就是**两路待机采集同时在跑**，主进程收到两路交错的音频，
   * 唤醒模型听到的是一句话重复两遍——表现就是"怎么喊都唤不醒"。
   */
  async start(): Promise<void> {
    if (this.running || this.starting) return
    this.starting = true
    this.disposed = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
      if (this.disposed) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.stream = stream

      const context = new AudioContext()
      if (this.disposed) {
        void context.close().catch(() => undefined)
        return
      }
      this.context = context
      if (context.state === 'suspended') await context.resume()
      this.resampler = new PcmResampler(context.sampleRate, WAKE_SAMPLE_RATE)
      this.pending = []

      await context.audioWorklet.addModule(new URL('capture-worklet.js', document.baseURI).href)
      if (this.disposed) {
        await this.releaseLocal()
        return
      }

      const source = context.createMediaStreamSource(this.stream)
      const worklet = new AudioWorkletNode(context, 'capture-processor')
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.onBlock(event.data)
      source.connect(worklet)
      this.worklet = worklet

      this.running = true
      await window.assistant.wake.start()
    } catch (error) {
      this.hooks.onError(error instanceof Error ? error.message : String(error))
      await this.releaseLocal()
      // 自己是被丢弃的那一路时，别去动主进程的共享状态：
      // 另一路可能刚把唤醒监听拉起来，这一下会把它关掉
      if (!this.disposed) await window.assistant.wake.stop()
    } finally {
      this.starting = false
    }
  }

  async stop(): Promise<void> {
    this.disposed = true
    await this.releaseLocal()
    await window.assistant.wake.stop()
  }

  /** 只拆本实例占的资源，不碰主进程状态。 */
  private async releaseLocal(): Promise<void> {
    this.running = false
    this.worklet?.port.close()
    this.worklet?.disconnect()
    this.worklet = undefined
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    if (this.context) {
      await this.context.close().catch(() => undefined)
      this.context = undefined
    }
    this.pending = []
  }

  private onBlock(block: Float32Array): void {
    if (!this.running || !this.resampler) return

    const samples = this.resampler.push(block)
    for (const sample of samples) this.pending.push(sample)

    while (this.pending.length >= WAKE_CHUNK_SAMPLES) {
      const chunk = Float32Array.from(this.pending.splice(0, WAKE_CHUNK_SAMPLES))
      void window.assistant.wake.sendAudio(chunk.buffer)
    }
  }
}
