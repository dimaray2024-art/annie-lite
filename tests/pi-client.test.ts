import { describe, expect, it } from 'vitest'
import { readAssistantText } from '../electron/tasks/pi-client'

describe('读取 pi 的助手文本', () => {
  // 这条守的是一个静默故障：pi 回的 data 是 {text}，不是字符串。
  // 按字符串读永远拿到 null，任务照样显示"完成"，只是播报变成"没有输出"——
  // 不报错、不崩溃，所以必须靠测试盯住形状。
  it('pi 返回的是 {text} 对象，不是字符串', () => {
    expect(readAssistantText({ text: '项目里有两处未处理的错误' })).toBe('项目里有两处未处理的错误')
  })

  it('没有助手文本时是 null', () => {
    expect(readAssistantText({ text: null })).toBeNull()
  })

  it('空白文本当成没有，免得播报一句空话', () => {
    expect(readAssistantText({ text: '   \n ' })).toBeNull()
  })

  it('形状不对时返回 null，而不是把乱七八糟的东西念出来', () => {
    expect(readAssistantText(undefined)).toBeNull()
    expect(readAssistantText(null)).toBeNull()
    expect(readAssistantText('一段裸字符串')).toBeNull()
    expect(readAssistantText({ text: 42 })).toBeNull()
  })
})
