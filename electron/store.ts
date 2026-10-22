/**
 * 落盘基础设施：原子写 + 安全读。
 *
 * 为什么非要原子写：这些文件（设置、任务索引、密钥）会在崩溃或断电时处于「写了一半」的状态，
 * 而它们一旦损坏就会连带 app 起不来。做法是先写临时文件再 rename——同一文件系统内 rename 是原子的，
 * 所以任何时刻磁盘上要么是旧内容、要么是新内容，不存在中间态。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 只有拥有者的读写权限。密钥和任务记录都属于用户私有数据。 */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export function atomicWriteJson(file: string, value: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    // wx: 目标已存在就报错，避免并发写互相覆盖
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/**
 * 读 JSON。文件不存在返回 fallback；文件损坏**抛错而不是静默回退**——
 * 静默回退会把用户的设置悄悄重置成默认值，等到发现时已经找不回来了。
 */
export function readJson<T>(file: string, fallback: T): T {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`配置文件损坏，已保留原文件未改动: ${file}`)
  }
}
