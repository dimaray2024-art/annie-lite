import { useState } from 'react'

export interface ConfirmRequest {
  id: string
  action: string
  target: string
  detail?: string
}

interface ConfirmDialogProps {
  request: ConfirmRequest
  onAnswer: (approved: boolean, remember: boolean) => void
}

/**
 * 破坏性操作的确认框。
 *
 * 这里必须把**要执行的东西原样显示**（命令、路径），而不是"某工具要运行"这种
 * 转述——用户是凭这行字判断危不危险的，转述等于没给信息。
 * 所以默认不做"允许"的快捷键：得让手停下来看一眼。
 */
export function ConfirmDialog({ request, onAnswer }: ConfirmDialogProps): React.JSX.Element {
  const [remember, setRemember] = useState(false)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="需要确认">
      <div className="modal">
        <h2>要动到本机，确认一下</h2>
        <pre className="confirm-target">{request.target}</pre>
        {request.detail ? <p className="confirm-detail">{request.detail}</p> : null}

        <label className="confirm-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          这次对话里不再问
        </label>

        <div className="modal-actions">
          <button className="ghost" type="button" onClick={() => onAnswer(false, false)}>
            不执行
          </button>
          <button className="toggle" type="button" onClick={() => onAnswer(true, remember)}>
            执行
          </button>
        </div>
      </div>
    </div>
  )
}
