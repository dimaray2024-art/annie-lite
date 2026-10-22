import { describe, expect, it } from 'vitest'
import {
  Float32Chunker,
  PcmFloat32LeStreamDecoder,
  PcmJitterBuffer,
  PcmResampler,
  RealtimePlaybackGate
} from '../src/pcm'

function float32Le(values: number[]): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 4)
  const view = new DataView(buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return new Uint8Array(buffer)
}

describe('PcmFloat32LeStreamDecoder', () => {
  it('一个消息里含完整样本时直接解出', () => {
    const decoder = new PcmFloat32LeStreamDecoder()
    expect(Array.from(decoder.push(float32Le([0.5, -0.25])))).toEqual([0.5, -0.25])
  })

  it('样本被切在两个消息之间时，边界样本仍然正确', () => {
    const decoder = new PcmFloat32LeStreamDecoder()
    const all = float32Le([1.5, -2.5, 0.125])

    // 第一个消息只有 6 字节：第 2 个样本被切成两半
    const first = decoder.push(all.subarray(0, 6))
    const second = decoder.push(all.subarray(6))

    // 第一个样本必须正确；被切开的样本不能当作有效数据吐出来
    expect(Array.from(first)).toEqual([1.5])
    expect(Array.from(second)).toEqual([-2.5, 0.125])
  })

  it('逐字节喂入也能还原', () => {
    const decoder = new PcmFloat32LeStreamDecoder()
    const all = float32Le([0.75, -0.5])
    const out: number[] = []
    for (const byte of all) out.push(...decoder.push(new Uint8Array([byte])))
    expect(out).toEqual([0.75, -0.5])
  })

  it('NaN 与 Infinity 归零，避免污染后续播放', () => {
    const decoder = new PcmFloat32LeStreamDecoder()
    expect(Array.from(decoder.push(float32Le([Number.NaN, Number.POSITIVE_INFINITY, 0.5])))).toEqual([0, 0, 0.5])
  })

  it('reset 丢弃残留的半个样本', () => {
    const decoder = new PcmFloat32LeStreamDecoder()
    decoder.push(float32Le([1, 2]).subarray(0, 3))
    decoder.reset()
    expect(Array.from(decoder.push(float32Le([9])))).toEqual([9])
  })
})

describe('PcmJitterBuffer', () => {
  const options = { prebufferSamples: 10, blockSamples: 4 }

  it('未攒够 prebuffer 时不吐块', () => {
    const buffer = new PcmJitterBuffer(options)
    buffer.push(new Float32Array(6))
    expect(buffer.take()).toBeNull()
  })

  it('攒够后按固定块吐出，且样本顺序不变', () => {
    const buffer = new PcmJitterBuffer(options)
    buffer.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))

    expect(Array.from(buffer.take()!)).toEqual([1, 2, 3, 4])
    expect(Array.from(buffer.take()!)).toEqual([5, 6, 7, 8])
    expect(Array.from(buffer.take()!)).toEqual([9, 10, 11, 12])
    expect(buffer.take()).toBeNull()
  })

  it('跨 push 的碎片会被拼成完整的块', () => {
    const buffer = new PcmJitterBuffer(options)
    buffer.push(Float32Array.from([1, 2, 3, 4, 5, 6]))
    buffer.push(Float32Array.from([7, 8, 9, 10]))

    expect(Array.from(buffer.take()!)).toEqual([1, 2, 3, 4])
    expect(Array.from(buffer.take()!)).toEqual([5, 6, 7, 8])
    // 只剩 2 个样本，不够一块，等 flush
    expect(buffer.take()).toBeNull()
    expect(Array.from(buffer.flush()!)).toEqual([9, 10])
  })

  it('flush 吐出不足一块的尾巴', () => {
    const buffer = new PcmJitterBuffer(options)
    buffer.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    buffer.take()
    buffer.take()

    expect(Array.from(buffer.flush()!)).toEqual([9, 10])
    expect(buffer.flush()).toBeNull()
  })
})

