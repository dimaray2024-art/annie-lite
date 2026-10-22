import { afterEach, describe, expect, it, vi } from 'vitest'
import { createViduLiveSession } from '../electron/vidu'
import { pcm16FromF32Base64 } from '../src/vidu-pcm'
import { parseViduTranscriptSignal } from '../src/vidu-transcript'

describe('Vidu integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('创建 Live 会话时使用 Vidu 返回的 RTC 凭证', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          live: { id: 'live-1' },
          client_secret: 'secret-1',
          rtc: {
            provider: 'artc',
            app_id: 'vidu-app',
            channel_id: 'live-user-live-1',
            user_id: 'live-user-creator-live-1',
            token: 'vidu-token'
          }
        }),
        { status: 200 }
      )
    )
    const session = await createViduLiveSession({
      apiKey: 'vda-test-key',
      settings: {
        enabled: true,
        apiHost: 'https://api.vidu.cn',
        model: 'vidu-s1',
        avatarImageUrl: 'https://example.com/avatar.jpg',
        rtcAppId: 'rtc-app'
      }
    })
    const request = fetchMock.mock.calls[0]
    expect(request?.[0]).toBe('https://api.vidu.cn/live/v1/lives')
    expect(request?.[1]).toMatchObject({ headers: { Authorization: 'Token vda-test-key' } })
    const body = JSON.parse(String((request?.[1] as RequestInit).body)) as Record<string, any>
    expect(body.call_mode).toBe('video')
    expect(body.avatar.image_uri).toBe('https://example.com/avatar.jpg')
    expect(body.avatar.persona).toContain('安妮')
    expect(body.audio.enable_transcription).toBe(true)
    expect(JSON.stringify(body)).not.toContain('vda-test-key')
    expect(session).toMatchObject({
      liveId: 'live-1',
      clientSecret: 'secret-1',
      rtc: {
        provider: 'artc',
        appId: 'vidu-app',
        channelId: 'live-user-live-1',
        userId: 'live-user-creator-live-1',
        token: 'vidu-token'
      }
    })
  })

  it('解析 Vidu 的输入和输出音频转录信令', () => {
    expect(
      parseViduTranscriptSignal({
        type: 9,
        payload: { input_audio_transcription: { text: '惠州天气', is_final: true } }
      })
    ).toEqual({ side: 'user', text: '惠州天气', final: true })
    expect(
      parseViduTranscriptSignal({
        signal_type: 10,
        payload: { output_audio_transcription: { transcript: '惠州今天晴。', final: false } }
      })
    ).toEqual({ side: 'assistant', text: '惠州今天晴。', final: false })
    expect(parseViduTranscriptSignal({ type: 2, payload: { text: '不是转录' } })).toBeUndefined()
  })

  it('把豆包 Float32 音频转成 Vidu 的 little-endian s16', () => {
    const input = new Float32Array([-1, -0.5, 0, 0.5, 1])
    const encoded = Buffer.from(input.buffer).toString('base64')
    const result = pcm16FromF32Base64(encoded)
    const view = new DataView(result.buffer)
    expect([0, 1, 2, 3, 4].map((index) => view.getInt16(index * 2, true))).toEqual([-32768, -16384, 0, 16383, 32767])
  })
})
