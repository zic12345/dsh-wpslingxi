/**
 * WPS 灵犀 DSH 适配器（v2.0：直连云端，DSH 主导 agent 循环）。
 *
 * ## 与 v1.x 的根本差异
 *
 * v1.x 把对话交给桌面 `lingxi.exe`（app-server），模型跑在**灵犀自己的
 * agent 循环**里：工具是灵犀沙箱内的 bash/file/web，DSH 的工具链完全用不上，
 * 宿主 PowerShell 还被灵犀的双层黑名单拦住（Python 审计层 + Go 词法层）。
 *
 * v2.0 直接调云端 `POST /api/public/v1/agent-runtime/chat/completions`
 * （OpenAI 风格，支持 `tools`/`tool_calls`），**agent 循环交回 DSH**：
 *
 * - 工具：`options.tools` 原样下发，模型返回的 `tool_calls` 转成 DSH 的
 *   `tool-call` 块，DSH 执行完再用 `role:'tool'` 回传 → 宿主 PowerShell、
 *   WSL bash、DSH 全部内置工具立即可用；
 * - 系统提示词：走灵犀的 `context` 字段（真机抓包确认可整体覆盖其内置提示词）；
 * - 上下文/压缩/重试/审批：全部由 DSH 负责，灵犀只当一个纯 LLM 后端。
 *
 * 详见 {@link LingxiDirectClient}（HTTP 客户端）与 lingxi-messages.ts（消息转换）。
 *
 * ## 仍然保留的能力
 *
 * - 凭据：`wps_sid` 由 {@link extractWpsSid} 从桌面 App 登录态自动提取
 *   （DPAPI + AES-256-GCM 解 Chromium cookie），也允许 `DSH_LINGXI_WPS_SID` 覆盖；
 * - 计费：按 run 计（一个 DSH 会话 1 智点），见 {@link LingxiDirectClient}；
 * - 设置页的签到/智点面板：与 LLM 通道共用同一个 SID，互不影响。
 */
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { detectWsl, resolveLingxiWorkspaceOverride, wslPathToWindows, type WslEnvironment } from './lingxi-win32.js'
import { extractWpsSid } from './lingxi-credential.js'
import { LingxiDirectClient, type DirectToolCall } from './lingxi-direct.js'
import { toDirectMessages, toDirectTools } from './lingxi-messages.js'
import {
  LINGXI_DEFAULT_MODEL,
  LINGXI_FALLBACK_MODELS,
  findFallbackModel,
  type LingxiModelEntry,
} from './lingxi.js'
import { LINGXI } from './lingxi-product.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 适配器构造参数。 */
export interface LingxiAdapterOptions {
  /** 强制注入 WSL 环境（测试用）；缺省时运行时探测。 */
  env?: WslEnvironment
  /**
   * 按 DSH 会话 id 解析该会话的项目工作目录（**WSL 路径**）。
   *
   * 由 index.ts 用宿主 `ctx.sessionQuery.observeSession(sessionId).header.cwd`
   * 实现并注入：LLM 的 GenerateOptions 不携带工作区，只携带 sessionId。
   * v2.0 里该路径只用于在云端会话上**声明**工作区（不影响工具执行，
   * 工具跑在 DSH 侧的真实 cwd 里）。
   */
  resolveSessionCwd?: (sessionId: string) => Promise<string | undefined>
}

/** sessionQuery 的最小结构化类型（避免硬依赖宿主包的 .d.ts）。 */
interface LingxiSessionObservation {
  header?: { cwd?: string }
  [Symbol.dispose]?: () => void
}
interface LingxiSessionQueryLike {
  observeSession(sessionId: string): Promise<LingxiSessionObservation>
}

export class LingxiAdapter extends LlmAdapter {
  private env: WslEnvironment | undefined
  /** 直连客户端（进程级单例，内部按 sessionId 缓存 run）。 */
  private client: LingxiDirectClient | undefined
  /** 远端刷新过的模型目录（未刷新前用内置兜底目录）。 */
  private remoteModels: LingxiModelEntry[] | undefined
  /**
   * 每个 DSH 会话解析出的工作区（Windows 路径），按 sessionId 缓存。
   * 会话 cwd 固定，只反查一次；wslpath 转换同样缓存（按 WSL 路径）。
   */
  private readonly sessionWorkspace = new Map<string, string | undefined>()
  private readonly wslToWinCache = new Map<string, string | undefined>()

