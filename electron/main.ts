/**
 * 主进程入口：只负责装配。业务逻辑都在 electron/ 下的各个模块里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { CH, EVENT_CHANNEL, type TaskSummary, type VoiceEvent } from '@shared/contract'
import { assertSender, emptyArgs, handleInvoke, openExternalUrl } from './ipc'
import { Notification } from 'electron'
import { SettingsStore } from './settings'
import { resolvePiRuntime, type PiRuntime } from './runtime'
import { initLog, log } from './log'
import { SecretStore } from './secrets'
import { SafePathService } from './files'
import { MemoryService } from './memory'
import { ensureTaskDir, TaskService } from './tasks/service'
import { SchedulerService, type ScheduledJob } from './schedule'
import { ReminderService } from './reminders'
import { spawn } from 'node:child_process'
import { ConfirmationService } from './voice/confirmation'
import { VoiceSession } from './voice/session'
import type { ToolCall, ToolDefinition } from './voice/tool-registry'
import { buildToolRegistry, describeTools } from './voice/tools'
import { WakeWordService } from './wake-word'
import { buildInstructions } from './voice/instructions'
import { createViduLiveSession } from './vidu'

app.setName('annie-lite')

/**
 * 单实例。
 *
 * 不做这个的话，双击两次（或者开发时 dev 还开着又双击了打包产物）就会有两个安妮：
 * 两边同时开麦，唤醒词互相抢音频；定时任务也会各跑一遍，同一份知识库被整理两次。
 * 拿不到锁说明已经有一个在跑，直接退出，把已有窗口叫到前面来。
 */
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

/** 待机音频一片 = 1600 个 float32 = 6400 字节。 */
const WAKE_CHUNK_BYTES = 1600 * 4

/**
 * 调唤醒词用的开关：ANNIE_DUMP_WAKE=/tmp/wake.f32 会把待机音频原样落盘。
 * 唤醒词不灵时，拿真实录音离线跑模型，比在界面上反复试快得多。
 */
const WAKE_DUMP_PATH = process.env.ANNIE_DUMP_WAKE
let wakeDump: fs.WriteStream | undefined
let wakeChunkCount = 0
let wakePeak = 0

let mainWindow: BrowserWindow | undefined
let settings: SettingsStore
let secrets: SecretStore
let piRuntime: PiRuntime | undefined
let piError: string | undefined
let voiceSession: VoiceSession
let wakeWord: WakeWordService
let tasks: TaskService
/** 对话记录。没有配知识库时是 undefined，此时不记。 */
let conversation: MemoryService | undefined
/** 一次会话一个：会话结束时"一直允许"的授权要跟着作废。 */
let confirmations: ConfirmationService | undefined
/** 知识库的定时维护。没有 pi 或没配知识库时不启动。 */
let scheduler: SchedulerService | undefined
let reminders: ReminderService | undefined

const getWindow = (): BrowserWindow | undefined => mainWindow

let uplinkChunks = 0

let audioFrames = 0

