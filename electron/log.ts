/**
 * 主进程日志：落到 app 私有目录，同时打到 stderr。
 *
 * 为什么必须有：语音链路的失败几乎都是"静默"的——连接断了、密钥无效、
 * 音频长度不对，界面上往往只表现为"说话没反应"。没有日志就只能靠猜。
 *
 * 所有输出都过 scrub：错误信息里经常夹着 key 或 Authorization 头。
 */

import fs from 'node:fs'
import path from 'node:path'
import { scrub } from './ipc'

let logFile: string | undefined
let stream: fs.WriteStream | undefined

export function initLog(userDataDir: string): void {
  logFile = path.join(userDataDir, 'annie.log')
  try {
    stream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 })
  } catch {
    stream = undefined
  }
}

export function logPath(): string | undefined {
  return logFile
}

export function log(scope: string, message: string, detail?: unknown): void {
  const stamp = new Date().toISOString().slice(11, 23)
  const extra = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  const line = `${stamp} [${scope}] ${scrub(message)}${scrub(extra)}\n`
  process.stderr.write(line)
  stream?.write(line)
}
