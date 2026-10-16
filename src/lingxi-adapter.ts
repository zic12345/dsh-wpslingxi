/**
 * WPS 灵犀（桌面版）DSH 适配器。
 *
 * 与本插件其它 provider 不同，灵犀**没有云端 OpenAI 兼容端点、没有 API Key、
 * 也没有可在设置页填写的 baseURL**——模型能力只经桌面 App 自带的
 * `lingxi.exe`（app-server）以 stdio JSON-RPC 暴露。在 WSL 里还要跨过
 * 两层 interop（WSL Node → 灵犀 portable node.exe → boot.cjs → lingxi.exe），
 * 详见 {@link LingxiBridge} 与 src/lingxi-assets/boot.cjs 的头部注释。
 *
 * 因此本适配器：
 * - **不进** provider-registry / provider-runtime / Jet Hub 账号池（无登录 UI、
 *   无 HTTP 限流、无余额面板），只在成功探测到 WSL + 桌面登录态时注册 `ctx.llm` 路由；
 * - 凭据（wps_sid）由 {@link extractWpsSid} 自动从桌面 App 的登录 cookie 提取，
 *   也允许 `DSH_LINGXI_WPS_SID` 覆盖；
 * - 每次 `stream()` 是一次**无状态**对话：把 messages 渲染成单条 prompt，
 *   新建 session + run，实时消费 component 事件产出 StreamChunk。
 * - 灵犀无原生 function-calling，工具调用/结果降级为转录文本（见 lingxi-messages.ts）。
 */
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { detectWsl, resolveLingxiWorkspaceOverride, wslPathToWindows, type WslEnvironment } from './lingxi-win32.js'
import { extractWpsSid } from './lingxi-credential.js'
import { detectLingxiHost, LingxiBridge, type LingxiHost } from './lingxi-bridge.js'
import { serializeLingxiPrompt } from './lingxi-messages.js'
import {
  LINGXI_DEFAULT_MODEL,
  LINGXI_FALLBACK_MODELS,
  findFallbackModel,
  normalizeRemoteModel,
  type LingxiModelEntry,
} from './lingxi.js'
import { LINGXI } from './lingxi-product.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 适配器构造参数。 */
export interface LingxiAdapterOptions {
  /** 强制注入 WSL 环境（测试用）；缺省时运行时探测。 */
  env?: WslEnvironment
  /** 强制注入桥工厂（测试用）。 */
  bridgeFactory?: (host: LingxiHost, sid: string) => Promise<LingxiBridge>
  /**
   * 按 DSH 会话 id 解析该会话的项目工作目录（**WSL 路径**）。
   *
   * 由 index.ts 用宿主 `ctx.sessionQuery.observeSession(sessionId).header.cwd`
   * 实现并注入：LLM 的 GenerateOptions 不携带工作区，只携带 sessionId，
   * 每个会话的 cwd 必须这样反查，才能做到「跟随当前会话工作区」。
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

/** 队列事件：把桥的同步回调搬进 async generator。 */
type QueueEvent =
  | { kind: 'start'; componentId: string; blockKind: 'reasoning' | 'text'; index: number }
  | { kind: 'delta'; index: number; blockKind: 'reasoning' | 'text'; text: string }
  | { kind: 'error'; error: Error }

/** 判定桥错误是否属于登录态失效（需要重新提取 SID 后整体重建桥）。 */
function isAuthFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (typeof code === 'number') {
    // 灵犀网关 401 段错误码（v7code 401xxxxx 等）；保守只认明确未登录/未授权。
    return code === 401 || code === 40101 || code === 401020001
  }
  const text = (error as Error | undefined)?.message ?? ''
  return /未登录|登录态|unauthorized|unauthenticated|401|UserUnauthorized/i.test(text)
}

export class LingxiAdapter extends LlmAdapter {
  private env: WslEnvironment | undefined
  private host: LingxiHost | undefined
  private bridge: LingxiBridge | undefined
  /** 单飞的建桥 Promise，避免并发请求重复拉起进程。 */
  private bridgePromise: Promise<LingxiBridge> | undefined
  /** 远端刷新过的模型目录（未刷新前用内置兜底目录）。 */
  private remoteModels: LingxiModelEntry[] | undefined
  /**
   * 每个 DSH 会话解析出的灵犀工作目录（Windows 路径），按 sessionId 缓存。
   * 会话 cwd 固定，只反查一次；wslpath 转换同样缓存（按 WSL 路径）。
   */
  private readonly sessionWorkspace = new Map<string, string | undefined>()
  private readonly wslToWinCache = new Map<string, string | undefined>()

