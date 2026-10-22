export interface ViduTranscriptEvent {
  side: 'user' | 'assistant'
  text: string
  final: boolean
}

interface ViduTranscriptSignal {
  type?: number
  signal_type?: number
  payload?: Record<string, unknown>
}

const TRANSCRIPT_TEXT_KEYS = ['text', 'transcript', 'content', 'delta', 'sentence', 'value'] as const
const TRANSCRIPT_FINAL_KEYS = ['final', 'is_final', 'isFinal', 'finished', 'is_finished', 'done', 'complete'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findTranscriptPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (TRANSCRIPT_TEXT_KEYS.some((key) => typeof value[key] === 'string')) return value

  // Vidu 文档固定了 signal type=9/10，但 payload 的包裹字段会随版本变化；
  // 优先走常见字段，再递归一层，兼容 input_audio_transcription 等命名。
  const preferredKeys = [
    'audio_transcription',
    'input_audio_transcription',
    'output_audio_transcription',
    'input_transcription',
    'output_transcription',
    'transcription',
    'asr',
    'tts',
    'result'
  ]
  for (const key of preferredKeys) {
    const found = findTranscriptPayload(value[key])
    if (found) return found
  }
  for (const child of Object.values(value)) {
    const found = findTranscriptPayload(child)
    if (found) return found
  }
  return undefined
}

function readTranscriptText(payload: Record<string, unknown>): string | undefined {
  for (const key of TRANSCRIPT_TEXT_KEYS) {
    const text = payload[key]
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return undefined
}

function readTranscriptFinal(payload: Record<string, unknown>): boolean {
  for (const key of TRANSCRIPT_FINAL_KEYS) {
    if (typeof payload[key] === 'boolean') return payload[key]
  }
  if (typeof payload.status === 'string') return ['final', 'finished', 'done', 'complete'].includes(payload.status)
  return false
}

/** 将 Vidu Live 的 type=9/10 音频转录信令折成 UI 使用的两类文本事件。 */
export function parseViduTranscriptSignal(signal: ViduTranscriptSignal): ViduTranscriptEvent | undefined {
  const signalType = signal.type ?? signal.signal_type
  if (signalType !== 9 && signalType !== 10) return undefined
  const payload = findTranscriptPayload(signal.payload)
  const text = payload ? readTranscriptText(payload) : undefined
  if (!text) return undefined
  return {
    side: signalType === 9 ? 'user' : 'assistant',
    text,
    final: payload ? readTranscriptFinal(payload) : false
  }
}
