import { useCallback, useState } from 'react'
import type { VoiceEvent } from '@shared/contract'

export interface TranscriptView {
  /** 用户这句话（流式时是当前识别到的最新版本）。 */
  user: string
  /** 用户这句话是否已定稿。 */
  userFinal: boolean
  /** 安妮的回复。 */
  assistant: string
  applyEvent: (event: VoiceEvent) => void
  reset: () => void
}

/**
 * 把语音事件折成两行文字。
 *
 * 注意两边的增量语义是**不一样**的，混淆会得到重复或残缺的句子：
 * - 用户侧（ASR）发的是**累计文本**，每次都要整体替换
 * - 助手侧（模型回复）发的是**增量片段**，要追加；最终稿再整体替换一次
 */
export function useTranscript(): TranscriptView {
  const [user, setUser] = useState('')
  const [userFinal, setUserFinal] = useState(false)
  const [assistant, setAssistant] = useState('')

  const applyEvent = useCallback((event: VoiceEvent) => {
    switch (event.type) {
      case 'input_speech_started':
        // 新一轮开始：清掉上一轮的回答，准备接新内容
        setAssistant('')
        break
      case 'input_transcript':
        setUser(event.text)
        setUserFinal(event.final)
        if (event.final) setAssistant('')
        break
      case 'response_text':
        if (event.final) setAssistant(event.text)
        else setAssistant((previous) => previous + event.text)
        break
      default:
        break
    }
  }, [])

  const reset = useCallback(() => {
    setUser('')
    setUserFinal(false)
    setAssistant('')
  }, [])

  return { user, userFinal, assistant, applyEvent, reset }
}
