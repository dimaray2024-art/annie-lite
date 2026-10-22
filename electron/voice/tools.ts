/**
 * 第一版工具集。
 *
 * 一条贯穿所有工具的设计约束：**工具返回多长，安妮就会念多长**。
 * 所以默认输出都是"概要和结论"，把明细留给界面——目录列表默认只报数量和占用体积，
 * 用户明确要求列名字时才带 verbose。这一条是从原型上踩出来的：把文件名全返回，
 * 一句话的播报会变成念 45 秒的清单。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { clipboard, powerMonitor, shell } from 'electron'
import { z } from 'zod'
import type { ToolDescriptor } from '@shared/contract'
import { PathDenied, type SafePathService } from '../files'
import { MemoryWriteRejected, type MemoryService } from '../memory'
import { runCommand, type CommandResult } from '../process'
import type { ReminderService } from '../reminders'
import type { TaskService } from '../tasks/service'
import { ToolRegistry, type ApprovalHook, type ToolDefinition } from './tool-registry'

const execFileAsync = promisify(execFile)

/** 单次读取的上限。再大也不适合念出来。 */
const MAX_READ_BYTES = 64 * 1024

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const listDirectorySchema = z.object({ path: z.string().optional(), verbose: z.boolean().optional() }).strict()

function listDirectory(files: SafePathService): ToolDefinition<typeof listDirectorySchema> {
  return {
    name: 'list_directory',
    description:
      '查看本机某个目录里有什么。默认只返回数量与占用体积的概要；' +
      '只有用户明确要求"列出名字"时才把 verbose 设为 true。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "目录路径；省略表示第一个授权目录" },
        verbose: { type: 'boolean', description: '是否逐个列出名称。默认 false' }
      }
    },
    schema: listDirectorySchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 5000,
    execute: (args) => {
      const result = files.list(args.path ?? '', 200)
      const dirs = result.entries.filter((entry) => entry.type === 'dir')
      const regular = result.entries.filter((entry) => entry.type === 'file')
      const totalBytes = regular.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)

      const lines = [
        `${result.path} 下有 ${dirs.length} 个子目录、${regular.length} 个文件，合计 ${humanBytes(totalBytes)}。`
      ]
      if (args.verbose) {
        if (dirs.length > 0) lines.push(`子目录：${dirs.map((entry) => entry.name).join('、')}`)
        if (regular.length > 0) lines.push(`文件：${regular.map((entry) => entry.name).join('、')}`)
      }
      if (result.truncated) lines.push('（条目过多，只列举了一部分）')
      return lines.join('\n')
    }
  }
}

const readFileSchema = z.object({ path: z.string().min(1), maxBytes: z.number().int().positive().optional() }).strict()

function readFile(files: SafePathService): ToolDefinition<typeof readFileSchema> {
  return {
    name: 'read_file',
    description: '读取一个文本文件的内容。用户问"某个文件里写了什么"时用它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        maxBytes: { type: 'number', description: '最多读取的字节数，默认 65536' }
      },
      required: ['path']
    },
    schema: readFileSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 5000,
    execute: (args) => {
      const result = files.readText(args.path, Math.min(args.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES))
      const tail = result.truncated ? `\n（文件更长，这里只读了开头 ${result.lines} 行）` : ''
      return `${result.path} 的内容：\n${result.text}${tail}`
    }
  }
}

/** rg 缺失时的兜底：受深度和文件数限制的朴素搜索，宁可慢也不能扫爆磁盘。 */
function fallbackSearch(root: string, query: string, maxResults: number): string[] {
  const hits: string[] = []
  const queue = [root]
  let visited = 0
  while (queue.length > 0 && hits.length < maxResults && visited < 2000) {
    const current = queue.shift()!
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue
      const full = path.join(current, dirent.name)
      if (dirent.isDirectory()) {
        queue.push(full)
        continue
      }
      visited += 1
      try {
        if (fs.statSync(full).size > 1024 * 1024) continue
        const content = fs.readFileSync(full, 'utf8')
        if (content.includes('\0')) continue
        content.split('\n').forEach((line, index) => {
          if (hits.length < maxResults && line.includes(query)) hits.push(`${full}:${index + 1}: ${line.trim().slice(0, 160)}`)
        })
      } catch {
        // 读不了就跳过
      }
      if (hits.length >= maxResults) break
    }
  }
  return hits
}

