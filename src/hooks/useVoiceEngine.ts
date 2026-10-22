import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceEvent } from '@shared/contract'
import { BrowserVoiceEngine } from '../voice-engine'
import type { OrbState } from '../components/ParticleOrb'

export interface VoiceEngineView {
  state: OrbState
  level: number
  notice: { level: 'info' | 'warn' | 'error'; text: string } | null
  start: () => Promise<void>
  stop: () => Promise<void>
  toggle: () => Promise<void>
  busy: boolean
  /** 把主进程来的事件喂给引擎，驱动状态机与播放。 */
  applyEvent: (event: VoiceEvent) => void
  /** 豆包下行声音对应的 WebRTC 音轨，供 Vidu 做口型同步。 */
  getAssistantAudioTrack: () => MediaStreamTrack | undefined
  /** 用户麦克风音轨，供 Vidu Live 独立模式直接接收。 */
  getMicrophoneAudioTrack: () => MediaStreamTrack | undefined
}

export interface UseVoiceEngineOptions {
  /**
   * P1 验证用：把采集到的音频直接回灌播放，确认重采样/分块与 AEC 正常。
   * 打开方式：地址栏加 #loopback，或 localStorage.setItem('annie.loopback','1')。
   */
  loopback: boolean
  /** 上行音频的去处。P2 起接到 window.assistant.voice.sendAudio。 */
  onUplink?: (chunk: ArrayBuffer) => void
}

export function useVoiceEngine(options: UseVoiceEngineOptions): VoiceEngineView {
  const engineRef = useRef<BrowserVoiceEngine | null>(null)
  const [state, setState] = useState<OrbState>('idle')
  const [level, setLevel] = useState(0)
  const [notice, setNotice] = useState<VoiceEngineView['notice']>(null)
  const [busy, setBusy] = useState(false)

  const uplinkRef = useRef(options.onUplink)
  uplinkRef.current = options.onUplink

  const engine = useCallback((): BrowserVoiceEngine => {
    if (!engineRef.current) {
      engineRef.current = new BrowserVoiceEngine({
        loopback: options.loopback,
        onUplink: (chunk) => uplinkRef.current?.(chunk),
        onLevel: setLevel,
        onNotice: setNotice
      })
    }
    return engineRef.current
  }, [options.loopback])

  const start = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await engine().start()
      setState('listening')
      setNotice(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState('error')
      setNotice({ level: 'error', text: `无法打开麦克风：${message}` })
    } finally {
      setBusy(false)
    }
  }, [engine])

  const stop = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await engine().stop()
      setState('idle')
      setLevel(0)
    } finally {
      setBusy(false)
    }
  }, [engine])

  const toggle = useCallback(async (): Promise<void> => {
    if (engineRef.current?.active) await stop()
    else await start()
  }, [start, stop])

  const getAssistantAudioTrack = useCallback((): MediaStreamTrack | undefined => {
    return engineRef.current?.getAssistantAudioTrack()
  }, [])

  const getMicrophoneAudioTrack = useCallback((): MediaStreamTrack | undefined => {
    return engineRef.current?.getMicrophoneAudioTrack()
  }, [])

  // 未说完仍是聆听；VAD 停止或最终转写到来后才进入思考。
  const applyEvent = useCallback((event: VoiceEvent): void => {
    switch (event.type) {
      case 'input_speech_started':
        // 用户开口即打断当前播报：先停本地播放，主进程也会发 response.cancel
        engineRef.current?.interruptPlayback()
        setState('listening')
        break
      case 'input_transcript':
        setState(event.final ? 'thinking' : 'listening')
        break
      case 'input_speech_stopped':
        setState('thinking')
        break
      case 'response_audio':
        if (event.final) engineRef.current?.finishAudio(event.sampleRate, event.responseId)
        else engineRef.current?.pushAudioBase64(event.audioBase64, event.sampleRate, event.responseId)
        setState('speaking')
        break
      case 'interrupted':
        // 服务端确认取消，闸门放行，下一句回复才播得出来
        engineRef.current?.releaseGate()
        setState('listening')
        break
      case 'response_done':
        engineRef.current?.releaseGate()
        setState('listening')
        break
      case 'notice':
        setNotice({ level: event.level, text: event.text })
        break
      default:
        break
    }
  }, [])

  useEffect(() => {
    return () => {
      void engineRef.current?.stop()
      engineRef.current = null
    }
  }, [])

  return {
    state,
    level,
    notice,
    start,
    stop,
    toggle,
    busy,
    applyEvent,
    getAssistantAudioTrack,
    getMicrophoneAudioTrack
  }
}
