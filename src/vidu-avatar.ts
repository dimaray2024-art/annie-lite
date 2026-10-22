import AliRtcEngine, { AliRtcSubscribeState, AliRtcVideoTrack } from 'aliyun-rtc-sdk'
import type { ViduSessionCredentials } from '@shared/contract'
import { parseViduTranscriptSignal, type ViduTranscriptEvent } from './vidu-transcript'

interface ViduAvatarOptions {
  video: HTMLVideoElement
  /** 用户麦克风音轨；Vidu Live 独立模式负责 ASR、回答、TTS 和口型。 */
  getInputAudioTrack?: () => MediaStreamTrack | undefined
  onState?: (state: 'connecting' | 'ready' | 'ended' | 'error', detail?: string) => void
  onSpeechStarted?: () => void
  onTranscript?: (event: ViduTranscriptEvent) => void
}

interface ViduSignalPayload extends Record<string, unknown> {
  conn_init_ack?: { success?: boolean; error_code?: string; error_msg?: string }
  hangup?: { hangup_reason?: string }
}

interface ViduSignal {
  type: number
  live_id?: string
  seq_id?: number
  payload?: ViduSignalPayload
}

interface RtcEngineEvents {
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
}

interface RtcErrorLike {
  code?: number
  errorCode?: number
  codeName?: string
  errorCodeName?: string
  message?: string
  errorMsg?: string
}

/**
 * Vidu Live 的浏览器端控制器。
 *
 * API Key 和 ARTC AppKey 永远不会进入这里；主进程只下发当前会话的 client_secret 和 RTC token。
 */
export class ViduAvatarController {
  private readonly video: HTMLVideoElement
  private readonly getInputAudioTrack?: ViduAvatarOptions['getInputAudioTrack']
  private readonly onState?: ViduAvatarOptions['onState']
  private readonly onSpeechStarted?: ViduAvatarOptions['onSpeechStarted']
  private readonly onTranscript?: ViduAvatarOptions['onTranscript']
  private socket?: WebSocket
  private engine?: InstanceType<typeof AliRtcEngine>
  private credentials?: ViduSessionCredentials
  private seq = 0
  private ready = false
  private stopped = true
  private retryTimer?: number
  private deadlineTimer?: number
  private connId?: string
  private inputTranscriptActive = false
  private readonly engineListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = []

  constructor(options: ViduAvatarOptions) {
    this.video = options.video
    this.getInputAudioTrack = options.getInputAudioTrack
    this.onState = options.onState
    this.onSpeechStarted = options.onSpeechStarted
    this.onTranscript = options.onTranscript
  }

  async start(credentials: ViduSessionCredentials): Promise<void> {
    await this.stop()
    this.credentials = credentials
    this.stopped = false
    this.onState?.('connecting')
    this.openSocket()
  }

  private openSocket(): void {
    const credentials = this.credentials
    if (!credentials || this.stopped) return
    const connId = crypto.randomUUID()
    this.connId = connId
    const socketUrl = `${credentials.apiHost.replace(/^https:/, 'wss:')}/live/ws/live/connect?live_id=${encodeURIComponent(credentials.liveId)}&conn_id=${encodeURIComponent(connId)}&client_secret=${encodeURIComponent(credentials.clientSecret)}`
    const socket = new WebSocket(socketUrl)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.deadlineTimer = window.setTimeout(() => {
      if (!this.ready) this.fail('Vidu 等待数字人就绪超时')
    }, 60_000)

    socket.addEventListener('open', () => {
      this.sendSignal(1, { conn_init: { version: 1 } }, credentials.liveId)
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      this.handleSignal(event.data)
    })
    socket.addEventListener('error', () => {
      if (!this.stopped) this.fail('Vidu 控制连接失败')
    })
    socket.addEventListener('close', () => {
      if (!this.stopped && !this.ready) this.fail('Vidu 控制连接已关闭')
    })
  }

  private handleSignal(raw: string): void {
    let signal: ViduSignal
    try {
      signal = JSON.parse(raw) as ViduSignal
    } catch {
      return
    }

    if (signal.type === 9 && !this.inputTranscriptActive) {
      this.inputTranscriptActive = true
      this.onSpeechStarted?.()
    }
    const transcript = parseViduTranscriptSignal(signal)
    if (transcript) {
      this.onTranscript?.(transcript)
      if (transcript.side === 'user' && transcript.final) this.inputTranscriptActive = false
    }

    if (signal.type === 2) {
      const ack = signal.payload?.conn_init_ack
      if (ack?.success) {
        this.ready = true
        window.clearTimeout(this.deadlineTimer)
        void this.joinRtc()
        return
      }
      if (ack?.error_code === 'NOT_READY') {
        window.clearTimeout(this.retryTimer)
        this.retryTimer = window.setTimeout(() => {
          if (!this.stopped) {
            const liveId = this.credentials?.liveId
            if (liveId) this.sendSignal(1, { conn_init: { version: 1 } }, liveId)
          }
        }, 2500)
        return
      }
      this.fail(`Vidu 初始化失败${ack?.error_msg ? `：${ack.error_msg}` : ''}`)
      return
    }
    if (signal.type === 6) {
      this.fail(`Vidu 会话被结束${signal.payload?.hangup?.hangup_reason ? `：${signal.payload.hangup.hangup_reason}` : ''}`)
    }
  }