const searchTextSchema = z
  .object({
    query: z.string().min(1).max(256),
    path: z.string().optional(),
    maxResults: z.number().int().min(1).max(100).optional()
  })
  .strict()

function searchText(files: SafePathService): ToolDefinition<typeof searchTextSchema> {
  return {
    name: 'search_text',
    description: '在目录中搜索包含某段文本的文件。用户问"哪里用到了 X"时用它。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文本' },
        path: { type: 'string', description: '搜索目录；省略表示第一个授权目录' },
        maxResults: { type: 'number', description: '最多返回多少条，默认 20' }
      },
      required: ['query']
    },
    schema: searchTextSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 15_000,
    execute: async (args) => {
      const root = files.resolve(args.path ?? '', { allowMissing: true })
      const maxResults = args.maxResults ?? 20

      let lines: string[] = []
      try {
        const { stdout } = await execFileAsync(
          'rg',
          ['-n', '--no-heading', '--max-count', '2', '-g', '!node_modules', '-g', '!.git', args.query, root],
          { timeout: 12_000, maxBuffer: 4 * 1024 * 1024 }
        )
        lines = stdout.split('\n').filter(Boolean).slice(0, maxResults)
      } catch {
        // rg 没装或没命中：走到兜底实现
        lines = fallbackSearch(root, args.query, maxResults)
      }

      if (lines.length === 0) return `没有找到包含「${args.query}」的内容。`
      return `搜索「${args.query}」命中 ${lines.length} 处：\n${lines.join('\n')}`
    }
  }
}

const getCurrentTimeSchema = z.object({ timeZone: z.string().optional() }).strict()

function getCurrentTime(): ToolDefinition<typeof getCurrentTimeSchema> {
  return {
    name: 'get_current_time',
    description: '查询当前日期和时间。',
    parameters: {
      type: 'object',
      properties: { timeZone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai' } }
    },
    schema: getCurrentTimeSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 2000,
    execute: (args) => {
      const now = new Date()
      const formatted = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: args.timeZone
      }).format(now)
      return `现在是 ${formatted}。`
    }
  }
}

const getWeatherSchema = z.object({ location: z.string().min(1).max(80).optional() }).strict()

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function firstNumber(value: unknown): number | undefined {
  return Array.isArray(value) ? asNumber(value[0]) : undefined
}

function weatherLabel(code: number | undefined): string {
  if (code === 0) return '晴'
  if (code === 1) return '大部晴朗'
  if (code === 2) return '局部多云'
  if (code === 3) return '阴天'
  if (code === 45 || code === 48) return '有雾'
  if (code === 51 || code === 53 || code === 55) return '毛毛雨'
  if (code === 56 || code === 57) return '冻毛毛雨'
  if (code === 61) return '小雨'
  if (code === 63) return '中雨'
  if (code === 65) return '大雨'
  if (code === 66 || code === 67) return '冻雨'
  if (code === 71 || code === 73 || code === 75 || code === 77) return '降雪'
  if (code === 80) return '阵雨'
  if (code === 81) return '中阵雨'
  if (code === 82) return '强阵雨'
  if (code === 85 || code === 86) return '阵雪'
  if (code === 95 || code === 96 || code === 99) return '雷雨'
  return '天气情况未知'
}

function serviceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

async function fetchWeatherJson(url: string, signal: AbortSignal): Promise<JsonObject> {
  let response: Response
  try {
    response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  } catch {
    throw serviceError('weather_unavailable', '天气服务暂时不可用')
  }
  if (!response.ok) throw serviceError('weather_unavailable', `天气服务返回 ${response.status}`)
  const body = asObject(await response.json())
  if (!body) throw serviceError('weather_unavailable', '天气服务返回了无效数据')
  return body
}

