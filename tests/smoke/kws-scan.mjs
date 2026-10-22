/**
 * 手动 smoke：拿真实待机录音离线调唤醒词。
 *
 *   ANNIE_DUMP_WAKE=/tmp/wake-dump.f32 npm run dev      # 先在 app 里录一段
 *   node tests/smoke/kws-scan.mjs /tmp/wake-dump.f32 [threshold]
 *
 * 录音是 16k 单声道 f32（渲染层待机音频原样追加），和真实路径同一份数据。
 * 扫描用和线上一样的参数，所以"扫不到"就等于"线上也唤醒不了"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const dumpPath = process.argv[2] ?? '/tmp/wake-dump.f32'
const modelDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../resources/models/wake-word')

// 关键：sherpa 用 keywords.txt 里每行的 :score 和 #threshold，config 里的
// keywordsScore / keywordsThreshold 会被文件里的值覆盖。所以调参必须改文件，
// 改 config 是白改——线上 worker 里那两个值现在就是死的。
const KW_TOKENS = process.env.KW_TOKENS ?? 'n ǐ h ǎo ān n ī'
const score = process.env.KW_SCORE ?? '1.8'
const threshold = process.env.KW_THRESHOLD ?? '0.25'

const raw = fs.readFileSync(dumpPath)
const total = Math.floor(raw.byteLength / 4)
// 拷一份对齐的 Float32Array：Buffer 的 byteOffset 不保证 4 对齐，直接 new Float32Array(buffer) 会崩
const view = new Float32Array(total)
for (let i = 0; i < total; i++) view[i] = raw.readFloatLE(i * 4)

const CHUNK = 1600 // 100ms，和渲染层待机分块一致
const sampleRate = 16000
// 录音的"真实"采样率。KWS 假定 16k，若送进来的其实是别的速率，
// 用户的声音在它听来就是变速的，怎么都匹配不上——所以这个必须验。
const srcRate = Number(process.env.SRC_RATE ?? '16000')

// 每行格式：<tokens> :score #threshold @显示文本。
// USE_MODEL_KEYWORDS=1 时直接用仓库里那份，验证真实生效的文件——
// 用生成的文件只能验证参数，验证不了文件本身写对没有。
const modelKeywords = path.join(modelDir, 'keywords.txt')
const keywordsFile =
  process.env.USE_MODEL_KEYWORDS === '1'
    ? modelKeywords
    : path.join(os.tmpdir(), `kws-scan-${process.pid}.txt`)
if (process.env.USE_MODEL_KEYWORDS !== '1') {
  fs.writeFileSync(keywordsFile, `${KW_TOKENS} :${score} #${threshold} @你好安妮\n`)
}

// 参数来源要说清楚：用仓库文件时，生效的是文件里那行，不是这里的默认值
const source =
  process.env.USE_MODEL_KEYWORDS === '1'
    ? `${path.relative(process.cwd(), modelKeywords)} 里那一行`
    : `生成的文件 score=${score} threshold=${threshold}`
console.log(`录音 ${(total / sampleRate).toFixed(1)}s，${total} 样本；关键词「${KW_TOKENS}」，参数取自 ${source}`)

const sherpa = require('sherpa-onnx-node')
const spotter = new sherpa.KeywordSpotter({
  featConfig: { sampleRate, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(modelDir, 'encoder.int8.onnx'),
      decoder: path.join(modelDir, 'decoder.int8.onnx'),
      joiner: path.join(modelDir, 'joiner.int8.onnx')
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  },
  maxActivePaths: 4,
  // 连续这么多个空白帧就把关键词路径丢掉。太小的话，说「你好，安妮」
  // 中间那一下停顿会直接把路径判死，整句就再也不算命中。
  numTrailingBlanks: Number(process.env.NUM_TRAILING_BLANKS ?? '2'),
  keywordsScore: 1.8,
  keywordsThreshold: 0.25,
  keywordsFile
})

let stream = spotter.createStream()
const hits = []

for (let off = 0; off + CHUNK <= total; off += CHUNK) {
  const samples = view.subarray(off, off + CHUNK)
  stream.acceptWaveform({ samples, sampleRate: srcRate })
  while (spotter.isReady(stream)) spotter.decode(stream)
  const result = spotter.getResult(stream)
  if (result?.keyword) {
    hits.push({ at: off / sampleRate, keyword: result.keyword })
    stream = spotter.createStream() // 同线上：命中后换流，否则同一句会被反复报
  }
}

// 顺带报一下录音本身有多响，区分"没录到人说话"和"录到了但没命中"
let peak = 0
let loudChunks = 0
for (let off = 0; off + CHUNK <= total; off += CHUNK) {
  let p = 0
  for (let i = off; i < off + CHUNK; i++) p = Math.max(p, Math.abs(view[i]))
  peak = Math.max(peak, p)
  if (p > 0.1) loudChunks += 1
}

// 说话段：用来算「分母」——你一共说了几段，命中了其中几段。
// 只看命中数没法判断好坏：命中 1 次，可能是说了 20 次里的 1 次，也可能只说了 1 次。
const segments = []
let current = null
for (let off = 0; off + CHUNK <= total; off += CHUNK) {
  let p = 0
  for (let i = off; i < off + CHUNK; i++) p = Math.max(p, Math.abs(view[i]))
  const at = off / sampleRate
  if (p > 0.1) {
    if (current) current.end = at + 0.1
    else current = { start: at, end: at + 0.1 }
  } else if (current && at - current.end > 0.4) {
    // 静音超过 0.4s 才算这段说完
    segments.push(current)
    current = null
  }
}
if (current) segments.push(current)

console.log(`峰值 ${peak.toFixed(3)}；说话段 ${segments.length} 个（共约 ${(loudChunks * 0.1).toFixed(1)}s）`)
console.log(`命中 ${hits.length} 次`)
const nearMiss = new Set()
for (const hit of hits) {
  console.log(`  ${hit.at.toFixed(1)}s  ${hit.keyword}`)
  for (const seg of segments) if (hit.at >= seg.start - 1 && hit.at <= seg.end + 1) nearMiss.add(seg.start)
}
console.log(`命中覆盖了 ${nearMiss.size}/${segments.length} 个说话段`)
if (keywordsFile !== modelKeywords) fs.rmSync(keywordsFile, { force: true })
