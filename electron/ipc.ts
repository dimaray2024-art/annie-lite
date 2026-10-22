/**
 * IPC 的唯一入口。
 *
 * 两条纪律，都来自「渲染层是不可信输入」这个前提：
 * 1. 每个 invoke 都先验发送方（必须是主窗口的顶层 frame），再验参数（zod）
 * 2. 抛回渲染层的错误要洗一遍，别把密钥、路径、供应商原始响应带出去
 */

import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent, shell } from 'electron'
import { z } from 'zod'

export function assertSender(event: IpcMainInvokeEvent, window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) throw new Error('窗口已关闭')
  if (event.sender !== window.webContents) throw new Error('非法调用来源')
  // 只接受顶层 frame：防止 iframe 里的脚本拿到同一套能力
  if (event.senderFrame !== window.webContents.mainFrame) throw new Error('非法调用来源')
}

/** 常见敏感串的兜底遮蔽。供应商的报错里经常夹着 key 或 Authorization 头。 */
export function scrub(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer|Api-Key|X-Api-Key)[:=\s]+\S+/gi, '$1 ***')
    .replace(/[A-Za-z0-9_-]{32,}/g, (match) => (match.length >= 32 ? '***' : match))
}

export function displayError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  return new Error(scrub(raw))
}

/** 无参数通道：渲染层可能不传、传 null，也可能传空对象，都接受。 */
export const emptyArgs = z.union([z.undefined(), z.null(), z.object({}).passthrough()])

/** 已注册的通道。同一个通道注册两次是 bug，且报错时机很隐蔽（见 handleInvoke）。 */
const registered = new Set<string>()

/**
 * 注册一个带发送方校验与参数校验的 invoke 处理器。
 * 所有 renderer → main 的调用都必须走这里，不允许裸 ipcMain.handle。
 */
export function handleInvoke<TSchema extends z.ZodTypeAny>(
  channel: string,
  schema: TSchema,
  getWindow: () => BrowserWindow | undefined,
  handler: (input: z.infer<TSchema>, event: IpcMainInvokeEvent) => Promise<unknown> | unknown
): void {
  // 重复注册时 ipcMain.handle 抛的是「Attempted to register a second handler」，
  // 不带通道名，也不说是在哪注册的。这里先拦一道，把通道名点出来。
  // 更麻烦的是它通常抛在 whenReady 回调里，会把后面的建窗步骤一起带走——
  // 表现成「应用启动了但没有窗口」，很难联想到这里。
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`)
  registered.add(channel)

  ipcMain.handle(channel, async (event, raw) => {
    assertSender(event, getWindow())
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw displayError(new Error(`参数不合法: ${parsed.error.issues[0]?.message ?? 'unknown'}`))
    }
    try {
      return await handler(parsed.data, event)
    } catch (error) {
      throw displayError(error)
    }
  })
}

/** 对外链接受限：只允许 http/https，别把 file: 或自定义协议放出去。 */
export async function openExternalUrl(raw: string): Promise<void> {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许打开 http/https 链接')
  }
  await shell.openExternal(url.toString())
}