async function queryWeather(location: string, signal: AbortSignal): Promise<string> {
  const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search')
  geocodeUrl.search = new URLSearchParams({
    name: location,
    count: '1',
    language: 'zh',
    format: 'json'
  }).toString()
  const geocode = await fetchWeatherJson(geocodeUrl.toString(), signal)
  const results = Array.isArray(geocode.results) ? geocode.results : []
  const place = asObject(results[0])
  const latitude = asNumber(place?.latitude)
  const longitude = asNumber(place?.longitude)
  if (latitude === undefined || longitude === undefined) {
    throw serviceError('weather_location_not_found', `找不到地点「${location}」`)
  }

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast')
  forecastUrl.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    timezone: 'Asia/Shanghai',
    forecast_days: '1'
  }).toString()
  const forecast = await fetchWeatherJson(forecastUrl.toString(), signal)
  const current = asObject(forecast.current)
  const daily = asObject(forecast.daily)
  const name = typeof place?.name === 'string' ? place.name : location
  const temperature = asNumber(current?.temperature_2m)
  const apparent = asNumber(current?.apparent_temperature)
  const humidity = asNumber(current?.relative_humidity_2m)
  const wind = asNumber(current?.wind_speed_10m)
  const currentCode = asNumber(current?.weather_code)
  const maximum = firstNumber(daily?.temperature_2m_max)
  const minimum = firstNumber(daily?.temperature_2m_min)
  const rainChance = firstNumber(daily?.precipitation_probability_max)
  const dailyCode = firstNumber(daily?.weather_code)

  const currentParts = [
    temperature === undefined ? undefined : `${Math.round(temperature)}°C`,
    apparent === undefined ? undefined : `体感 ${Math.round(apparent)}°C`,
    weatherLabel(currentCode),
    humidity === undefined ? undefined : `湿度 ${Math.round(humidity)}%`,
    wind === undefined ? undefined : `风速 ${Math.round(wind)} km/h`
  ].filter((part): part is string => Boolean(part))
  const todayParts = [
    minimum === undefined || maximum === undefined ? undefined : `今天 ${Math.round(minimum)}～${Math.round(maximum)}°C`,
    `预计${weatherLabel(dailyCode)}`,
    rainChance === undefined ? undefined : `降雨概率 ${Math.round(rainChance)}%`
  ].filter((part): part is string => Boolean(part))
  return `${name}现在 ${currentParts.join('，')}。${todayParts.join('，')}。`
}

function getWeather(): ToolDefinition<typeof getWeatherSchema> {
  return {
    name: 'get_weather',
    description: '查询实时天气和今天预报。用户问天气、温度、下雨或是否带伞时必须调用这个工具，不要只说去查询；地点省略时默认查询惠州。',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: '城市或地区名称，例如 惠州；省略默认惠州' } }
    },
    schema: getWeatherSchema,
    risk: 'read_only',
    destructive: false,
    speakResult: true,
    timeoutMs: 15_000,
    execute: async (args, { signal }) => {
      return queryWeather(args.location ?? '惠州', signal)
    }
  }
}

const setReminderSchema = z
  .object({
    message: z.string().min(1).max(200),
    delaySeconds: z.number().int().min(10).max(7 * 24 * 60 * 60)
  })
  .strict()

