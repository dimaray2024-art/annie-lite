/**
 * 手动 smoke：证明「播报会吃掉工具那一轮的回复」，别再把播报加回去。
 *
 * 跑法（需要真 key 和一段真实提问音频 /tmp/q.pcm，见 README 里的造法）：
 *   KEEP_UPLINK=1 VARIANT=plain    DOUBAO_KEY=... node doubao-tool-repro.mjs   # 模型接话
 *   KEEP_UPLINK=1 VARIANT=announce DOUBAO_KEY=... node doubao-tool-repro.mjs   # 模型不接话
 *
 * 两个变体只差一处：回传工具结果前有没有插一句 speech_text_buffer 播报。
 * 服务端会把播报合成成一整轮独立 response（tts_type=chat_tts_text），
 * 这一轮里回传的工具结果就再也不会让模型开口。
 * 顺序、延迟到 response.done 之后再发、换 item 形状、换 replacement 变体——都救不回来。
 *
 * KEEP_UPLINK=1 也是必须的：上行一停，工具回传后模型同样不接话。
 * 官方 demo 有一个 while True 补静音帧就是为这个。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import WebSocket from 'ws'

const KEY = process.env.DOUBAO_KEY
const VARIANT = process.env.VARIANT ?? 'plain'
const PCM = fs.readFileSync('/tmp/q.pcm')
const INPUT_CHUNK = 640

const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', {
  headers: { 'X-Api-Key': KEY },
  handshakeTimeout: 15000
})

let seq = 0
const nextId = () => `event_${++seq}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

let audioFrames = 0
let toolAnswered = false
let pendingSubmit = null
let framesAfterTool = 0
let toolResultAt = 0

function send(obj) {
  if (obj.type !== 'input_audio_buffer.append') {
    const brief = JSON.stringify(obj)
    log('UP  ', obj.type, brief.length > 240 ? `${brief.slice(0, 240)}…` : brief)
  }
  ws.send(JSON.stringify(obj))
}

ws.on('open', () => {
  log('open, variant =', VARIANT)
  send({
    type: 'session.create',
    event_id: nextId(),
    session: {
      id: crypto.randomUUID(),
      model: '1.2.6.1',
      instructions: '你叫安妮。涉及本机内容的问题必须调用工具查看，不能凭空回答。用口语简短回答。',
      audio: {
        input: { format: { type: 'pcm', rate: 16000 } },
        output: {
          format: { type: process.env.OUT_FORMAT ?? 'pcm', rate: 24000 },
          voice: 'zh_female_xiaohe_jupiter_bigtts'
        }
      },
      tools: [
        {
          type: 'function',
          name: 'list_directory',
          description: '列出一个目录里的内容。需要知道某个文件夹里有什么时调用。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '目录的绝对路径' } },
            required: ['path']
          }
        }
      ]
    },
    // 原样照搬官方 demo 的 extension：我们只发了 enable_loudness_norm，
    // 先排除"少发的字段里有开关"这个可能
    extension: {
      asr: { extra: {} },
      tts: { extra: {} },
      dialog: {
        location: {
          longitude: 114.305556,
          latitude: 22.62,
          city: '深圳',
          country: '中国',
          province: '广东省',
          district: '南山区',
          town: '深圳',
          country_code: 'CN',
          address: '中国深圳市南山区'
        },
        extra: {
          audit_response: '抱歉，这个问题我无法回答，你可以换个其他话题，我会尽力为你提供帮助。',
          enable_loudness_norm: true,
          enable_music: false
        }
      }
    }
  })
})

ws.on('message', (buf) => {
  let frame
  try {
    frame = JSON.parse(buf.toString())
  } catch {
    log('DOWN 无法解析')
    return
  }
  const t = frame.type

  if (t === 'response.output_audio.delta') {
    audioFrames += 1
    if (toolResultAt) framesAfterTool += 1
    return
  }
  if (t === 'conversation.item.input_audio_transcription.delta') return

  log('DOWN', t, JSON.stringify({ ...frame, delta: undefined }).slice(0, 320))

  if (t === 'session.created') void askQuestion()

  if (t === 'response.function_call_arguments.done' && !toolAnswered) {
    toolAnswered = true
    const items = Array.isArray(frame.items) ? frame.items : []
    log('  >>> 收到工具调用: ' + JSON.stringify(items))

    const announce = () => {
      const speechId = crypto.randomUUID()
      // replacement 是 demo 用来"插话改口"的，语义上更像替换当前回复而不是自己占一轮
      const prefix = process.env.ANNOUNCE_STYLE === 'replacement' ? 'speech_text_buffer.replacement' : 'speech_text_buffer'
      send({ type: `${prefix}.append`, event_id: nextId(), speech_id: speechId, text: '我看一下。' })
      send({ type: `${prefix}.commit`, event_id: nextId(), speech_id: speechId, text: '' })
    }
    if (VARIANT === 'announce' && process.env.ANNOUNCE_MODE !== 'after') announce()

    const submit = () => {
      // 两种 item 形状都试：官方 demo 用 message/role=tool，
      // OpenAI Realtime 规范用 function_call_output
      const output = '下载目录里有 12 项，其中 3 个是安装包'
      const items2 =
        process.env.ITEM_SHAPE === 'function_call_output'
          ? items.map((item) => ({ type: 'function_call_output', call_id: item.call_id, output }))
          : items.map((item) => ({
              type: 'message',
              role: 'tool',
              call_id: item.call_id,
              content: [{ type: 'input_text', text: output }]
            }))
      send({ type: 'conversation.item.create', event_id: nextId(), items: items2 })
      log('  >>> 工具结果已回传', `item 形状=${process.env.ITEM_SHAPE ?? 'message'}`)

      if (process.env.SEND_CREATE === '1') {
        send({ type: 'response.create', event_id: nextId() })
        log('  >>> 已补发 response.create')
      }
      toolResultAt = Date.now()

      if (VARIANT === 'announce' && process.env.ANNOUNCE_MODE === 'after') {
        log('  >>> 结果已回传，现在播报')
        announce()
      }
    }

    // 模拟"用户看确认对话框花了很久"。回传太晚的话模型可能就不接话了——
    // 这条决定破坏性工具的确认流程还能不能靠模型播报结果。
    const delay = Number(process.env.DELAY_MS ?? '0')
    if (delay > 0) {
      log(`  >>> 先等 ${delay}ms 再回传（模拟用户在看确认对话框）`)
      setTimeout(submit, delay)
      return
    }

    // 推迟到播报那一轮 response.done 之后再回传，避免和播报撞进同一轮
    if (process.env.ANNOUNCE_MODE === 'defer') {
      pendingSubmit = submit
      log('  >>> 工具结果待发：等播报的 response.done')
    } else {
      submit()
    }
  }

  // 播报那一轮的结束信号：在这里把工具结果补上
  if (t === 'response.done' && pendingSubmit) {
    const go = pendingSubmit
    pendingSubmit = undefined
    log('  >>> 播报这一轮结束了，现在回传工具结果')
    go()
  }

  if (t === 'response.output_audio.done') {
    log(`  >>> 本轮音频 ${audioFrames} 帧${toolResultAt ? `（其中工具回传后 ${framesAfterTool} 帧）` : ''}`)
    audioFrames = 0
  }
})

ws.on('error', (e) => log('ERR', e.message))
ws.on('close', (c) => log('close', c))

async function askQuestion() {
  log('开始上行提问音频', PCM.length, 'bytes')
  for (let off = 0; off + INPUT_CHUNK <= PCM.length; off += INPUT_CHUNK) {
    send({ type: 'input_audio_buffer.append', audio: PCM.subarray(off, off + INPUT_CHUNK).toString('base64') })
    await sleep(20)
  }
  // 尾随静音：服务端靠 VAD 判「说完了」。音频一停就收尾的话它等不到这句，
  // 表现是转写只 started 不 completed，整轮用户输入根本不成句
  const silence = Buffer.alloc(INPUT_CHUNK)
  for (let i = 0; i < 75; i++) {
    send({ type: 'input_audio_buffer.append', audio: silence.toString('base64') })
    await sleep(20)
  }
  log('提问音频发完，继续持续上行静音')

  // 关键：官方 demo 放完音频文件后不会停上行，永远以 20ms 节奏补静音。
  // 上行一停，服务端在工具回传之后就不再生成下一轮回复。
  if (process.env.KEEP_UPLINK === '1') {
    while (true) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence.toString('base64') }))
      await sleep(20)
    }
  }
  log('上行结束（含 1.5 秒尾随静音）')
}

setTimeout(() => {
  log('=== 结论 ===')
  log('工具回传后的音频帧数:', framesAfterTool)
  log(framesAfterTool > 0 ? '模型接话了' : '模型没有接话 —— 复现')
  process.exit(0)
}, 25_000)
