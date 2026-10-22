import { useState } from 'react'
import { USER_NAME_MAX_CHARS, normalizeUserName, type SettingsStatus } from '@shared/contract'

interface SettingsPanelProps {
  status: SettingsStatus
  onClose: () => void
  onChanged: () => void
}

const DOUBAO_LABEL: Record<SettingsStatus['doubao']['status'], string> = {
  missing: '未配置',
  unavailable: '系统加密不可用',
  unreadable: '已存但解不开（请重新录入）',
  verified: '已配置'
}

const VIDU_LABEL: Record<SettingsStatus['vidu']['status'], string> = {
  missing: '未配置',
  unavailable: '系统加密不可用',
  unreadable: '已存但解不开（请重新录入）',
  verified: '已配置'
}

export function SettingsPanel({ status, onClose, onChanged }: SettingsPanelProps): React.JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [instructions, setInstructions] = useState(status.settings.voice.instructions ?? '')
  const [userName, setUserName] = useState(status.settings.voice.userName ?? '')
  const [viduKey, setViduKey] = useState('')
  const [viduEnabled, setViduEnabled] = useState(status.settings.vidu.enabled)
  const [avatarImageUrl, setAvatarImageUrl] = useState(status.settings.vidu.avatarImageUrl)

  const save = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    try {
      await window.assistant.settings.saveDoubaoKey(key.trim())
      setKey('')
      setMessage('已保存（加密存在本机，不会上传）')
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    await window.assistant.settings.clearDoubaoKey()
    setMessage('已清除')
    onChanged()
  }

  /** 立刻生效：下次唤醒用的是新会话，不需要重启 app。 */
  const setConfirmDestructive = async (value: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.assistant.settings.update({ confirmDestructive: value })
      setMessage(value ? '执行命令前会先问你' : '已关闭确认：命令会直接执行')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const saveInstructions = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.assistant.settings.update({ voice: { instructions } })
      setMessage('已保存，下次唤醒生效')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const saveUserName = async (): Promise<void> => {
    setBusy(true)
    try {
      const name = normalizeUserName(userName)
      await window.assistant.settings.update({ voice: { ...status.settings.voice, userName: name } })
      setUserName(name)
      setMessage(name ? `好，以后叫你「${name}」，下次唤醒生效` : '已清除称呼，下次唤醒生效')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const saveViduSettings = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.assistant.settings.update({
        vidu: {
          ...status.settings.vidu,
          enabled: viduEnabled,
          avatarImageUrl: avatarImageUrl.trim(),
          rtcAppId: status.settings.vidu.rtcAppId
        }
      })
      setMessage('Vidu 设置已保存，下次进入会话时生效')
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const saveViduKey = async (): Promise<void> => {
    if (!viduKey.trim() || busy) return
    setBusy(true)
    try {
      await window.assistant.settings.saveViduKey(viduKey.trim())
      setViduKey('')
      setMessage('Vidu API Key 已加密保存在本机')
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <h2>设置</h2>
        <button className="ghost" type="button" onClick={onClose}>
          关闭
        </button>
      </header>

      <section className="field">
        <label htmlFor="doubao-key">豆包 API Key</label>
        <p className="field-hint">
          从火山引擎控制台的「API Key 管理」获取。仅保存在本机（系统钥匙串加密），不会发往任何第三方。
        </p>
        <div className="row">
          <input
            id="doubao-key"
            type="password"
            value={key}
            placeholder={status.doubao.status === 'verified' ? '••••••••（已配置）' : '粘贴 API Key'}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
          />
          <button className="toggle small" type="button" onClick={() => void save()} disabled={busy || !key.trim()}>
            保存
          </button>
        </div>
        <p className="field-status">
          状态：{DOUBAO_LABEL[status.doubao.status]}
          {status.doubao.status !== 'missing' ? (
            <button className="link" type="button" onClick={() => void clear()}>
              清除
            </button>
          ) : null}
        </p>
      </section>

      <section className="field">
        <label htmlFor="vidu-enabled">Vidu 数字人画面</label>
        <p className="field-hint">
          开启后使用 Vidu Live 的官方 RTC 凭证展示数字人画面，不需要手动填写阿里云 RTC AppID/AppKey。未配置完整时不会影响纯语音模式。
        </p>
        <label className="confirm-remember">
          <input
            id="vidu-enabled"
            type="checkbox"
            checked={viduEnabled}
            disabled={busy}
            onChange={(event) => setViduEnabled(event.target.checked)}
          />
          会话中启用数字人
        </label>
        <label htmlFor="vidu-image">数字人图片 URL</label>
        <input
          id="vidu-image"
          type="url"
          value={avatarImageUrl}
          placeholder="https://.../avatar.jpg"
          onChange={(event) => setAvatarImageUrl(event.target.value)}
        />
        <div className="row">
          <button className="toggle small" type="button" onClick={() => void saveViduSettings()} disabled={busy}>
            保存数字人设置
          </button>
        </div>
        <p className="field-status">Vidu API Key：{VIDU_LABEL[status.vidu.status]}</p>
        <div className="row">
          <input
            type="password"
            value={viduKey}
            placeholder="粘贴 vda_... API Key"
            onChange={(event) => setViduKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveViduKey()
            }}
          />
          <button className="toggle small" type="button" onClick={() => void saveViduKey()} disabled={busy || !viduKey.trim()}>
            保存
          </button>
          {status.vidu.status !== 'missing' ? (
            <button className="link" type="button" onClick={() => void window.assistant.settings.clearViduKey().then(onChanged)}>
              清除
            </button>
          ) : null}
        </div>
      </section>

      <section className="field">
        <label htmlFor="user-name">怎么称呼你</label>
        <p className="field-hint">安妮会用这个名字叫你，对话记录里也用它标注你说的话。留空则不叫名字。改完下次唤醒生效。</p>
        <div className="row">
          <input
            id="user-name"
            type="text"
            value={userName}
            maxLength={USER_NAME_MAX_CHARS}
            placeholder="例如：小明"
            onChange={(event) => setUserName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveUserName()
            }}
          />
          <button className="toggle small" type="button" onClick={() => void saveUserName()} disabled={busy}>
            保存
          </button>
        </div>
      </section>

      <section className="field">
        <label htmlFor="persona">补充设定</label>
        <p className="field-hint">补充语气、称呼、习惯说法一类的偏好。改完下次唤醒生效。</p>
        <textarea
          id="persona"
          rows={5}
          value={instructions}
          placeholder="例如：说话别太客气，直接给结论；提到天气时顺便提醒我带伞。"
          onChange={(event) => setInstructions(event.target.value)}
        />
        <div className="row">
          <button className="toggle small" type="button" onClick={() => void saveInstructions()} disabled={busy}>
            保存
          </button>
        </div>
      </section>

      <section className="field">
        <label htmlFor="confirm-destructive">执行命令前先问我</label>
        <p className="field-hint">
          关掉之后，安妮跑命令不再弹确认框，直接执行。她仍然会先说要做什么。
        </p>
        <label className="confirm-remember">
          <input
            id="confirm-destructive"
            type="checkbox"
            checked={status.settings.confirmDestructive}
            disabled={busy}
            onChange={(event) => void setConfirmDestructive(event.target.checked)}
          />
          需要确认（推荐）
        </label>
      </section>

      <section className="field">
        <label>Pi 执行引擎</label>
        <p className="field-status">
          {status.pi.status === 'ready'
            ? `已就绪${status.pi.version ? ` · v${status.pi.version}` : ''}`
            : '未找到，请先 npm i -g @earendil-works/pi-coding-agent'}
        </p>
      </section>

      {message ? <p className="drawer-message">{message}</p> : null}
    </aside>
  )
}