function setReminderTool(reminders?: ReminderService): ToolDefinition<typeof setReminderSchema> {
  return {
    name: 'set_reminder',
    description:
      '设置一次性提醒。用户说“几分钟后提醒我”“一小时后提醒我”时必须调用。把时间换算成 delaySeconds，提醒内容放到 message。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '到时间要提醒用户的内容' },
        delaySeconds: { type: 'integer', description: '延迟秒数，至少 10 秒，最多 7 天' }
      },
      required: ['message', 'delaySeconds']
    },
    schema: setReminderSchema,
    risk: 'side_effect',
    destructive: false,
    speakResult: true,
    timeoutMs: 2000,
    execute: (args) => {
      if (!reminders) throw serviceError('reminders_unavailable', '提醒服务还没有启动')
      const reminder = reminders.add(args.message, args.delaySeconds)
      const seconds = args.delaySeconds
      const when = seconds % 3600 === 0 ? `${seconds / 3600} 小时` : seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`
      return `已设置提醒：${when}后提醒你「${reminder.message}」。`
    }
  }
}

const getCalendarEventsSchema = z
  .object({
    startDay: z.enum(['today', 'tomorrow']).optional(),
    days: z.number().int().min(1).max(7).optional()
  })
  .strict()

function getCalendarEvents(): ToolDefinition<typeof getCalendarEventsSchema> {
  return {
    name: 'get_calendar_events',
    description: '查询 macOS 日历的安排。今天查询传 startDay=today，明天查询传 startDay=tomorrow；days 表示连续查询几天。不要凭空回答。',
    parameters: {
      type: 'object',
      properties: {
        startDay: { type: 'string', enum: ['today', 'tomorrow'], description: '从今天或明天开始，默认 today' },
        days: { type: 'integer', description: '连续查询几天，默认 1，最多 7' }
      }
    },
    schema: getCalendarEventsSchema,
    risk: 'read_only',
    destructive: false,
    speakResult: true,
    timeoutMs: 10_000,
    execute: async (args) => {
      if (process.platform !== 'darwin') return '日历查询目前只支持 macOS。'
      const days = args.days ?? 1
      const startOffset = args.startDay === 'tomorrow' ? 1 : 0
      const script = `
set startDate to (current date) + (${startOffset} * days)
set time of startDate to 0
set endDate to startDate + (${days} * days)
set rows to {}
tell application "Calendar"
  repeat with calendarItem in calendars
    repeat with eventItem in (every event of calendarItem whose start date < endDate and end date > startDate)
      set eventTitle to summary of eventItem as text
      set eventStart to start date of eventItem
      set end of rows to eventTitle & "｜" & (eventStart as text)
    end repeat
  end repeat
end tell
if (count of rows) is 0 then return ""
set AppleScript's text item delimiters to linefeed
return rows as text`
      try {
        const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 8000, maxBuffer: 256 * 1024 })
        const rows = stdout
          .trim()
          .split('\n')
          .map((row) => row.trim())
          .filter(Boolean)
          .slice(0, 20)
        const label = args.startDay === 'tomorrow' ? '明天起' : '今天起'
        return rows.length > 0 ? `${label} ${days} 天的日程：\n${rows.join('\n')}` : `${label} ${days} 天没有日程。`
      } catch {
        return '暂时无法读取日历，请在系统设置里允许安妮访问日历。'
      }
    }
  }
}

const getClipboardSchema = z.object({ maxChars: z.number().int().min(100).max(4000).optional() }).strict()

function getClipboard(): ToolDefinition<typeof getClipboardSchema> {
  return {
    name: 'get_clipboard',
    description: '读取当前剪贴板文字。用户说“读一下我刚复制的”“总结剪贴板”时调用；只读取，不修改剪贴板。',
    parameters: {
      type: 'object',
      properties: { maxChars: { type: 'integer', description: '最多读取字符数，默认 2000' } }
    },
    schema: getClipboardSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 1000,
    execute: (args) => {
      const text = clipboard.readText()
      if (!text) return '剪贴板目前是空的。'
      const maxChars = args.maxChars ?? 2000
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}……（内容较长，已截断）` : text
      return `剪贴板内容：\n${clipped}`
    }
  }
}

const getSystemStatusSchema = z
  .object({ scope: z.enum(['all', 'battery', 'memory', 'disk']).optional() })
  .strict()

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

async function batterySummary(): Promise<string> {
  if (process.platform !== 'darwin') return `电池状态：${powerMonitor.isOnBatteryPower() ? '使用电池' : '接通电源'}`
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { timeout: 2000 })
    const percent = stdout.match(/(\d+)%/)?.[1]
    const source = stdout.includes('AC Power') ? '接通电源' : '使用电池'
    return `电量 ${percent ? `${percent}%` : '未知'}，${source}`
  } catch {
    return `电池状态：${powerMonitor.isOnBatteryPower() ? '使用电池' : '接通电源'}`
  }
}

function getSystemStatus(): ToolDefinition<typeof getSystemStatusSchema> {
  return {
    name: 'get_system_status',
    description: '查询本机系统状态：电量、内存、磁盘空间、设备信息。用户问“电脑现在怎么样”“还有多少空间”时调用。',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['all', 'battery', 'memory', 'disk'] } }
    },
    schema: getSystemStatusSchema,
    risk: 'read_only',
    destructive: false,
    speakResult: true,
    timeoutMs: 5000,
    execute: async (args) => {
      const scope = args.scope ?? 'all'
      const lines: string[] = []
      if (scope === 'all' || scope === 'battery') lines.push(await batterySummary())
      if (scope === 'all' || scope === 'memory') {
        const total = os.totalmem()
        const free = os.freemem()
        lines.push(`内存已用 ${formatBytes(total - free)}，剩余 ${formatBytes(free)}`)
      }
      if (scope === 'all' || scope === 'disk') {
        try {
          const stats = fs.statfsSync(os.homedir())
          const available = Number(stats.bavail) * Number(stats.bsize)
          lines.push(`主磁盘剩余 ${formatBytes(available)}`)
        } catch {
          lines.push('主磁盘空间暂时无法读取')
        }
      }
      if (scope === 'all') lines.push(`设备：${os.cpus()[0]?.model ?? os.platform()}，${os.arch()}`)
      return lines.join('；') + '。'
    }
  }
}

