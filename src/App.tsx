import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { type SettingsStatus, type VoiceEvent } from '@shared/contract'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { SettingsPanel } from './components/SettingsPanel'
import { TaskPanel } from './components/TaskPanel'
import { VoiceStage } from './components/VoiceStage'
import { useTranscript } from './hooks/useTranscript'
import { useVoiceEngine } from './hooks/useVoiceEngine'
import { activityReducer, INITIAL_ACTIVITY, presentationState } from './activity'
import { ViduAvatarController } from './vidu-avatar'

/**
 * 工具名 → 给人看的说法。
 *
 * 界面上不该出现 `run_command` 这种标识：用户看不懂，而这一行的全部意义
 * 就是让他知道"在办什么"。没登记的工具退回"处理"。
 */
const TOOL_LABEL: Record<string, string> = {
  list_directory: '查看目录',
  read_file: '读文件',
  search_text: '搜索内容',
  open_web: '打开网页',
  open_app: '打开应用',
  run_command: '执行命令',
  run_pi_task: '安排后台任务',
  calculate: '计算',
  get_current_time: '查时间',
  get_weather: '查天气',
  set_reminder: '设置提醒',
  get_calendar_events: '查日程',
  get_clipboard: '读剪贴板',
  get_system_status: '查系统状态',
  search_web: '搜索网页',
  recall: '查记忆',
  read_note: '读笔记',
  remember: '记笔记'
}

/**
 * 唤醒后多久没有对话就回到待机。
 *
 * 会话 30 秒没有新的对话活动就退回待机；工具和后台任务进行中会额外阻止退下，避免误断。
 */
