import { WAKE_PHRASE } from '@shared/contract'
import { ParticleOrb, type OrbState } from './ParticleOrb'

const STATE_LABEL: Record<OrbState, string> = {
  idle: '待命',
  listening: '正在聆听',
  thinking: '正在思考',
  executing: '正在执行任务',
  speaking: '正在回应',
  error: '需要注意'
}

interface VoiceStageProps {
  state: OrbState
  level: number
  /** 用户这句话的转写（未定稿时用暗色显示）。 */
  userText: string
  userFinal: boolean
  /** 安妮的回复文本。 */
  assistantText: string
  /** 待机状态，用来提示"说『安妮』就能唤醒我"。 */
  wakeState: string
  /** 会话进行中：这时候点粒子团不该再起一次会话。 */
  sessionActive: boolean
  notice: { level: 'info' | 'warn' | 'error'; text: string } | null
  /** 手动进入会话。唤醒词失灵时的备用入口。 */
  onActivate: () => void
  /**
   * 正在做的事，比如「正在执行命令」。
   *
   * 长操作期间界面上必须有东西在动，否则用户不知道是在办还是卡住了，
   * 只能干等——他明确抱怨过这一点。
   */
  activity: string | null
  /** Vidu 回传的数字人视频；没有配置或尚未连上时继续显示粒子团。 */
  viduVideoRef: React.RefObject<HTMLVideoElement | null>
  viduActive: boolean
}

export function VoiceStage({
  state,
  level,
  userText,
  userFinal,
  assistantText,
  wakeState,
  sessionActive,
  notice,
  onActivate,
  activity,
  viduVideoRef,
  viduActive
}: VoiceStageProps): React.JSX.Element {
  // 待机中且没有任何对话内容时，给一句怎么唤醒的提示——否则界面上什么都不像在等
  const showWakeHint = state === 'idle' && !sessionActive && wakeState === 'listening' && !userText && !assistantText
  const hints: Record<OrbState, string> = {
    idle: '点一下，和我说话',
    listening: '我在听，慢慢说',
    thinking: '正在梳理思路',
    executing: '任务持续处理中，完成后告诉你',
    speaking: '我在回应，随时可以打断',
    error: '请检查语音连接或设置'
  }
  return (
    <main className={`stage${viduActive ? ' is-vidu-active' : ''}`} data-state={state}>
      <p className="state-label">
        <span className="state-dot" />
        {STATE_LABEL[state]}
      </p>

      {/* 粒子团本身就是那个"按钮"。唤醒词不灵的时候，这是唯一的入口，
          所以不能只做成装饰——但会话进行中要禁掉，免得又起一路麦克风 */}
      <button
        className="orb-button"
        type="button"
        onClick={onActivate}
        disabled={sessionActive}
        aria-label={sessionActive ? '会话进行中' : '开始对话'}
        title={sessionActive ? '会话进行中' : '点一下开始对话'}
      >
        <video ref={viduVideoRef} className={`vidu-avatar-video${viduActive ? ' is-active' : ''}`} muted playsInline />
        <ParticleOrb state={state} level={level} />
      </button>

      {/* 长操作进行中：给一行会呼吸的提示，别让人对着不动的界面猜 */}
      {activity ? (
        <p className="activity-line" role="status">
          <span className="activity-dot" />
          {activity}
        </p>
      ) : null}

      <div className="transcript">
        {showWakeHint ? <p className="line hint-line">说「{WAKE_PHRASE}」唤醒我</p> : null}
        {!showWakeHint && !userText && !assistantText ? <p className="line hint-line">{hints[state]}</p> : null}
        {userText ? <p className={`line user${userFinal ? '' : ' pending'}`}>{userText}</p> : null}
        {assistantText ? <p className="line assistant">{assistantText}</p> : null}
      </div>

      {notice ? (
        <div className={`notice notice-${notice.level}`} role="status">
          {notice.text}
        </div>
      ) : null}
    </main>
  )
}
