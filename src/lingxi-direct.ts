/**
 * 灵犀云端 LLM 直连客户端（v2.0 的核心）。
 *
 * ## 为什么不再走 lingxi.exe
 *
 * v1.x 的实现经两层 stdio 桥调用桌面 `lingxi.exe`（app-server），模型跑在
 * **灵犀自己的 agent 循环**里——工具是灵犀沙箱内的 bash/file/web，DSH 的
 * 工具链完全用不上，宿主 PowerShell 也被灵犀的 Python 审计层与 Go 词法层
 * 双重黑名单拦住（详见 HANDOFF.md 的调研章节）。
 *
 * 2026-10-28 抓包确认：灵犀自己也只是个 HTTP 客户端，它的 agent 循环
 * **完全在本地**，云端只提供 `POST /api/public/v1/agent-runtime/chat/completions`
 * 这一个纯 LLM 接口（OpenAI 风格，支持 `tools` / `tool_calls`）。因此本插件
 * 改为**直连该接口**，把 agent 循环交回 DSH——工具、权限、审批、上下文
 * 管理全部归 DSH，宿主 PowerShell 与 WSL 都直接可用。
 *
 * ## 调用链（三步，缺一不可）
 *
 * ```
 * ① POST /api/aioffice/v1/cowork/sessions      → session_id
 * ② POST /api/public/v1/credits/runs           → run_id（会话级，可复用）
 * ③ POST /api/public/v1/agent-runtime/chat/completions（SSE 流式）
 * ```
 *
 * `chat/completions` 的两个请求头 `x-cc-session-id` / `x-cc-run-id` 必须来自
 * 真实创建的对象（假值报 `SQLNoRows 数据不存在`），故 ①② 不能省。
 *
 * ## 计费（真机实测）
 *
 * - 计费单位是 **run**，不是请求：一个 run 内调多少次 `chat/completions`
 *   都只扣 1 智点（实测 10 次调用、跨 5 分钟、含并发，余额只 -1）；
 * - 扣费发生在**首次** `chat/completions`，建 run 本身不扣；
 * - 因此本模块按 sessionId 缓存 run 并长期复用，一个 DSH 会话只花 1 智点。
 *
 * ## 鉴权
 *
 * 与「智点」接口同源：`Cookie: wps_sid=<sid>`（不认 Bearer）。SID 由
 * {@link extractWpsSid} 从桌面 App 登录态自动提取，401 时强制重取一次。
 */
import { LingxiCloudError } from './lingxi-cloud.js'

/** 云端基址；允许用环境变量覆盖（测试/未来域名迁移）。 */
const CLOUD_BASE = process.env.DSH_LINGXI_CLOUD_BASE ?? 'https://lingxi.wps.cn'
const PUBLIC_PREFIX = '/api/public/v1'
const AIOFFICE_PREFIX = '/api/aioffice/v1'

/**
 * 客户端版本头。
 *
 * 服务端似乎不严格校验（实测 68 之外的值也通过），但保持与真机桌面版一致
 * 可降低未来被网关拦截的风险。
 */
const APPSERVER_VERSION = '68'

/** 一轮对话里单次 HTTP 请求的超时（流式下是「建连 + 首帧」超时）。 */
const REQUEST_TIMEOUT_MS = 120_000

/* ------------------------------- OpenAI 形状 ------------------------------- */

/**
 * 一条 OpenAI 风格的对话消息。
 *
 * 与 DSH 的 `Message` 不同，这里刻意用**最宽松的线上形状**：适配器负责
 * 在两者之间转换（见 lingxi-messages.ts）。
 */
export interface DirectChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 正文；assistant 携带 tool_calls 时可为空串。 */
  content: string
  /** assistant 专用：本轮发起的工具调用。 */
  tool_calls?: DirectToolCall[]
  /** tool 专用：回应哪一个工具调用。 */
  tool_call_id?: string
}

/** 一个工具调用（OpenAI 形状）。 */
export interface DirectToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON 字符串（不是对象）。 */
    arguments: string
  }
}

