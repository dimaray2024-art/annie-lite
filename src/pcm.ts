/**
 * 实时音频的三件套。这三块看起来啰嗦，但每一处都是踩出来的：
 *
 * 1. 流式解码：豆包把 float32 音频切在任意字节边界上，**一个样本可能跨两个消息**。
 *    按固定 4 字节切会在边界处拿到垃圾数据，听感是每几个字一次"咔"。
 * 2. 抖动缓冲：网络消息到达不均匀（有时 0 字节、有时几百毫秒一次），
 *    直接播会在抖动处断续。先攒一段再按固定块吐，抖动就被吸收掉了。
 * 3. 播放闸门：打断时服务端已经发出的音频仍会到达，如果不拦，被取消的那句话会接着播完。
 */

/** 把 base64 的 float32 LE 字节流解成样本，自动处理跨消息的半个样本。 */
export class PcmFloat32LeStreamDecoder {
  private remainder = new Uint8Array(0)

  push(bytes: Uint8Array): Float32Array {
    const merged = new Uint8Array(this.remainder.length + bytes.length)
    merged.set(this.remainder, 0)
    merged.set(bytes, this.remainder.length)

    // 只处理完整的 4 字节样本，剩下的留到下一个消息
    const usableBytes = merged.length - (merged.length % 4)
    const remainder = merged.subarray(usableBytes)
    this.remainder = new Uint8Array(remainder) // 复制，避免持有整个 merged 的引用

    const sampleCount = usableBytes / 4
    const samples = new Float32Array(sampleCount)
    const view = new DataView(merged.buffer, merged.byteOffset, usableBytes)
    for (let i = 0; i < sampleCount; i += 1) {
      const value = view.getFloat32(i * 4, true)
      // NaN/Infinity 会让后续的 AudioBuffer 复制变成噪声，直接归零
      samples[i] = Number.isFinite(value) ? value : 0
    }
    return samples
  }

  reset(): void {
    this.remainder = new Uint8Array(0)
  }
}

export interface JitterBufferOptions {
  /** 攒够这么多样本才开始吐，用来吸收网络抖动。 */
  prebufferSamples: number
  /** 每次吐出多少个样本。 */
  blockSamples: number
}

export class PcmJitterBuffer {
  private readonly options: JitterBufferOptions
  private queue: Float32Array[] = []
  private queuedSamples = 0
  private primed = false

  constructor(options: JitterBufferOptions) {
    this.options = options
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return
    this.queue.push(samples)
    this.queuedSamples += samples.length
  }

  /** 取一个满块；未达到 prebuffer 阈值或不足一块时返回 null。 */
  take(): Float32Array | null {
    if (!this.primed) {
      if (this.queuedSamples < this.options.prebufferSamples) return null
      this.primed = true
    }
    if (this.queuedSamples < this.options.blockSamples) return null

    const block = new Float32Array(this.options.blockSamples)
    let filled = 0
    while (filled < block.length && this.queue.length > 0) {
      const head = this.queue[0]!
      const need = block.length - filled
      if (head.length <= need) {
        block.set(head, filled)
        filled += head.length
        this.queue.shift()
        this.queuedSamples -= head.length
      } else {
        block.set(head.subarray(0, need), filled)
        this.queue[0] = head.subarray(need)
        this.queuedSamples -= need
        filled += need
      }
    }
    return block
  }

  /** 音频结束时把残块吐出来，否则最后一个短音节会被丢掉。 */
  flush(): Float32Array | null {
    if (this.queuedSamples === 0) return null
    const block = new Float32Array(this.queuedSamples)
    let offset = 0
    for (const chunk of this.queue) {
      block.set(chunk, offset)
      offset += chunk.length
    }
    this.reset()
    return block
  }

  get bufferedSamples(): number {
    return this.queuedSamples
  }

  reset(): void {
    this.queue = []
    this.queuedSamples = 0
    this.primed = false
  }
}

/**
 * 决定一段音频该不该播。
 *
 * 打断之后服务端已经发出的音频仍然会到达，所以按 responseId 把它们拦掉。
 * 但豆包有些音频消息**不带 responseId**，这时只能用"取消过就一直拦到下一个响应开始"
 * 这种粗略办法——不这么做的话，被取消的那句话会从中间接着播出来。
 */