function emit(event: VoiceEvent): void {
  // 音频帧每秒几十条，只记"开始/结束"，否则日志会被淹掉
  if (event.type === 'response_audio') {
    audioFrames += 1
    if (event.final) {
      log('voice', `音频段结束，本轮共 ${audioFrames} 帧`)
      audioFrames = 0
    } else if (audioFrames === 1) {
      log('voice', `收到首帧音频 (${event.audioBase64.length} 字符 base64, ${event.sampleRate}Hz)`)
    }
  } else if (event.type === 'input_transcript' && event.final) {
    // 记原话。只记定稿的那一次——流式过程里它会来回改，
    // 每次都记会把一句话记成十几行
    conversation?.recordTurn('user', event.text)
  } else if (event.type === 'response_text' && event.final) {
    // 安妮说的也记。这一段同时覆盖模型回复和 say() 播报，
    // 两者都是"她说过的话"，下次问"我们聊了什么"都该在里面
    conversation?.recordTurn('annie', event.text)
  } else if (event.type !== 'input_transcript') {
    log(
      'voice',
      `事件 ${event.type}`,
      event.type === 'connection' || event.type === 'notice' || event.type === 'wake_status' || event.type === 'wake_detected'
        ? event
        : undefined
    )
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#080b14',
    webPreferences: {
      // vite 的 lib 模式按格式追加后缀，cjs 产物是 preload.cjs
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 渲染层的报错以前只出现在 devtools 里，接进同一个日志文件才查得动
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) log('renderer', `console(${level}) ${message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer', `进程退出: ${details.reason}`)
  })

  // 渲染层不允许被导航走，也不允许开新窗口——否则一个外链就能把 app 变成浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url).catch(() => undefined)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
    void openExternalUrl(url).catch(() => undefined)
  })

  // ANNIE_LOOPBACK=1 让渲染层进入回放自检：把麦克风收到的声音直接放出来，
  // 用来确认重采样/分块链路与回声消除都在工作。仅用于开发排查。
  const loopback = process.env.ANNIE_LOOPBACK === '1'
  if (process.env.ELECTRON_RENDERER_URL) {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    void mainWindow.loadURL(loopback ? `${devUrl}#loopback` : devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), loopback ? { hash: 'loopback' } : undefined)
  }
}

function registerSettingsIpc(): void {

  const buildStatus = () => {
    // 从真实注册表取，避免"设置里显示有、实际没注册"这种漂移
    const current = settings.get()
    const toolDescriptors = describeTools(
      new SafePathService(current.workspaceRoots.map((root) => root.path)),
      current.memory.vaultPath ? new MemoryService(current.memory.vaultPath) : undefined
    )

    const piStatus = piRuntime
      ? {
          status: 'ready' as const,
          version: piRuntime.version,
          path: piRuntime.piEntryPath,
          entryPath: piRuntime.rpcEntryPath
        }
      : { status: 'missing' as const, version: undefined, path: piError }

    return settings.status({
      doubao: { status: secrets.doubaoStatus() },
      vidu: { status: secrets.viduStatus() },
      rtcAppKey: { status: secrets.rtcAppKeyStatus() },
      pi: piStatus,
      tools: toolDescriptors
    })
  }

  handleInvoke(CH.settingsGet, emptyArgs, getWindow, () => buildStatus())
  handleInvoke(CH.settingsUpdate, z.object({ patch: z.record(z.unknown()) }), getWindow, ({ patch }) => {
    settings.update(patch as never)
    return buildStatus()
  })
  handleInvoke(CH.settingsSaveKey, z.object({ key: z.string().min(8) }), getWindow, ({ key }) => {
    secrets.saveDoubaoKey(key.trim())
    return buildStatus()
  })
  handleInvoke(CH.settingsClearKey, emptyArgs, getWindow, () => {
    secrets.clearDoubaoKey()
    return buildStatus()
  })
  handleInvoke(CH.settingsSaveViduKey, z.object({ key: z.string().min(8) }), getWindow, ({ key }) => {
    secrets.saveViduKey(key.trim())
    return buildStatus()
  })
  handleInvoke(CH.settingsClearViduKey, emptyArgs, getWindow, () => {
    secrets.clearViduKey()
    return buildStatus()
  })
  handleInvoke(CH.settingsSaveRtcAppKey, z.object({ key: z.string().min(8) }), getWindow, ({ key }) => {
    secrets.saveRtcAppKey(key.trim())
    return buildStatus()
  })
  handleInvoke(CH.settingsClearRtcAppKey, emptyArgs, getWindow, () => {
    secrets.clearRtcAppKey()
    return buildStatus()
  })
  handleInvoke(CH.settingsRemoveRoot, z.object({ id: z.string().min(1) }), getWindow, ({ id }) => {
    settings.removeWorkspaceRoot(id)
    return buildStatus()
  })
  handleInvoke(CH.settingsPickRoot, emptyArgs, getWindow, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录'
    })
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    const root = { id: `root-${Date.now()}`, name: path.basename(picked) || picked, path: picked }
    settings.addWorkspaceRoot(root)
    return root
  })

  handleInvoke(CH.openExternal, z.object({ url: z.string().url() }), getWindow, ({ url }) => openExternalUrl(url))

  handleInvoke(
    CH.appLog,
    z.object({
      scope: z.string().max(40),
      message: z.string().max(500),
      detail: z.string().max(2000).nullable()
    }),
    getWindow,
    ({ scope, message, detail }) => log(`renderer:${scope}`, message, detail ?? undefined)
  )
}

