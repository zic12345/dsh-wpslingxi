/**
 * 一条 OpenAI 风格的对话消息。
 *
 * 与 DSH 的 `Message` 不同，这里刻意用**最宽松的线上形状**：适配器负责
 * 在两者之间转换（见 lingxi-messages.ts）。
 */
export interface DirectChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** 正文；assistant 携带 tool_calls 时可为空串。 */
    content: string;
    /** assistant 专用：本轮发起的工具调用。 */
    tool_calls?: DirectToolCall[];
    /** tool 专用：回应哪一个工具调用。 */
    tool_call_id?: string;
}
/** 一个工具调用（OpenAI 形状）。 */
export interface DirectToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        /** JSON 字符串（不是对象）。 */
        arguments: string;
    };
}
/** 一个可下发给模型的工具定义（OpenAI 形状）。 */
export interface DirectToolSchema {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
/** token 计量（云端返回 `cached_tokens`，需从 prompt 里剥出来）。 */
export interface DirectUsage {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly cachedTokens: number;
}
/** 一次 chat/completions 的完整结果（非流式；流式由回调驱动）。 */
export interface DirectChatResult {
    /** 正文（可能为空，若模型只产出 tool_calls 或思考）。 */
    readonly text: string;
    /** 思考内容（灵犀的 `reasoning_content`）。 */
    readonly reasoning: string;
    /** 模型发起的工具调用。 */
    readonly toolCalls: readonly DirectToolCall[];
    /** 结束原因，已归一为 DSH 的三种常用值。 */
    readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown';
    readonly usage?: DirectUsage;
}
/** 流式回调：与 DSH StreamChunk 解耦，由适配器翻译。 */
export interface DirectStreamListener {
    /** 正文增量。 */
    onText?(delta: string): void;
    /** 思考增量。 */
    onReasoning?(delta: string): void;
    /**
     * 工具调用增量。
     *
     * @param index  该调用在本轮的序号（0 起）
     * @param id     调用 id（仅首帧携带，后续帧为 undefined）
     * @param name   函数名（仅首帧携带）
     * @param argsDelta 参数 JSON 片段
     */
    onToolCallDelta?(index: number, id: string | undefined, name: string | undefined, argsDelta: string): void;
}
/**
 * 直连客户端。
 *
 * 一个实例对应一个 DSH 进程：内部按 sessionId 缓存 run 上下文，
 * 一个 DSH 会话只建一次 run（= 只扣 1 智点）。
 */
export declare class LingxiDirectClient {
    /** 取当前 SID；force=true 时强制重新从桌面登录态提取。 */
    private readonly resolveSid;
    /** 日志出口（缺省静默）。 */
    private readonly logger?;
    /** sessionId → run 上下文；一个 DSH 会话长期复用同一个 run。 */
    private readonly runs;
    /** sessionId → 正在创建中的 Promise（避免并发首请求重复建 run）。 */
    private readonly pendingRuns;
    /** sessionId → 串行锁链尾（同一 run 内的对话请求必须排队，见 withRunLock）。 */
    private readonly runLocks;
    constructor(
    /** 取当前 SID；force=true 时强制重新从桌面登录态提取。 */
    resolveSid: (force?: boolean) => Promise<string>, 
    /** 日志出口（缺省静默）。 */
    logger?: {
        warn?(message: string): void;
        info?(message: string): void;
    } | undefined);
    /** 构造通用请求头（会话/run 创建只用这 4 个）。 */
    private baseHeaders;
    /**
     * 发一次 JSON 请求并解析灵犀包络。
     *
     * 与 `lingxi-cloud.ts` 的 `cloudFetch` 分开实现：这里的路径前缀有两套
     * （public / aioffice），且错误体形状不同（`code`/`message` vs `result`/`hint`）。
     */
    private postJson;
    /**
     * 建一个云端会话。
     *
     * `env.work_space_dir` 只是声明，不影响直连（我们不跑灵犀的工具），
     * 但保持字段完整以贴合官方请求形状。
     */
    private createSession;
    /**
     * 建一个 run（计费单位）。
     *
     * `agent_input.text` 会成为积分流水里的任务名（真机实测），故传入用户
     * 首条消息的摘要，让账单可读。
     */
    private createRun;
    /**
     * 取（必要时创建）某个 DSH 会话的 run 上下文。
     *
     * 并发安全：同一 sessionId 的并发首请求共用同一个建 run Promise。
     */
    private ensureRun;
    /** 丢弃某个会话的 run 缓存（run 失效时调用，下次请求重建）。 */
    private dropRun;
    /**
     * 发起一次对话（流式），把增量交给 listener。
     *
     * @param dshSessionId DSH 会话 id（用作 run 缓存键）
     * @param request     已转换好的 OpenAI 形状请求
     * @returns 归一化后的完整结果（正文/思考/工具调用/usage）
     */
    chat(dshSessionId: string, request: {
        model: string;
        messages: DirectChatMessage[];
        tools?: DirectToolSchema[];
        /** 系统提示词；灵犀用独立的 `context` 字段（覆盖其内置提示词）。 */
        system?: string;
        maxTokens?: number;
        temperature?: number;
        reasoningEffort?: string;
        /** 建 run 时用作账单标题的文本。 */
        title?: string;
        workspaceWin?: string;
        signal?: AbortSignal;
    }, listener?: DirectStreamListener): Promise<DirectChatResult>;
    /**
     * 在持有该会话的 run 锁时执行一次对话。
     *
     * 内含两类可恢复错误的重试：
     * - 登录态失效（401）：强制重新提取 SID，再重发（run 仍有效）；
     * - run 失效（SQLNoRows / 数据不存在）：丢缓存重建 run 后重发。
     */
    private runChat;
    /**
     * 以「按 sessionId 串行」的方式执行一段异步逻辑。
     *
     * 实现是每个 sessionId 维护一条 Promise 链尾：新任务接在链尾，
     * 前一个任务结束（无论成功失败）后才开始下一个。相比引入信号量，
     * 这样能保证严格的**先来先服务**，且不需要额外的清理逻辑。
     */
    private withRunLock;
    /** 真正发流式请求并解析 SSE。 */
    private streamChat;
    /** 清理所有缓存的 run（进程退出/插件卸载时用）。 */
    clear(): void;
}
