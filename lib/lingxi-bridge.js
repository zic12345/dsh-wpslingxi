/**
 * WSL 侧的灵犀 app-server 两层桥客户端。
 *
 * 调用链（2026-10-12 真机验证，缺一不可）：
 *
 * ```
 * WSL Node（本类）
 *   └─ interop spawn 灵犀自带 portable node.exe（Windows 进程）
 *        └─ 执行随插件分发、启动时投放到 Windows TEMP 的 boot.cjs
 *             └─ boot.cjs spawn lingxi.exe -stdin，透传 JSON-RPC
 * ```
 *
 * ⚠️ **不能让 WSL Node 直接 spawn `/mnt/c/.../lingxi.exe`**：实测 initialize
 * 能成功但 model/list 恒报「网络异常」（interop 直接托管 Windows exe 的网络栈
 * 问题）；中间隔一层 Windows node.exe 后全部正常。
 *
 * ⚠️ **自定义参数必须走 argv，不能走环境变量**：该 interop 链里 boot.cjs 从
 * process.env 读自定义变量得到 undefined（argv 稳定）。SID 例外——它由
 * boot.cjs 在 Windows 侧注入给 lingxi.exe 的 env。
 *
 * 协议要点（实测，见 /tmp/lxdrv/poc.js）：
 * - initialize（protocol_version `2026-08-13`）→ notification initialized；
 * - 每次对话 = session/start（session_type 必须 `cowork_client`，`agent` 会
 *   InvalidArgument）→ session/subscribe → run/start；
 * - 结果由 notification 流回：component.start/content（c_reasoning / c_text）、
 *   agent.error、run.end（含 credit_consumed）；按 run_id 路由；
 * - SID 经 LINGXI_WPS_SID 环境变量注入，lingxi.exe 日志 `auth loaded from env`。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { psValue, runPowerShell } from './lingxi-win32.js';
/** initialize 握手协议版本（来自 app.asar，桌面 4.27.0）。 */
const PROTOCOL_VERSION = '2026-08-13';
/**
 * 一次性 PowerShell 探测：AppData 根（`Get-ChildItem -Filter WPS*`，直写中文
 * 目录名在 interop 下不稳）+ portable node.exe + TEMP。
 *
 * 同时验证 `app_server_link\service\lingxi.exe` 存在（junction 指向安装目录）。
 */
export async function detectLingxiHost(env) {
    const script = String.raw `
$ErrorActionPreference = 'Stop'
$dir = Get-ChildItem $env:APPDATA -Directory | Where-Object { $_.Name -like 'WPS*' } | Select-Object -First 1
if (-not $dir) { throw 'LINGXI_NOT_INSTALLED' }
$root = $dir.FullName
$exe = Join-Path $root 'app_server_link\service\lingxi.exe'
if (-not (Test-Path $exe)) { throw 'LINGXI_EXE_MISSING' }
$node = Get-ChildItem (Join-Path $root 'portable-node') -Directory -Filter 'node-*' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $node) { throw 'LINGXI_NODE_MISSING' }
$nodeExe = Join-Path $node.FullName 'node.exe'
if (-not (Test-Path $nodeExe)) { throw 'LINGXI_NODE_MISSING' }
Write-Output ('APPROOT=' + $root)
Write-Output ('NODE=' + $nodeExe)
Write-Output ('TEMP=' + $env:TEMP)
`;
    const { stdout } = await runPowerShell(env, script, 20_000);
    const appRootWin = psValue(stdout, 'APPROOT');
    const nodeExeWin = psValue(stdout, 'NODE');
    const winTemp = psValue(stdout, 'TEMP');
    if (!appRootWin || !nodeExeWin || !winTemp) {
        throw new Error(`灵犀宿主探测输出不完整：${stdout.slice(0, 200)}`);
    }
    return { env, appRootWin, nodeExeWin, winTemp };
}
/** Windows 路径 → WSL drvfs 路径（`C:\x` → `/mnt/c/x`），仅支持系统盘外挂场景外的常见形态。 */
function winToWslPath(windowsPath) {
    const normalized = windowsPath.replace(/\\/g, '/');
    const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (!drive)
        throw new Error(`无法转换 Windows 路径: ${windowsPath}`);
    return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
}
/** 把灵犀组件类型归一为桥关心的两类（其余返回 null，不产出正文）。 */
function componentKind(type) {
    if (type === 'c_reasoning')
        return 'reasoning';
    if (!type || type === 'c_text')
        return 'text';
    return null;
}
/**
 * 一个长驻的 lingxi.exe stdio 连接，多 session / 多 run 复用。
 *
 * JSON-RPC id 多路复用；notification 按 run_id 路由到各 run 的等待器。
 * 连接死亡（exit / 致命协议错误）时拒绝所有待决请求，适配器可重建实例。
 */