const searchWebSchema = z.object({ query: z.string().min(1).max(200), maxResults: z.number().int().min(1).max(5).optional() }).strict()

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function searchWeb(): ToolDefinition<typeof searchWebSchema> {
  return {
    name: 'search_web',
    description: '搜索互联网并返回结果摘要。用户说“帮我查一下”“搜索新闻/资料”时调用；不要只打开浏览器，也不要假装已经查到。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或完整问题' },
        maxResults: { type: 'integer', description: '最多返回几条，默认 3' }
      },
      required: ['query']
    },
    schema: searchWebSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 15_000,
    execute: async (args, { signal }) => {
      const url = new URL('https://html.duckduckgo.com/html/')
      url.search = new URLSearchParams({ q: args.query, kl: 'cn-zh' }).toString()
      let response: Response
      try {
        response = await fetch(url, { signal, headers: { Accept: 'text/html', 'User-Agent': 'annie-lite/1.0' } })
      } catch {
        throw serviceError('search_unavailable', '搜索服务暂时不可用')
      }
      if (!response.ok) throw serviceError('search_unavailable', `搜索服务返回 ${response.status}`)
      const html = await response.text()
      const matches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      const maxResults = args.maxResults ?? 3
      const results = matches.slice(0, maxResults).map((match, index) => {
        const blockStart = match.index ?? 0
        const blockEnd = matches[index + 1]?.index ?? html.length
        const block = html.slice(blockStart, blockEnd)
        const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1]
        return `${index + 1}. ${decodeHtml(match[2] ?? '')}${snippet ? `：${decodeHtml(snippet)}` : ''}`
      })
      return results.length > 0 ? `搜索「${args.query}」找到：\n${results.join('\n')}` : `没有找到「${args.query}」的搜索结果。`
    }
  }
}

const calculateSchema = z
  .object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    operands: z.array(z.number().finite()).min(2).max(20)
  })
  .strict()

function calculate(): ToolDefinition<typeof calculateSchema> {
  return {
    name: 'calculate',
    description: '做基础四则运算。语音里报数字容易听错，算数交给它。',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
        operands: { type: 'array', items: { type: 'number' }, description: '参与运算的数字，至少两个' }
      },
      required: ['operation', 'operands']
    },
    schema: calculateSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 1000,
    execute: (args) => {
      const [first, ...rest] = args.operands
      const value = rest.reduce<number>((acc, operand) => {
        if (args.operation === 'add') return acc + operand
        if (args.operation === 'subtract') return acc - operand
        if (args.operation === 'multiply') return acc * operand
        return operand === 0 ? Number.NaN : acc / operand
      }, first!)
      if (!Number.isFinite(value)) return '算不出来：出现了除以零或溢出。'
      return `结果是 ${Number(value.toFixed(6))}。`
    }
  }
}

const openWebSchema = z.object({ url: z.string().url() }).strict()

function openWeb(): ToolDefinition<typeof openWebSchema> {
  return {
    name: 'open_web',
    description: '在默认浏览器里打开一个网页链接。只负责打开，不读取页面内容。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '必须是 http 或 https 链接' } },
      required: ['url']
    },
    schema: openWebSchema,
    risk: 'side_effect',
    destructive: false,
    timeoutMs: 3000,
    execute: async (args) => {
      const url = new URL(args.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new PathDenied('invalid_url', '只允许打开 http/https 链接')
      }
      await shell.openExternal(url.toString())
      return `已在浏览器中打开 ${url.toString()}。`
    }
  }
}

// ── 长期记忆 ─────────────────────────────────────────────────────────────

const recallSchema = z.object({ query: z.string().min(1).max(200) }).strict()