describe('RealtimePlaybackGate', () => {
  it('正常响应一路放行', () => {
    const gate = new RealtimePlaybackGate()
    expect(gate.accept('r1')).toBe(true)
    expect(gate.accept('r1')).toBe(true)
  })

  it('取消后，该响应的后续音频被拒', () => {
    const gate = new RealtimePlaybackGate()
    gate.accept('r1')
    gate.cancelActive()
    expect(gate.accept('r1')).toBe(false)
  })

  it('无 responseId 时，取消后拦掉所有无 id 的音频', () => {
    const gate = new RealtimePlaybackGate()
    gate.cancelActive()
    expect(gate.accept(undefined)).toBe(false)
    expect(gate.accept('r2')).toBe(true)
  })

  it('取消一个带 id 的响应，不会误伤其他响应', () => {
    const gate = new RealtimePlaybackGate()
    gate.accept('r1')
    gate.cancelActive()
    expect(gate.accept('r2')).toBe(true)
  })

  it('finish 之后取消记录被清掉，集合不会无限增长', () => {
    const gate = new RealtimePlaybackGate()
    gate.accept('r1')
    gate.cancelActive()
    gate.finish('r1')
    // 同一个 id 复用（服务端可能重用编号）时不该被永久拦住
    expect(gate.accept('r1')).toBe(true)
  })

  it('reset 清空全部状态', () => {
    const gate = new RealtimePlaybackGate()
    gate.cancelActive()
    gate.reset()
    expect(gate.accept(undefined)).toBe(true)
  })
})

describe('PcmResampler', () => {
  /** 生成一段正弦波，用来验证重采样后的样本确实落在正确位置。 */
  function sine(freq: number, rate: number, length: number): Float32Array {
    const out = new Float32Array(length)
    for (let i = 0; i < length; i += 1) out[i] = Math.sin((2 * Math.PI * freq * i) / rate)
    return out
  }

  it('48k → 16k 输出长度约为输入的三分之一', () => {
    const resampler = new PcmResampler(48000, 16000)
    const out = resampler.push(sine(1000, 48000, 4800))
    expect(out.length).toBeGreaterThanOrEqual(1599)
    expect(out.length).toBeLessThanOrEqual(1600)
  })

  it('分块喂入与整块喂入得到的输出样本一致', () => {
    const whole = new PcmResampler(48000, 16000)
    const wholeOut = whole.push(sine(440, 48000, 4800))

    const split = new PcmResampler(48000, 16000)
    const parts: number[] = []
    const input = sine(440, 48000, 4800)
    for (let offset = 0; offset < input.length; offset += 128) {
      parts.push(...split.push(input.slice(offset, offset + 128)))
    }

    // 严格相等：跨块既不能丢样本，也不能重复。
    // 这条断言抓出过一个真实 bug——循环退出时 position 越过数组末尾，
    // 把下一次插值要用的尾部样本一起丢了，于是每块都错开一点、总量还多出来
    expect(parts.length).toBe(wholeOut.length)
    for (let i = 0; i < wholeOut.length; i += 1) {
      expect(parts[i]).toBeCloseTo(wholeOut[i]!, 5)
    }
  })

  it('采样率相同时原样返回', () => {
    const resampler = new PcmResampler(16000, 16000)
    const input = sine(440, 16000, 320)
    expect(resampler.push(input)).toBe(input)
  })
})

describe('Float32Chunker', () => {
  it('攒够一块才吐出，长度精确', () => {
    const chunker = new Float32Chunker(320)
    expect(chunker.push(new Float32Array(200))).toHaveLength(0)
    expect(chunker.pendingSamples).toBe(200)

    const chunks = chunker.push(new Float32Array(200))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.length).toBe(320)
    expect(chunks[0]!.buffer.byteLength).toBe(640) // 上行协议要求的固定长度
    expect(chunker.pendingSamples).toBe(80)
  })

  it('一次喂入很多样本会切出多块', () => {
    const chunker = new Float32Chunker(320)
    expect(chunker.push(new Float32Array(1000))).toHaveLength(3)
  })

  it('超出 [-1,1] 的样本被限幅，不会回绕成噪声', () => {
    const chunker = new Float32Chunker(2)
    const chunks = chunker.push(Float32Array.from([2, -2]))
    expect(Array.from(chunks[0]!)).toEqual([32767, -32768])
  })

  // 这就是实际踩到的 bug：采集块重采样后只有 42 个样本，
  // 如果按"每次回调必须凑满一块"来写，就永远发不出任何音频。
  it('小块反复喂入最终也能凑出完整的一块', () => {
    const chunker = new Float32Chunker(320)
    let produced = 0
    for (let i = 0; i < 30; i += 1) produced += chunker.push(new Float32Array(42)).length
    expect(produced).toBe(3) // 30 × 42 = 1260 ≈ 3 块
  })
})