export class RealtimePlaybackGate {
  private activeResponseId: string | undefined
  private readonly cancelled = new Set<string>()
  private blockUnidentified = false

  accept(responseId?: string): boolean {
    if (responseId) {
      if (this.cancelled.has(responseId)) return false
      this.activeResponseId = responseId
      return true
    }
    if (this.blockUnidentified) return false
    this.activeResponseId = undefined
    return true
  }

  /** 打断：把当前响应标记为已取消；不知道 id 时退化为拦截所有无 id 的音频。 */
  cancelActive(responseId?: string): void {
    const target = responseId ?? this.activeResponseId
    if (target) this.cancelled.add(target)
    else this.blockUnidentified = true
    this.activeResponseId = undefined
  }

  /** 一个响应正常结束，可以忘掉它的取消记录了（否则集合会一直涨）。 */
  finish(responseId?: string): void {
    if (responseId) {
      this.cancelled.delete(responseId)
    } else {
      this.blockUnidentified = false
    }
    if (this.activeResponseId === responseId) this.activeResponseId = undefined
  }

  reset(): void {
    this.activeResponseId = undefined
    this.cancelled.clear()
    this.blockUnidentified = false
  }
}

/**
 * 流式重采样。必须能"喂多少处理多少"——采集回调每 128 帧就来一次，
 * 而重采样后可能连一个输出样本都凑不齐，剩下的要留到下一次。
 *
 * 之前这里出过一个很隐蔽的 bug：每个 128 帧的块重采样后只有 42 个样本，
 * 而一块上行需要 320 个，于是永远凑不满、一个字节都没发出去；
 * 同时成功路径忘了推进 carry，样本被静默丢弃。表现是"说话完全没反应"。
 */
export class PcmResampler {
  private readonly inputRate: number
  private readonly outputRate: number
  private carry = new Float32Array(0)
  /** 上一次读到输入数组里的小数位置，跨块必须保留，否则每次都会漏掉不足一步的尾巴。 */
  private phase = 0

  constructor(inputRate: number, outputRate: number) {
    this.inputRate = inputRate
    this.outputRate = outputRate
  }

  push(block: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return block

    const input = new Float32Array(this.carry.length + block.length)
    input.set(this.carry, 0)
    input.set(block, this.carry.length)

    const step = this.inputRate / this.outputRate
    const output: number[] = []
    let position = this.phase
    while (position + 1 < input.length) {
      const index = Math.floor(position)
      const fraction = position - index
      const a = input[index]!
      const b = input[index + 1]!
      output.push(a + (b - a) * fraction)
      position += step
    }

    // 别让 consumed 越过数组末尾：position 在循环退出时可能已经超出，
    // 而尾部那个样本正是下一次插值要用的，丢掉它会让后续输出的位置整体错开
    const consumed = Math.min(Math.floor(position), Math.max(0, input.length - 1))
    this.carry = input.slice(consumed)
    this.phase = position - consumed
    return Float32Array.from(output)
  }

  reset(): void {
    this.carry = new Float32Array(0)
    this.phase = 0
  }
}

/**
 * 把连续的 float32 样本切成固定大小、转成 int16 的块。
 * 上行要求恰好 640 字节 = 320 个样本，多一个少一个服务端都会报错。
 */
export class Float32Chunker {
  private readonly samplesPerChunk: number
  private carry = new Float32Array(0)

  constructor(samplesPerChunk: number) {
    this.samplesPerChunk = samplesPerChunk
  }

  push(samples: Float32Array): Int16Array<ArrayBuffer>[] {
    if (samples.length > 0) {
      const merged = new Float32Array(this.carry.length + samples.length)
      merged.set(this.carry, 0)
      merged.set(samples, this.carry.length)
      this.carry = merged
    }

    const chunks: Int16Array<ArrayBuffer>[] = []
    let offset = 0
    while (this.carry.length - offset >= this.samplesPerChunk) {
      const chunk = new Int16Array(this.samplesPerChunk)
      for (let i = 0; i < this.samplesPerChunk; i += 1) {
        const sample = this.carry[offset + i]!
        const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample
        chunk[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      }
      chunks.push(chunk)
      offset += this.samplesPerChunk
    }
    this.carry = this.carry.slice(offset)
    return chunks
  }

  get pendingSamples(): number {
    return this.carry.length
  }

  reset(): void {
    this.carry = new Float32Array(0)
  }
}