function recallTool(memory: MemoryService): ToolDefinition<typeof recallSchema> {
  return {
    name: 'recall',
    description:
      '在自己的长期记忆里检索。用户提到以前说过的事、偏好、项目背景时用它。' +
      '它只返回命中的笔记标题和摘要，要看内容再用 read_note 读具体那一篇。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要查的关键词' } },
      required: ['query']
    },
    schema: recallSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 3000,
    execute: (args) => {
      const { hits, searched } = memory.recall(args.query)
      if (hits.length === 0) {
        // 明确说查过哪里，而不是笼统一句"没有"
        return `记忆里没有关于「${args.query}」的内容（查了 ${searched.join('、')}）。`
      }
      const lines = hits.map(
        (hit, index) => `${index + 1}. ${hit.title}（${hit.path}${hit.updatedAt ? `，更新于 ${hit.updatedAt}` : ''}）
   ${hit.summary}`
      )
      return (
        `找到 ${hits.length} 篇：` +
        lines.join('\n') +
        '\n\n需要细节就用 read_note 读对应的那一篇。'
      )
    }
  }
}

const readNoteSchema = z.object({ path: z.string().min(1) }).strict()

function readNoteTool(memory: MemoryService): ToolDefinition<typeof readNoteSchema> {
  return {
    name: 'read_note',
    description: '读长期记忆里的某一篇笔记。路径从 recall 的结果里取。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '笔记相对知识库根目录的路径' } },
      required: ['path']
    },
    schema: readNoteSchema,
    risk: 'read_only',
    destructive: false,
    timeoutMs: 3000,
    execute: (args) => memory.readNote(args.path)
  }
}

const rememberSchema = z.object({ text: z.string().min(1).max(2000) }).strict()

function rememberTool(memory: MemoryService): ToolDefinition<typeof rememberSchema> {
  return {
    name: 'remember',
    description:
      '把值得长期留着的事记下来：用户明确说"记住"的事、他的偏好、正在进行的项目、重要决定。' +
      '只记成事实，不要记闲聊和一次性信息。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要用第三人称写成一句可复用的事实' } },
      required: ['text']
    },
    schema: rememberSchema,
    risk: 'side_effect',
    destructive: false,
    timeoutMs: 3000,
    execute: (args) => {
      try {
        const result = memory.remember(args.text)
        return `记住了（写入 ${result.file}）。`
      } catch (error) {
        // 写入被拒绝的原因要如实说，但不必展开细节——用户只需要知道没记成
        const reason = error instanceof MemoryWriteRejected ? error.code : 'failed'
        return `这条没能记下来：${reason}。`
      }
    }
  }
}

// ── 长任务 ───────────────────────────────────────────────────────────────

const runPiTaskSchema = z
  .object({ task: z.string().min(1).max(4000), title: z.string().min(1).max(60).optional() })
  .strict()

function runPiTaskTool(tasks: TaskService): ToolDefinition<typeof runPiTaskSchema> {
  return {
    name: 'run_pi_task',
    description:
      // 描述里刻意不出现 pi：模型会照抄这里的字眼去回话，
      // 说成「让 pi 看看」就把实现细节漏给了用户，而他只该知道自己找的是安妮
      '把需要多步操作或要花时间的任务交给后台执行：分析项目、改代码、跑命令、排查问题等。' +
      '调用后立刻返回，真实结果稍后单独播报——不要在这里等，也不要向用户报编号。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '用中文完整描述要执行的任务，保留路径等细节' },
        title: { type: 'string', description: '给任务起个短名字，便于在列表里辨认' }
      },
      required: ['task']
    },
    schema: runPiTaskSchema,
    risk: 'side_effect',
    destructive: false,
    timeoutMs: 3000,
    // 受理用语由我们自己念：交给模型说的话，它不一定开口——
    // 实测派出去之后它一个字都没说，用户就在沉默里干等
    execute: (args) => {
      // 立刻返回。豆包等工具结果有超时，而 pi 动辄几十秒——
      // 在这里等的结果就是模型那边静默失效，用户只看到"没反应"
      const summary = tasks.submit(args.task, args.title)
      return {
        output: `已受理，开始执行。请用一句话告诉用户你接下来要去做什么，说具体的事，不要提编号。`,
        // 具体到事情本身。「我去办一件事」这种不说明任何东西的话问了等于没问
        speech: `好，我去办「${summary.title}」，办好告诉你。`
      }
    }
  }
}

