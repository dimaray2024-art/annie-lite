import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dueAt, SchedulerService, type ScheduledJob } from '../electron/schedule'

const job: ScheduledJob = { id: 'daily', title: '整理', hour: 2, minute: 0, prompt: '' }

/** 构造本地时间，别用 UTC 字符串——判断是按本地时区做的。 */
const at = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m - 1, d, h, min, 0, 0)

describe('最近一次该跑的时间点', () => {
  it('当天到点了，就是今天这个点', () => {
    expect(dueAt(job, at(2026, 10, 3, 2, 0))).toEqual(at(2026, 10, 3, 2, 0))
    expect(dueAt(job, at(2026, 10, 3, 9, 30))).toEqual(at(2026, 10, 3, 2, 0))
  })

  // 跨天是最容易算错的一处：凌晨一点查，该补的是昨天那次
  it('还没到点，退回前一天', () => {
    expect(dueAt(job, at(2026, 10, 3, 1, 59))).toEqual(at(2026, 10, 2, 2, 0))
  })

  it('每周任务：退到最近的那个星期几', () => {
    // 2026-10-04 是周日
    const weekly: ScheduledJob = { ...job, weekday: 0 }
    expect(dueAt(weekly, at(2026, 10, 4, 3, 0))).toEqual(at(2026, 10, 4, 2, 0))
    // 周三查，补的是上个周日
    expect(dueAt(weekly, at(2026, 10, 7, 10, 0))).toEqual(at(2026, 10, 4, 2, 0))
    // 周日但还没到点，补的是上周日
    expect(dueAt(weekly, at(2026, 10, 4, 1, 0))).toEqual(at(2026, 9, 27, 2, 0))
  })

  it('配置越界就不猜，返回 null', () => {
    expect(dueAt({ ...job, hour: 24 }, at(2026, 10, 3, 9, 0))).toBeNull()
    expect(dueAt({ ...job, weekday: 7 }, at(2026, 10, 3, 9, 0))).toBeNull()
  })
})

describe('补跑', () => {
  let dir: string
  let stateFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-sched-'))
    stateFile = path.join(dir, 'schedule.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function setup(now: Date, jobs: ScheduledJob[] = [job]): { runs: string[]; scheduler: SchedulerService } {
    const runs: string[] = []
    const scheduler = new SchedulerService({
      jobs,
      stateFile,
      run: async (item) => {
        runs.push(item.id)
        return '整理完了'
      },
      onFinish: () => undefined,
      now: () => now
    })
    return { runs, scheduler }
  }

  it('从来没跑过、时间已过：起来就补上', async () => {
    const { scheduler, runs } = setup(at(2026, 10, 3, 9, 0))
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.stop()
    expect(runs).toEqual(['daily'])
  })

  it('当天已经跑过就不重复跑——补跑最容易犯的错就是反复触发', async () => {
    const { scheduler, runs } = setup(at(2026, 10, 3, 9, 0))
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.stop()

    // 新建一个实例（模拟重启），状态从磁盘读回来
    const again = setup(at(2026, 10, 3, 23, 0))
    again.scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    again.scheduler.stop()

    expect(runs).toEqual(['daily'])
    expect(again.runs).toEqual([])
  })

  // 这条守的是"别把积压一次性放出来"：凌晨一点启动，最近一次该跑的是
  // 昨天两点，不该立刻跑——等今天两点就是
  it('还没到今天的点：不补，安静等着', async () => {
    const { scheduler, runs } = setup(at(2026, 10, 3, 1, 0))
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.stop()
    expect(runs).toEqual([])
  })

  it('跨过下一个周期，又会跑一次', async () => {
    const { scheduler } = setup(at(2026, 10, 3, 9, 0))
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.stop()

    const next = setup(at(2026, 10, 4, 3, 0))
    next.scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    next.scheduler.stop()
    expect(next.runs).toEqual(['daily'])
  })

  // 失败的也记时间：不然一个跑不通的任务会每分钟重试一次，把日志刷满
  it('跑失败也算跑过，不会陷在重试里', async () => {
    let attempts = 0
    const scheduler = new SchedulerService({
      jobs: [job],
      stateFile,
      run: async () => {
        attempts += 1
        throw new Error('pi 起不来')
      },
      onFinish: () => undefined,
      now: () => at(2026, 10, 3, 9, 0)
    })
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.stop()
    expect(attempts).toBe(1)
  })

  it('跑完会通知，并带上结果', async () => {
    const finished: Array<{ ok: boolean; detail: string }> = []
    const scheduler = new SchedulerService({
      jobs: [job],
      stateFile,
      run: async () => '整理了三条',
      onFinish: (_item, ok, detail) => finished.push({ ok, detail }),
      now: () => at(2026, 10, 3, 9, 0)
    })
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.stop()
    expect(finished).toEqual([{ ok: true, detail: '整理了三条' }])
  })
})
