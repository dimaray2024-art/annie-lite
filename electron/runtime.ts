/**
 * 解析 node 与 pi 的绝对路径。
 *
 * 为什么需要这个：pi 官方的 RpcClient 内部是 `spawn("node", [cliPath, ...])`，
 * 用的是 `node` 这个字面命令，依赖 PATH 解析。开发时从终端启动没问题，
 * 但打包成 .app 双击运行时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * node 和 pi 都找不到（它们装在 nvm / ~/.npm-global 之类的地方）。
 *
 * 所以这里用**登录 shell** 探测真实路径，再把它们所在目录补进子进程的 PATH。
 * 这是从终端启动和从 Finder 启动唯一的差别所在，也是最容易到打包阶段才暴露的坑。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface PiRuntime {
  nodePath: string
  /** pi CLI 的真实入口（dist/bundle/cli.js）。 */
  piEntryPath: string
  /** 强制 rpc 模式的入口；比 cli.js 干净（不会打印启动警告）。 */
  rpcEntryPath: string
  /** 补全后的 PATH，注入给子进程。 */
  pathEnv: string
  version?: string
}

async function whichInLoginShell(names: string[]): Promise<Record<string, string>> {
  const shell = process.env.SHELL ?? '/bin/zsh'
  const script = names.map((name) => `command -v ${name} || true`).join('; ')
  try {
    const { stdout } = await execFileAsync(shell, ['-ilc', script], { timeout: 10_000 })
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    const result: Record<string, string> = {}
    names.forEach((name, index) => {
      const found = lines[index]
      if (found) result[name] = found
    })
    return result
  } catch {
    return {}
  }
}

/** pi 的 dist/bundle 里同时有 cli.js 和 rpc-entry.js，优先用后者。 */
function pickRpcEntry(piEntry: string): string {
  const dir = path.dirname(piEntry)
  const candidate = path.join(dir, 'rpc-entry.js')
  return fs.existsSync(candidate) ? candidate : piEntry
}

function readPiVersion(piEntry: string): string | undefined {
  // piEntry 形如 .../pi-coding-agent/dist/bundle/cli.js，往上找 package.json
  let dir = path.dirname(piEntry)
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
        if (parsed.name?.includes('pi-coding-agent') && parsed.version) return parsed.version
      } catch {
        // 忽略：版本号只用于提示，读不到不影响功能
      }
    }
    dir = path.dirname(dir)
  }
  return undefined
}

export async function resolvePiRuntime(): Promise<PiRuntime> {
  const found = await whichInLoginShell(['node', 'pi'])
  if (!found.node || !found.pi) {
    throw new Error(
      'PATH_MISSING: 找不到 node 或 pi。请确认已安装 Node.js，并执行 ' +
        '`npm i -g @earendil-works/pi-coding-agent`'
    )
  }

  const nodePath = fs.realpathSync(found.node)
  const piEntryPath = fs.realpathSync(found.pi)
  const rpcEntryPath = pickRpcEntry(piEntryPath)

  const extra = [path.dirname(nodePath), path.dirname(piEntryPath)].join(path.delimiter)
  const pathEnv = `${extra}${path.delimiter}${process.env.PATH ?? ''}`

  return { nodePath, piEntryPath, rpcEntryPath, pathEnv, version: readPiVersion(piEntryPath) }
}

/** 默认工作目录：优先第一个授权根，其次用户主目录。 */
export function defaultWorkingDirectory(roots: Array<{ path: string }>): string {
  return roots[0]?.path ?? os.homedir()
}
