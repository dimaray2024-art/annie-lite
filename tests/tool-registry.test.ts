import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, type ToolDefinition } from '../electron/voice/tool-registry'

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const schema = z.object({ value: z.string() }).strict()
  return {
    name: 'echo',
    description: '回声',
    parameters: { type: 'object' },
    schema,
    risk: 'read_only',
    destructive: false,
    execute: (args: { value: string }) => `收到 ${args.value}`,
    ...overrides
  } as ToolDefinition
}

const call = (name: string, args: unknown): { callId: string; name: string; arguments: string } => ({
  callId: 'c1',
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args)
})

describe('参数校验', () => {
  it('正常调用返回结果', async () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    const result = await registry.execute(call('echo', { value: '你好' }))
    expect(result).toMatchObject({ ok: true, output: '收到 你好' })
  })

  it('未知工具返回 unknown_tool，而不是抛异常', async () => {
    const registry = new ToolRegistry()
    const result = await registry.execute(call('nope', {}))
    expect(result.error).toBe('unknown_tool')
  })

  it('参数不是合法 JSON', async () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    const result = await registry.execute({ callId: 'c1', name: 'echo', arguments: '{ 坏的' })
    expect(result.error).toBe('invalid_json')
  })

  it('schema 不匹配时报出具体字段', async () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    const result = await registry.execute(call('echo', { value: 123 }))
    expect(result.error).toBe('invalid_arguments')
    expect(result.output).toContain('value')
  })

  it('多余的字段被拒绝（strict），避免模型偷偷塞参数', async () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    const result = await registry.execute(call('echo', { value: 'a', extra: 1 }))
    expect(result.error).toBe('invalid_arguments')
  })

  it('参数过大直接拒绝', async () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    const huge = JSON.stringify({ value: 'x'.repeat(20 * 1024) })
    const result = await registry.execute({ callId: 'c1', name: 'echo', arguments: huge })
    expect(result.error).toBe('arguments_too_large')
  })

  it('结果过大被拒绝（否则会被念很久）', async () => {
    const registry = new ToolRegistry()
    registry.register(tool({ execute: () => 'x'.repeat(40 * 1024) }))
    const result = await registry.execute(call('echo', { value: 'a' }))
    expect(result.error).toBe('result_too_large')
  })
})

describe('超时与错误', () => {
  it('超时返回 timeout', async () => {
    const registry = new ToolRegistry()
    registry.register(
      tool({
        timeoutMs: 30,
        execute: () => new Promise<string>((resolve) => setTimeout(() => resolve('晚了'), 500))
      })
    )
    const result = await registry.execute(call('echo', { value: 'a' }))
    expect(result.error).toBe('timeout')
  })

  it('工具抛的带 code 错误按原码返回', async () => {
    const registry = new ToolRegistry()
    registry.register(
      tool({
        execute: () => {
          const error = new Error('找不到') as Error & { code: string }
          error.code = 'not_found'
          throw error
        }
      })
    )
    const result = await registry.execute(call('echo', { value: 'a' }))
    expect(result.error).toBe('not_found')
  })

  it('未知异常收敛成 execution_failed，不泄露原始信息', async () => {
    const registry = new ToolRegistry()
    registry.register(
      tool({
        execute: () => {
          throw new Error('内部路径 /Users/someone/secret 出错了')
        }
      })
    )
    const result = await registry.execute(call('echo', { value: 'a' }))
    expect(result.error).toBe('execution_failed')
    expect(result.output).not.toContain('secret')
  })
})

describe('破坏性操作的确认', () => {
  const destructive = tool({ name: 'rm', destructive: true, execute: () => '已删除' })

  it('用户同意时执行', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    const registry = new ToolRegistry({ approve })
    registry.register(destructive)
    const result = await registry.execute(call('rm', { value: 'x' }))
    expect(approve).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
  })

  it('用户拒绝时返回 approval_cancelled，且工具没被执行', async () => {
    const execute = vi.fn(() => '已删除')
    const registry = new ToolRegistry({ approve: async () => false })
    registry.register(tool({ name: 'rm', destructive: true, execute }))
    const result = await registry.execute(call('rm', { value: 'x' }))
    expect(result.error).toBe('approval_cancelled')
    expect(execute).not.toHaveBeenCalled()
  })

  it('只读工具不触发确认', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    const registry = new ToolRegistry({ approve })
    registry.register(tool())
    await registry.execute(call('echo', { value: 'a' }))
    expect(approve).not.toHaveBeenCalled()
  })

  it('没有确认钩子时默认拒绝，而不是默默执行', async () => {
    const execute = vi.fn(() => '已删除')
    const registry = new ToolRegistry()
    registry.register(tool({ name: 'rm', destructive: true, execute }))
    const result = await registry.execute(call('rm', { value: 'x' }))
    // 反过来（没钩子就放行）会让"忘了接线"变成"静默执行删除"
    expect(result.error).toBe('approval_unavailable')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('下发给豆包的格式', () => {
  it('工具定义是扁平的：name 与 type 同级', () => {
    const registry = new ToolRegistry()
    registry.register(tool({ name: 'list_directory' }))
    const [entry] = registry.doubaoTools()
    expect(Object.keys(entry!).sort()).toEqual(['description', 'name', 'parameters', 'type'])
    expect(entry!.type).toBe('function')
  })

  it('工具名不合规时拒绝注册', () => {
    const registry = new ToolRegistry()
    expect(() => registry.register(tool({ name: 'Bad-Name' }))).toThrow()
  })

  it('重复注册会报错', () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    expect(() => registry.register(tool())).toThrow(/重复/)
  })
})