/** 一个可下发给模型的工具定义（OpenAI 形状）。 */
export interface DirectToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** token 计量（云端返回 `cached_tokens`，需从 prompt 里剥出来）。 */
export interface DirectUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly cachedTokens: number
}

/** 一次 chat/completions 的完整结果（非流式；流式由回调驱动）。 */
export interface DirectChatResult {
  /** 正文（可能为空，若模型只产出 tool_calls 或思考）。 */
  readonly text: string
  /** 思考内容（灵犀的 `reasoning_content`）。 */
  readonly reasoning: string
  /** 模型发起的工具调用。 */
  readonly toolCalls: readonly DirectToolCall[]
  /** 结束原因，已归一为 DSH 的三种常用值。 */
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown'
  readonly usage?: DirectUsage
}

/** 流式回调：与 DSH StreamChunk 解耦，由适配器翻译。 */
export interface DirectStreamListener {
  /** 正文增量。 */
  onText?(delta: string): void
  /** 思考增量。 */
  onReasoning?(delta: string): void
  /**
   * 工具调用增量。
   *
   * @param index  该调用在本轮的序号（0 起）
   * @param id     调用 id（仅首帧携带，后续帧为 undefined）
   * @param name   函数名（仅首帧携带）
   * @param argsDelta 参数 JSON 片段
   */
  onToolCallDelta?(index: number, id: string | undefined, name: string | undefined, argsDelta: string): void
}

/* --------------------------------- 会话/run -------------------------------- */

/** 一个可复用的 run 上下文（session + run）。 */
interface RunContext {
  readonly sessionId: string
  readonly runId: string
}

/** 灵犀统一响应包络（会话/run 创建接口用）。 */
interface Envelope<T> {
  result?: string
  v7code?: number
  msg?: string
  hint?: string
  code?: string
  message?: string
  data?: T
}

/**
 * 直连客户端。
 *
 * 一个实例对应一个 DSH 进程：内部按 sessionId 缓存 run 上下文，
 * 一个 DSH 会话只建一次 run（= 只扣 1 智点）。
 */
export class LingxiDirectClient {
  /** sessionId → run 上下文；一个 DSH 会话长期复用同一个 run。 */
  private readonly runs = new Map<string, RunContext>()
  /** sessionId → 正在创建中的 Promise（避免并发首请求重复建 run）。 */
  private readonly pendingRuns = new Map<string, Promise<RunContext>>()
  /** sessionId → 串行锁链尾（同一 run 内的对话请求必须排队，见 withRunLock）。 */
  private readonly runLocks = new Map<string, Promise<void>>()

  constructor(
    /** 取当前 SID；force=true 时强制重新从桌面登录态提取。 */
    private readonly resolveSid: (force?: boolean) => Promise<string>,
    /** 日志出口（缺省静默）。 */
    private readonly logger?: { warn?(message: string): void; info?(message: string): void },
  ) {}

  /* ------------------------------ HTTP 基座 ------------------------------ */

  /** 构造通用请求头（会话/run 创建只用这 4 个）。 */
  private baseHeaders(sid: string): Record<string, string> {
    return {
      Cookie: `wps_sid=${sid}`,
      'Content-Type': 'application/json',
      'X-Client-Type': 'lingxi_claw',
      'X-Lingxi-Appserver-Version': APPSERVER_VERSION,
    }
  }

