/**
 * 工具注册表：模型想调工具时的唯一入口。
 *
 * 这里是**不可信输入**进入本机能力的关口，所以校验按顺序全做一遍：
 * 大小 → JSON → schema → 超时。任何一步失败都返回**稳定的错误码字符串**，
 * 而不是原始异常信息——原始信息里经常夹着路径和凭据。
 */

import { z } from 'zod'
import type { ToolDescriptor, ToolRisk } from '@shared/contract'

/** 参数上限。模型被诱导生成超大 JSON 时，别让它把内存吃满。 */
const MAX_ARGUMENT_BYTES = 16 * 1024
/** 结果上限。超出会被截断——反正语音也念不了那么长。 */
const MAX_RESULT_BYTES = 32 * 1024

export interface ToolContext {
  signal: AbortSignal
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  /** 给豆包用的 JSON Schema（扁平结构，见 provider 里的注释）。 */
  parameters: Record<string, unknown>
  schema: TSchema
  risk: ToolRisk
  /** 会改动本机状态的操作：需要用户确认。 */
  destructive: boolean
  /**
   * 结果由我们自己念，不等模型开口。
   *
   * 给"要用户先确认"的工具用：确认对话框一定会超过豆包等工具结果的窗口
   * （实测 8 秒还能接上话，20 秒就彻底没反应），所以那一轮模型已经死了，
   * 再指望它播报就是永远不出声。
   */
  speakResult?: boolean
  // 这里原先有一个 announce 字段：动手前让安妮先念一句「我看一下」。
  // 实测证明它行不通——播报走 speech_text_buffer，服务端会把它合成成一整轮
  // 完整的 response；只要这一轮里出现过播报，随后回传的工具结果就再也不会
  // 让模型接话（用户的感受是"她说看一眼，然后就没了"）。
  // 顺序、延迟、item 形状、replacement 变体全都试过，无一例外。
  // 所以费时间的活交给"立刻返回 + 跑完单独播报"，短活直接让模型自己开口。
  timeoutMs?: number
  execute: (args: z.infer<TSchema>, context: ToolContext) => Promise<ToolOutput> | ToolOutput
}

/**
 * 工具返回的东西。
 *
 * 通常就是给模型看的一句话。需要由我们自己念的时候返回对象，把两句分开——
 * 给模型的和给用户听的经常不是同一句：「已受理，请用一句话告诉用户…」是工单语气，
 * 该给模型看；用户听到的应该是「好，我去查惠州天气，办好告诉你」。
 */
export type ToolOutput = string | { output: string; speech?: string }

export interface ToolCall {
  callId: string
  name: string
  arguments: string
}

export interface ToolResult {
  callId: string
  name: string
  ok: boolean
  /** 回给模型的文本。失败时是错误码，不是异常堆栈。 */
  output: string
  /**
   * 立刻念这句，不等结果。
   *
   * 给「派活」类工具用：它们马上返回，活儿在后台跑，需要一句话把这段空白填上。
   * 和 speakResult 是两回事——那个念的是**结果**，这个是**受理**。
   */
  speech?: string
  error?: string
  /** 成功时给界面显示的一句话（可选）。 */
  message?: string
}

export type ApprovalHook = (call: ToolCall, definition: ToolDefinition) => Promise<boolean>

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly approve?: ApprovalHook

  constructor(options: { approve?: ApprovalHook } = {}) {
    this.approve = options.approve
  }

  register<TSchema extends z.ZodTypeAny>(definition: ToolDefinition<TSchema>): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(definition.name)) {
      throw new Error(`工具名不合法: ${definition.name}`)
    }
    if (this.tools.has(definition.name)) throw new Error(`工具重复注册: ${definition.name}`)
    // 协变问题：带具体 schema 的 execute 不能赋给 ToolDefinition<ZodTypeAny>。
    // 这里是安全的——调用方传进来的参数已经过该 schema 的 safeParse。
    this.tools.set(definition.name, definition as unknown as ToolDefinition)
  }

  /** 按名字取定义，用于执行后的收尾（比如要不要自己念结果）。 */
  descriptorFor(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  descriptors(): ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      destructive: tool.destructive
    }))
  }

  /** 交给豆包的 tools 配置。注意是**扁平**结构：name 与 type 同级。 */
  doubaoTools(): Array<Record<string, unknown>> {
    return [...this.tools.values()].map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const definition = this.tools.get(call.name)
    if (!definition) {
      return this.fail(call, 'unknown_tool', `没有这个工具: ${call.name}`)
    }

    const rawArguments = call.arguments ?? ''
    if (Buffer.byteLength(rawArguments, 'utf8') > MAX_ARGUMENT_BYTES) {
      return this.fail(call, 'arguments_too_large', '参数过大')
    }

    let parsed: unknown
    try {
      parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {}
    } catch {
      return this.fail(call, 'invalid_json', '参数不是合法 JSON')
    }

    const validated = definition.schema.safeParse(parsed)
    if (!validated.success) {
      const issue = validated.error.issues[0]
      return this.fail(call, 'invalid_arguments', issue ? `${issue.path.join('.')}: ${issue.message}` : '参数不合法')
    }

    if (definition.destructive) {
      // 默认拒绝：没配确认通道时不执行破坏性操作。
      // 反过来（没钩子就放行）会让"忘了接线"变成"静默执行删除"。
      if (!this.approve) return this.fail(call, 'approval_unavailable', '破坏性操作需要确认，但确认通道不可用')
      const approved = await this.approve(call, definition)
      if (!approved) return this.fail(call, 'approval_cancelled', '用户没有同意执行')
    }

    const controller = new AbortController()
    const timeoutMs = definition.timeoutMs ?? 8000
    // 和计时器赛跑，而不是只 abort 信号：工具如果没理会 signal，
    // 只 abort 的话它的晚到结果会被当成成功返回，超时形同虚设。
    // 语音场景下这条尤其要紧——一个卡住的工具会把整轮对话拖住。
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        const error = new Error('timeout') as Error & { code: string }
        error.code = '__timeout__'
        reject(error)
      }, timeoutMs)
    })

    try {
      const raw = await Promise.race([definition.execute(validated.data, { signal: controller.signal }), timeout])
      const output = typeof raw === 'string' ? { output: raw } : raw
      const text = typeof output.output === 'string' ? output.output : String(output.output)
      if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
        return this.fail(call, 'result_too_large', '结果过大')
      }
      return { callId: call.callId, name: call.name, ok: true, output: text, speech: output.speech }
    } catch (error) {
      // 工具自己抛的"可展示错误"带 code；其余一律收敛成 execution_failed，
      // 不把原始 message 透出去（可能含路径、命令输出片段）
      const code = (error as { code?: string }).code
      if (code === '__timeout__') return this.fail(call, 'timeout', `超过 ${timeoutMs}ms`)
      const message = error instanceof Error ? error.message : String(error)
      if (code) return this.fail(call, code, message)
      return this.fail(call, 'execution_failed', '执行失败')
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(call: ToolCall, code: string, detail: string): ToolResult {
    return { callId: call.callId, name: call.name, ok: false, output: `${code}: ${detail}`, error: code }
  }
}
