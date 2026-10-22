/**
 * 跑一条 shell 命令，带超时和输出截断。
 *
 * 两件事必须做对，都是踩过的：
 *
 * 1. **必须以进程组起（detached）**。命令经常会自己再拉子进程（构建脚本、
 *    测试框架、`sh -c` 里的管道）。只杀父进程的话，它们会变成孤儿继续占着
 *    端口和 CPU，而用户以为命令已经停了。
 * 2. **超时先 SIGTERM 整组，宽限期后再 SIGKILL**。直接 SIGKILL 会跳过清理，
 *    留下半截文件；只 SIGTERM 又可能被无视，命令永远不退。
 */

import { spawn } from 'node:child_process'

/** 默认保留多少输出。命令的输出可能有几 MB，全留着既没用又占内存。 */
const DEFAULT_MAX_BYTES = 8 * 1024
/** SIGTERM 之后给多久清理，然后 SIGKILL。 */
const KILL_GRACE_MS = 2000

export interface CommandResult {
  /** 退出码。被信号杀死时是 null。 */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** 输出被截断过（只留了末尾）。 */
  truncated: boolean
  /** 是我们超时杀掉的，不是命令自己结束的。 */
  timedOut: boolean
}

export interface RunCommandOptions {
  command: string
  cwd: string
  timeoutMs: number
  maxBytes?: number
}

/**
 * 环形缓冲：只保留**末尾**的 maxBytes。
 *
 * 留末尾而不是开头，是因为命令失败时想知道"为什么"——报错总在最后。
 * 开头那部分是进度噪音。
 */
class TailBuffer {
  private readonly chunks: Buffer[] = []
  private size = 0
  private overflowed = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      this.size -= dropped?.length ?? 0
      this.overflowed = true
    }
  }

  get truncated(): boolean {
    return this.overflowed
  }

  text(): string {
    const joined = Buffer.concat(this.chunks)
    // 从末尾切：最后一块可能自己就超了
    const slice = joined.length > this.maxBytes ? joined.subarray(joined.length - this.maxBytes) : joined
    return slice.toString('utf8')
  }
}

export function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  return new Promise<CommandResult>((resolve) => {
    let settled = false
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(options.command, {
        shell: true,
        cwd: options.cwd,
        detached: true,
        // 命令不该读我们的 stdin：一个等输入的命令会把工具卡到超时
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      finish({
        code: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
        timedOut: false
      })
      return
    }

    const stdout = new TailBuffer(maxBytes)
    const stderr = new TailBuffer(maxBytes)
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined

    /** 杀整个进程组。负号是"进程组"的意思，少了它只杀得掉 shell 自己。 */
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // 组已经没了，或者已经退出——都无所谓
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        stdout: stdout.text(),
        stderr: error.message,
        truncated: stdout.truncated || stderr.truncated,
        timedOut
      })
    })

    child.on('close', (code, signal) => {
      finish({
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut
      })
    })
  })
}
