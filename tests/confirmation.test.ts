import { describe, expect, it, vi } from 'vitest'
import { ConfirmationService, type ConfirmationRequest } from '../electron/voice/confirmation'

const REQUEST: ConfirmationRequest = { action: 'run_command', target: 'rm -rf 789' }

function setup(options: { deliver?: boolean; timeoutMs?: number } = {}): {
  service: ConfirmationService
  asked: Array<ConfirmationRequest & { id: string }>
} {
  const asked: Array<ConfirmationRequest & { id: string }> = []
  const service = new ConfirmationService({
    ask: (request) => {
      asked.push(request)
      return options.deliver ?? true
    },
    timeoutMs: options.timeoutMs
  })
  return { service, asked }
}

describe('破坏性操作的确认', () => {
  // 这条是红线：问不出去就必须拒绝。写成"问不出去就放行"的话，
  // 哪天忘了接界面，删除命令会静默执行，用户根本来不及发现。
  it('问题递不出去时拒绝，而不是放行', async () => {
    const { service } = setup({ deliver: false })
    expect(await service.confirm(REQUEST)).toBe(false)
  })

  it('用户同意才返回 true', async () => {
    const { service, asked } = setup()
    const answer = service.confirm(REQUEST)
    await Promise.resolve()
    service.answer(asked[0]!.id, true)
    expect(await answer).toBe(true)
  })

  it('用户拒绝就返回 false', async () => {
    const { service, asked } = setup()
    const answer = service.confirm(REQUEST)
    await Promise.resolve()
    service.answer(asked[0]!.id, false)
    expect(await answer).toBe(false)
  })

  it('勾了「不再问」之后，同一工具直接放行、不再弹框', async () => {
    const { service, asked } = setup()
    const first = service.confirm(REQUEST)
    await Promise.resolve()
    service.answer(asked[0]!.id, true, true)
    await first

    expect(await service.confirm({ action: 'run_command', target: 'ls' })).toBe(true)
    expect(asked).toHaveLength(1) // 第二次没有再去打扰用户
  })

  it('「不再问」只对本工具生效，别的破坏性工具照样问', async () => {
    const { service, asked } = setup()
    const first = service.confirm(REQUEST)
    await Promise.resolve()
    service.answer(asked[0]!.id, true, true)
    await first

    void service.confirm({ action: 'delete_file', target: 'a.txt' })
    await Promise.resolve()
    expect(asked).toHaveLength(2)
  })

  it('没人回答就超时拒绝，不会一直挂着', async () => {
    vi.useFakeTimers()
    try {
      const { service } = setup({ timeoutMs: 1000 })
      const answer = service.confirm(REQUEST)
      await vi.advanceTimersByTimeAsync(1200)
      expect(await answer).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // 会话结束时待答的必须收掉：不然用户早就走开了，脚本还在后台等一个永远不会来的回答
  it('会话结束：待答的按拒绝处理，「不再问」也一并作废', async () => {
    const { service, asked } = setup()
    const pending = service.confirm(REQUEST)
    await Promise.resolve()
    service.reset()

    expect(await pending).toBe(false)
    expect(service.waiting).toBe(false)

    // 作废之后要重新问过
    void service.confirm({ action: 'run_command', target: 'ls' })
    await Promise.resolve()
    expect(asked).toHaveLength(2)
  })

  it('认不出的 id 当没听见，不影响还在等的那一个', async () => {
    const { service, asked } = setup()
    const answer = service.confirm(REQUEST)
    await Promise.resolve()
    service.answer('不存在的-id', true)
    expect(service.waiting).toBe(true)
    service.answer(asked[0]!.id, true)
    expect(await answer).toBe(true)
  })
})