  constructor(private readonly options: LingxiAdapterOptions = {}) {
    super()
  }

  /** 注册阶段已探测过宿主时注入，省去首次请求的重复 interop 探测。 */
  primeHost(host: LingxiHost): void {
    this.host = host
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: LINGXI.id, name: LINGXI.displayName }
  }

  /**
   * 对外可展示的模型：默认直接返回内置目录（GUI 不能被一次昂贵的 interop
   * 建桥拖住）。后台不主动刷新——首次真实对话建桥后目录已可用，下次列表即更新。
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
    // 纯本地元数据，不触发 interop；未知 model id 也放行（核心路由接受未列名模型）。
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
      // 文本桥暂不投递图片；即便桌面模型多模态，DSH 这一路只声明文本。
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
      // 不强制默认档：灵犀按 expect_model 选模型，思考档由其内部策略处理，
      // DSH 侧选了档位目前不透传（run/start 无对应字段），仅做能力播报。
    }
  }

  /** 懒探测 WSL 环境（非 WSL 直接抛错，注册阶段已拦截，这里双保险）。 */
  private async ensureEnv(): Promise<WslEnvironment> {
    if (this.env) return this.env
    const env = this.options.env ?? detectWsl()
    if (!env) throw new Error('WPS 灵犀桌面 provider 仅在 WSL 环境可用（未检测到 WSL）')
    this.env = env
    return env
  }

  /**
   * 解析本次 LLM 请求应交给灵犀 agent 的工作目录（Windows 路径），**跟随会话**。
   *
   * 优先级：
   * 1. 环境变量 DSH_LINGXI_WORKSPACE（显式覆盖，全局固定）；
   * 2. 当前 DSH 会话的项目目录——用 GenerateOptions.sessionId 经注入的
   *    resolveSessionCwd 反查 `sessionQuery.observeSession(...).header.cwd`；
   * 3. 都拿不到时返回 undefined，由桥回退到它自己的临时工作区。
   *
   * 每个 sessionId 只反查/转换一次（会话 cwd 固定）。
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
      // 反查失败（会话已结束 / sessionQuery 不可用）不致命：回退临时工作区。
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
   * 取得（必要时拉起）长驻桥。登录态失效时清缓存重建一次；
   * 其它致命错误（进程退出等）也重建。
   */
  private async getBridge(): Promise<LingxiBridge> {
    if (this.bridge) return this.bridge
    if (this.bridgePromise) return this.bridgePromise
    this.bridgePromise = this.startBridge().finally(() => {
      this.bridgePromise = undefined
    })
    try {
      this.bridge = await this.bridgePromise
      return this.bridge
    } catch (error) {
      throw error
    }
  }

  private async startBridge(): Promise<LingxiBridge> {
    const env = await this.ensureEnv()
    if (!this.host) this.host = await detectLingxiHost(env)
    const sid = await extractWpsSid(env)
    if (this.options.bridgeFactory) return this.options.bridgeFactory(this.host, sid)
    return LingxiBridge.start(this.host, sid)
  }

  /** 关闭并丢弃当前桥（致命错误后调用）。 */
  private discardBridge(): void {
    const bridge = this.bridge
    this.bridge = undefined
    bridge?.close()
  }

  /**
   * 带一次「登录态失效自动重建」的桥调用。
   * 仅对鉴权类错误重建；重建用强制刷新的 SID。
   */
  private async withBridge<T>(run: (bridge: LingxiBridge) => Promise<T>): Promise<T> {
    let bridge = await this.getBridge()
    try {
      return await run(bridge)
    } catch (error) {
      if (isAuthFailure(error)) {
        this.discardBridge()
        const env = await this.ensureEnv()
        await extractWpsSid(env, true)
        bridge = await this.getBridge()
        return await run(bridge)
      }
      // 进程死亡类错误：丢桥，让下一次请求重新拉起（本次失败照传）。
      const message = (error as Error | undefined)?.message ?? ''
      if (/意外退出|启动失败|连接不可用|桥进程/.test(message)) this.discardBridge()
      throw error
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    const model = options.model || LINGXI_DEFAULT_MODEL
    const prompt = serializeLingxiPrompt(options.messages, options.system)

    // 桥回调 → 异步队列；generator 单线程消费，保证 chunk 顺序。
    const queue: QueueEvent[] = []
    let wake: (() => void) | undefined
    let finished = false
    const notify = (): void => {
      const fn = wake
      wake = undefined
      fn?.()
    }
    const push = (event: QueueEvent): void => {
      queue.push(event)
      notify()
    }
    const waitForEvent = (): Promise<void> =>
      new Promise((resolve) => {
        wake = resolve
      })

    // componentId → 块索引/类型/累积文本（块按首次 start 顺序编号）。
    const components = new Map<string, { index: number, kind: 'reasoning' | 'text', text: string }>()
    let nextIndex = 0

    let result: { textLength: number } | undefined
    let runError: Error | undefined

    // 跟随当前 DSH 会话的工作区（按 sessionId 反查 cwd），不依赖进程 cwd。
    const workspaceWin = await this.resolveWorkspaceWin(options.sessionId)

    const task = this.withBridge(async (bridge) => {
      return bridge.runOnce({
        prompt,
        model,
        signal: options.signal,
        // 让灵犀 agent 在当前 DSH 会话的工作区里读写，而不是桥的 Windows TEMP。
        workspaceWin,
        listener: {
          onBlockStart: (componentId, kind) => {
            const index = nextIndex++
            components.set(componentId, { index, kind, text: '' })
            push({ kind: 'start', componentId, blockKind: kind, index })
          },
          onDelta: (componentId, kind, delta) => {
            const component = components.get(componentId)
            if (!component) return
            component.text += delta
            push({ kind: 'delta', index: component.index, blockKind: kind, text: delta })
          },
        },
      })
    }).then((res) => {
      result = { textLength: res.text.length }
    }).catch((error: unknown) => {
      runError = error instanceof Error ? error : new Error(String(error))
    }).finally(() => {
      finished = true
      notify()
    })

    options.signal?.addEventListener('abort', () => {
      finished = true
      notify()
    }, { once: true })

    // 排空队列直到 run 结束。
    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await waitForEvent()
        continue
      }
      const event = queue.shift()!
      if (event.kind === 'start') {
        yield {
          type: 'block-start',
          index: event.index,
          blockType: event.blockKind === 'reasoning' ? 'reasoning' : 'text',
        }
      } else if (event.kind === 'delta') {
        if (event.blockKind === 'reasoning') {
          yield { type: 'reasoning-delta', index: event.index, text: event.text }
        } else {
          yield { type: 'text-delta', index: event.index, text: event.text }
        }
      } else if (event.kind === 'error') {
        throw event.error
      }
    }

    await task

    // abort：产出 aborted finish（不抛，遵循 StreamChunk 收尾约定）。
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
    if (runError) throw runError

    // 按块索引顺序补 block-end（携带累积完整块）。
    const ordered = [...components.values()].sort((a, b) => a.index - b.index)
    for (const component of ordered) {
      yield {
        type: 'block-end',
        index: component.index,
        block: component.kind === 'reasoning'
          ? { type: 'reasoning', text: component.text }
          : { type: 'text', text: component.text },
      }
    }

    if (!result || result.textLength === 0) {
      // 空响应：规范错误码，运行时按 EMPTY_RESPONSE 处理（可安全重试），
      // 与 openai-compat.ts 的空响应口径一致。
      throw new LlmError('灵犀模型未返回任何正文内容', 'EMPTY_RESPONSE')
    }

    // 灵犀不下发 token 计数，故不产出 usage 块（避免用假数字污染计量）。
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * 注册灵犀 provider 路由。
 *
 * 仅当①运行在 WSL、②能探测到桌面 App、③能取到登录 SID 时才注册；
 * 任一不满足都静默跳过（非 WSL / 未装桌面版 / 未登录的用户不应看到一个一用就报错的模型）。
 * 探测是异步且宽松的：失败只记日志、不影响插件其它 provider。
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
    // 提前探测宿主 + 登录态，避免注册出一个无法工作的路由。
    const host = await detectLingxiHost(env)
    await extractWpsSid(env)

    // 按会话 id 反查该会话的项目工作目录（WSL 路径）。
    // sessionQuery 由插件 inject 声明；observeSession 返回的租约带 [Symbol.dispose]，
    // 只读 header.cwd 后立即释放。失败/拿不到都返回 undefined（回退临时工作区）。
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
    // 缓存探测结果，省去首次请求的重复探测。
    adapter.primeHost(host)
  } catch (error) {
    ctx.logger?.warn?.(
      `[lingxi] 未启用 WPS 灵犀桌面 provider：${(error as Error).message}`,
    )
    return undefined
  }
  registerAdapterIdempotent(ctx.llm, [LINGXI.id], adapter)
  ctx.logger?.info?.(`[lingxi] 已注册 provider "${LINGXI.id}"（WPS 灵犀桌面版）`)
  return adapter
}
