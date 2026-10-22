/**
 * 手动 smoke：证明 conversation.item.create 单独发不会让模型开口。
 *
 *   MODE=user|tool DOUBAO_KEY=... node doubao-inject-probe.mjs
 *
 * 两种 role 都不触发回复。这个接口只在「回答一个待处理的工具调用」时
 * 才生成下一轮——所以「往会话里塞一条消息让安妮说句话」这条路走不通。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import WebSocket from 'ws'

const KEY = process.env.DOUBAO_KEY
const PCM = fs.readFileSync('/tmp/q.pcm')
const INPUT_CHUNK = 640
const MODE = process.env.MODE ?? 'user'

const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', {
  headers: { 'X-Api-Key': KEY },
  handshakeTimeout: 15000
})

let seq = 0
const nextId = () => `event_${++seq}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

let audioFrames = 0
let afterProbe = 0
let probeAt = 0
let probed = false

function send(obj) {
  if (obj.type !== 'input_audio_buffer.append') log('UP  ', obj.type, JSON.stringify(obj).slice(0, 200))
  ws.send(JSON.stringify(obj))
}

ws.on('open', () => {
  send({
    type: 'session.create',
    event_id: nextId(),
    session: {
      id: crypto.randomUUID(),
      model: '1.2.6.1',
      instructions: '你叫安妮，是用户的私人语音助手。用口语简短回答。',
      audio: {
        input: { format: { type: 'pcm', rate: 16000 } },
        output: { format: { type: 'pcm', rate: 24000 }, voice: 'zh_female_xiaohe_jupiter_bigtts' }
      },
      tools: []
    },
    extension: { asr: { extra: {} }, tts: { extra: {} }, dialog: { extra: { enable_loudness_norm: true } } }
  })
})

ws.on('message', (buf) => {
  let frame
  try {
    frame = JSON.parse(buf.toString())
  } catch {
    return
  }
  const t = frame.type

  if (t === 'response.output_audio.delta') {
    audioFrames += 1
    if (probeAt) afterProbe += 1
    return
  }
  if (t === 'conversation.item.input_audio_transcription.delta') return

  log('DOWN', t, JSON.stringify({ ...frame, delta: undefined }).slice(0, 260))

  if (t === 'session.created') void askQuestion()

  // 用户提问那一轮结束后，注入一条文本消息，看模型接不接
  if (t === 'response.done' && !probed) {
    probed = true
    probeAt = Date.now()
    log(`  >>> 注入一条 role=${MODE} 的文本消息`)
    send({
      type: 'conversation.item.create',
      event_id: nextId(),
      items: [
        {
          type: 'message',
          role: MODE,
          content: [{ type: 'input_text', text: '下载文件夹里一共有 12 项，其中 3 个是安装包。' }]
        }
      ]
    })
  }

  if (t === 'response.output_audio.done') {
    log(`  >>> 本轮音频 ${audioFrames} 帧${probeAt ? `（注入后 ${afterProbe} 帧）` : ''}`)
    audioFrames = 0
  }
})

ws.on('error', (e) => log('ERR', e.message))

async function askQuestion() {
  for (let off = 0; off + INPUT_CHUNK <= PCM.length; off += INPUT_CHUNK) {
    send({ type: 'input_audio_buffer.append', audio: PCM.subarray(off, off + INPUT_CHUNK).toString('base64') })
    await sleep(20)
  }
  const silence = Buffer.alloc(INPUT_CHUNK)
  while (true) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence.toString('base64') }))
    await sleep(20)
  }
}

setTimeout(() => {
  log('=== 结论 ===')
  log('注入之后的音频帧数:', afterProbe)
  log(afterProbe > 0 ? '模型接话了' : '模型没接话')
  process.exit(0)
}, 28_000)
