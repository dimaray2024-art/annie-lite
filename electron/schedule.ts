/**
 * 应用内定时任务。
 *
 * 没有走系统的 launchd，所以有个绕不开的事实：**凌晨两点机器多半在睡，
 * 那时候定时器不会响**。只做"到点触发"的话，这个功能基本永远不会跑。
 * 所以做成 cron 那种「补跑」语义：每次心跳检查"最近一次该跑的时间点"
 * 是不是已经跑过了，没过就补上。这样机器唤醒、app 重启都能接上。
 *
 * 判断逻辑全在 dueAt() 这个纯函数里——它最容易算错（跨天、跨周），
 * 也最好测。
 */

import { atomicWriteJson, readJson } from './store'

export interface ScheduledJob {
  id: string
  /** 界面上和通知里的名字。 */
  title: string
  hour: number
  minute: number
  /** 0=周日。不给就是每天。 */
  weekday?: number
  /** 交给 pi 的提示词。 */
  prompt: string
}

interface ScheduleState {
  /** jobId → 上次跑完的时间戳。 */
  lastRunAt: Record<string, number>
}

export interface SchedulerOptions {
  jobs: ScheduledJob[]
  stateFile: string
  /** 真去跑。返回一句话结果，用于通知。 */
  run: (job: ScheduledJob) => Promise<string>
  /** 跑完（或失败）后通知。 */
  onFinish: (job: ScheduledJob, ok: boolean, detail: string) => void
  now?: () => Date
  /** 检查间隔。任务精确到分钟，用不着更密。 */
  tickMs?: number
}

const DEFAULT_TICK_MS = 60_000

/**
 * 最近一次「本该跑」的时间点。
 *
 * 返回 null 表示配置本身有问题（时/分越界），不猜。
 */
export function dueAt(job: ScheduledJob, now: Date): Date | null {
  if (job.hour < 0 || job.hour > 23 || job.minute < 0 || job.minute > 59) return null

  const candidate = new Date(now)
  candidate.setHours(job.hour, job.minute, 0, 0)

  if (job.weekday === undefined) {
    // 每天：今天这个点如果还没到，就退回昨天
    if (candidate > now) candidate.setDate(candidate.getDate() - 1)
    return candidate
  }

  if (job.weekday < 0 || job.weekday > 6) return null
  // 每周：往前退到最近的那个星期几。
  // 退 0..7 而不是 0..6：今天正好是那个星期几但还没到点时要退整整一周，
  // 那一刻落在第 7 次回退上——只退 6 次会算成"没有"。
  for (let back = 0; back <= 7; back++) {
    if (candidate.getDay() === job.weekday && candidate <= now) return candidate
    candidate.setDate(candidate.getDate() - 1)
  }
  return null
}

/** 两个时间是不是同一个日历日（按本地时区）。 */
export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

export class SchedulerService {
  private readonly options: SchedulerOptions
  private readonly now: () => Date
  private state: ScheduleState = { lastRunAt: {} }
  private timer?: NodeJS.Timeout
  private running = false
  /** 正在跑的任务，防止一次补跑还没完又被下一次心跳拉起来。 */
  private readonly inFlight = new Set<string>()

  constructor(options: SchedulerOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.state = readJson<ScheduleState>(options.stateFile, { lastRunAt: {} })
  }

  start(): void {
    if (this.timer) return
    // 起来就先查一次：机器睡过了、app 刚开，都靠这一次把欠的补上
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? DEFAULT_TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 现在欠哪些任务没跑。设置面板和排错都看它。 */
  pending(): ScheduledJob[] {
    const now = this.now()
    return this.options.jobs.filter((job) => this.isDue(job, now))
  }

  private isDue(job: ScheduledJob, now: Date): boolean {
    if (this.inFlight.has(job.id)) return false
    const due = dueAt(job, now)
    if (!due) return false
    // 只在"当天"补跑。主要场景是机器睡了 2 点、早上醒了要补上。
    // 不跨天补：否则一个刚装上、或者关了一周的应用，一启动就把积压的任务
    // 全放出来——用户什么都没做，却看见一堆 pi 在后台跑。
    if (!sameDay(due, now)) return false
    return (this.state.lastRunAt[job.id] ?? 0) < due.getTime()
  }

  /** 不管到没到点，立刻跑一个。 */
  async runNow(jobId: string): Promise<void> {
    const job = this.options.jobs.find((item) => item.id === jobId)
    if (job) await this.execute(job)
  }

  private async tick(): Promise<void> {
    // 上一次还没回来就跳过这一轮，不叠加
    if (this.running) return
    this.running = true
    try {
      const now = this.now()
      for (const job of this.options.jobs) {
        if (this.isDue(job, now)) await this.execute(job)
      }
    } finally {
      this.running = false
    }
  }

  private async execute(job: ScheduledJob): Promise<void> {
    this.inFlight.add(job.id)
    try {
      const detail = await this.options.run(job)
      // 先记时间再通知：通知那一步崩了也不该让同一天重复跑
      this.markRun(job.id)
      this.options.onFinish(job, true, detail)
    } catch (error) {
      // 失败也要记时间。否则一个跑不通的任务会每分钟重试一次，
      // 把日志刷满、还一直占着 pi。
      this.markRun(job.id)
      this.options.onFinish(job, false, error instanceof Error ? error.message : String(error))
    } finally {
      this.inFlight.delete(job.id)
    }
  }

  private markRun(jobId: string): void {
    this.state.lastRunAt[jobId] = this.now().getTime()
    atomicWriteJson(this.options.stateFile, this.state)
  }
}
