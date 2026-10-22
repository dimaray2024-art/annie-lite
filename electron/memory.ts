/**
 * 长期记忆：一个 Obsidian 风格的知识库，三层结构。
 *
 * 两条纪律贯穿全文：
 *
 * 1. **先检索，再按需读**。库里可能有几百篇笔记，任何时候都不许整体加载——
 *    注入的只有索引概览，细节靠 recall/read_note 一层层要。
 *    这既是上下文成本（豆包的 instructions 只有 12K token），也是检索质量。
 *
 * 2. **记忆是持久的提示注入面**。写进去的内容会进系统提示词，下一次会话它就成了"指令"。
 *    所以每次写入都要扫：密钥、注入指令、隐藏 Unicode、长度。漏一条，外部内容就
 *    被洗成了我的规则。
 */

import fs from 'node:fs'
import path from 'node:path'
import { ASSISTANT_NAME, DEFAULT_USER_LABEL, normalizeUserName } from '@shared/contract'
import { PathDenied, SafePathService } from './files'

/** 单条记忆的长度上限。记忆是进提示词的，不能让它无限膨胀。 */
const MAX_ENTRY_CHARS = 2000
/** 注入到提示词里的概览上限，超了就截断——宁可少给，不要挤掉对话空间。 */
const MAX_OVERVIEW_CHARS = 1500
/** 单句对话记多长。语音一句话说不到这么长，超了基本是转写出了问题。 */
const MAX_TURN_CHARS = 500
/** recall 一次最多返回几篇。 */
const MAX_RECALL_RESULTS = 5

