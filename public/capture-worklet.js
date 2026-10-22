/**
 * 采集 worklet：只做一件事——把每个音频块原样转给主线程。
 *
 * 刻意不在这里做重采样和分块：那些逻辑要能写单测，而 worklet 里的代码很难测。
 * 这里保持"哑"的，主线程就还能用 vitest 覆盖整条转换链路。
 *
 * AudioWorkletGlobalScope 里没有 window/import，只能用它自带的 registerProcessor。
 */
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel && channel.length > 0) {
      // 必须复制：这块 buffer 在下一个 process 调用时会被复用
      this.port.postMessage(new Float32Array(channel))
    }
    return true
  }
}

registerProcessor('capture-processor', CaptureProcessor)
