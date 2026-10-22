/**
 * pi 子进程的 JSONL 客户端。
 *
 * 没有用官方的 `RpcClient`：它会把整个 pi-coding-agent 包（undici、wasm、quickjs…）
 * 拖进 app，而我们要的只是一个 JSONL 往返；而且它的三处硬编码本来就得绕——
 * 固定 `spawn("node", ...)`（打包后 PATH 残缺就找不到）、不暴露子进程退出事件、
 * `send()` 有 30 秒超时。自己写一版比绕它更短，也更好控制。
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { PiRuntime } from '../runtime'

/** 单行上限。pi 的事件里可能带完整工具输出，行会很大。 */
const MAX_LINE_BYTES = 32 * 1024 * 1024

export interface PiClientOptions {
  runtime: PiRuntime
  cwd: string
  model?: string
  thinking?: string
  /** 额外 CLI 参数。 */
  args?: string[]
  /** 追加到系统提示词。 */
  appendSystemPrompt?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 按 LF 切行。
 *
 * 不能用 node 的 readline：它还会在 U+2028/U+2029 上切，而这两个字符**是合法的 JSON 字符串内容**，
 * 切错了就把一条事件劈成两半。
 */
class LineSplitter {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = Buffer.alloc(0)
      throw new Error('pi 输出单行超限')
    }
    const lines: string[] = []
    let index = this.buffer.indexOf(0x0a)
    while (index !== -1) {
      lines.push(this.buffer.subarray(0, index).toString('utf8'))
      this.buffer = this.buffer.subarray(index + 1)
      index = this.buffer.indexOf(0x0a)
    }
    return lines
  }
}

/**
 * 读 `get_last_assistant_text` 的结果。
 *
 * pi 回的 `data` 是 `{text: string | null}`，**不是字符串**（见
 * packages/coding-agent/docs/rpc-commands.md）。早先按字符串读，于是永远拿到
 * null——任务明明跑完、在事件流里逐字说了一整段话，播报出去的却是"做完了，
 * 但没有输出"。这个形状值得单独拎出来测：它错了不会报错，只会静默变空。
 */
export function readAssistantText(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const text = (data as { text?: unknown }).text
  return typeof text === 'string' && text.trim() ? text : null
}

export class PiClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private readonly splitter = new LineSplitter()
  private readonly pending = new Map<string, PendingRequest>()
  private requestSeq = 0

  constructor(private readonly options: PiClientOptions) {
    super()
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null
  }

  async start(): Promise<void> {
    if (this.running) return

    const args = [this.options.runtime.rpcEntryPath, '--mode', 'rpc']
    if (this.options.model) args.push('--model', this.options.model)
    if (this.options.thinking) args.push('--thinking', this.options.thinking)
    if (this.options.appendSystemPrompt) args.push('--append-system-prompt', this.options.appendSystemPrompt)
    if (this.options.args) args.push(...this.options.args)

    // 用绝对路径起 node，并把 node/pi 所在目录补进 PATH：
    // 打包后从 Finder 启动时 PATH 只有 /usr/bin:/bin，pi 自己再 spawn 什么都找不到
    this.child = spawn(this.options.runtime.nodePath, args, {
      cwd: this.options.cwd,
      env: { ...process.env, PATH: this.options.runtime.pathEnv },
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    this.splitter.push(Buffer.alloc(0))
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => {
      // stderr 是日志，不是协议；只留给排错，且不进模型上下文
      this.emit('stderr', chunk.toString('utf8'))
    })
    this.child.on('exit', (code, signal) => {
      this.child = undefined
      const error = new Error(`pi 进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      for (const [, request] of this.pending) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      this.pending.clear()
      this.emit('exit', { code, signal })
    })
    this.child.on('error', (error) => this.emit('error', error))
  }

  private onData(chunk: Buffer): void {
    let lines: string[]
    try {
      lines = this.splitter.push(chunk)
    } catch (error) {
      this.emit('error', error)
      return
    }
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (parsed.type === 'response') {
        const id = typeof parsed.id === 'string' ? parsed.id : undefined
        const request = id ? this.pending.get(id) : undefined
        if (request) {
          clearTimeout(request.timer)
          this.pending.delete(id!)
          if (parsed.success === false) request.reject(new Error(String(parsed.error ?? 'pi 命令失败')))
          else request.resolve(parsed.data)
        }
        continue
      }
      this.emit('event', parsed)
    }
  }

  private send(command: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child
    if (!child?.stdin.writable) return Promise.reject(new Error('pi 进程未运行'))

    this.requestSeq += 1
    const id = `req_${this.requestSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('pi 没有在超时内回应该命令'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`)
    })
  }

  /**
   * 发一个任务。
   *
   * 注意返回只代表「已接受」，不代表跑完——完成信号是 `agent_settled` 事件。
   * 判成 `agent_end` 会提前收工：它之后可能还有重试或压缩。
   */
  async prompt(message: string): Promise<void> {
    await this.send({ type: 'prompt', message, streamingBehavior: 'followUp' }, 30_000)
  }

  async abort(): Promise<void> {
    if (!this.running) return
    await this.send({ type: 'abort' }, 10_000).catch(() => undefined)
  }

  /** 探活。子进程退出不会主动通知我们（除非监听 exit），靠它兜底。 */
  async getState(): Promise<unknown> {
    return this.send({ type: 'get_state' }, 10_000)
  }

  async getLastAssistantText(): Promise<string | null> {
    return readAssistantText(await this.send({ type: 'get_last_assistant_text' }, 10_000))
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // 已经断了
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