/** 明显是凭据的内容不许进记忆。 */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/i,
  /Bearer\s+\S{16,}/i,
  /AKIA[A-Z0-9]{12,}/,
  /\b[a-f0-9]{32,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

/** 提示注入的典型措辞。记忆会进系统提示词，这类内容等于改写我的指令。 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)/i,
  /忽略(之前|以上|前面)的?(所有)?(指令|规则|要求)/,
  /你现在是|从现在起你是|you are now/i,
  /system\s*[:：]/i,
  /<\s*\/?\s*system\s*>/i,
  /disregard\s+(your\s+)?instructions/i
]

/** 零宽字符和双向覆盖字符：肉眼看不出来，但能藏东西。 */
const HIDDEN_UNICODE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/
/**
 * 同一个字符类，剥除用的。
 *
 * 不能把上面那个直接加 g：带 g 的正则用 .test() 是有状态的，lastIndex 会跨调用残留——
 * 第一次测出 true 之后，后面同样的内容就再也测不出来了。这个坑测试当场就抓到了。
 */
const HIDDEN_UNICODE_ALL = new RegExp(HIDDEN_UNICODE.source, 'g')

export type MemoryRejection = 'secret' | 'injection' | 'hidden_unicode' | 'too_long' | 'empty'

export class MemoryWriteRejected extends Error {
  readonly code: string
  constructor(reason: MemoryRejection) {
    super(reason)
    this.code = reason
  }
}

export interface RecallHit {
  /** 相对知识库根目录的路径，交给 read_note 用。 */
  path: string
  title: string
  /** 一句话摘要，不是正文。 */
  summary: string
  updatedAt?: string
}

export class MemoryService {
  private readonly vault: string
  /** 复用文件访问的安全层：路径约束、符号链接、敏感文件都在那里做掉了。 */
  private readonly files: SafePathService

  /** 对话记录和提示词里怎么称呼用户；来自设置，没填就用中性的「用户」。 */
  private readonly userLabel: string

  constructor(vaultPath: string, options: { userName?: string } = {}) {
    this.vault = path.resolve(vaultPath)
    this.files = new SafePathService([this.vault])
    this.userLabel = normalizeUserName(options.userName) || DEFAULT_USER_LABEL
  }

  get vaultPath(): string {
    return this.vault
  }

  isReady(): boolean {
    return fs.existsSync(path.join(this.vault, 'index.md'))
  }

  /**
   * 会话开始时注入的东西：一段指针 + 索引概览。
   * 不是全部内容——库里可能有几百篇，全塞进去会挤掉对话空间。
   */
  overview(): string {
    if (!this.isReady()) return ''
    const index = this.readIfSmall(path.join(this.vault, 'index.md'), MAX_OVERVIEW_CHARS)
    const profile = this.readIfSmall(path.join(this.vault, 'profile.md'), MAX_OVERVIEW_CHARS)

    const parts = [
      `你的长期记忆是一个知识库：${this.vault}`,
      '需要回忆时用 recall 先查索引、再按需用 read_note 读具体笔记；不要一次读完整个库。',
      '要记住新东西用 remember，它会先落到 inbox，之后由整理流程编译进三层结构。',
      // 不点明这一句，被问"我们最近聊了什么"时她不会想到去翻 sources/，
      // 而对话原文正是不在原处、只在 sources/ 的那一类内容
      `你和${this.userLabel}每天的对话原文都记在 sources/ 下，按日期命名（如 sources/2026-10-03.md）。` +
        '被问到"我们最近聊了什么"这类问题时，先去那里找。'
    ]
    if (profile) parts.push(`\n当前的身份与偏好：\n${profile}`)
    if (index) parts.push(`\n知识库索引：\n${index}`)
    return parts.join('\n')
  }

  private readIfSmall(file: string, limit: number): string {
    try {
      const text = fs.readFileSync(file, 'utf8')
      return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
    } catch {
      return ''
    }
  }

  /**
   * 检索：先看索引，再全文搜索，最后只返回标题/摘要/路径。
   * **故意不返回正文**——想看内容得再调 read_note，这样上下文才不会被几篇长文塞满。
   */
  recall(query: string, options: { limit?: number } = {}): { hits: RecallHit[]; searched: string[] } {
    const limit = Math.min(options.limit ?? MAX_RECALL_RESULTS, MAX_RECALL_RESULTS)
    const searched: string[] = []
    const seen = new Map<string, RecallHit>()

    // 1) 索引里点名过的优先
    const indexText = this.readIfSmall(path.join(this.vault, 'index.md'), 100_000)
    if (indexText) {
      searched.push('index.md')
      for (const line of indexText.split('\n')) {
        if (!line.includes(query)) continue
        const link = /\(([^)]+\.md)\)/.exec(line)
        if (!link) continue
        this.addHit(seen, link[1]!, line.replace(/^[-*\s]+/, '').slice(0, 160))
      }
    }

    // 2) 全文搜索补齐索引没有的（比如刚进 inbox、还没来得及进索引的）
    const files = this.walk()
    searched.push(`${files.length} 个笔记文件`)
    for (const relative of files) {
      if (seen.size >= limit * 2) break
      if (relative === 'index.md' || relative === 'log.md' || relative === 'AGENTS.md') continue
      let text: string
      try {
        text = fs.readFileSync(path.join(this.vault, relative), 'utf8')
      } catch {
        continue
      }
      if (!text.includes(query)) continue
      this.addHit(seen, relative, text)
    }

    return { hits: [...seen.values()].slice(0, limit), searched }
  }

  private addHit(seen: Map<string, RecallHit>, relative: string, source: string): void {
    const normalized = relative.replace(/^\.\//, '')
    if (seen.has(normalized)) return
    const { title, updatedAt, summary } = this.describe(normalized, source)
    seen.set(normalized, { path: normalized, title, summary, updatedAt })
  }

  /** 从 frontmatter 和正文里抠出标题、更新时间、一句话摘要。 */
  private describe(relative: string, source: string): { title: string; updatedAt?: string; summary: string } {
    const absolute = path.join(this.vault, relative)
    let text = source
    if (source === relative || !source.includes('\n')) {
      try {
        text = fs.readFileSync(absolute, 'utf8')
      } catch {
        text = source
      }
    }
    const title = /^title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? relative
    const updatedAt = /^updatedAt:\s*(.+)$/m.exec(text)?.[1]?.trim()

    // 摘要取第一段非标题、非 frontmatter 的正文
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '')
    const summary =
      body
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('<!--')) ?? '（无摘要）'
    return { title, updatedAt, summary: summary.slice(0, 140) }
  }

  private walk(dir = ''): string[] {
    const root = path.join(this.vault, dir)
    const out: string[] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...this.walk(relative))
      else if (entry.name.endsWith('.md')) out.push(relative)
    }
    return out
  }

  /** 读某一篇笔记。路径限定在库内，长度有上限。 */
  readNote(relative: string, maxChars = 4000): string {
    const resolved = this.files.resolve(relative)
    const text = fs.readFileSync(resolved, 'utf8')
    if (text.length > maxChars) return `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字）`
    return text
  }

  /**
   * 写入记忆。默认落 inbox，不直接改编译层——语音现场编译质量不可控，
   * 编译该由整理流程做（那也是三层结构能被信任的原因）。
   */
  remember(text: string, now = new Date()): { file: string; chars: number } {
    this.validate(text)
    const stamp = now.toISOString().slice(0, 10)
    const entry = `\n## [${stamp}] ${text.trim()}\n`

    const inbox = path.join(this.vault, 'inbox.md')
    fs.appendFileSync(inbox, entry, { mode: 0o600 })
    fs.appendFileSync(path.join(this.vault, 'log.md'), `\n## [${stamp}] remember | inbox.md\n`, { mode: 0o600 })

    return { file: 'inbox.md', chars: text.trim().length }
  }

  /**
   * 记一句对话。用户说的和安妮说的都按时间落到 `sources/YYYY-MM-DD.md`。
   *
   * 这是"我们最近聊了什么"能答上来的前提——在这之前对话**完全没有落盘**：
   * 会话一结束就没了，库里只剩安妮主动 remember 的那几条。
   *
   * 放 sources/ 而不是直接进 syntheses/：AGENTS.md 里 sources 的定位正是
   * "聊天原文"，而现场编译质量不可控，编译该交给每天的整理流程。
   *
   * 不做完整的写入闸（那四道是给安妮自己生成的内容用的）：这里记的是原话，
   * 拒绝了就等于对话有了窟窿。但**隐藏 Unicode 必须剥掉**——它不可见，
   * 却能在这些话被读回来时改变指令，而用户在界面上根本看不到它。
   */
  recordTurn(speaker: 'user' | 'annie', text: string, now = new Date()): void {
    const clean = text.replace(HIDDEN_UNICODE_ALL, '').replace(/\s+/g, ' ').trim()
    if (!clean) return

    const stamp = now.toISOString().slice(0, 10)
    const dir = path.join(this.vault, 'sources')
    const file = path.join(dir, `${stamp}.md`)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        file,
        `---\ntitle: ${stamp} 对话\nupdatedAt: ${stamp}\ntags: [sources, 对话]\n---\n\n# ${stamp} 对话\n\n`,
        { mode: 0o600 }
      )
    }
    const label = speaker === 'user' ? this.userLabel : ASSISTANT_NAME
    fs.appendFileSync(file, `- **${now.toTimeString().slice(0, 5)} ${label}**：${clean.slice(0, MAX_TURN_CHARS)}\n`, {
      mode: 0o600
    })
  }

  /** 写入前的四道闸。任何一道不过，整条拒绝——记忆一旦进去就是指令。 */
  private validate(text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new MemoryWriteRejected('empty')
    if (trimmed.length > MAX_ENTRY_CHARS) throw new MemoryWriteRejected('too_long')
    if (HIDDEN_UNICODE.test(trimmed)) throw new MemoryWriteRejected('hidden_unicode')
    if (SECRET_PATTERNS.some((pattern) => pattern.test(trimmed))) throw new MemoryWriteRejected('secret')
    if (INJECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) throw new MemoryWriteRejected('injection')
  }
}

export { PathDenied }
