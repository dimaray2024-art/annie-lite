import { describe, expect, it } from 'vitest'
import { USER_NAME_MAX_CHARS, normalizeUserName, wakeGreeting } from '../shared/contract'
import { buildInstructions } from '../electron/voice/instructions'

describe('用户称呼', () => {
  it('去掉首尾空白、换行和零宽字符，并限制长度', () => {
    expect(normalizeUserName('  小明 ')).toBe('小明')
    expect(normalizeUserName('小\n明\u200b')).toBe('小明')
    expect(normalizeUserName('a'.repeat(50))).toHaveLength(USER_NAME_MAX_CHARS)
    expect(normalizeUserName(undefined)).toBe('')
    expect(normalizeUserName(42)).toBe('')
  })

  it('唤醒应声：有称呼叫名字，没有就只说我在', () => {
    expect(wakeGreeting('小明')).toBe('小明，我在。')
    expect(wakeGreeting('')).toBe('我在。')
    expect(wakeGreeting()).toBe('我在。')
  })

  it('人设：设置了称呼时直接叫名字', () => {
    const text = buildInstructions({ workspaceRoots: [], hasTools: false, userName: '小明' })
    expect(text).toContain('和你说话的人就是小明')
  })

  it('人设：没设置称呼时不出现任何名字', () => {
    const text = buildInstructions({ workspaceRoots: [], hasTools: false })
    expect(text).toContain('你叫安妮')
    expect(text).toContain('直接用「你」称呼')
    expect(text).not.toMatch(/是.+的女朋友/)
  })
})
