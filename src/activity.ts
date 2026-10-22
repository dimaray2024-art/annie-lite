import type { VoiceEvent } from '@shared/contract'
import type { OrbState } from './components/ParticleOrb'

export interface ActivityState {
  tasks: Record<string, string>
  tools: string[]
  userSpeaking: boolean
}

export const INITIAL_ACTIVITY: ActivityState = { tasks: {}, tools: [], userSpeaking: false }

/** 后台任务寿命独立于语音会话、派活工具。按 ID 收尾，不能被另一条完成事件清空。 */
export function activityReducer(state: ActivityState, event: VoiceEvent | { type: 'session_stopped' }): ActivityState {
  switch (event.type) {
    case 'task_started': return { ...state, tasks: { ...state.tasks, [event.taskId]: event.title } }
    case 'task_finished': {
      const tasks = { ...state.tasks }
      delete tasks[event.taskId]
      return { ...state, tasks }
    }
    case 'tool_started': return { ...state, tools: [...state.tools, event.name] }
    case 'tool_finished': {
      const index = state.tools.indexOf(event.name)
      return index < 0 ? state : { ...state, tools: state.tools.filter((_, i) => i !== index) }
    }
    case 'input_speech_started': return { ...state, userSpeaking: true }
    case 'input_speech_stopped': return { ...state, userSpeaking: false }
    case 'input_transcript': return event.final ? { ...state, userSpeaking: false } : state
    case 'session_stopped': return { ...state, tools: [], userSpeaking: false }
    default: return state
  }
}

export function presentationState(voice: OrbState, work: ActivityState, confirming: boolean): OrbState {
  if (voice === 'error') return 'error'
  if (work.userSpeaking) return 'listening'
  if (voice === 'speaking') return 'speaking'
  if (Object.keys(work.tasks).length || (!confirming && work.tools.length)) return 'executing'
  // 等待确认时不假装已经执行。
  if (confirming) return 'idle'
  return voice
}
