import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SafePathService } from '../electron/files'
import { ReminderService } from '../electron/reminders'
import { buildToolRegistry, findApp } from '../electron/voice/tools'

let root: string
let files: SafePathService

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-tools-'))
  fs.mkdirSync(path.join(root, 'projects'))
  fs.writeFileSync(path.join(root, 'readme.md'), '# 标题\n正文里提到了安妮\n')
  fs.writeFileSync(path.join(root, 'readme2.md'), '另一个文件\n')
  files = new SafePathService([root])
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const run = async (name: string, args: unknown): Promise<string> => {
  const registry = buildToolRegistry(files)
  const result = await registry.execute({ callId: 'c1', name, arguments: JSON.stringify(args) })
  if (!result.ok) throw new Error(`${result.error}: ${result.output}`)
  return result.output
}

describe('list_directory', () => {
  // 这条是原型上踩出来的：工具返回多长，安妮就会念多长。
  // 默认带文件名的话，一句"有什么"会变成念几十秒的清单。
  it('默认只给概要不列名字', async () => {
    const output = await run('list_directory', {})
    expect(output).toContain('1 个子目录')
    expect(output).toContain('2 个文件')
    expect(output).not.toContain('readme.md')
  })

  it('明确要求时才列名字', async () => {
    const output = await run('list_directory', { verbose: true })
    expect(output).toContain('readme.md')
    expect(output).toContain('projects')
  })

  it('越界路径被拒绝', async () => {
    const registry = buildToolRegistry(files)
    const result = await registry.execute({
      callId: 'c1',
      name: 'list_directory',
      arguments: JSON.stringify({ path: '/etc' })
    })
    expect(result.error).toBe('outside_authorized_roots')
  })
})

describe('read_file', () => {
  it('返回文件内容', async () => {
    expect(await run('read_file', { path: 'readme.md' })).toContain('安妮')
  })

  it('缺 path 参数时报参数错误', async () => {
    const registry = buildToolRegistry(files)
    const result = await registry.execute({ callId: 'c1', name: 'read_file', arguments: '{}' })
    expect(result.error).toBe('invalid_arguments')
  })
})

describe('search_text', () => {
  it('能搜到内容并给出文件与行号', async () => {
    const output = await run('search_text', { query: '安妮' })
    expect(output).toContain('readme.md')
    expect(output).toContain('2') // 行号
  })

  it('搜不到时明确说没有，而不是返回空串', async () => {
    const output = await run('search_text', { query: '这个词肯定不存在zzz' })
    expect(output).toContain('没有找到')
  })
})

describe('calculate', () => {
  it('四则运算', async () => {
    expect(await run('calculate', { operation: 'add', operands: [2, 3, 4] })).toContain('9')
    expect(await run('calculate', { operation: 'multiply', operands: [6, 7] })).toContain('42')
  })

  it('除以零不返回 Infinity，而是明确说算不出来', async () => {
    const output = await run('calculate', { operation: 'divide', operands: [1, 0] })
    expect(output).toContain('算不出来')
    expect(output).not.toContain('Infinity')
  })

  it('少于两个操作数被 schema 拒绝', async () => {
    const registry = buildToolRegistry(files)
    const result = await registry.execute({
      callId: 'c1',
      name: 'calculate',
      arguments: JSON.stringify({ operation: 'add', operands: [1] })
    })
    expect(result.error).toBe('invalid_arguments')
  })
})

describe('get_current_time', () => {
  it('返回可读的时间', async () => {
    expect(await run('get_current_time', {})).toContain('现在是')
  })
})

