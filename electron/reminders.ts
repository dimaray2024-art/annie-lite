/**
 * 一次性提醒。
 *
 * 提醒不是语音会话的临时状态：用户说完「一小时后提醒我」后，即使会话退下，
 * 提醒也应该继续存在。因此这里单独持久化，并由主进程统一负责到点回调。
 */

import crypto from 'node:crypto'
import { atomicWriteJson, readJson } from './store'

export interface Reminder {
  id: string
  message: string
  dueAt: number
}

interface ReminderState {
  reminders: Reminder[]
}

export class ReminderService {
  private readonly stateFile: string
  private readonly onDue: (reminder: Reminder) => void
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private reminders: Reminder[]

  constructor(options: { stateFile: string; onDue: (reminder: Reminder) => void }) {
    this.stateFile = options.stateFile
    this.onDue = options.onDue
    this.reminders = readJson<ReminderState>(this.stateFile, { reminders: [] }).reminders.filter(
      (reminder) => Boolean(reminder.id && reminder.message) && Number.isFinite(reminder.dueAt)
    )
  }

  start(): void {
    for (const reminder of this.reminders) this.schedule(reminder)
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  add(message: string, delaySeconds: number): Reminder {
    const reminder: Reminder = {
      id: crypto.randomUUID(),
      message,
      dueAt: Date.now() + delaySeconds * 1000
    }
    this.reminders.push(reminder)
    this.save()
    this.schedule(reminder)
    return reminder
  }

  list(): Reminder[] {
    return this.reminders.map((reminder) => ({ ...reminder }))
  }

  private schedule(reminder: Reminder): void {
    const delay = Math.max(0, reminder.dueAt - Date.now())
    const timer = setTimeout(() => {
      this.timers.delete(reminder.id)
      this.reminders = this.reminders.filter((item) => item.id !== reminder.id)
      this.save()
      this.onDue(reminder)
    }, delay)
    this.timers.set(reminder.id, timer)
  }

  private save(): void {
    atomicWriteJson(this.stateFile, { reminders: this.reminders })
  }
}