  constructor(private readonly options: LingxiAdapterOptions = {}) {
    super()
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: LINGXI.id, name: LINGXI.displayName }
  }

  /**
   * 对外可展示的模型：直接返回内置目录。
   *
   * 云端 `model/list` 已不再需要（直连时模型名就是请求字段，网关按名路由），
   * 故列表纯本地、零延迟。
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const entries = this.remoteModels ?? LINGXI_FALLBACK_MODELS
    return entries.map((entry) => this.toModelInfo(entry))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    // 纯本地元数据，不发网络请求；未知 model id 也放行（网关按名路由）。
    const entry = findFallbackModel(model)
    const base = this.toModelInfo(entry ?? {
      modelName: model,
      name: model,
      intro: '',
      multimodal: false,
      contextTokens: 1048576,
      maxNewTokens: 131072,
      reasoningEfforts: [],
    })
    const resolved: LlmResolvedModelInfo = {
      ...base,
      provider,
      context: { contextWindow: entry?.contextTokens ?? 1048576 },
      defaultMaxTokens: entry?.maxNewTokens ?? 131072,
    }
    const reasoning = this.reasoningInfo(entry)
    if (reasoning) resolved.reasoning = reasoning
    return resolved
  }

  private toModelInfo(entry: LingxiModelEntry): LlmModelInfo {
    return {
      provider: LINGXI.id,
      id: entry.modelName,
      name: entry.name,
      description: entry.intro || undefined,
      // 直连通道按纯文本接入：图片/文件不投递（DSH 据此不会给出图片附件）。
      inputModalities: ['text'],
    }
  }

  private reasoningInfo(entry: LingxiModelEntry | undefined): LlmModelReasoningInfo | undefined {
    if (!entry || entry.reasoningEfforts.length === 0) return undefined
    const labels: Record<'low' | 'high' | 'max', string> = {
      low: '低',
      high: '高',
      max: '最强',
    }
    return {
      efforts: entry.reasoningEfforts.map((id) => ({
        id: ReasoningEffortId(id),
        name: labels[id],
      })),
    }
  }

  /** 懒探测 WSL 环境（非 WSL 直接抛错，注册阶段已拦截，这里双保险）。 */
  private async ensureEnv(): Promise<WslEnvironment> {
    if (this.env) return this.env
    const env = this.options.env ?? detectWsl()
    if (!env) throw new Error('WPS 灵犀 provider 仅在 WSL 环境可用（未检测到 WSL）')
    this.env = env
    return env
  }

  /**
   * 取直连客户端（单例）。SID 在首次真正请求时才提取，避免注册阶段
   * 拖慢启动；401 由客户端内部强制重取。
   */
  private async getClient(): Promise<LingxiDirectClient> {
    if (this.client) return this.client
    const env = await this.ensureEnv()
    this.client = new LingxiDirectClient(async (force) => extractWpsSid(env, force))
    return this.client
  }

  /**
   * 解析本次请求应声明给云端的会话工作区（Windows 路径）。
   *
   * 优先级：
   * 1. 环境变量 DSH_LINGXI_WORKSPACE（显式覆盖，全局固定）；
   * 2. 当前 DSH 会话的项目目录——用 GenerateOptions.sessionId 经注入的
   *    resolveSessionCwd 反查 `sessionQuery.observeSession(...).header.cwd`；
   * 3. 都拿不到时返回 undefined（云端回退到它的默认临时目录）。
   *
   * ⚠️ 只用于云端会话的 `work_space_dir` 声明，**不决定工具执行目录**：
   * v2.0 的工具全在 DSH 侧执行，天然跟随会话 cwd。
   */
  private async resolveWorkspaceWin(sessionId: string | undefined): Promise<string | undefined> {
    const overrideWsl = resolveLingxiWorkspaceOverride()
    if (overrideWsl) return this.toWindowsCached(overrideWsl)

    if (!sessionId || !this.options.resolveSessionCwd) return undefined
    const cached = this.sessionWorkspace.get(sessionId)
    if (cached !== undefined || this.sessionWorkspace.has(sessionId)) return cached

    let win: string | undefined
    try {
      const cwdWsl = await this.options.resolveSessionCwd(sessionId)
      if (cwdWsl) win = this.toWindowsCached(cwdWsl)
    } catch {
      win = undefined
    }
    this.sessionWorkspace.set(sessionId, win)
    return win
  }

  /** WSL→Windows 路径转换，按 WSL 路径缓存结果。 */
  private toWindowsCached(wslPath: string): string | undefined {
    const existing = this.wslToWinCache.get(wslPath)
    if (existing !== undefined || this.wslToWinCache.has(wslPath)) return existing
    let win: string | undefined
    try {
      win = wslPathToWindows(wslPath)
    } catch {
      win = undefined
    }
    this.wslToWinCache.set(wslPath, win)
    return win
  }

  /**
   * 主流程：把 DSH 的请求翻译成云端 OpenAI 形状，流式转发回 DSH。
   *
   * 块编号策略（与 DSH 协议一致）：
   * - 思考块（`reasoning_content`）先出现 → 索引 0；
   * - 正文块 → 紧随其后；
   * - 工具调用块按 `index` 顺序依次编号；
   * - 每个块在 `block-end` 时携带**累积完整内容**。
   */
  override async *stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    const model = options.model || LINGXI_DEFAULT_MODEL
    const converted = toDirectMessages(options.messages, options.system)
    const tools = toDirectTools(options.tools)

    if (converted.messages.length === 0) {
      // 没有任何可下发内容：这是调用方 bug，给出明确错误而不是发空请求。
      throw new LlmError('灵犀请求没有可下发的消息', 'INVALID_REQUEST')
    }

    const client = await this.getClient()
    const workspaceWin = await this.resolveWorkspaceWin(options.sessionId)
    const sessionKey = options.sessionId ? String(options.sessionId) : 'default'

    /* ---------------- 流式状态：块编号与累积内容 ---------------- */

    /** 已开启的块（按 DSH 索引）。 */
    interface OpenBlock {
      index: number
      type: 'reasoning' | 'text' | 'tool-call'
      /** 累积正文（text/reasoning）。 */
      text: string
      /** 工具调用身份与累积参数。 */
      callId?: string
      name?: string
      args?: string
    }

    const blocks: OpenBlock[] = []
    /** 云端 tool_call index → 我们分配的块（同一调用跨帧复用）。 */
    const callIndexToBlock = new Map<number, OpenBlock>()
    let reasoningBlock: OpenBlock | undefined
    let textBlock: OpenBlock | undefined
    let nextIndex = 0

    /** 开一个新块并立即产出 block-start（generator 内联，故用闭包收集）。 */
    const opened: StreamChunk[] = []
    const openBlock = (type: OpenBlock['type']): OpenBlock => {
      const block: OpenBlock = { index: nextIndex++, type, text: '' }
      blocks.push(block)
      opened.push({ type: 'block-start', index: block.index, blockType: type })
      return block
    }

    /* ---------------- 队列：把回调搬进 generator ---------------- */

    const queue: StreamChunk[] = []
    let wake: (() => void) | undefined
    let done = false
    let failure: Error | undefined
    const notify = (): void => {
      const fn = wake
      wake = undefined
      fn?.()
    }
    /** 把已开块产生的 chunk 冲进队列。 */
    const flushOpened = (): void => {
      while (opened.length > 0) queue.push(opened.shift()!)
      notify()
    }

    let result: Awaited<ReturnType<LingxiDirectClient['chat']>> | undefined

    const task = client.chat(
      sessionKey,
      {
        model,
        messages: converted.messages,
        tools,
        system: converted.system || undefined,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        reasoningEffort: options.reasoningEffort ? String(options.reasoningEffort) : undefined,
        // 建 run 时用作账单标题（积分流水里可见，便于对账）。
        title: firstUserText(options.messages) || 'DSH 会话',
        workspaceWin,
        signal: options.signal,
      },
      {
        onReasoning(delta) {
          if (!reasoningBlock) {
            reasoningBlock = openBlock('reasoning')
            flushOpened()
          }
          reasoningBlock.text += delta
          queue.push({ type: 'reasoning-delta', index: reasoningBlock.index, text: delta })
          notify()
        },
        onText(delta) {
          if (!textBlock) {
            textBlock = openBlock('text')
            flushOpened()
          }
          textBlock.text += delta
          queue.push({ type: 'text-delta', index: textBlock.index, text: delta })
          notify()
        },
        onToolCallDelta(callIndex, id, name, argsDelta) {
          let block = callIndexToBlock.get(callIndex)
          if (!block) {
            block = openBlock('tool-call')
            block.callId = id
            block.name = name
            block.args = ''
            callIndexToBlock.set(callIndex, block)
            flushOpened()
            // 首帧必须发一次带 id/name 的 delta，DSH 据此建立调用身份。
            queue.push({
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(block.callId ?? `call_${callIndex}`),
              name: block.name,
              argumentsDelta: '',
            })
            notify()
          } else {
            if (id) block.callId = id
            if (name) block.name = name
          }
          if (argsDelta) {
            block.args = (block.args ?? '') + argsDelta
            queue.push({
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(block.callId ?? `call_${callIndex}`),
              argumentsDelta: argsDelta,
            })
            notify()
          }
        },
      },
    ).then((res) => {
      result = res
    }).catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error))
    }).finally(() => {
      done = true
      notify()
    })

    options.signal?.addEventListener('abort', () => {
      done = true
      notify()
    }, { once: true })

    /* ---------------- 排空队列 ---------------- */

    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      yield queue.shift()!
    }

    await task

    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { code: 'ABORTED', message: '灵犀对话已取消' },
        },
      }
      return
    }
    if (failure) throw failure
    if (!result) throw new LlmError('灵犀对话未返回结果', 'EMPTY_RESPONSE')

    /* ---------------- 补 block-end（携带累积完整内容） ---------------- */

    for (const block of blocks) {
      let content: ContentBlock
      if (block.type === 'reasoning') {
        content = { type: 'reasoning', text: block.text }
      } else if (block.type === 'text') {
        content = { type: 'text', text: block.text }
      } else {
        content = {
          type: 'tool-call',
          id: ToolCallId(block.callId ?? `call_${block.index}`),
          name: block.name ?? '',
          arguments: block.args ?? '',
        }
      }
      yield { type: 'block-end', index: block.index, block: content }
    }

    /* ---------------- usage ---------------- */

    const usage = toTokenUsage(result.usage)
    if (usage) yield { type: 'usage', usage }

    /* ---------------- finish ---------------- */

    // 空响应（既无正文也无工具调用）：规范成 EMPTY_RESPONSE，运行时可安全重试。
    if (result.toolCalls.length === 0 && result.text.trim().length === 0) {
      throw new LlmError('灵犀模型未返回任何内容', 'EMPTY_RESPONSE')
    }

    yield {
      type: 'finish',
      reason: result.toolCalls.length > 0
        ? { kind: 'tool-calls' }
        : result.finishReason === 'length'
          ? { kind: 'max-tokens' }
          : { kind: 'stop' },
    }
  }
}

