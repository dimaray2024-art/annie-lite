/**
 * 本地文件访问的安全层。所有工具读文件都必须走这里。
 *
 * 两件事在这里做掉，而不是分散在各工具里：
 * 1. **路径约束**：只允许访问用户明确授权的目录。模型的输入是不可信的，
 *    它可能被一段网页内容诱导去读 ~/.ssh。约束放在一处才审计得清楚。
 * 2. **符号链接**：先 realpath 再判断是否越界。否则 /tmp/link → ~/.ssh 就能绕过。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 明显属于凭据的文件不进模型上下文。命中就直接拒绝，不做"脱敏后返回"。 */
const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.ssh$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /^credentials$/i,
  /^\.aws$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i
]

export class PathDenied extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface DirectoryEntry {
  name: string
  type: 'file' | 'dir' | 'link'
  bytes?: number
}

export class SafePathService {
  private readonly roots: string[]

  constructor(roots: string[]) {
    // 统一成 realpath 后的绝对路径，比较时才不会有 /private/var 与 /var 这类差异
    this.roots = roots.map((root) => {
      try {
        return fs.realpathSync(root)
      } catch {
        return path.resolve(root)
      }
    })
  }

  get authorizedRoots(): string[] {
    return [...this.roots]
  }

  private isSensitive(name: string): boolean {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name))
  }

  /** 解析并校验路径。越界、命中敏感文件名都会抛 PathDenied。 */
  resolve(raw: string, options: { allowMissing?: boolean } = {}): string {
    if (!raw || raw.trim().length === 0) {
      if (this.roots.length === 1) return this.roots[0]!
      throw new PathDenied('missing_path', '需要指定路径')
    }

    const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(this.roots[0] ?? process.cwd(), expanded)

    let resolved = absolute
    try {
      resolved = fs.realpathSync(absolute)
    } catch (error) {
      // 文件不存在时 realpath 会失败；对"列出目录"这类操作要能报出友好的未找到
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !options.allowMissing) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new PathDenied('not_found', `找不到: ${absolute}`)
        }
        throw new PathDenied('os_permission_denied', `无法访问: ${absolute}`)
      }
      resolved = path.resolve(absolute)
    }

    // 逐级检查敏感名：既拦路径最后一段，也拦中间目录（~/.ssh/id_rsa）
    for (const segment of resolved.split(path.sep)) {
      if (this.isSensitive(segment)) {
        throw new PathDenied('sensitive_path', '该路径涉及凭据，已拒绝访问')
      }
    }

    const inside = this.roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    if (!inside) {
      throw new PathDenied('outside_authorized_roots', `路径不在授权目录内: ${resolved}`)
    }
    return resolved
  }

  list(pathArg: string, limit = 200): { path: string; entries: DirectoryEntry[]; truncated: boolean } {
    const target = this.resolve(pathArg, { allowMissing: true })
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      throw new PathDenied('not_found', `找不到: ${target}`)
    }
    if (!stat.isDirectory()) throw new PathDenied('not_a_directory', `不是目录: ${target}`)

    const entries: DirectoryEntry[] = []
    for (const dirent of fs.readdirSync(target, { withFileTypes: true })) {
      if (dirent.name.startsWith('.')) continue // 隐藏文件不进列表：噪声大，且容易碰到凭据
      const full = path.join(target, dirent.name)
      const type: DirectoryEntry['type'] = dirent.isDirectory() ? 'dir' : dirent.isSymbolicLink() ? 'link' : 'file'
      let bytes: number | undefined
      if (type === 'file') {
        try {
          bytes = fs.statSync(full).size
        } catch {
          bytes = undefined
        }
      }
      entries.push({ name: dirent.name, type, bytes })
    }

    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    const truncated = entries.length > limit
    return { path: target, entries: entries.slice(0, limit), truncated }
  }

  readText(pathArg: string, maxBytes: number): { path: string; text: string; truncated: boolean; lines: number } {
    const target = this.resolve(pathArg)
    const stat = fs.statSync(target)
    if (!stat.isFile()) throw new PathDenied('not_a_file', `不是文件: ${target}`)

    const limit = Math.min(maxBytes, stat.size)
    const buffer = Buffer.alloc(limit)
    const fd = fs.openSync(target, 'r')
    let read = 0
    try {
      read = fs.readSync(fd, buffer, 0, limit, 0)
    } finally {
      fs.closeSync(fd)
    }
    const slice = buffer.subarray(0, read)

    // 二进制检测：NUL 字节是可靠信号。把二进制当文本念出来毫无意义
    if (slice.includes(0)) throw new PathDenied('binary_file', `这是二进制文件: ${target}`)

    const text = slice.toString('utf8')
    return {
      path: target,
      text,
      truncated: stat.size > read,
      lines: text.split('\n').length
    }
  }
}