  private sendSignal(type: number, payload: Record<string, unknown>, liveId = this.credentials?.liveId): void {
    if (!liveId || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(
      JSON.stringify({
        type,
        live_id: liveId,
        conn_id: this.connId,
        seq_id: ++this.seq,
        payload
      })
    )
  }

  private async joinRtc(): Promise<void> {
    const credentials = this.credentials
    if (!credentials || this.stopped) return
    try {
      const supported = await AliRtcEngine.isSupported('recvonly')
      if (!supported.support) throw new Error('当前环境不支持 WebRTC 视频接收')

      const engine = AliRtcEngine.createInstance()
      this.engine = engine
      const events = engine as unknown as RtcEngineEvents
      const onRemoteOnline = (...args: unknown[]) => {
        const uid = typeof args[0] === 'string' ? args[0] : undefined
        console.info('[Vidu RTC] remoteUserOnLineNotify', uid ?? '')
        if (uid) this.attachRemote(uid)
      }
      const onRemoteTrack = (...args: unknown[]) => {
        const uid = typeof args[0] === 'string' ? args[0] : undefined
        const videoTrack = Number(args[2] ?? 0)
        console.info('[Vidu RTC] remoteTrackAvailableNotify', uid ?? '', videoTrack)
        if (uid && videoTrack > 0) this.attachRemote(uid)
      }
      const onVideoState = (...args: unknown[]) => {
        const uid = typeof args[0] === 'string' ? args[0] : undefined
        const nextState = Number(args[2] ?? 0)
        console.info('[Vidu RTC] videoSubscribeStateChanged', uid ?? '', nextState)
        if (uid && nextState === AliRtcSubscribeState.AliRtcStateSubscribed) this.attachRemote(uid)
      }
      const onRtcError = (...args: unknown[]) => {
        const error = (args[0] ?? {}) as RtcErrorLike
        const code = error.code ?? error.errorCode
        const name = error.codeName ?? error.errorCodeName
        const message = error.message ?? error.errorMsg
        const detail = [code !== undefined ? `code=${code}` : '', name ?? '', message ?? ''].filter(Boolean).join(' ')
        console.error('[Vidu RTC] occurError', detail || error)
        if (!this.stopped) this.fail(`Vidu RTC 入会失败${detail ? `：${detail}` : ''}`)
      }
      const onConnectionStatus = (...args: unknown[]) => {
        console.info('[Vidu RTC] connectionStatusChange', ...args)
      }
      this.bindEngineEvent(events, 'remoteUserOnLineNotify', onRemoteOnline)
      this.bindEngineEvent(events, 'remoteTrackAvailableNotify', onRemoteTrack)
      this.bindEngineEvent(events, 'videoSubscribeStateChanged', onVideoState)
      this.bindEngineEvent(events, 'occurError', onRtcError)
      this.bindEngineEvent(events, 'connectionStatusChange', onConnectionStatus)

      // Vidu 独立模式的声音来自远端数字人流，AliRTC 负责直接播放它。
      engine.setDefaultSubscribeAllRemoteAudioStreams(true)
      engine.setDefaultSubscribeAllRemoteVideoStreams(true)
      await engine.publishLocalVideoStream(false)
      const audioTrack = this.getInputAudioTrack?.()
      if (!audioTrack) throw new Error('用户麦克风轨道尚未就绪，无法启动 Vidu 独立模式')
      // AliRTC 的 switchMicrophone 第二个参数允许传入自定义音轨，避免 Vidu
      // 自己再次申请麦克风；同一条轨道同时用于本地电平和 Vidu 输入。
      await engine.switchMicrophone('annie-microphone', audioTrack as MediaStreamAudioTrack)
      await engine.joinChannel(credentials.rtc.token, credentials.rtc.userId)
      console.info('[Vidu RTC] joined', credentials.rtc.channelId, credentials.rtc.userId)
      await engine.publishLocalAudioStream(true)
      console.info('[Vidu RTC] local audio published')
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : String(cause))
    }
  }

  private bindEngineEvent(events: RtcEngineEvents, event: string, listener: (...args: unknown[]) => void): void {
    events.on(event, listener)
    this.engineListeners.push({ event, listener })
  }

  private attachRemote(uid: string): void {
    if (!this.engine || this.stopped) return
    this.engine.setRemoteViewConfig(this.video, uid, AliRtcVideoTrack.AliRtcVideoTrackCamera)
    this.video.autoplay = true
    this.video.playsInline = true
    void this.video.play().catch(() => undefined)
    this.onState?.('ready')
  }

  sendAudio(audioBase64: string, sampleRate: number): void {
    // Vidu 独立模式不接收豆包事件；保留接口以兼容旧事件契约。
    void audioBase64
    void sampleRate
  }

  sendInputText(content: string): void {
    // Vidu 独立模式直接使用麦克风 ASR，不需要重复发送文本信令。
    void content
  }

  sendOutputText(content: string): void {
    // 豆包的输出不应再次作为用户输入发给 Vidu，否则会触发二次回答。
    void content
  }

  interrupt(): void {
    this.sendSignal(7, {})
  }

  private fail(detail: string): void {
    if (this.stopped) return
    this.onState?.('error', detail)
    void this.stop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.ready = false
    window.clearTimeout(this.retryTimer)
    window.clearTimeout(this.deadlineTimer)
    this.retryTimer = undefined
    this.deadlineTimer = undefined
    this.connId = undefined
    this.inputTranscriptActive = false

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSignal(5, { hangup: { hangup_reason: 'client_hangup' } })
      this.socket.close()
    }
    this.socket = undefined

    if (this.engine) {
      const events = this.engine as unknown as RtcEngineEvents
      for (const { event, listener } of this.engineListeners) events.off(event, listener)
      this.engineListeners.length = 0
      try {
        await this.engine.leaveChannel()
      } catch {
        // 已经断开的 RTC 不应阻塞本地会话退出
      }
      await this.engine.destroy().catch(() => undefined)
    }
    this.engine = undefined
    this.video.pause()
    this.video.srcObject = null
    this.onState?.('ended')
  }
}