/**
 * 云端 usage → DSH `TokenUsage`。
 *
 * ⚠️ 口径差异：DSH 的计数是**互斥**的（`inputTokens` 只算未命中缓存的输入，
 * 缓存命中单列 `cacheReadTokens`），而灵犀的 `prompt_tokens` 是**含缓存**的
 * 总数（真机实测 `cached_tokens` 是其子集）。故必须相减，否则计量翻倍。
 */
function toTokenUsage(raw: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  const cached = Math.max(0, raw.cachedTokens)
  const input = Math.max(0, raw.promptTokens - cached)
  return {
    inputTokens: input,
    outputTokens: raw.completionTokens,
    totalTokens: raw.totalTokens || input + cached + raw.completionTokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

/** 取首条用户消息的纯文本（用作积分流水里的任务名）。 */
function firstUserText(messages: GenerateOptions['messages']): string {
  for (const message of messages) {
    if ((message as { role?: string }).role !== 'user') continue
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .map((raw) => (typeof raw === 'string' ? raw : (raw as { text?: string }).text ?? ''))
        .join('')
      if (text.trim()) return text
    }
  }
  return ''
}

/**
 * 注册灵犀 provider 路由。
 *
 * 仅当①运行在 WSL、②能取到桌面登录态 SID 时才注册；任一不满足都静默跳过
 * （非 WSL / 未登录的用户不应看到一个一用就报错的模型）。
 *
 * 注意：v2.0 不再探测 `lingxi.exe`——直连云端只需要 SID，桌面版是否在运行
 * 都无所谓（只要曾经登录过，cookie 就在）。
 */
export async function registerLingxiLlm(ctx: Context): Promise<LingxiAdapter | undefined> {
  let env: WslEnvironment
  try {
    const detected = detectWsl()
    if (!detected) return undefined
    env = detected
  } catch {
    return undefined
  }
  let adapter: LingxiAdapter
  try {
    // 提前验证登录态可提取，避免注册出一个无法工作的路由。
    await extractWpsSid(env)

    // 按会话 id 反查该会话的项目工作目录（WSL 路径）。
    // sessionQuery 由插件 inject 声明；observeSession 返回的租约带 [Symbol.dispose]，
    // 只读 header.cwd 后立即释放。失败/拿不到都返回 undefined。
    const sessionQuery = (ctx as unknown as { sessionQuery?: LingxiSessionQueryLike }).sessionQuery
    const resolveSessionCwd = sessionQuery
      ? async (sessionId: string): Promise<string | undefined> => {
          const obs = await sessionQuery.observeSession(sessionId)
          try {
            return obs.header?.cwd
          } finally {
            obs[Symbol.dispose]?.()
          }
        }
      : undefined

    adapter = new LingxiAdapter({ env, resolveSessionCwd })
  } catch (error) {
    ctx.logger?.warn?.(
      `[lingxi] 未启用 WPS 灵犀 provider：${(error as Error).message}`,
    )
    return undefined
  }
  registerAdapterIdempotent(ctx.llm, [LINGXI.id], adapter)
  ctx.logger?.info?.(`[lingxi] 已注册 provider "${LINGXI.id}"（WPS 灵犀云端直连，支持工具调用）`)
  return adapter
}

/** 供测试/诊断：导出内部类型。 */
export type { DirectToolCall }
