/**
 * 渲染层 ↔ 主进程的唯一契约。
 *
 * 两边都只用 `import type` 引入（类型在编译期擦除，不会把主进程代码打进渲染层）。
 * 新增能力时先改这里，再改实现——契约是权威，不是事后文档。
 */

// ── IPC 通道名 ────────────────────────────────────────────────────────────

export const CH = {
  voiceStart: 'voice:start',
  voiceAudio: 'voice:audio',
  voiceCommit: 'voice:commit',
  voiceInterrupt: 'voice:interrupt',
  voiceSay: 'voice:say',
  voiceStop: 'voice:stop',

  tasksList: 'tasks:list',
  tasksDetail: 'tasks:detail',
  tasksCancel: 'tasks:cancel',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSaveKey: 'settings:save-key',
  settingsClearKey: 'settings:clear-key',
  settingsSaveViduKey: 'settings:save-vidu-key',
  settingsClearViduKey: 'settings:clear-vidu-key',
  settingsSaveRtcAppKey: 'settings:save-rtc-app-key',
  settingsClearRtcAppKey: 'settings:clear-rtc-app-key',
  settingsPickRoot: 'settings:pick-root',
  settingsRemoveRoot: 'settings:remove-root',

  viduStart: 'vidu:start',
  viduStop: 'vidu:stop',

  confirmAnswer: 'confirm:answer',
  appLog: 'app:log',

  wakeStart: 'wake:start',
  wakeStop: 'wake:stop',
  wakeAudio: 'wake:audio',
  openExternal: 'app:open-external'
} as const

/** 事件是单向的：主进程推，渲染层只订阅。 */
export const EVENT_CHANNEL = 'voice:event' as const

// ── 语音控制面（渲染层 invoke 主进程）────────────────────────────────────

export type VoiceMode = 'doubao' | 'demo'

export interface VoiceStartResult {
  mode: VoiceMode
  /** 密钥存在但解不开时降级到 demo；这里说明原因，UI 据此提示用户重新录入。 */
  credentialIssue?: 'stored-key-unreadable' | 'no-key'
}

export interface VoiceControl {
  start(): Promise<VoiceStartResult>
  /**
   * 上行音频。**必须**是 640 字节（16kHz int16 mono 的 20ms）。
   * 主进程会断言这个长度——不一致说明渲染层的重采样/分块有 bug，宁可报错也不要宽容处理。
   */
  sendAudio(chunk: ArrayBuffer): Promise<void>
  /** 服务端 VAD 判定用户说完后调用，触发 input_audio_buffer.commit。 */
  commit(): Promise<void>
  /** 用户插话：取消当前响应。渲染层在收到 input_speech_started 时调用。 */
  interrupt(): Promise<void>
  /**
   * 让安妮念一句指定文本。用于唤醒问候、任务结果播报这类"不由模型决定说什么"的场景。
   * 文案由调用方给，模型只负责朗读。
   */
  say(text: string): Promise<void>
  stop(): Promise<void>
}

export interface ViduRtcCredentials {
  provider: 'artc'
  appId: string
  channelId: string
  userId: string
  token: string
}

export interface ViduSessionCredentials {
  liveId: string
  clientSecret: string
  apiHost: string
  rtc: ViduRtcCredentials
}

export interface ViduControl {
  start(): Promise<ViduSessionCredentials>
  stop(): Promise<void>
}

// ── 事件（主进程 → 渲染层）──────────────────────────────────────────────

export interface TaskEventItem {
  at: number
  kind: 'text' | 'tool' | 'status' | 'error' | 'result'
  text: string
}

export interface TaskSummary {
  id: string
  number: number
  title: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  createdAt: number
  updatedAt: number
  resultPreview?: string
  error?: string
}

export type PiStatus = 'stopped' | 'starting' | 'ready' | 'exited' | 'restarting'

export type WakeState = 'disabled' | 'starting' | 'listening' | 'paused' | 'error' | 'unavailable'

/** 助手的名字。人设、唤醒问候、界面文案都从这里取，避免各处写不一致。 */
export const ASSISTANT_NAME = '安妮'

/** 用户称呼的长度上限：它会进系统提示词，不能当成一段自由文本。 */
export const USER_NAME_MAX_CHARS = 20

/** 没设置称呼时，在对话记录等需要标签的地方用的中性说法。 */
export const DEFAULT_USER_LABEL = '用户'

/**
 * 用户在设置里填的称呼（如「小明」）。空字符串表示不叫名字。
 * 去掉换行、控制字符和首尾空白并截断长度——这个值会拼进系统提示词，
 * 不能让它变成一段额外的指令。
 */
export function normalizeUserName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .trim()
    .slice(0, USER_NAME_MAX_CHARS)
}

/** 唤醒后的应声。措辞固定，模型只负责念。 */
export function wakeGreeting(userName?: string): string {
  const name = normalizeUserName(userName)
  return name ? `${name}，我在。` : '我在。'
}

/**
 * 唤醒词。界面提示和日志都用这个常量。
 * 注意：真正生效的发音在 resources/models/wake-word/keywords.txt 里，
 * 改词要两边一起改——那边是拼音 token，这边是给人看的字。
 */
export const WAKE_PHRASE = '你好安妮'

