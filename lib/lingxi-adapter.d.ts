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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { type WslEnvironment } from './lingxi-win32.js';
import { LingxiBridge, type LingxiHost } from './lingxi-bridge.js';
/** 适配器构造参数。 */
export interface LingxiAdapterOptions {
    /** 强制注入 WSL 环境（测试用）；缺省时运行时探测。 */
    env?: WslEnvironment;
    /** 强制注入桥工厂（测试用）。 */
    bridgeFactory?: (host: LingxiHost, sid: string) => Promise<LingxiBridge>;
    /**
     * 按 DSH 会话 id 解析该会话的项目工作目录（**WSL 路径**）。
     *
     * 由 index.ts 用宿主 `ctx.sessionQuery.observeSession(sessionId).header.cwd`
     * 实现并注入：LLM 的 GenerateOptions 不携带工作区，只携带 sessionId，
     * 每个会话的 cwd 必须这样反查，才能做到「跟随当前会话工作区」。
     */
    resolveSessionCwd?: (sessionId: string) => Promise<string | undefined>;
}
export declare class LingxiAdapter extends LlmAdapter {
    private readonly options;
    private env;
    private host;
    private bridge;
    /** 单飞的建桥 Promise，避免并发请求重复拉起进程。 */
    private bridgePromise;
    /** 远端刷新过的模型目录（未刷新前用内置兜底目录）。 */
    private remoteModels;
    /**
     * 每个 DSH 会话解析出的灵犀工作目录（Windows 路径），按 sessionId 缓存。
     * 会话 cwd 固定，只反查一次；wslpath 转换同样缓存（按 WSL 路径）。
     */
    private readonly sessionWorkspace;
    private readonly wslToWinCache;
    constructor(options?: LingxiAdapterOptions);
    /** 注册阶段已探测过宿主时注入，省去首次请求的重复 interop 探测。 */
    primeHost(host: LingxiHost): void;
    providerInfo(_provider: string): LlmProviderInfo;
    /**
     * 对外可展示的模型：默认直接返回内置目录（GUI 不能被一次昂贵的 interop
     * 建桥拖住）。后台不主动刷新——首次真实对话建桥后目录已可用，下次列表即更新。
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    private toModelInfo;
    private reasoningInfo;
    /** 懒探测 WSL 环境（非 WSL 直接抛错，注册阶段已拦截，这里双保险）。 */
    private ensureEnv;
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
    private resolveWorkspaceWin;
    /** WSL→Windows 路径转换，按 WSL 路径缓存结果。 */
    private toWindowsCached;
    /**
     * 取得（必要时拉起）长驻桥。登录态失效时清缓存重建一次；
     * 其它致命错误（进程退出等）也重建。
     */
    private getBridge;
    private startBridge;
    /** 关闭并丢弃当前桥（致命错误后调用）。 */
    private discardBridge;
    /**
     * 带一次「登录态失效自动重建」的桥调用。
     * 仅对鉴权类错误重建；重建用强制刷新的 SID。
     */
    private withBridge;
    stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk>;
}
/**
 * 注册灵犀 provider 路由。
 *
 * 仅当①运行在 WSL、②能探测到桌面 App、③能取到登录 SID 时才注册；
 * 任一不满足都静默跳过（非 WSL / 未装桌面版 / 未登录的用户不应看到一个一用就报错的模型）。
 * 探测是异步且宽松的：失败只记日志、不影响插件其它 provider。
 */
export declare function registerLingxiLlm(ctx: Context): Promise<LingxiAdapter | undefined>;
