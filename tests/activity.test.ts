import { describe, expect, it } from 'vitest'
import { activityReducer, INITIAL_ACTIVITY, presentationState } from '../src/activity'

const task = (id: string) => ({ type: 'task_started' as const, taskId: id, number: 1, title: `任务 ${id}` })
const finish = (id: string) => ({ type: 'task_finished' as const, taskId: id, ok: true })

describe('粒子状态与真实任务生命周期', () => {
  it('派活工具结束不代表后台任务结束', () => {
    let work = activityReducer(INITIAL_ACTIVITY, { type: 'tool_started', name: 'run_pi_task' })
    work = activityReducer(work, task('a'))
    work = activityReducer(work, { type: 'tool_finished', name: 'run_pi_task', ok: true })
    expect(presentationState('listening', work, false)).toBe('executing')
    work = activityReducer(work, finish('a'))
    expect(presentationState('listening', work, false)).toBe('listening')
  })

  it('一项任务完成后，其他任务保持执行动效', () => {
    let work = activityReducer(activityReducer(INITIAL_ACTIVITY, task('a')), task('b'))
    work = activityReducer(work, finish('a'))
    expect(Object.keys(work.tasks)).toEqual(['b'])
    expect(presentationState('idle', work, false)).toBe('executing')
  })

  it('语音待机不清掉仍在运行的后台任务', () => {
    const work = activityReducer(activityReducer(INITIAL_ACTIVITY, task('a')), { type: 'session_stopped' })
    expect(presentationState('idle', work, false)).toBe('executing')
  })

  it('用户插话优先聆听，说完恢复执行', () => {
    let work = activityReducer(INITIAL_ACTIVITY, task('a'))
    work = activityReducer(work, { type: 'input_speech_started' })
    expect(presentationState('speaking', work, false)).toBe('listening')
    work = activityReducer(work, { type: 'input_transcript', text: '继续', final: false })
    expect(presentationState('thinking', work, false)).toBe('listening')
    work = activityReducer(work, { type: 'input_speech_stopped' })
    expect(presentationState('thinking', work, false)).toBe('executing')
  })

  it('回应优先显示说话动效，结束后继续任务动效', () => {
    const work = activityReducer(INITIAL_ACTIVITY, task('a'))
    expect(presentationState('speaking', work, false)).toBe('speaking')
    expect(presentationState('listening', work, false)).toBe('executing')
  })

  it('等待确认的工具不假装在执行，确认后的工具恢复执行', () => {
    const work = activityReducer(INITIAL_ACTIVITY, { type: 'tool_started', name: 'run_command' })
    expect(presentationState('thinking', work, true)).toBe('idle')
    expect(presentationState('thinking', work, false)).toBe('executing')
  })

  it('失败、取消等终止事件也能清除任务动效', () => {
    const work = activityReducer(activityReducer(INITIAL_ACTIVITY, task('a')), { ...finish('a'), ok: false })
    expect(presentationState('idle', work, false)).toBe('idle')
  })

  it('工具结束只移除对应工具，未知完成事件不清空其他工作', () => {
    let work = activityReducer(INITIAL_ACTIVITY, { type: 'tool_started', name: 'read_file' })
    work = activityReducer(work, { type: 'tool_finished', name: 'search_text', ok: true })
    expect(work.tools).toEqual(['read_file'])
    expect(presentationState('error', work, false)).toBe('error')
  })
})
