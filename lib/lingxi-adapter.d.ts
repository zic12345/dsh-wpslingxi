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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { type WslEnvironment } from './lingxi-win32.js';
import { type DirectToolCall } from './lingxi-direct.js';
/** 适配器构造参数。 */
export interface LingxiAdapterOptions {
    /** 强制注入 WSL 环境（测试用）；缺省时运行时探测。 */
    env?: WslEnvironment;
    /**
     * 按 DSH 会话 id 解析该会话的项目工作目录（**WSL 路径**）。
     *
     * 由 index.ts 用宿主 `ctx.sessionQuery.observeSession(sessionId).header.cwd`
     * 实现并注入：LLM 的 GenerateOptions 不携带工作区，只携带 sessionId。
     * v2.0 里该路径只用于在云端会话上**声明**工作区（不影响工具执行，
     * 工具跑在 DSH 侧的真实 cwd 里）。
     */
    resolveSessionCwd?: (sessionId: string) => Promise<string | undefined>;
}
export declare class LingxiAdapter extends LlmAdapter {
    private readonly options;
    private env;
    /** 直连客户端（进程级单例，内部按 sessionId 缓存 run）。 */
    private client;
    /** 远端刷新过的模型目录（未刷新前用内置兜底目录）。 */
    private remoteModels;
    /**
     * 每个 DSH 会话解析出的工作区（Windows 路径），按 sessionId 缓存。
     * 会话 cwd 固定，只反查一次；wslpath 转换同样缓存（按 WSL 路径）。
     */
    private readonly sessionWorkspace;
    private readonly wslToWinCache;
    constructor(options?: LingxiAdapterOptions);
    providerInfo(_provider: string): LlmProviderInfo;
    /**
     * 对外可展示的模型：直接返回内置目录。
     *
     * 云端 `model/list` 已不再需要（直连时模型名就是请求字段，网关按名路由），
     * 故列表纯本地、零延迟。
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    private toModelInfo;
    private reasoningInfo;
    /** 懒探测 WSL 环境（非 WSL 直接抛错，注册阶段已拦截，这里双保险）。 */
    private ensureEnv;
    /**
     * 取直连客户端（单例）。SID 在首次真正请求时才提取，避免注册阶段
     * 拖慢启动；401 由客户端内部强制重取。
     */
    private getClient;
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
    private resolveWorkspaceWin;
    /** WSL→Windows 路径转换，按 WSL 路径缓存结果。 */
    private toWindowsCached;
    /**
     * 主流程：把 DSH 的请求翻译成云端 OpenAI 形状，流式转发回 DSH。
     *
     * 块编号策略（与 DSH 协议一致）：
     * - 思考块（`reasoning_content`）先出现 → 索引 0；
     * - 正文块 → 紧随其后；
     * - 工具调用块按 `index` 顺序依次编号；
     * - 每个块在 `block-end` 时携带**累积完整内容**。
     */
    stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk>;
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
export declare function registerLingxiLlm(ctx: Context): Promise<LingxiAdapter | undefined>;
/** 供测试/诊断：导出内部类型。 */
export type { DirectToolCall };
