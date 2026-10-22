import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteJson, readJson } from '../electron/store'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-store-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('atomicWriteJson', () => {
  it('写入后可读回，且不残留临时文件', () => {
    const file = path.join(dir, 'nested', 'settings.json')
    atomicWriteJson(file, { a: 1, b: '中文' })

    expect(readJson(file, null)).toEqual({ a: 1, b: '中文' })
    // 同目录下只应该有目标文件，没有 .tmp 残留
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json'])
  })

  it('用 0600 写文件：这些是用户私有数据', () => {
    const file = path.join(dir, 'secrets.json')
    atomicWriteJson(file, { doubao: 'x' })

    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('覆盖写不会留下旧内容', () => {
    const file = path.join(dir, 'tasks.json')
    atomicWriteJson(file, { version: 1 })
    atomicWriteJson(file, { version: 2 })

    expect(readJson(file, null)).toEqual({ version: 2 })
  })
})

describe('readJson', () => {
  it('文件不存在时返回 fallback，而不是抛错', () => {
    expect(readJson(path.join(dir, 'missing.json'), { fallback: true })).toEqual({ fallback: true })
  })

  it('文件损坏时抛错，并且不改动原文件', () => {
    const file = path.join(dir, 'broken.json')
    fs.writeFileSync(file, '{ 这不是 JSON')

    expect(() => readJson(file, {})).toThrow(/损坏/)
    // 关键：保留现场，别把用户的数据悄悄换成默认值
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 这不是 JSON')
  })
})