// ── 打开应用 ─────────────────────────────────────────────────────────────

/** 允许查找应用的目录。写死在这里：模型只能给名字，不能给路径。 */
const APP_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications')
]

/**
 * 按名字找一个应用。
 *
 * 模型只能传名字、传不了路径——这是这个工具的安全边界：它没法诱导我们
 * 去打开任意文件。找不找得到由我们说了算。
 */
export function findApp(name: string): string | null {
  // 路径只取文件名当线索，然后用它去我们允许的目录里查。
  // 传进来的路径本身**不会**被使用——返回的路径一定出自 APP_DIRS。
  // （之前这里还做了反向包含匹配，结果传路径进来靠"路径里含有应用名"就能命中，
  //   那不是我们要的语义。）
  const wanted = path.basename(name.trim(), '.app').toLowerCase()
  if (!wanted) return null

  const exact: string[] = []
  const partial: string[] = []
  for (const dir of APP_DIRS) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue // 目录不存在或没权限，跳过
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue
      const base = entry.slice(0, -4)
      const lower = base.toLowerCase()
      if (lower === wanted) exact.push(path.join(dir, entry))
      // 只做"应用名里含有用户说的词"这一个方向：
      // 说「音乐」能命中「酷狗音乐」，反过来不成立
      else if (lower.includes(wanted)) partial.push(path.join(dir, entry))
    }
  }
  // 完全同名的优先："音乐" 不该随手指到 "酷狗音乐" 之外的某个东西
  return exact[0] ?? partial[0] ?? null
}

const openAppSchema = z.object({ name: z.string().min(1).max(120) }).strict()

function openAppTool(): ToolDefinition<typeof openAppSchema> {
  return {
    name: 'open_app',
    description:
      '按名字打开本机的一个应用程序，比如「微信」「酷狗音乐」「Safari」。' +
      '只需要应用的名字，不要传路径。找不到就如实说找不到。' +
      // 不这么写的话，模型找不到就会改用 run_command 去 find/ls 翻应用目录，
      // 然后把一整屏 png 路径念给用户听——这正是它之前干的事
      '**不要**为了找应用去用 run_command 翻文件目录：找不到就说找不到。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '应用名，不需要 .app 后缀，也不要路径' } },
      required: ['name']
    },
    schema: openAppSchema,
    risk: 'side_effect',
    // 打开应用不改本机状态，不需要确认
    destructive: false,
    timeoutMs: 8000,
    execute: async (args) => {
      const target = findApp(args.name)
      if (!target) return `没有找到叫「${args.name}」的应用。`
      const error = await shell.openPath(target)
      if (error) return `找到了「${args.name}」，但没能打开：${error}`
      return `已经打开${path.basename(target, '.app')}了。`
    }
  }
}

// ── 执行命令 ─────────────────────────────────────────────────────────────

/** 跑命令的超时。比读文件宽得多：构建、测试本来就要等。 */
const COMMAND_TIMEOUT_MS = 60_000
/** 念出来的输出上限。再长就不是播报，是念稿了。 */
const SPOKEN_OUTPUT_CHARS = 200
/** 最多念几行。成屏的路径和日志不该被念出来。 */
const SPOKEN_OUTPUT_LINES = 3

const runCommandSchema = z
  .object({
    command: z.string().min(1).max(2000),
    cwd: z.string().max(500).optional(),
    /** 这条命令是干嘛的。写在确认框里，让用户不用读懂命令再决定。 */
    purpose: z.string().max(200).optional()
  })
  .strict()

/**
 * 把命令输出压成"适合念"的一段。
 *
 * **不念命令本身。** 用户要的是结论，不是"我刚跑了什么"——
 * 之前连命令带输出一起念，一句"看看电脑配置"变成听一长串
 * `system_profiler ... | grep -E ...`，那是折磨。
 *
 * 失败的时候反过来，要带上命令：用户得知道是哪件事没成。
 */
