/**
 * 待机唤醒词服务：管 worker 生命周期、状态机、以及模型之上的去抖策略。
 *
 * 关键语义：**待机音频只在本机处理，不上传**。唤醒词命中之前不会连豆包，
 * 所以待机期间没有任何音频离开这台机器。
 */

import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { WakeState } from '@shared/contract'

/** 模型初始化超时。原生模块加载偶发卡住时，宁可报 unavailable 也不要一直挂。 */
const INIT_TIMEOUT_MS = 15_000

export interface WakeWordEvents {
  onState: (state: WakeState, detail?: string) => void
  onDetected: (phrase: string) => void
}

/**
 * 模型之上的去抖。模型本身在阈值附近会连着触发好几次，没有这层的话
 * 说一句"安妮"能唤醒三四轮。
 */
export class WakeWordPolicy {
  private readonly debounceMs: number
  private readonly cooldownMs: number
  private lastAt = 0
  private coolingUntil = 0

  constructor(debounceMs = 900, cooldownMs = 4000) {
    this.debounceMs = debounceMs
    this.cooldownMs = cooldownMs
  }

  consider(now: number): boolean {
    if (now - this.lastAt < this.debounceMs) return false
    if (now < this.coolingUntil) return false
    this.lastAt = now
    this.cooldownUntil(now)
    return true
  }

  private cooldownUntil(now: number): void {
    this.coolingUntil = now + this.cooldownMs
  }

  reset(): void {
    this.lastAt = 0
    this.coolingUntil = 0
  }
}

export class WakeWordService {
  private readonly modelDir: string
  private readonly events: WakeWordEvents
  private readonly policy = new WakeWordPolicy()
  private worker?: Worker
  private state: WakeState = 'disabled'
  private initTimer?: NodeJS.Timeout

  constructor(modelDir: string, events: WakeWordEvents) {
    this.modelDir = modelDir
    this.events = events
  }

  get currentState(): WakeState {
    return this.state
  }

  private setState(state: WakeState, detail?: string): void {
    if (this.state === state && !detail) return
    this.state = state
    this.events.onState(state, detail)
  }

  /**
   * 交付给 sherpa 之前的自检：缺文件或格式不对都直接报 unavailable。
   *
   * keywords.txt 必须逐行校验：它由 sherpa 的原生解析器读取，而那个解析器
   * **不支持注释**——一行 `#` 开头的注释会让它抛 C++ 异常并终止整个进程，
   * try/catch 拦不住。与其让 app 挂掉，不如在这里拦下来。
   *
   * 格式：`拼音token ... :boost #threshold @关键词`，与界面上显示的
   * WAKE_PHRASE 对应，改词要两边一起改。
   */
  private validateModelFiles(): string[] {
    const required = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt', 'keywords.txt']
    const problems = required
      .filter((name) => !fs.existsSync(path.join(this.modelDir, name)))
      .map((name) => `缺少 ${name}`)

    if (problems.length > 0) return problems

    const lines = fs
      .readFileSync(path.join(this.modelDir, 'keywords.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    if (lines.length === 0) problems.push('keywords.txt 是空的')
    for (const line of lines) {
      if (line.startsWith('#')) {
        problems.push('keywords.txt 不支持注释行（会导致原生解析器崩溃）')
        break
      }
      if (!line.includes(':') || !line.includes('#') || !line.includes('@')) {
        problems.push(`keywords.txt 格式不对: ${line.slice(0, 30)}`)
        break
      }
    }
    return problems
  }

  async start(): Promise<void> {
    if (this.state === 'listening' || this.state === 'starting') return

    const problems = this.validateModelFiles()
    if (problems.length > 0) {
      this.setState('unavailable', `唤醒词模型不可用: ${problems.join('; ')}`)
      return
    }

    this.setState('starting')
    this.policy.reset()

    const workerPath = path.join(__dirname, 'wake-word-worker.js')
    const worker = new Worker(workerPath, {
      workerData: {
        encoder: path.join(this.modelDir, 'encoder.int8.onnx'),
        decoder: path.join(this.modelDir, 'decoder.int8.onnx'),
        joiner: path.join(this.modelDir, 'joiner.int8.onnx'),
        tokens: path.join(this.modelDir, 'tokens.txt'),
        keywords: path.join(this.modelDir, 'keywords.txt')
      }
    })
    this.worker = worker

    // 加载模型是同步阻塞的，超时说明卡住了
    this.initTimer = setTimeout(() => {
      this.setState('error', '唤醒词模型加载超时')
      void this.stop()
    }, INIT_TIMEOUT_MS)

    worker.on('message', (message: { type: string; phrase?: string; detail?: string }) => {
      if (message.type === 'ready') {
        clearTimeout(this.initTimer)
        this.initTimer = undefined
        this.setState('listening')
        return
      }
      if (message.type === 'candidate') {
        if (this.state !== 'listening') return
        if (!this.policy.consider(Date.now())) return
        // 命中就暂停接收，等上层决定是进入会话还是继续待机
        this.setState('paused')
        worker.postMessage({ type: 'reset' })
        this.events.onDetected(message.phrase ?? '')
        return
      }
      if (message.type === 'unavailable') {
        clearTimeout(this.initTimer)
        this.initTimer = undefined
        this.setState('unavailable', message.detail)
        return
      }
      if (message.type === 'error') {
        this.setState('error', message.detail)
      }
    })

    worker.on('error', (error) => this.setState('error', error.message))
    worker.on('exit', (code) => {
      if (this.state !== 'disabled' && code !== 0) this.setState('error', `唤醒词进程退出 (${code})`)
    })
  }

  /** 暂停待机采集（进入正式会话前必须调，两路麦克风不能同时开）。 */
  pause(): void {
    if (this.state === 'listening' || this.state === 'starting') this.setState('paused')
  }

  /** 会话结束回到待机。 */
  resume(): void {
    if (this.state === 'paused') {
      this.policy.reset()
      this.worker?.postMessage({ type: 'reset' })
      this.setState('listening')
    }
  }

  /** 待机音频：只在本机做唤醒词检测，不上传。 */
  audio(samples: Float32Array): void {
    if (this.state !== 'listening') return
    // transferable 零拷贝；代价是这块 buffer 在调用方那边会失效
    this.worker?.postMessage({ type: 'audio', samples }, [samples.buffer as ArrayBuffer])
  }

  async stop(): Promise<void> {
    clearTimeout(this.initTimer)
    this.initTimer = undefined
    const worker = this.worker
    this.worker = undefined
    this.setState('disabled')
    if (worker) await worker.terminate().catch(() => undefined)
  }
}
