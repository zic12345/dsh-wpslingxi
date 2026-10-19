import { type WslEnvironment } from './lingxi-win32.js';
/**
 * 宿主环境探测结果。路径同时保留 Windows 形态（喂给 Windows 进程）。
 */
export interface LingxiHost {
    /** WSL 互操作句柄。 */
    readonly env: WslEnvironment;
    /** 灵犀 AppData 根（Windows 路径，含中文目录名），如 `C:\Users\x\AppData\Roaming\WPS 灵犀`。 */
    readonly appRootWin: string;
    /** 灵犀自带 portable node.exe（Windows 路径）。 */
    readonly nodeExeWin: string;
    /** Windows TEMP（Windows 路径，结尾无反斜杠）。 */
    readonly winTemp: string;
}
/**
 * 一次性 PowerShell 探测：AppData 根（`Get-ChildItem -Filter WPS*`，直写中文
 * 目录名在 interop 下不稳）+ portable node.exe + TEMP。
 *
 * 同时验证 `app_server_link\service\lingxi.exe` 存在（junction 指向安装目录）。
 */
export declare function detectLingxiHost(env: WslEnvironment): Promise<LingxiHost>;
/** 一次 run 的组件事件收集器。 */
export interface LingxiRunResult {
    /** c_text 组件（正文），按组件出现顺序拼接的全文。 */
    readonly text: string;
    /** c_reasoning 组件（思考过程）全文。 */
    readonly reasoning: string;
    /** 服务端计费（run.end.credit_consumed），通常为 0。 */
    readonly creditConsumed: number;
}
export interface LingxiRunOptions {
    /** 已渲染好的单条 prompt 文本（多轮历史由适配器拼接）。 */
    readonly prompt: string;
    /** model/list 里的 model_name（max / pro / kimi-k3 …）。 */
    readonly model: string;
    /** 取消信号：abort 时发 run/interrupt 并中止本地等待。 */
    readonly signal?: AbortSignal;
    /** 可选的逐块事件监听（用于产出 StreamChunk 流式增量）。 */
    readonly listener?: LingxiRunListener;
    /**
     * 灵犀 agent 的工作目录（**Windows 路径形态**，由适配器经 wslpath 转换）。
     *
     * 这是灵犀在宿主侧读写文件、执行命令的根目录；应指向 DSH 会话的工作区，
     * 而不是桥自己的 TEMP。缺省时回退到 DATA\\workspace（临时目录，仅保不报错）。
     */
    readonly workspaceWin?: string;
}
/**
 * run 生命周期回调。component.type 只关心正文/思考两类：
 * - `c_reasoning` → reasoning 块；
 * - `c_text`（含缺省）→ text 块；
 * - `c_recommend` 等其它类型不回调（推荐问不是模型回答）。
 */
export interface LingxiRunListener {
    onBlockStart?(componentId: string, kind: 'reasoning' | 'text'): void;
    onDelta?(componentId: string, kind: 'reasoning' | 'text', delta: string): void;
    onBlockEnd?(componentId: string, kind: 'reasoning' | 'text', full: string): void;
}
/**
 * 一个长驻的 lingxi.exe stdio 连接，多 session / 多 run 复用。
 *
 * JSON-RPC id 多路复用；notification 按 run_id 路由到各 run 的等待器。
 * 连接死亡（exit / 致命协议错误）时拒绝所有待决请求，适配器可重建实例。
 */
export declare class LingxiBridge {
    private readonly host;
    private readonly sid;
    private readonly logger?;
    private child;
    private nextId;
    private readonly pending;
    private readonly runWaiters;
    /** run_id → 组件缓冲（多组件按 start 顺序）。 */
    private readonly runs;
    private startError;
    private readonly stderrTail;
    private closed;
    /** boot.cjs 建目录骨架的 data-dir（Windows 路径），与 session/start 必须一致。 */
    private dataWin;
    private constructor();
    /**
     * 启动桥：
     * 1. 在 Windows TEMP 下建本桥专属目录，投放 boot.cjs 与独立 data-dir；
     * 2. interop spawn portable node.exe；
     * 3. initialize / initialized 握手。
     */
    static start(host: LingxiHost, sid: string, logger?: {
        warn: (message: string) => void;
    }): Promise<LingxiBridge>;
    private bootCjsSource;
    private boot;
    /** 处理一行 NDJSON：响应 / 服务端请求 / 通知。 */
    private dispatchLine;
    private dispatchNotification;
    private rpc;
    private notify;
    /** 拉取远端 model/list 的原始模型数组（失败由调用方回退内置目录）。 */
    listRemoteModels(): Promise<unknown[]>;
    /**
     * 执行一次完整对话：新 session + run，收集到 run.end。
     *
     * 多 run 在同一连接上并发是安全的（session_id / run_id 隔离，PoC 已验证
     * 单连接可连续创建多个 session）。
     */
    runOnce(options: LingxiRunOptions): Promise<LingxiRunResult>;
    private failAll;
    /** 关闭桥（杀 Windows node.exe；boot.cjs 会连锁杀 lingxi.exe）。 */
    close(): void;
}