function registerViduIpc(): void {
  handleInvoke(CH.viduStart, emptyArgs, getWindow, async () => {
    const current = settings.get().vidu
    if (!current.enabled) throw new Error('Vidu 数字人未启用')
    const apiKey = secrets.getViduKey()
    if (!apiKey) throw new Error('请先在设置里配置 Vidu API Key')
    if (!current.avatarImageUrl.trim()) throw new Error('请先在设置里填写数字人图片地址')

    log('vidu', `创建数字人会话 · model=${current.model} · host=${current.apiHost}`)
    const session = await createViduLiveSession({
      apiKey,
      settings: { ...current, avatarImageUrl: current.avatarImageUrl.trim() }
    })
    log('vidu', `数字人会话已创建 · live=${session.liveId}`)
    return session
  })

  // 组件模式的结束信令由渲染层的 WebSocket 发出；这个通道保留给主进程做生命周期对齐。
  handleInvoke(CH.viduStop, emptyArgs, getWindow, () => undefined)
}

/**
 * 任务结束后告诉用户。
 *
 * 会话还在就直接说；会话已经回待机（长任务常常跑过 60 秒静默）就发系统通知——
 * 什么都不做的话，用户永远不知道任务跑完了。
 */
function announceTaskResult(summary: TaskSummary, result: string): void {
  const ok = summary.state === 'completed'
  const said = result.replace(/\s+/g, ' ').trim()

  // 只说编号等于没说——用户要听的是"到底做了什么"。所以有结果就念结果本身。
  // 没结果时退回任务标题（标题就是当初派活时那句话），也**不要**说"没有输出"：
  // 那是在描述系统状态，不是在告诉用户事情办得怎么样。
  const spoken = ok ? said || `「${summary.title}」办好了。` : `「${summary.title}」没做成：${said || '原因不明'}`

  if (voiceSession?.active) {
    voiceSession.say(spoken)
    return
  }
  try {
    new Notification({
      title: summary.title,
      body: ok ? said || '已完成' : `没做成：${said || '原因不明'}`
    }).show()
  } catch {
    // 通知失败不影响任务本身
  }
}

/**
 * 跑一次知识库维护。
 *
 * 用 `pi -p`（非交互模式，跑完退出）起一次性进程，工作目录就是知识库本身——
 * pi 于是把它当项目来读，AGENTS.md 会被自动带上，不用我们再解释一遍结构。
 * 输出要等它自己收敛，所以给足超时。
 */
function runVaultJob(vaultPath: string, job: ScheduledJob): Promise<string> {
  const runtime = piRuntime
  if (!runtime) throw new Error('pi 未就绪')

  return new Promise<string>((resolve, reject) => {
    const child = spawn(runtime.nodePath, [runtime.piEntryPath, '-p', job.prompt], {
      cwd: vaultPath,
      // 打包后从 Finder 启动时 PATH 是残缺的，pi 自己再 spawn 什么都找不到
      env: { ...process.env, PATH: runtime.pathEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('超过 20 分钟还没结束'))
    }, 20 * 60_000)

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 8000) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      const said = stdout.replace(/\s+/g, ' ').trim()
      if (code !== 0) {
        reject(new Error(said || stderr.replace(/\s+/g, ' ').trim() || `pi 退出码 ${code}`))
        return
      }
      resolve(said.slice(0, 300) || '整理完成')
    })
  })
}

/**
 * 知识库的定期维护。
 *
 * 走 `pi -p`（非交互模式，跑完就退出）而不是复用 TaskService：
 * TaskService 会把 pi 进程一直养着（心跳探活），而这两个任务一天才跑一次，
 * 没必要为此常驻第二个 pi。代价是它们不出现在任务面板里，结果走系统通知。
 *
 * 提示词按知识库 AGENTS.md 里定的三层结构写：只读索引和收件箱，
 * 整理完更新 index.md 并追加 log.md。
 */
const VAULT_JOBS: ScheduledJob[] = [
  {
    id: 'vault-daily',
    title: '整理知识库',
    hour: 2,
    minute: 0,
    prompt: [
      '整理知识库。',
      '一、收件箱：读 inbox.md，把每一则未整理的记录编译进三层结构——',
      '属于项目/决策/复盘的写进 syntheses/，属于人、组织、项目的写进 entities/，',
      '只是原始素材的留在 sources/。已整理的条目从 inbox.md 移走。',
      '二、对话记录：读 sources/ 下今天和昨天的对话原文，',
      '从中提取新出现的事实、偏好、决定和进行中的事，编译进对应笔记；',
      '闲聊和已经记过的东西不要重复记。',
      '写完更新 index.md，并往 log.md 追加一行。',
      '最后用一句话说明整理了几条。'
    ].join('')
  },
  {
    id: 'vault-weekly',
    title: '知识库复盘',
    hour: 2,
    minute: 30,
    // 周日
    weekday: 0,
    prompt: [
      '做一次知识库复盘。',
      '通读 index.md 和 syntheses/ 下的笔记：合并重复的内容，',
      '把已经结束的项目压缩成一段摘要，原始资料移到 archive/。',
      '更新 index.md，并往 log.md 追加一行。',
      '最后用一句话说明这周做了什么调整。'
    ].join('')
  }
]

