import { afterEach, describe, expect, it } from 'vitest'
import { runCommand } from '../electron/process'

const cwd = process.cwd()

/** 等一个 pid 真的消失。SIGTERM 到进程表更新之间有一小段延迟。 */
async function gone(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const spawnedPids: number[] = []

afterEach(() => {
  // 测试失败时别把子进程漏在外面
  for (const pid of spawnedPids) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 已经没了
    }
  }
  spawnedPids.length = 0
})

describe('跑命令', () => {
  it('正常结束：拿到退出码和输出', async () => {
    const result = await runCommand({ command: 'echo 你好', cwd, timeoutMs: 5000 })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('你好')
    expect(result.timedOut).toBe(false)
  })

  it('失败的命令不抛异常，而是把退出码带回来', async () => {
    // 命令失败是预期内的结果，不是异常——抛出去会让工具层把它当执行错误，
    // 用户就听不到"失败了，退出码 2"这句话
    const result = await runCommand({ command: 'exit 2', cwd, timeoutMs: 5000 })
    expect(result.code).toBe(2)
    expect(result.timedOut).toBe(false)
  })

  it('stderr 单独收着，不混进 stdout', async () => {
    const result = await runCommand({ command: 'echo 出错了 >&2', cwd, timeoutMs: 5000 })
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr.trim()).toBe('出错了')
  })

  // 这条守的是最要紧的一处：只杀 shell 自己，它拉起来的子进程会变成孤儿继续跑
  it('超时会把整组进程杀掉，孙进程也不留', async () => {
    // 子进程 sleep 100 秒，父进程立刻退出——只有按进程组杀才治得住
    const result = await runCommand({
      command: 'sleep 100 & echo $!; wait',
      cwd,
      timeoutMs: 600
    })
    expect(result.timedOut).toBe(true)

    const grandchild = Number(result.stdout.trim())
    expect(Number.isInteger(grandchild)).toBe(true)
    expect(await gone(grandchild)).toBe(true)
  })

  it('只留末尾的输出，并标明截断了', async () => {
    // seq 是 POSIX 的：花括号展开 {1..n} 在 /bin/sh 下不生效，
    // 用了会得到一个几乎没输出的命令，测试就变成假通过
    const result = await runCommand({
      command: 'seq 1 5000; echo 结尾',
      cwd,
      timeoutMs: 5000,
      maxBytes: 100
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.endsWith('结尾\n')).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(120)
  })
})
