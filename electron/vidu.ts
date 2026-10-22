import type { Settings, ViduSessionCredentials } from '@shared/contract'

interface ViduLiveResponse {
  live?: { id?: string; status?: string }
  rtc?: {
    provider?: 'artc'
    app_id?: string
    channel_id?: string
    user_id?: string
    token?: string
  }
  client_secret?: string
}

function normalizeHost(host: string): string {
  const parsed = new URL(host)
  if (parsed.protocol !== 'https:') throw new Error('Vidu API 地址必须使用 HTTPS')
  return parsed.origin
}

function readErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string; code?: string | number }
    const message = parsed.message || parsed.error
    if (message) return `${parsed.code ? `${parsed.code}: ` : ''}${message}`
  } catch {
    // 非 JSON 响应直接截断后返回
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export async function createViduLiveSession(options: {
  apiKey: string
  settings: Settings['vidu']
}): Promise<ViduSessionCredentials> {
  const apiHost = normalizeHost(options.settings.apiHost)

  const response = await fetch(`${apiHost}/live/v1/lives`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${options.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      call_mode: 'video',
      avatar: {
        persona: '你是安妮，一个友好、灵动、简洁的中文 AI 助手。',
        image_uri: options.settings.avatarImageUrl
      },
      // Vidu 独立模式的 ASR 和回复都由 Vidu 负责；显式开启后，
      // Vidu 会通过控制 WebSocket 下发 type=9/10 的输入/输出转录事件。
      audio: {
        enable_transcription: true
      }
    }),
    signal: AbortSignal.timeout(20_000)
  })

  const body = await response.text()
  if (!response.ok) {
    throw new Error(`Vidu 会话创建失败（${response.status}）：${readErrorBody(body) || '服务端没有返回原因'}`)
  }

  let payload: ViduLiveResponse
  try {
    payload = JSON.parse(body) as ViduLiveResponse
  } catch {
    throw new Error('Vidu 返回了无法识别的会话数据')
  }

  const liveId = payload.live?.id
  const clientSecret = payload.client_secret
  const rtc = payload.rtc
  if (!liveId || !clientSecret || rtc?.provider !== 'artc' || !rtc.app_id || !rtc.channel_id || !rtc.user_id || !rtc.token) {
    throw new Error('Vidu 返回的会话或 RTC 凭据不完整')
  }

  return {
    liveId,
    clientSecret,
    apiHost,
    rtc: {
      provider: 'artc',
      appId: rtc.app_id,
      channelId: rtc.channel_id,
      userId: rtc.user_id,
      token: rtc.token
    }
  }
}