/**
 * 确认框里显示"要做什么"。
 *
 * 显示命令本身，而不是"run_command 工具"——用户看不懂工具名，
 * 但一眼能看出这条命令危险不危险。
 */
function describeCall(call: ToolCall, definition: ToolDefinition): string {
  try {
    const args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
    if (typeof args.command === 'string') return args.command
    if (typeof args.path === 'string') return args.path
    if (typeof args.url === 'string') return args.url
  } catch {
    // 参数不是 JSON 就退回工具名：确认框至少得有东西可显示
  }
  return definition.name
}

function purposeOf(call: ToolCall): string | undefined {
  try {
    const args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
    return typeof args.purpose === 'string' ? args.purpose : undefined
  } catch {
    return undefined
  }
}

/** 任务跑在哪个目录：优先设置里的工作目录，其次第一个授权目录，最后主目录。 */
function defaultWorkingDir(): string {
  const current = settings.get()
  return current.pi.workingDirectory || current.workspaceRoots[0]?.path || app.getPath('home')
}

function registerTasksIpc(): void {
  handleInvoke(CH.tasksList, emptyArgs, getWindow, () => tasks?.list() ?? [])
  handleInvoke(CH.tasksDetail, z.object({ taskId: z.string() }), getWindow, ({ taskId }) => tasks?.detail(taskId) ?? null)
  handleInvoke(CH.tasksCancel, z.object({ taskId: z.string() }), getWindow, async ({ taskId }) => {
    await tasks?.cancel(taskId)
  })
}

function registerWakeIpc(): void {
  handleInvoke(CH.wakeStart, emptyArgs, getWindow, async () => {
    await wakeWord?.start()
    return { state: wakeWord?.currentState ?? 'disabled' }
  })
  handleInvoke(CH.wakeStop, emptyArgs, getWindow, async () => {
    await wakeWord?.stop()
  })

  // 待机音频：固定 1600 个 float32（100ms），长度不对说明渲染层分批有 bug
  ipcMain.handle(CH.wakeAudio, (event, raw) => {
    assertSender(event, getWindow())
    const bytes = raw instanceof ArrayBuffer ? raw.byteLength : -1
    if (bytes !== WAKE_CHUNK_BYTES) {
      throw new Error(`待机音频必须是 ${WAKE_CHUNK_BYTES} 字节，收到 ${bytes}`)
    }
    const samples = new Float32Array(raw as ArrayBuffer)

    if (WAKE_DUMP_PATH) {
      wakeDump ??= fs.createWriteStream(WAKE_DUMP_PATH)
      wakeDump.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    }

    // 每 5 秒报一次电平：判断"待机路径收到的声音有多响"，
    // 和会话路径的电平对比就能看出是不是麦克风或处理链把声音压小了
    for (const sample of samples) wakePeak = Math.max(wakePeak, Math.abs(sample))
    wakeChunkCount += 1
    if (wakeChunkCount % 50 === 0) {
      log('wake', `待机音频 5 秒内峰值 ${wakePeak.toFixed(3)}`)
      wakePeak = 0
    }

    wakeWord?.audio(samples)
    return undefined
  })
}

