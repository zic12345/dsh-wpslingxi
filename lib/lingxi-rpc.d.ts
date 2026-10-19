/**
 * 宿主侧管理 RPC：把「每日签到 / 余额 / 状态」暴露给左侧插件面板。
 *
 * 复用 DSH 的 connection.fetch 通道（与 codearts 母插件的 jet-hub RPC 同构）：
 *
 * - Host：`connection.fetch.register({ path:'/api/wpslingxi', methods:['POST'] })`；
 * - Client：`connection.rpc.call('/api', 'wpslingxi', { method, payload })`；
 * - 请求包络 `{ type:'client-request', rpcId, method:'wpslingxi',
 *    payload:{ method, payload } }`，响应 `{ type:'server-response', rpcId, result }`，
 *    result 统一为 `{ ok:true, value } | { ok:false, error:{ code, message } }`。
 *
 * 方法：
 * - `credits.balance`  → 智点余额；
 * - `checkin.status`   → 每日签到状态（不领奖）；
 * - `checkin.claim`    → 一键签到领奖（今天已签则返回 alreadyClaimed）。
 *
 * 三个方法都在调用时**实时提取桌面 SID**：cookie 失效（401）时强制重新从
 * Windows 登录态解密一次，避免面板长期持有过期 SID。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type WslEnvironment } from './lingxi-win32.js';
/** 面板需要的环境前提探测结果（首包返回，供前端给出未就绪原因）。 */
export interface LingxiAvailability {
    readonly available: boolean;
    readonly reason?: string;
}
/**
 * 注册管理 RPC。在非 WSL / 无 connection 服务时静默跳过（面板会显示不可用原因）。
 */
export declare function registerLingxiRpc(ctx: Context, env?: WslEnvironment): void;
