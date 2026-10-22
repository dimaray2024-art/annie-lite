/**
 * 唤醒词检测 worker。
 *
 * 跑在 worker_threads 里（不是 utilityProcess）——原生模块在 worker 线程里加载正常，
 * 而且它把 sherpa 那个没有类型声明、会阻塞的原生边界关在了主进程之外：
 * 检测是 CPU 密集的，放主线程会卡住界面。
 *
 * `sherpa-onnx-node` 没有 TS 类型，所以这里用 require，并且只和外面交换校验过的简单消息。
 */

import { parentPort, workerData } from 'node:worker_threads'

interface ModelFiles {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
  keywords: string
}

interface SpotterLike {
  createStream(): StreamLike
  isReady(stream: StreamLike): boolean
  decode(stream: StreamLike): void
  getResult(stream: StreamLike): { keyword?: string }
}

interface StreamLike {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
}

const files = workerData as ModelFiles

// sherpa-onnx-node 无类型声明；用 require 把它挡在类型系统之外
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sherpa = require('sherpa-onnx-node') as { KeywordSpotter: new (config: unknown) => SpotterLike }

let spotter: SpotterLike
let stream: StreamLike

try {
  spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0
    },
    maxActivePaths: 4,
    numTrailingBlanks: 2,
    // 下面这两个值**不起作用**：keywords.txt 每行末尾的 :score 和 #threshold
    // 会覆盖它们。调参必须改那个文件，改这里是白改（实测：把阈值从 0.25 一路
    // 调到 0.01，命中数一个没变；改文件才动）。
    // 留着是为了配置完整，值刻意与文件里的保持一致，免得读代码的人被误导。
    keywordsScore: 2.4,
    keywordsThreshold: 0.1,
    keywordsFile: files.keywords
  })
  stream = spotter.createStream()
  parentPort?.postMessage({ type: 'ready' })
} catch (error) {
  parentPort?.postMessage({
    type: 'unavailable',
    detail: error instanceof Error ? error.message : String(error)
  })
}

/** 命中后换一条新流：否则同一句话会被反复识别出来。 */
function resetStream(): void {
  try {
    stream = spotter.createStream()
  } catch {
    // 初始化失败时 stream 可能不存在，忽略
  }
}

parentPort?.on('message', (message: { type: string; samples?: Float32Array }) => {
  if (!spotter || !stream) return

  if (message.type === 'reset') {
    resetStream()
    return
  }
  if (message.type !== 'audio' || !message.samples) return

  const samples = message.samples
  // 上游已经校验过，这里再挡一道：原生层崩掉的代价是整个 worker 没了
  if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > 8000) return

  try {
    stream.acceptWaveform({ samples, sampleRate: 16000 })
    while (spotter.isReady(stream)) spotter.decode(stream)
    const result = spotter.getResult(stream)
    if (result.keyword) {
      parentPort?.postMessage({ type: 'candidate', phrase: result.keyword })
      resetStream()
    }
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
})
