import { useEffect, useState } from 'react'
import type { TaskEventItem, TaskSummary } from '@shared/contract'

const STATE_LABEL: Record<TaskSummary['state'], string> = {
  queued: '排队中',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
}

interface TaskPanelProps {
  /** 每次有任务事件时递增，用来触发列表刷新。 */
  revision: number
  onClose: () => void
}

export function TaskPanel({ revision, onClose }: TaskPanelProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selected, setSelected] = useState<{ summary: TaskSummary; events: TaskEventItem[] } | null>(null)

  useEffect(() => {
    window.assistant.tasks
      .list()
      .then(setTasks)
      .catch(() => setTasks([]))
  }, [revision])

  const open = async (taskId: string): Promise<void> => {
    setSelected(await window.assistant.tasks.detail(taskId))
  }

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <h2>任务</h2>
        <button className="ghost" type="button" onClick={onClose}>
          关闭
        </button>
      </header>

      {tasks.length === 0 ? (
        <p className="field-hint">还没有任务。让安妮做点需要动手的事，比如「分析一下这个项目有什么问题」。</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <button className="task-row" type="button" onClick={() => void open(task.id)}>
                <span className={`chip chip-${task.state}`}>{STATE_LABEL[task.state]}</span>
                <span className="task-title">
                  {task.number}. {task.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <section className="field task-detail">
          <div className="drawer-head">
            <h2>
              {selected.summary.number}. {selected.summary.title}
            </h2>
            <button className="ghost" type="button" onClick={() => setSelected(null)}>
              返回
            </button>
          </div>

          {selected.summary.state === 'running' || selected.summary.state === 'queued' ? (
            <button
              className="toggle small"
              type="button"
              onClick={() => {
                void window.assistant.tasks.cancel(selected.summary.id)
                setSelected(null)
              }}
            >
              取消任务
            </button>
          ) : null}

          <div className="task-events">
            {selected.events.length === 0 ? <p className="field-hint">还没有输出。</p> : null}
            {selected.events.map((event, index) => (
              <p key={index} className={`task-event kind-${event.kind}`}>
                {event.text}
              </p>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  )
}