function registerVoiceIpc(): void {
  handleInvoke(CH.voiceStart, emptyArgs, getWindow, async () => {
    // 待机麦克风必须先让出：两路 getUserMedia 同时开会互相干扰
    wakeWord?.pause()
    const status = settings.get()
    // 每次开会话都按当前授权目录重建：用户在设置里改了目录，下一次会话就生效
    const files = new SafePathService(status.workspaceRoots.map((root) => root.path))
    const memory = status.memory.vaultPath
      ? new MemoryService(status.memory.vaultPath, { userName: status.voice.userName })
      : undefined
    // 对话记录复用同一个知识库实例：没配库就整体不记
    conversation = memory

    confirmations = new ConfirmationService({
      // ask 只负责"把问题递出去"。返回 false 表示递不出去（没窗口），
      // 这时 confirm() 会直接拒绝——绝不能反过来当成"放行"。
      ask: (request) => {
        if (!getWindow()) return false
        emit({
          type: 'confirmation_request',
          id: request.id,
          action: request.action,
          target: request.target,
          detail: request.detail
        })
        // 先把话递到耳朵里：用户可能没在看屏幕
        voiceSession?.say('这件事会动到本机，你看一下屏幕确认一下。')
        return true
      }
    })

    const tools = buildToolRegistry(files, {
      memory,
      tasks,
      reminders,
      approve: async (call, definition) => {
        // 用户在设置里自己关了确认开关，就按他的意思直接执行
        if (!status.confirmDestructive) return true
        return confirmations!.confirm({
          action: definition.name,
          target: describeCall(call, definition),
          detail: purposeOf(call)
        })
      }
    })

    voiceSession = new VoiceSession({
      getApiKey: () => secrets.getDoubaoKey(),
      keyStatus: () => secrets.doubaoStatus(),
      instructions: () =>
        buildInstructions({
          workspaceRoots: files.authorizedRoots,
          hasTools: true,
          extra: status.voice.instructions,
          memoryOverview: memory?.overview(),
          userName: status.voice.userName
        }),
      voice: () => status.voice.voice,
      tools,
      emit,
      log: (message, detail) => log('tool', message, detail)
    })
    log('voice', `start 请求 · doubao=${secrets.doubaoStatus()} · 目录数=${status.workspaceRoots.length}`)
    try {
      const result = await voiceSession.start()
      log('voice', `start 完成 mode=${result.mode}`, result)
      return result
    } catch (error) {
      log('voice', `start 失败: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  })

  handleInvoke(CH.voiceStop, emptyArgs, getWindow, async () => {
    // 待答的确认一律按拒绝处理，"一直允许"也随之作废：
    // 这两个都只该在当前这次会话里有效
    confirmations?.reset()
    await voiceSession?.stop()
    wakeWord?.resume()
  })
  handleInvoke(CH.voiceCommit, emptyArgs, getWindow, () => voiceSession?.commit())
  handleInvoke(CH.voiceInterrupt, emptyArgs, getWindow, () => voiceSession?.interrupt())
  handleInvoke(CH.voiceSay, z.object({ text: z.string().min(1).max(300) }), getWindow, ({ text }) => {
    voiceSession?.say(text)
  })

  // 任务的三个通道由 registerTasksIpc 注册，这里不要再注册一遍：
  // ipcMain.handle 对同一通道重复注册会抛错，而这里抛在 whenReady 的回调里，
  // 会把后面的 createWindow() 一起带走——表现是「应用启动了但没有窗口」
  handleInvoke(
    CH.confirmAnswer,
    z.object({ id: z.string(), approved: z.boolean(), remember: z.boolean().optional() }),
    getWindow,
    ({ id, approved, remember }) => confirmations?.answer(id, approved, remember ?? false)
  )

  // 上行音频是唯一的二进制通道，单独注册：长度不对说明渲染层的分块有 bug，
  // 宁可当场报错也不要"宽容处理"——宽容只会把问题推到更难查的地方
  ipcMain.handle(CH.voiceAudio, (event, raw) => {
    assertSender(event, getWindow())
    if (!(raw instanceof ArrayBuffer) || raw.byteLength !== 640) {
      const size = raw instanceof ArrayBuffer ? raw.byteLength : typeof raw
      log('voice', `上行音频长度不对: ${size}`)
      throw new Error(`上行音频必须是 640 字节，收到 ${size}`)
    }
    uplinkChunks += 1
    if (uplinkChunks === 1 || uplinkChunks % 500 === 0) {
      log('voice', `上行音频 ${uplinkChunks} 块`)
    }
    try {
      voiceSession?.sendAudio(Buffer.from(raw))
    } catch (error) {
      log('voice', `上行失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  })
}

app.whenReady().then(async () => {
  // quit() 是异步的，这中间 whenReady 照样会触发。已经决定退出了就别再建窗口
  if (!singleInstance) return
  initLog(app.getPath('userData'))
  log('app', `启动 v${app.getVersion()} · userData=${app.getPath('userData')}`)
  settings = new SettingsStore(app.getPath('userData'))
  settings.ensureDefaultRoot(os.homedir())
  // 默认指向用户目录下的 annie-vault；没建库时记忆功能整体不启用，其余照常
  settings.ensureMemoryVault(path.join(os.homedir(), 'Documents', 'annie-vault'))
  secrets = new SecretStore(app.getPath('userData'))

  try {
    piRuntime = await resolvePiRuntime()
    log('app', `pi 就绪 v${piRuntime.version ?? '?'} · ${piRuntime.rpcEntryPath}`)
  } catch (error) {
    piError = error instanceof Error ? error.message : String(error)
    // 这行日志不能省。打包后从 Finder 启动时，登录 shell 探测 PATH 失败是最常见的
    // 一种翻车，而它的全部症状就是"任务派不出去"——没有这行就只能靠猜。
    log('app', `pi 未就绪: ${piError}`)
  }

  // 模型随 app 分发：打包后在 resources/models/wake-word，开发时在仓库里
  const wakeModelDir = app.isPackaged
    ? path.join(process.resourcesPath, 'models/wake-word')
    : path.join(__dirname, '../resources/models/wake-word')
  wakeWord = new WakeWordService(wakeModelDir, {
    onState: (state, detail) => emit({ type: 'wake_status', state, detail }),
    onDetected: (phrase) => emit({ type: 'wake_detected', phrase })
  })

  if (piRuntime) {
    ensureTaskDir(path.join(app.getPath('userData'), 'tasks'))
    tasks = new TaskService({
      runtime: piRuntime,
      dataDir: path.join(app.getPath('userData'), 'tasks'),
      model: settings.get().pi.model,
      thinking: settings.get().pi.thinking,
      workingDirectory: defaultWorkingDir(),
      appendSystemPrompt:
        '这个任务来自语音助手，结果会被念出来：最终回复请用口语，三句话以内，不要用 Markdown 或列表。',
      events: {
        onTaskStarted: (summary) => emit({ type: 'task_started', taskId: summary.id, number: summary.number, title: summary.title }),
        onTaskEvent: (taskId, event) => emit({ type: 'task_event', taskId, event }),
        onTaskFinished: (summary, result) => {
          emit({
            type: 'task_finished',
            taskId: summary.id,
            ok: summary.state === 'completed',
            result,
            error: summary.error
          })
          announceTaskResult(summary, result)
        },
        onPiStatus: (state, detail) => emit({ type: 'pi_status', state, detail })
      }
    })
  }

  reminders = new ReminderService({
    stateFile: path.join(app.getPath('userData'), 'reminders.json'),
    onDue: (reminder) => {
      const text = `提醒你：${reminder.message}`
      log('reminder', text)
      try {
        new Notification({ title: '安妮提醒', body: reminder.message }).show()
      } catch {
        // 系统通知不可用时仍尝试语音播报
      }
      voiceSession?.say(text)
    }
  })
  reminders.start()

  // 定时维护知识库。机器睡过了就靠 start() 里的那次补跑接上。
  const vaultPath = settings.get().memory.vaultPath
  if (piRuntime && vaultPath && fs.existsSync(vaultPath)) {
    scheduler = new SchedulerService({
      jobs: VAULT_JOBS,
      stateFile: path.join(app.getPath('userData'), 'schedule.json'),
      run: (job) => runVaultJob(vaultPath, job),
      onFinish: (job, ok, detail) => {
        log('schedule', `${job.title} ${ok ? '完成' : '失败'}: ${detail}`)
        emit({ type: 'notice', level: ok ? 'info' : 'warn', text: `${job.title}${ok ? '完成' : '失败'}：${detail}` })
        try {
          new Notification({ title: job.title, body: detail.slice(0, 180) || (ok ? '完成' : '失败') }).show()
        } catch {
          // 通知失败不影响整理本身
        }
      }
    })
    scheduler.start()
  }

  registerTasksIpc()
  registerWakeIpc()
  registerSettingsIpc()
  registerViduIpc()
  registerVoiceIpc()
  createWindow()

  emit({ type: 'pi_status', state: piRuntime ? 'ready' : 'stopped', detail: piError })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  scheduler?.stop()
  reminders?.stop()
  void tasks?.shutdown()
  wakeDump?.end()
  void voiceSession?.stop()
  void wakeWord?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