describe('get_weather', () => {
  it('查询地点并返回当前天气与今日预报', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('geocoding-api.open-meteo.com')) {
        return new Response(
          JSON.stringify({ results: [{ name: '惠州', latitude: 23.11, longitude: 114.42 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 28,
            apparent_temperature: 31,
            relative_humidity_2m: 82,
            weather_code: 80,
            wind_speed_10m: 12
          },
          daily: {
            temperature_2m_max: [31],
            temperature_2m_min: [25],
            precipitation_probability_max: [70],
            weather_code: [61]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    try {
      const registry = buildToolRegistry(files)
      const result = await registry.execute({
        callId: 'weather-1',
        name: 'get_weather',
        arguments: JSON.stringify({ location: '惠州' })
      })
      expect(result.ok).toBe(true)
      expect(result.output).toContain('惠州')
      expect(result.output).toContain('28°C')
      expect(result.output).toContain('降雨概率 70%')
      expect(result.speech).toBeUndefined()
    } finally {
      fetchMock.mockRestore()
    }
  })
})

describe('高频工具', () => {
  it('设置提醒并持久化', async () => {
    const stateFile = path.join(root, 'reminders.json')
    const reminders = new ReminderService({ stateFile, onDue: () => undefined })
    const registry = buildToolRegistry(files, { reminders })
    const result = await registry.execute({
      callId: 'reminder-1',
      name: 'set_reminder',
      arguments: JSON.stringify({ message: '起来活动一下', delaySeconds: 60 })
    })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('起来活动一下')
    expect(reminders.list()).toHaveLength(1)
    reminders.stop()
  })

  it('搜索网页并提取结果摘要', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<a class="result__a" href="https://example.com">示例 <b>结果</b></a><a class="result__snippet">这是摘要。</a>',
        { status: 200 }
      )
    )
    try {
      const result = await buildToolRegistry(files).execute({
        callId: 'search-1',
        name: 'search_web',
        arguments: JSON.stringify({ query: '安妮' })
      })
      expect(result.ok).toBe(true)
      expect(result.output).toContain('示例 结果')
      expect(result.output).toContain('这是摘要')
    } finally {
      fetchMock.mockRestore()
    }
  })
})

describe('工具清单', () => {
  it('注册的工具清单', () => {
    const names = buildToolRegistry(files)
      .descriptors()
      .map((tool) => tool.name)
      .sort()
    expect(names).toEqual([
      'calculate',
      'get_calendar_events',
      'get_clipboard',
      'get_current_time',
      'get_system_status',
      'get_weather',
      'list_directory',
      'open_app',
      'open_web',
      'read_file',
      'run_command',
      'search_text',
      'search_web',
      'set_reminder'
    ])
  })

  // 早先这条断言的是"破坏性工具一个都没有"，理由是"确认保护还没做"。
  // 现在保护有了（ConfirmationService + 确认框），run_command 才敢注册进来。
  // 所以改成钉住"破坏性工具只有它一个"：以后再加破坏性工具，
  // 必须同时想清楚它的确认路径，而不是顺手注册进去。
  it('破坏性工具只有 run_command，且它必须走确认', () => {
    const destructive = buildToolRegistry(files)
      .descriptors()
      .filter((tool) => tool.destructive)
    expect(destructive.map((tool) => tool.name)).toEqual(['run_command'])
  })
})

describe('run_command', () => {
  it('一律需要确认：没接确认通道时直接拒绝，不执行', async () => {
    const registry = buildToolRegistry(files)
    // 这条是红线：宁可拒绝，也不能在没有确认通道时把命令跑出去
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'echo 不该被执行' })
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('approval_unavailable')
  })

  // 只念结论，不念"我刚跑了什么命令"——把命令一起念出来，
  // 一句"看看电脑配置"会变成听一长串 system_profiler 的管道
  it('用户同意后执行，只念输出，不念命令本身', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'echo 三点一四' })
    })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('三点一四')
  })

  it('多行输出按行拼起来念，不保留对齐用的空格', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'printf "  型号: Mac mini\\n  芯片: M4\\n"' })
    })
    expect(result.output).toBe('型号: Mac mini；芯片: M4')
  })

  it('用户拒绝时明确说没执行，而不是假装跑过了', async () => {
    const registry = buildToolRegistry(files, { approve: async () => false })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'rm -rf 789' })
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('approval_cancelled')
  })

  it('命令失败也照实说，带上退出码', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'exit 3' })
    })
    expect(result.ok).toBe(true) // 工具本身成功了，是命令失败
    expect(result.output).toContain('退出码 3')
  })

  it('工作目录必须在授权范围内', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'pwd', cwd: '/etc' })
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('outside_authorized_roots')
  })
})

describe('命令播报的措辞', () => {
  // 没输出的命令（mkdir、git add 这类）不该被说成"没有任何输出"——
  // 那是系统状态描述。但也不能一声不吭：用户刚点过"执行"
  it('命令没输出时说一声办好了，不提"没有输出"', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'true' })
    })
    expect(result.output).toBe('办好了。')
  })

  // 失败时反过来要带上命令：用户得知道是哪件事没成
  it('失败时带上命令和退出码', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'exit 4' })
    })
    expect(result.output).toBe('`exit 4` 失败了，退出码 4。')
  })
})

describe('open_app', () => {
  // 安全边界：传进来的路径只当线索用，**返回的路径一定出自我们允许的目录**。
  // 这样模型没法诱导我们去打开任意位置的文件。
  it('传路径进来也只取文件名当线索，不会真去打开那个路径', () => {
    const found = findApp('/tmp/完全不相干的目录/Calculator.app')
    expect(found).not.toContain('/tmp/')
    expect(found?.endsWith('/Calculator.app')).toBe(true)
  })

  it('标准目录里没有的，就是找不到', () => {
    expect(findApp('/tmp/没有这个应用xyzzy.app')).toBeNull()
  })

  it('忽略 .app 后缀和大小写', () => {
    const withSuffix = findApp('Calculator.app')
    const upper = findApp('CALCULATOR')
    expect(withSuffix).toBe(upper)
  })

  // 找不到就说找不到。之前这里是模型改用 run_command 去 find，
  // 然后把一整屏 png 路径念出来——用户听到的就是那串东西
  it('找不到时如实说找不到，不返回候选清单', async () => {
    const registry = buildToolRegistry(files)
    const result = await registry.execute({
      callId: 'c1',
      name: 'open_app',
      arguments: JSON.stringify({ name: '这个名字肯定不存在应用xyzzy' })
    })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('没有找到叫「这个名字肯定不存在应用xyzzy」的应用。')
  })

  it('打开应用不需要确认（它不改本机状态）', () => {
    const open = buildToolRegistry(files)
      .descriptors()
      .find((tool) => tool.name === 'open_app')
    expect(open?.destructive).toBe(false)
  })
})

describe('命令输出只念开头', () => {
  // 用户的原话：「不要给我输出一堆日志文件」。find 一个应用目录会吐成屏的 png 路径，
  // 全念出来是一分钟不停的机器噪音
  it('超过三行只念前三行，末尾提示还有', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'printf "第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n"' })
    })
    expect(result.output).toBe('第一行；第二行；第三行……')
  })

  it('三行以内不截断，也不加省略号', async () => {
    const registry = buildToolRegistry(files, { approve: async () => true })
    const result = await registry.execute({
      callId: 'c1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'printf "第一行\\n第二行\\n"' })
    })
    expect(result.output).toBe('第一行；第二行')
  })
})