export function App(): React.JSX.Element {
  const [status, setStatus] = useState<SettingsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  // 任务事件到来时递增，让面板重新拉列表——比在渲染层维护一份副本更简单
  const [taskRevision, setTaskRevision] = useState(0)
  const wakeState = 'disabled'
  // 会话是否进行中。用来决定点粒子团是「启动」还是什么都不做——
  // 不能只看 wakeState：唤醒词模型加载失败时会变成 unavailable，
  // 那种情况下更应该让点一下能启动，不然就完全没入口了。
  const [sessionActive, setSessionActive] = useState(false)
  /** 待确认的破坏性操作。同一时刻只会有一个：工具是串行执行的。 */
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  /** 正在进行的操作。长任务期间界面得有东西在动，否则用户只能干等。 */
  const [work, dispatchWork] = useReducer(activityReducer, INITIAL_ACTIVITY)
  /** 防止连点粒子团和唤醒词同时触发，起两路麦克风。 */
  const enteringRef = useRef(false)
  const viduVideoRef = useRef<HTMLVideoElement | null>(null)
  const viduRef = useRef<ViduAvatarController | null>(null)
  const [viduActive, setViduActive] = useState(false)
  const autoStartedRef = useRef(false)

  const transcript = useTranscript()
  // Vidu 控制器只创建一次；用 ref 让 WebSocket 回调始终拿到最新的 React 状态。
  const transcriptRef = useRef(transcript)
  transcriptRef.current = transcript

  // P1 的自验开关：把麦克风收到的声音直接回放，确认分块与回声消除都正常。
  const loopback = useMemo(
    () => window.location.hash.includes('loopback') || window.localStorage.getItem('annie.loopback') === '1',
    []
  )

  // Vidu 独立模式直接接收麦克风；这里不再启动或上传豆包音频。
  const voice = useVoiceEngine({ loopback })

  useEffect(() => {
    const video = viduVideoRef.current
    if (!video) return
    const controller = new ViduAvatarController({
      video,
      getInputAudioTrack: () => voice.getMicrophoneAudioTrack(),
      onSpeechStarted: () => transcriptRef.current.applyEvent({ type: 'input_speech_started' }),
      onTranscript: (event) => {
        transcriptRef.current.applyEvent(
          event.side === 'user'
            ? { type: 'input_transcript', text: event.text, final: event.final }
            // Vidu type=10 返回的是当前完整累计稿，不是豆包式 delta；
            // 强制按最终稿覆盖，避免每次更新都把前文再追加一遍。
            : { type: 'response_text', text: event.text, final: true }
        )
      },
      onState: (state, detail) => {
        setViduActive(state === 'connecting' || state === 'ready')
        if (state === 'error' && detail) setError(`Vidu：${detail}`)
      }
    })
    viduRef.current = controller
    return () => {
      viduRef.current = null
      void controller.stop()
    }
  }, [])

  const taskTitles = Object.values(work.tasks)
  const toolName = work.tools.at(-1)
  const activity = taskTitles.length
    ? `正在办「${taskTitles[0]}」${taskTitles.length > 1 ? `，另有 ${taskTitles.length - 1} 项任务` : ''}…`
    : toolName && !confirmRequest ? `正在${TOOL_LABEL[toolName] ?? '处理'}…` : null
  const visualState = presentationState(voice.state, work, !!confirmRequest)
  const readiness = !status ? 'loading' : status.vidu.status === 'verified' ? 'ready' : 'attention'
  const readinessLabel = readiness === 'ready' ? 'Vidu 已就绪' : readiness === 'loading' ? '正在读取状态' : '请配置 Vidu'

  const refresh = useCallback(() => {
    window.assistant.settings
      .get()
      .then(setStatus)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  /** 启动 Vidu 独立会话：麦克风直接交给 Vidu，不连接豆包。 */
  const startSession = useCallback(async () => {
    try {
      if (!status?.settings.vidu.enabled) {
        setError('请先在设置中启用 Vidu 数字人')
        return
      }
      await voice.start()
      setSessionActive(true)
      if (viduRef.current) {
        try {
          const credentials = await window.assistant.vidu.start()
          await viduRef.current.start(credentials)
        } catch (cause) {
          setError(cause instanceof Error ? `Vidu：${cause.message}` : `Vidu：${String(cause)}`)
          await window.assistant.vidu.stop().catch(() => undefined)
          await voice.stop()
          setSessionActive(false)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      refresh()
    }
  }, [status, voice, refresh])

  /**
   * 手动重连 Vidu。Vidu 独立模式默认会在状态读取后自动进入，
   * 这里作为配置失败或用户主动重试时的备用入口。
   */
  const enterSession = useCallback(async () => {
    if (enteringRef.current) return
    enteringRef.current = true
    try {
      await startSession()
    } finally {
      enteringRef.current = false
    }
  }, [startSession])

  useEffect(refresh, [refresh])

  // Vidu 独立模式启动即进入全屏数字人，不再等待唤醒词或连接豆包。
  useEffect(() => {
    if (autoStartedRef.current || !status) return
    if (!status.settings.vidu.enabled || status.vidu.status !== 'verified') return
    autoStartedRef.current = true
    void startSession()
  }, [status, startSession])

  // 主进程事件 → 播放、转写、状态机，以及唤醒/回待机的切换
  useEffect(() => {
    return window.assistant.onEvent((event: VoiceEvent) => {
      voice.applyEvent(event)
      transcript.applyEvent(event)
      dispatchWork(event)

      if (event.type === 'response_audio') viduRef.current?.sendAudio(event.audioBase64, event.sampleRate)
      if (event.type === 'input_transcript' && event.final) viduRef.current?.sendInputText(event.text)
      if (event.type === 'response_text' && event.final) viduRef.current?.sendOutputText(event.text)
      if (event.type === 'tool_started') viduRef.current?.sendInputText(`正在${TOOL_LABEL[event.name] ?? '处理'}，请稍候`)
      if (event.type === 'task_started') viduRef.current?.sendInputText('正在认真思考并执行任务，请稍候')

      if (event.type === 'task_started' || event.type === 'task_event' || event.type === 'task_finished') {
        setTaskRevision((value) => value + 1)
      }

      if (event.type === 'confirmation_request') setConfirmRequest(event)
      if (event.type === 'input_speech_started') viduRef.current?.interrupt()
    })
  }, [voice, transcript])

  return (
    <div className={`app${viduActive ? ' vidu-fullscreen' : ''}`}>
      <header className="drag-region">
        <span className="brand">Annie</span>
        {loopback ? <span className="badge">回放自检</span> : null}
        <div className="header-actions">
          <span
            className={`readiness-dot readiness-${readiness}`}
            role="status"
            aria-label={readinessLabel}
            title={readinessLabel}
          />
          <button className="gear" type="button" onClick={() => setShowTasks((open) => !open)} aria-label="任务">
            任务
          </button>
          <button className="gear" type="button" onClick={() => setShowSettings((open) => !open)} aria-label="设置">
            ⚙
          </button>
        </div>
      </header>

      <VoiceStage
        state={visualState}
        level={voice.level}
        userText={transcript.user}
        userFinal={transcript.userFinal}
        assistantText={transcript.assistant}
        wakeState={wakeState}
        sessionActive={sessionActive}
        notice={voice.notice ?? (error ? { level: 'error', text: error } : null)}
        onActivate={() => void enterSession()}
        activity={activity}
        viduVideoRef={viduVideoRef}
        viduActive={viduActive}
      />

      {confirmRequest ? (
        <ConfirmDialog
          request={confirmRequest}
          onAnswer={(approved, remember) => {
            void window.assistant.confirmAnswer(confirmRequest.id, approved, remember)
            // 先关框再等主进程：用户点了就该立刻有反馈，不能等一个往返
            setConfirmRequest(null)
          }}
        />
      ) : null}

      {showTasks ? <TaskPanel revision={taskRevision} onClose={() => setShowTasks(false)} /> : null}

      {showSettings && status ? (
        <SettingsPanel status={status} onClose={() => setShowSettings(false)} onChanged={refresh} />
      ) : null}

    </div>
  )
}