export class LingxiBridge {
    host;
    sid;
    logger;
    child;
    nextId = 0;
    pending = new Map();
    runWaiters = new Map();
    /** run_id → 组件缓冲（多组件按 start 顺序）。 */
    runs = new Map();
    startError;
    stderrTail = [];
    closed = false;
    /** boot.cjs 建目录骨架的 data-dir（Windows 路径），与 session/start 必须一致。 */
    dataWin = '';
    constructor(host, sid, logger) {
        this.host = host;
        this.sid = sid;
        this.logger = logger;
    }
    /**
     * 启动桥：
     * 1. 在 Windows TEMP 下建本桥专属目录，投放 boot.cjs 与独立 data-dir；
     * 2. interop spawn portable node.exe；
     * 3. initialize / initialized 握手。
     */
    static async start(host, sid, logger) {
        const bridge = new LingxiBridge(host, sid, logger);
        await bridge.boot();
        return bridge;
    }
    bootCjsSource() {
        // 编译后位于 lib/lingxi-assets/boot.cjs（scripts/copy-assets.mjs 搬运）；
        // tsx 直接跑源码时落在 src/lingxi-assets/boot.cjs。
        const here = dirname(fileURLToPath(import.meta.url));
        const candidates = [
            join(here, 'lingxi-assets', 'boot.cjs'),
            join(here, '..', 'src', 'lingxi-assets', 'boot.cjs'),
        ];
        for (const candidate of candidates) {
            try {
                return readFileSync(candidate, 'utf8');
            }
            catch {
                // 试下一个候选。
            }
        }
        throw new Error('灵犀桥引导脚本 boot.cjs 未找到（插件构建资源缺失）');
    }
    async boot() {
        const slug = randomUUID().replace(/-/g, '').slice(0, 16);
        const workWsl = join(winToWslPath(this.host.winTemp), `dsh-lingxi-${slug}`);
        mkdirSync(workWsl, { recursive: true });
        // 投放 boot.cjs（Windows node.exe 读 \\wsl$ 路径有 UNC 告警与兼容风险，
        // 故复制到 Windows 盘）。bootCjsSource() 兼容编译产物与 tsx 源码两种布局。
        writeFileSync(join(workWsl, 'boot.cjs'), this.bootCjsSource(), 'utf8');
        const bootWin = `${this.host.winTemp}\\dsh-lingxi-${slug}\\boot.cjs`;
        const dataWin = `${this.host.winTemp}\\dsh-lingxi-${slug}\\data`;
        // 与 boot.cjs 在 DATA 下建的目录骨架保持一致（session/start 要引用）。
        this.dataWin = dataWin;
        const nodeWsl = winToWslPath(this.host.nodeExeWin);
        this.child = spawn(nodeWsl, [bootWin, this.host.appRootWin, this.sid, dataWin], {
            // cwd 钉在 Windows 本地目录，避开 interop 的 UNC 路径告警。
            cwd: '/mnt/c/Windows/System32',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdoutBuffer = '';
        this.child.stdout.on('data', (chunk) => {
            stdoutBuffer += chunk.toString('utf8');
            let index;
            while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
                const line = stdoutBuffer.slice(0, index).trim();
                stdoutBuffer = stdoutBuffer.slice(index + 1);
                if (line)
                    this.dispatchLine(line);
            }
        });
        this.child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8').replace(/\s+$/, '');
            this.stderrTail.push(text);
            if (this.stderrTail.length > 40)
                this.stderrTail.shift();
            this.logger?.warn(`[lingxi-bridge] ${text}`);
        });
        this.child.on('error', (error) => {
            this.startError = error;
            this.failAll(new Error(`灵犀桥进程启动失败: ${error.message}`));
        });
        this.child.on('exit', (code, signal) => {
            if (!this.closed) {
                this.failAll(new Error(`灵犀桥进程意外退出（code=${code ?? '?'} signal=${signal ?? '?'}）`
                    + (this.stderrTail.length ? `；尾部日志: ${this.stderrTail.slice(-3).join(' | ')}` : '')));
            }
        });
        // 握手（桌面 asar 常量：SZ='2026-08-13'，capabilities 固定四件）。
        const init = await this.rpc('initialize', {
            protocol_version: PROTOCOL_VERSION,
            client_info: { name: 'dsh-lingxi-bridge', version: '1.0' },
            capabilities: { bash_approval: false, skill_management: false, timer_task: true, auth_refresh: true },
            device_id: `dsh-${slug.slice(0, 8)}`,
            device_name: 'DSH (WSL bridge)',
        }, 30_000);
        const version = init?.server_info?.version;
        if (version === undefined) {
            throw new Error('灵犀桥 initialize 响应缺少 server_info.version');
        }
        this.notify('initialized', {});
    }
    /** 处理一行 NDJSON：响应 / 服务端请求 / 通知。 */
    dispatchLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            // lingxi.exe 理论上只输出 JSON 行；非 JSON 行（极少见的日志串入）忽略。
            return;
        }
        // 1) RPC 响应
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            this.pending.delete(message.id);
            if (pending.timer)
                clearTimeout(pending.timer);
            if (message.error) {
                const error = Object.assign(new Error(message.error.message ?? '灵犀 RPC 错误'), { code: message.error.code, rpcError: message.error });
                pending.reject(error);
            }
            else {
                pending.resolve(message.result);
            }
            return;
        }
        // 2) 服务端→客户端请求：除凭据刷新外一律回 null（bash_approval=false，
        //    不会有审批请求）；带 id 不响应会让对端 hang。
        if (message.id !== undefined && message.method) {
            const stdin = this.child?.stdin;
            if (!stdin)
                return;
            stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }) + '\n');
            return;
        }
        // 3) 通知：run 事件按 run_id 路由
        if (message.method)
            this.dispatchNotification(message.method, message.params);
    }
    dispatchNotification(method, params) {
        const p = params;
        const runId = p?.run_id;
        if (!runId)
            return; // account/updated、session/subscription/end 等与具体 run 无关，忽略
        const state = this.runs.get(runId);
        const waiter = this.runWaiters.get(runId);
        switch (method) {
            case 'component.start': {
                const kind = componentKind(p.type);
                if (state && p.id && kind && !state.order.some((entry) => entry.id === p.id)) {
                    state.order.push({ id: p.id, kind });
                    state.blocks.set(p.id, '');
                    waiter?.listener?.onBlockStart?.(p.id, kind);
                }
                break;
            }
            case 'component.content': {
                if (state && p.id) {
                    const entry = state.order.find((item) => item.id === p.id);
                    if (entry && p.delta) {
                        state.blocks.set(p.id, (state.blocks.get(p.id) ?? '') + p.delta);
                        waiter?.listener?.onDelta?.(p.id, entry.kind, p.delta);
                    }
                }
                break;
            }
            case 'agent.error':
                waiter?.reject(new Error(`灵犀运行错误: ${p.message ?? JSON.stringify(params).slice(0, 300)}`));
                this.runWaiters.delete(runId);
                break;
            case 'run.end': {
                if (!state || !waiter)
                    break;
                this.runs.delete(runId);
                this.runWaiters.delete(runId);
                let text = '';
                let reasoning = '';
                for (const { id, kind } of state.order) {
                    const body = state.blocks.get(id) ?? '';
                    waiter.listener?.onBlockEnd?.(id, kind, body);
                    if (kind === 'reasoning')
                        reasoning += body;
                    else
                        text += body;
                }
                waiter.resolve({ text, reasoning, creditConsumed: Number(p.credit_consumed ?? 0) });
                break;
            }
            default:
                // run.start / turn.* / stream.* 等事件不需要动作。
                break;
        }
    }
    rpc(method, params, timeoutMs = 120_000) {
        const child = this.child;
        if (this.closed || !child?.stdin || this.startError) {
            return Promise.reject(new Error('灵犀桥连接不可用（已关闭或启动失败）'));
        }
        const stdin = child.stdin;
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new Error(`灵犀 RPC 超时: ${method}（${Math.round(timeoutMs / 1000)}s）`));
                }
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    notify(method, params) {
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
    /** 拉取远端 model/list 的原始模型数组（失败由调用方回退内置目录）。 */
    async listRemoteModels() {
        const result = await this.rpc('model/list', {});
        return Array.isArray(result.models) ? result.models : [];
    }
    /**
     * 执行一次完整对话：新 session + run，收集到 run.end。
     *
     * 多 run 在同一连接上并发是安全的（session_id / run_id 隔离，PoC 已验证
     * 单连接可连续创建多个 session）。
     */
    async runOnce(options) {
        // 三个 skills 目录仍用 data-dir 下的空骨架（不向灵犀暴露 DSH 的工具/技能）。
        const skillsOfficial = `${this.dataWin}\\sk\\o`;
        const skillsUser = `${this.dataWin}\\sk\\u`;
        const skillsTarget = `${this.dataWin}\\sk\\t`;
        // 工作目录跟随 DSH 工作区（适配器传入，已是 Windows 路径）；未提供才回退临时目录。
        const workspace = options.workspaceWin ?? `${this.dataWin}\\workspace`;
        const session = await this.rpc('session/start', {
            client_type: 'desktop',
            session_type: 'cowork_client',
            workspace_dir: workspace,
            official_skills_dir: skillsOfficial,
            user_skills_dir: skillsUser,
            target_skills_dir: skillsTarget,
            env: {
                device_id: 'dsh-bridge',
                device_name: 'DSH (WSL bridge)',
                skills: { dir: skillsUser, list: [] },
                connectors: [],
                work_space_dir: workspace,
            },
        });
        const sessionId = session.session_id;
        if (!sessionId)
            throw new Error('灵犀 session/start 未返回 session_id');
        await this.rpc('session/subscribe', { session_id: sessionId });
        const run = await this.rpc('run/start', {
            session_id: sessionId,
            agent_input: {
                text: options.prompt,
                files: [],
                file_ids: [],
                expect_model: options.model,
                refs: [],
                permission_mode: 'default',
                current_mode: 'agent',
                browser_plugin_enabled: false,
            },
            model: { provider: 'lingxi', model_name: options.model },
            request_id: `dsh-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            client_type: 'desktop',
            open_position: 'app_server',
            agent: 'lingxiclaw',
        }, 180_000);
        const runId = run.run_id;
        if (!runId)
            throw new Error('灵犀 run/start 未返回 run_id');
        this.runs.set(runId, { order: [], blocks: new Map() });
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject: (error) => {
                    this.runs.delete(runId);
                    reject(error);
                },
                listener: options.listener,
                interrupted: false,
            };
            this.runWaiters.set(runId, waiter);
            options.signal?.addEventListener('abort', () => {
                if (waiter.interrupted)
                    return;
                waiter.interrupted = true;
                // 尽力通知服务端停止；响应与否不等待。
                this.rpc('run/interrupt', { session_id: sessionId, run_id: runId }, 5_000)
                    .catch(() => undefined);
                this.runs.delete(runId);
                this.runWaiters.delete(runId);
                reject(new Error('灵犀对话已取消'));
            }, { once: true });
        });
    }
    failAll(error) {
        for (const [id, pending] of this.pending) {
            if (pending.timer)
                clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        for (const [runId, waiter] of this.runWaiters) {
            waiter.reject(error);
        }
        this.runWaiters.clear();
        this.runs.clear();
    }
    /** 关闭桥（杀 Windows node.exe；boot.cjs 会连锁杀 lingxi.exe）。 */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.failAll(new Error('灵犀桥已关闭'));
        try {
            this.child?.kill();
        }
        catch {
            // 进程已退出。
        }
    }
}
//# sourceMappingURL=lingxi-bridge.js.map