export type VoiceEvent =
  /**
   * 模型请求调用工具。**主进程内部事件**：由 VoiceSession 拦截、执行、回传结果，
   * 不会送到渲染层（界面只看 tool_started / tool_finished）。
   */
  | { type: 'tool_request'; callId: string; name: string; arguments: string }
  // 连接
  | { type: 'connection'; state: 'connected' | 'disconnected' | 'error'; mode: VoiceMode; detail?: string }
  // 用户输入
  | { type: 'input_speech_started' }
  | { type: 'input_speech_stopped' }
  | { type: 'input_transcript'; text: string; final: boolean }
  // 助手输出
  | { type: 'response_text'; text: string; final: boolean }
  | {
      type: 'response_audio'
      audioBase64: string
      sampleRate: number
      sampleFormat: 'f32le'
      responseId?: string
      final: boolean
    }
  | { type: 'response_done'; responseId?: string }
  | { type: 'interrupted' }
  // 工具
  | { type: 'tool_started'; name: string }
  | { type: 'tool_finished'; name: string; ok: boolean; error?: string; message?: string }
  // 长任务
  | { type: 'task_started'; taskId: string; number: number; title: string }
  | { type: 'task_event'; taskId: string; event: TaskEventItem }
  | { type: 'task_finished'; taskId: string; ok: boolean; result?: string; error?: string }
  | { type: 'pi_status'; state: PiStatus; detail?: string }
  // 交互
  | { type: 'wake_status'; state: WakeState; detail?: string }
  | { type: 'wake_detected'; phrase: string }
  | { type: 'confirmation_request'; id: string; action: string; target: string; detail?: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }

// ── 设置面 ───────────────────────────────────────────────────────────────

export type ToolRisk = 'read_only' | 'side_effect'

export interface ToolDescriptor {
  name: string
  description: string
  risk: ToolRisk
  destructive: boolean
}

export interface WorkspaceRoot {
  id: string
  name: string
  path: string
}

export interface Settings {
  workspaceRoots: WorkspaceRoot[]
  pi: {
    /** user-config 复用 ~/.pi/agent（登录态和模型立即可用）；app-config 隔离到 app 私有目录。 */
    mode: 'user-config' | 'app-config'
    model?: string
    thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high'
    /** v1 只支持串行；留成字段是为了以后加并发时不用改契约。 */
    maxConcurrentTasks: number
    /** 任务跑在哪个工作目录，省略则用第一个 workspaceRoot。 */
    workingDirectory?: string
  }
  voice: {
    voice?: string
    /** 追加到豆包会话的系统提示词。 */
    instructions?: string
    /** 助手怎么称呼用户（如「小明」）。留空则不叫名字。 */
    userName?: string
  }
  memory: {
    /** 长期记忆知识库的根目录。空字符串表示不启用记忆。 */
    vaultPath: string
  }
  vidu: {
    /** 是否在语音会话中同步驱动数字人画面。 */
    enabled: boolean
    /** Vidu API host，国内账号默认使用 api.vidu.cn。 */
    apiHost: string
    model: 'vidu-s1' | 'vidu-s2'
    /** Vidu 组件模式要求的数字人图片地址。 */
    avatarImageUrl: string
    /** 阿里云 RTC App ID；AppKey 只存入 SecretStore。 */
    rtcAppId: string
  }
  /** 破坏性工具（跑命令等）是否需要确认。关掉就是 Annie 的 direct 模式。 */
  confirmDestructive: boolean
}

export interface SettingsStatus {
  settings: Settings
  doubao: { status: 'missing' | 'unavailable' | 'unreadable' | 'verified' }
  vidu: { status: 'missing' | 'unavailable' | 'unreadable' | 'verified' }
  rtcAppKey: { status: 'missing' | 'unavailable' | 'unreadable' | 'verified' }
  pi: { status: 'missing' | 'ready'; version?: string; path?: string; entryPath?: string }
  tools: ToolDescriptor[]
}

export interface WakeControl {
  /** 开待机麦克风做本地唤醒词检测。待机音频只在本机处理，不上传。 */
  start(): Promise<{ state: WakeState }>
  stop(): Promise<void>
  /** Float32 单声道 16kHz。必须是 1600 个样本（100ms），由 worker 侧再校验一次。 */
  sendAudio(samples: ArrayBuffer): Promise<void>
}

export interface AssistantAPI {
  voice: VoiceControl
  vidu: ViduControl
  wake: WakeControl
  tasks: {
    list(): Promise<TaskSummary[]>
    detail(taskId: string): Promise<{ summary: TaskSummary; events: TaskEventItem[] } | null>
    cancel(taskId: string): Promise<void>
  }
  settings: {
    get(): Promise<SettingsStatus>
    update(patch: Partial<Settings>): Promise<SettingsStatus>
    saveDoubaoKey(key: string): Promise<SettingsStatus>
    clearDoubaoKey(): Promise<void>
    saveViduKey(key: string): Promise<SettingsStatus>
    clearViduKey(): Promise<SettingsStatus>
    saveRtcAppKey(key: string): Promise<SettingsStatus>
    clearRtcAppKey(): Promise<SettingsStatus>
    pickWorkspaceRoot(): Promise<WorkspaceRoot | null>
    removeWorkspaceRoot(id: string): Promise<void>
  }
  confirmAnswer(id: string, approved: boolean, remember?: boolean): Promise<void>
  openExternal(url: string): Promise<void>
  /** 渲染层的诊断日志，写进主进程同一个日志文件，排查时能在一条时间线上看。 */
  log(scope: string, message: string, detail?: unknown): void
  onEvent(listener: (event: VoiceEvent) => void): () => void
}

declare global {
  interface Window {
    assistant: AssistantAPI
  }
}