  /**
   * 发一次 JSON 请求并解析灵犀包络。
   *
   * 与 `lingxi-cloud.ts` 的 `cloudFetch` 分开实现：这里的路径前缀有两套
   * （public / aioffice），且错误体形状不同（`code`/`message` vs `result`/`hint`）。
   */
  private async postJson<T>(
    sid: string,
    url: string,
    body: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.baseHeaders(sid),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new LingxiCloudError(`无法连接灵犀云端：${(error as Error).message}`, 0, 'NETWORK')
    }
    let envelope: Envelope<T> | null = null
    try {
      envelope = (await response.json()) as Envelope<T>
    } catch {
      envelope = null
    }
    const failed = !response.ok
      || (envelope?.result !== undefined && envelope.result !== 'ok')
      || (envelope?.code !== undefined && envelope.code !== 'Success')
    if (failed) {
      const code = envelope?.code ?? (typeof envelope?.result === 'string' ? envelope.result : undefined)
      const message = envelope?.hint || envelope?.message || envelope?.msg
        || `灵犀云端返回 ${response.status}`
      throw new LingxiCloudError(message, response.status, code, envelope?.v7code)
    }
    return envelope?.data as T
  }

  /* --------------------------- ①② 建会话与 run --------------------------- */

  /**
   * 建一个云端会话。
   *
   * `env.work_space_dir` 只是声明，不影响直连（我们不跑灵犀的工具），
   * 但保持字段完整以贴合官方请求形状。
   */
  private async createSession(sid: string, workspaceWin?: string): Promise<string> {
    const data = await this.postJson<{ session_id?: string }>(
      sid,
      `${CLOUD_BASE}${AIOFFICE_PREFIX}/cowork/sessions`,
      {
        session_type: 'cowork_client',
        agent_version: 2,
        env: {
          device_id: 'dsh-direct',
          device_name: 'DSH (direct)',
          work_space_dir: workspaceWin ?? 'C:\\Windows\\Temp',
        },
      },
    )
    const sessionId = data?.session_id
    if (!sessionId) throw new LingxiCloudError('灵犀云端未返回 session_id', 200, 'NO_SESSION')
    return sessionId
  }

  /**
   * 建一个 run（计费单位）。
   *
   * `agent_input.text` 会成为积分流水里的任务名（真机实测），故传入用户
   * 首条消息的摘要，让账单可读。
   */
  private async createRun(
    sid: string,
    sessionId: string,
    modelId: string,
    title: string,
  ): Promise<string> {
    const data = await this.postJson<{ run_id?: string }>(
      sid,
      `${CLOUD_BASE}${PUBLIC_PREFIX}/credits/runs`,
      {
        client_request_id: String(Date.now()),
        session_id: sessionId,
        model_provider: 'lingxi',
        model_id: modelId,
        agent_input: {
          text: title,
          files: [],
          file_ids: [],
          expect_model: modelId,
          refs: [],
          permission_mode: 'default',
          current_mode: 'agent',
          browser_plugin_enabled: false,
        },
      },
    )
    const runId = data?.run_id
    if (!runId) throw new LingxiCloudError('灵犀云端未返回 run_id', 200, 'NO_RUN')
    return runId
  }

  /**
   * 取（必要时创建）某个 DSH 会话的 run 上下文。
   *
   * 并发安全：同一 sessionId 的并发首请求共用同一个建 run Promise。
   */
  private async ensureRun(
    dshSessionId: string,
    modelId: string,
    title: string,
    workspaceWin?: string,
  ): Promise<RunContext> {
    const cached = this.runs.get(dshSessionId)
    if (cached) return cached
    const pending = this.pendingRuns.get(dshSessionId)
    if (pending) return pending

    const task = (async (): Promise<RunContext> => {
      const sid = await this.resolveSid()
      const sessionId = await this.createSession(sid, workspaceWin)
      const runId = await this.createRun(sid, sessionId, modelId, title)
      const context: RunContext = { sessionId, runId }
      this.runs.set(dshSessionId, context)
      this.logger?.info?.(`[lingxi] 已创建云端 run（session=${sessionId} run=${runId}）`)
      return context
    })()

    this.pendingRuns.set(dshSessionId, task)
    try {
      return await task
    } finally {
      this.pendingRuns.delete(dshSessionId)
    }
  }

  /** 丢弃某个会话的 run 缓存（run 失效时调用，下次请求重建）。 */
  private dropRun(dshSessionId: string): void {
    this.runs.delete(dshSessionId)
  }

  /* ------------------------- ③ chat/completions ------------------------- */

  /**
   * 发起一次对话（流式），把增量交给 listener。
   *
   * @param dshSessionId DSH 会话 id（用作 run 缓存键）
   * @param request     已转换好的 OpenAI 形状请求
   * @returns 归一化后的完整结果（正文/思考/工具调用/usage）
   */
  async chat(
    dshSessionId: string,
    request: {
      model: string
      messages: DirectChatMessage[]
      tools?: DirectToolSchema[]
      /** 系统提示词；灵犀用独立的 `context` 字段（覆盖其内置提示词）。 */
      system?: string
      maxTokens?: number
      temperature?: number
      reasoningEffort?: string
      /** 建 run 时用作账单标题的文本。 */
      title?: string
      workspaceWin?: string
      signal?: AbortSignal
    },
    listener: DirectStreamListener = {},
  ): Promise<DirectChatResult> {
    const title = request.title?.slice(0, 100) || 'DSH 会话'

    // ① + ②：取 run（首次会建会话与 run）。
    let context = await this.ensureRun(dshSessionId, request.model, title, request.workspaceWin)

    /*
     * 同一 run 内的对话请求必须**串行**。
     *
     * 云端按 run 维护一份服务端状态，同一 run 上并发两个 chat/completions
     * 会互相踩状态（真机复现：会话标题生成与正文请求同时发起时，正文请求
     * 稳定返回 HTTP 200 + `{"code":"AIError","message":"AI服务异常"}`，
     * 单发或串行则 100% 正常）。
     *
     * 这里不加锁会直接影响真实使用：DSH 在会话开头会并发发起「生成标题」
     * 与「正文」两个 purpose 的请求，两者共用一个 run，于是正文必挂。
     */
    return await this.withRunLock(dshSessionId, () =>
      this.runChat(context, dshSessionId, request, listener),
    )
  }

  /**
   * 在持有该会话的 run 锁时执行一次对话。
   *
   * 内含两类可恢复错误的重试：
   * - 登录态失效（401）：强制重新提取 SID，再重发（run 仍有效）；
   * - run 失效（SQLNoRows / 数据不存在）：丢缓存重建 run 后重发。
   */
  private async runChat(
    initialContext: RunContext,
    dshSessionId: string,
    request: {
      model: string
      messages: DirectChatMessage[]
      tools?: DirectToolSchema[]
      system?: string
      maxTokens?: number
      temperature?: number
      reasoningEffort?: string
      title?: string
      workspaceWin?: string
      signal?: AbortSignal
    },
    listener: DirectStreamListener,
  ): Promise<DirectChatResult> {
    let context = initialContext
    const title = request.title?.slice(0, 100) || 'DSH 会话'
    try {
      return await this.streamChat(context, request, listener)
    } catch (error) {
      if (isUnauthorizedFailure(error)) {
        this.logger?.warn?.('[lingxi] 登录态失效，重新提取 SID 后重试')
        await this.resolveSid(true)
        return await this.streamChat(context, request, listener)
      }
      if (!isStaleRunFailure(error)) throw error
      this.logger?.warn?.(`[lingxi] run 已失效，重建后重试：${(error as Error).message}`)
      this.dropRun(dshSessionId)
      context = await this.ensureRun(dshSessionId, request.model, title, request.workspaceWin)
      return await this.streamChat(context, request, listener)
    }
  }

  /**
   * 以「按 sessionId 串行」的方式执行一段异步逻辑。
   *
   * 实现是每个 sessionId 维护一条 Promise 链尾：新任务接在链尾，
   * 前一个任务结束（无论成功失败）后才开始下一个。相比引入信号量，
   * 这样能保证严格的**先来先服务**，且不需要额外的清理逻辑。
   */
  private async withRunLock<T>(dshSessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(dshSessionId) ?? Promise.resolve()
    // 链尾只关心「前一个任务已结束」，不关心其结果，故吞掉异常。
    const gate = previous.then(
      () => undefined,
      () => undefined,
    )
    const current = gate.then(task)
    // 记录本次的链尾（同样吞掉异常，避免未处理的 rejection 警告）。
    const tail: Promise<void> = current.then(
      () => undefined,
      () => undefined,
    )
    this.runLocks.set(dshSessionId, tail)
    try {
      return await current
    } finally {
      // 本任务结束后若链尾仍指向自己则清除，避免 Map 无限增长。
      if (this.runLocks.get(dshSessionId) === tail) this.runLocks.delete(dshSessionId)
    }
  }

  /** 真正发流式请求并解析 SSE。 */
  private async streamChat(
    context: RunContext,
    request: {
      model: string
      messages: DirectChatMessage[]
      tools?: DirectToolSchema[]
      system?: string
      maxTokens?: number
      temperature?: number
      reasoningEffort?: string
      signal?: AbortSignal
    },
    listener: DirectStreamListener,
  ): Promise<DirectChatResult> {
    const sid = await this.resolveSid()

    // 组装请求体：只发非空字段，避免把 undefined 序列化成 null。
    const body: Record<string, unknown> = {
      stream: true,
      model: request.model,
      messages: request.messages,
    }
    // 灵犀用独立的 `context` 承载系统提示词（真机抓包确认可整体覆盖）。
    if (request.system?.trim()) body.context = request.system.trim()
    if (request.tools && request.tools.length > 0) body.tools = request.tools
    const baseArgs: Record<string, unknown> = {}
    if (request.maxTokens !== undefined) baseArgs.max_tokens = request.maxTokens
    if (Object.keys(baseArgs).length > 0) body.base_llm_arguments = baseArgs
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.reasoningEffort) {
      // 顶层与 llm_arguments 都要带：真机抓包里灵犀两者同时下发。
      body.reasoning_effort = request.reasoningEffort
      body.llm_arguments = { reasoning_effort: request.reasoningEffort }
    }

    const headers: Record<string, string> = {
      ...this.baseHeaders(sid),
      'x-cc-session-id': context.sessionId,
      'x-cc-run-id': context.runId,
    }

    let response: Response
    try {
      response = await fetch(`${CLOUD_BASE}${PUBLIC_PREFIX}/agent-runtime/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (request.signal?.aborted) throw error
      throw new LingxiCloudError(`灵犀对话请求失败：${(error as Error).message}`, 0, 'NETWORK')
    }

    // 非 200：先把 body 读成文本，再判定是否登录态/run 失效。
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw toStreamFailure(response.status, text)
    }
    if (!response.body) {
      throw new LingxiCloudError('灵犀对话响应没有正文流', response.status, 'EMPTY_BODY')
    }

    return await consumeSse(response.body, listener)
  }

  /** 清理所有缓存的 run（进程退出/插件卸载时用）。 */
  clear(): void {
    this.runs.clear()
    this.pendingRuns.clear()
    this.runLocks.clear()
  }
}

/* ------------------------------ SSE 解析 ------------------------------ */

/** 流式聚合器：把 SSE 增量拼成完整结果。 */
interface Aggregator {
  text: string
  reasoning: string
  readonly calls: Map<number, { id: string; name: string; args: string }>
  finishReason: DirectChatResult['finishReason']
  usage?: DirectUsage
}

/**
 * 消费 SSE 流。
 *
 * 真机响应形状（每帧一行 `data: {...}`）：
 * ```json
 * {"code":"Success","message":"","usage":{...},"choices":[{
 *    "index":0,"finish_reason":"","text":"...","reasoning_content":"...",
 *    "tool_calls":[{"type":"function","id":"call_x","index":0,
 *                   "function":{"name":"...","arguments":"<JSON片段>"}}]}]}
 * ```
 *
 * 关键点：
 * - `tool_calls` 是**增量**：首帧带 `id`/`name`，后续帧 `id`/`name` 为空串、
 *   只带 `arguments` 片段，必须按 `index` 累积拼接；
 * - `usage` 只在**末帧**有效（前面帧全是 0），末帧同时带 `finish_reason`；
 * - 没有 `data: [DONE]` 结束标记时以流关闭为准。
 */
async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  listener: DirectStreamListener,
): Promise<DirectChatResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const state: Aggregator = {
    text: '',
    reasoning: '',
    calls: new Map(),
    finishReason: 'unknown',
  }
  let buffer = ''

  /** 处理一行 SSE。 */
  const handleLine = (line: string): void => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let frame: {
      code?: string
      message?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number }
      choices?: Array<{
        finish_reason?: string
        text?: string
        reasoning_content?: string
        tool_calls?: Array<{
          id?: string
          index?: number
          function?: { name?: string; arguments?: string }
        }>
      }>
    }
    try {
      frame = JSON.parse(payload)
    } catch {
      // 半包/脏帧：跳过而不是整轮失败。
      return
    }
    if (frame.code && frame.code !== 'Success') {
      throw new LingxiCloudError(frame.message || '灵犀对话返回错误', 200, frame.code)
    }
    // usage：只在非零时采纳（前序帧恒为 0）。
    if (frame.usage && ((frame.usage.completion_tokens ?? 0) > 0 || (frame.usage.prompt_tokens ?? 0) > 0)) {
      state.usage = {
        promptTokens: frame.usage.prompt_tokens ?? 0,
        completionTokens: frame.usage.completion_tokens ?? 0,
        totalTokens: frame.usage.total_tokens ?? 0,
        cachedTokens: frame.usage.cached_tokens ?? 0,
      }
    }
    const choice = frame.choices?.[0]
    if (!choice) return

    if (choice.reasoning_content) {
      state.reasoning += choice.reasoning_content
      listener.onReasoning?.(choice.reasoning_content)
    }
    if (choice.text) {
      state.text += choice.text
      listener.onText?.(choice.text)
    }
    for (const call of choice.tool_calls ?? []) {
      const index = call.index ?? 0
      const existing = state.calls.get(index)
      const id = call.id || ''
      const name = call.function?.name || ''
      const argsDelta = call.function?.arguments ?? ''
      if (!existing) {
        // 首帧：建立该调用的累积槽。
        state.calls.set(index, { id, name, args: argsDelta })
      } else {
        // 后续帧：只累加参数片段（id/name 为空串时保持原值）。
        if (id) existing.id = id
        if (name) existing.name = name
        existing.args += argsDelta
      }
      listener.onToolCallDelta?.(index, id || undefined, name || undefined, argsDelta)
    }
    if (choice.finish_reason) {
      state.finishReason = normalizeFinish(choice.finish_reason)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 以 \n 分隔；保留最后一段（可能不完整）。
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line.trimEnd())
    }
    if (buffer.trim()) handleLine(buffer.trim())
  } finally {
    reader.releaseLock()
  }

  // 兜底：若末帧没给 finish_reason，按有没有工具调用推断。
  const toolCalls = [...state.calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id || `call_${Math.random().toString(36).slice(2, 12)}`,
      type: 'function' as const,
      function: { name: call.name, arguments: call.args },
    }))
  const finishReason = state.finishReason === 'unknown' && toolCalls.length > 0
    ? 'tool_calls'
    : state.finishReason

  return {
    text: state.text,
    reasoning: state.reasoning,
    toolCalls,
    finishReason,
    usage: state.usage,
  }
}

/** 归一化 finish_reason。 */
function normalizeFinish(raw: string): DirectChatResult['finishReason'] {
  switch (raw) {
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
    case 'max_tokens':
      return 'length'
    default:
      return 'unknown'
  }
}

/** 把非 200 响应转成带语义的异常。 */
function toStreamFailure(status: number, text: string): LingxiCloudError {
  let code: string | undefined
  let message = `灵犀对话请求失败（HTTP ${status}）`
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string }
    code = parsed.code
    if (parsed.message) message = parsed.message
  } catch {
    if (text.trim()) message = `${message}：${text.slice(0, 200)}`
  }
  return new LingxiCloudError(message, status, code)
}

/**
 * 判断是否为「run 失效」类错误（需要重建 run）。
 *
 * 真机实测：run 过期/被清理时云端返回 `SQLNoRows 数据不存在`；session
 * 失效也走同一码。仅这类错误值得重建一次，其它（401/网络/参数）直接抛。
 */
function isUnauthorizedFailure(error: unknown): boolean {
  return error instanceof LingxiCloudError && error.isUnauthorized
}

function isStaleRunFailure(error: unknown): boolean {
  if (!(error instanceof LingxiCloudError)) return false
  if (error.code === 'SQLNoRows') return true
  return /数据不存在|SQLNoRows/.test(error.message)
}
