// 通过开发服务器 /tests/visual/particles.html 打开；不访问麦克风、IPC 或供应商。
import React, { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VoiceStage } from '../../src/components/VoiceStage'
import type { OrbState } from '../../src/components/ParticleOrb'
import '../../src/styles.css'

const states: Array<[OrbState, string]> = [['idle', '待命'], ['listening', '聆听'], ['thinking', '思考'], ['executing', '执行任务'], ['speaking', '回应'], ['error', '错误']]
function Preview() {
  const [state, setState] = useState<OrbState>('idle')
  const [level, setLevel] = useState(0.16)
  return <div className="app">
    <header className="drag-region"><span className="brand">Annie</span><span className="badge">粒子效果预览 · 无麦克风连接</span></header>
    <VoiceStage state={state} level={level} userText="" userFinal={true} assistantText="" wakeState="listening" sessionActive={false} notice={null} onActivate={() => setState(state === 'idle' ? 'listening' : 'idle')} activity={state === 'executing' ? '正在整理项目资料…（演示）' : null}/>
    <footer className="status" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
      {states.map(([value, label]) => <button key={value} className="toggle small" aria-pressed={state === value} style={{ background: state === value ? '#204659' : undefined }} onClick={() => setState(value)}>{label}</button>)}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>输入电平<input aria-label="输入电平" type="range" min="0" max="0.42" step="0.01" value={level} onChange={e => setLevel(Number(e.target.value))}/></label>
    </footer>
  </div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Preview/></StrictMode>)