function summarizeCommand(command: string, result: CommandResult): string {
  const why = result.signal ? `被信号 ${result.signal} 打断` : `退出码 ${result.code}`

  if (result.timedOut) {
    return `命令跑了 ${COMMAND_TIMEOUT_MS / 1000} 秒还没结束，我已经把它连同它起的进程一起停掉了。`
  }

  // 逐行去掉缩进再拼起来：命令的输出常带大量对齐空格，
  // 直接念出来全是停顿。用分号断开，比念换行自然。
  const lines = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  // 只念开头几行。有些命令会吐出成屏的路径或日志（比如 find 一个应用目录），
  // 把 400 个字念完是一分钟不停的机器噪音——用户要的是结论，不是流水。
  const kept = lines.slice(0, SPOKEN_OUTPUT_LINES)
  let body = kept.join('；')
  if (body.length > SPOKEN_OUTPUT_CHARS) body = body.slice(0, SPOKEN_OUTPUT_CHARS)
  const clipped = lines.length > kept.length || kept.join('；').length > body.length ? `${body}……` : body

  if (result.code !== 0) {
    return `\`${command}\` 失败了，${why}。${clipped ? `输出是：${clipped}` : ''}`
  }
  // 没输出就不提输出。`mkdir`、`git add` 这类命令本来就不打印东西，
  // 硬加一句"没有任何输出"是在描述系统状态，不是告诉用户事情办得怎么样。
  // 但也不能一声不吭：用户刚点过"执行"，没声会以为没跑成。
  return clipped || '办好了。'
}

function runCommandTool(files: SafePathService): ToolDefinition<typeof runCommandSchema> {
  return {
    name: 'run_command',
    // 分工写清楚，否则模型会拿它去干"跑几条命令再给结论"的活，
    // 而那种活它自己总结不了——用户听到的会是一堆机器输出
    description:
      '在本机执行一条 shell 命令。适合"跑一条命令看看输出"的场合。' +
      '如果用户要的是一句**结论**（比如"我的电脑什么配置""这个项目有什么问题"），' +
      '应该用 run_pi_task 让后台跑完再用自然语言回你，不要把命令的原始输出当答案。' +
      '涉及删除、覆盖、推送等改动本机的操作，用户会先收到确认框，你只管发起。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，比如 git status' },
        cwd: { type: 'string', description: '在哪个目录下执行，默认第一个授权目录' },
        purpose: { type: 'string', description: '一句话说明这条命令是干嘛的，给用户确认时看' }
      },
      required: ['command']
    },
    schema: runCommandSchema,
    risk: 'side_effect',
    // 任意命令都可能改本机状态，一律当破坏性走确认
    destructive: true,
    // 确认对话框必然超过豆包等结果的窗口，所以结果由我们自己念
    speakResult: true,
    timeoutMs: COMMAND_TIMEOUT_MS + 5000,
    execute: async (args) => {
      // 工作目录必须落在授权目录里。这不是沙箱（命令能碰到的地方远不止这里），
      // 但至少保证"默认在哪跑"不会莫名其妙跑到别处去。
      const cwd = files.resolve(args.cwd ?? '', { allowMissing: false })
      const result = await runCommand({ command: args.command, cwd, timeoutMs: COMMAND_TIMEOUT_MS })
      return summarizeCommand(args.command, result)
    }
  }
}

/** 按授权目录与知识库装配一套工具。每次开会话重建，保证用户改了配置立刻生效。 */
export function buildToolRegistry(
  files: SafePathService,
  options: { approve?: ApprovalHook; memory?: MemoryService; tasks?: TaskService; reminders?: ReminderService } = {}
): ToolRegistry {
  const registry = new ToolRegistry(options)
  registry.register(listDirectory(files))
  registry.register(readFile(files))
  registry.register(searchText(files))
  registry.register(getCurrentTime())
  registry.register(getWeather())
  registry.register(setReminderTool(options.reminders))
  registry.register(getCalendarEvents())
  registry.register(getClipboard())
  registry.register(getSystemStatus())
  registry.register(searchWeb())
  registry.register(calculate())
  registry.register(openWeb())
  registry.register(openAppTool())
  registry.register(runCommandTool(files))
  if (options.tasks) {
    registry.register(runPiTaskTool(options.tasks))
  }
  if (options.memory?.isReady()) {
    registry.register(recallTool(options.memory))
    registry.register(readNoteTool(options.memory))
    registry.register(rememberTool(options.memory))
  }
  return registry
}

/** 只列举不执行：设置面板要显示工具清单，但不该为此真的开一个会话。 */
export function describeTools(files: SafePathService, memory?: MemoryService): ToolDescriptor[] {
  return buildToolRegistry(files, { memory }).descriptors()
}
