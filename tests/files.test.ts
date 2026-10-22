import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathDenied, SafePathService } from '../electron/files'

let root: string
let outside: string
let files: SafePathService

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-root-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-outside-'))
  fs.writeFileSync(path.join(root, 'notes.txt'), '你好\n世界\n')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
  fs.mkdirSync(path.join(root, '.ssh'))
  fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'private')
  fs.writeFileSync(path.join(outside, 'other.txt'), 'other')
  // 二进制文件：含 NUL 字节
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
  files = new SafePathService([root])
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('路径约束', () => {
  it('授权目录内的路径可以解析', () => {
    expect(files.resolve(path.join(root, 'notes.txt'))).toBe(fs.realpathSync(path.join(root, 'notes.txt')))
  })

  it('相对路径按授权目录解析', () => {
    expect(files.resolve('notes.txt')).toBe(fs.realpathSync(path.join(root, 'notes.txt')))
  })

  it('授权目录之外的绝对路径被拒绝', () => {
    expect(() => files.resolve(path.join(outside, 'other.txt'))).toThrow(PathDenied)
    try {
      files.resolve(path.join(outside, 'other.txt'))
    } catch (error) {
      expect((error as PathDenied).code).toBe('outside_authorized_roots')
    }
  })

  it('用 ../ 逃逸被拒绝', () => {
    expect(() => files.resolve('../' + path.basename(outside) + '/other.txt')).toThrow(PathDenied)
  })

  it('符号链接指向外部目录时被拒绝', () => {
    const link = path.join(root, 'escape')
    fs.symlinkSync(outside, link)
    try {
      files.resolve(path.join(link, 'other.txt'))
      throw new Error('本该被拒绝')
    } catch (error) {
      expect((error as PathDenied).code).toBe('outside_authorized_roots')
    }
  })
})

describe('敏感文件', () => {
  it.each(['.env', '.ssh', path.join('.ssh', 'id_rsa')])('拒绝 %s', (target) => {
    try {
      files.resolve(path.join(root, target))
      throw new Error('本该被拒绝')
    } catch (error) {
      expect((error as PathDenied).code).toBe('sensitive_path')
    }
  })

  it('拒绝读取 .pem 文件', () => {
    fs.writeFileSync(path.join(root, 'server.pem'), 'key')
    expect(() => files.readText(path.join(root, 'server.pem'), 1024)).toThrow(PathDenied)
  })
})

describe('读取', () => {
  it('读文本正常返回', () => {
    const result = files.readText(path.join(root, 'notes.txt'), 1024)
    expect(result.text).toBe('你好\n世界\n')
    expect(result.truncated).toBe(false)
  })

  it('超过上限时截断并标记', () => {
    const result = files.readText(path.join(root, 'notes.txt'), 6)
    expect(result.truncated).toBe(true)
  })

  it('二进制文件被拒绝，不会被当成文本塞进模型上下文', () => {
    try {
      files.readText(path.join(root, 'blob.bin'), 1024)
      throw new Error('本该被拒绝')
    } catch (error) {
      expect((error as PathDenied).code).toBe('binary_file')
    }
  })

  it('不存在的文件报 not_found', () => {
    try {
      files.readText(path.join(root, 'nope.txt'), 1024)
      throw new Error('本该抛错')
    } catch (error) {
      expect((error as PathDenied).code).toBe('not_found')
    }
  })
})

describe('列目录', () => {
  it('隐藏文件不进列表', () => {
    const names = files.list(root).entries.map((entry) => entry.name)
    expect(names).toContain('notes.txt')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('.ssh')
  })

  it('目录排在文件前面', () => {
    const entries = files.list(root).entries
    expect(entries[0]!.type).toBe('dir')
  })

  it('对文件调用列目录会报 not_a_directory', () => {
    try {
      files.list(path.join(root, 'notes.txt'))
      throw new Error('本该抛错')
    } catch (error) {
      expect((error as PathDenied).code).toBe('not_a_directory')
    }
  })
})
