import { extractWpsSid } from './lingxi-credential.js';
import { detectWsl } from './lingxi-win32.js';
import { claimDailyCheckIn, getCreditsBalance, getCreditsDetail, getDailyCheckIn, LingxiCloudError, } from './lingxi-cloud.js';
const API_PATH = '/api/wpslingxi';
const ENDPOINT = 'wpslingxi';
/** 构造标准 RPC 响应。 */
function reply(rpcId, result) {
    return Response.json({ type: 'server-response', rpcId, result });
}
/** 把任意异常规整成错误包络；401 用专门 code 让前端可提示重新登录。 */
function toErrorEnvelope(error) {
    if (error instanceof LingxiCloudError) {
        return {
            ok: false,
            error: {
                code: error.isUnauthorized ? 'UNAUTHORIZED' : (error.code ?? 'CLOUD_ERROR'),
                message: error.message,
            },
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'LINGXI_ERROR', message } };
}
/**
 * 注册管理 RPC。在非 WSL / 无 connection 服务时静默跳过（面板会显示不可用原因）。
 */
export function registerLingxiRpc(ctx, env) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = ctx.connection ?? safeGet(ctx);
    if (!connection || typeof connection.fetch?.register !== 'function') {
        ctx.logger?.warn?.('[lingxi] connection.fetch 不可用，签到/余额 RPC 未注册');
        return;
    }
    const fetchRegistry = connection.fetch;
    /** 实时取 SID（不做长缓存；credential 模块内部有进程缓存，401 时强制刷新）。 */
    async function resolveSid(force = false) {
        const environment = env ?? detectWsl();
        if (!environment) {
            throw new LingxiCloudError('当前不是 WSL 环境，无法读取 Windows 宿主的灵犀登录态', 0, 'NOT_WSL');
        }
        return extractWpsSid(environment, force);
    }
    /** 分派单个业务方法。 */
    async function handle(method) {
        try {
            if (method === 'credits.balance') {
                const sid = await resolveSid();
                try {
                    return { ok: true, value: await getCreditsBalance(sid) };
                }
                catch (error) {
                    if (error instanceof LingxiCloudError && error.isUnauthorized) {
                        return { ok: true, value: await getCreditsBalance(await resolveSid(true)) };
                    }
                    throw error;
                }
            }
            // 积分明细：赠送池有效期 + 近 3 天到期统计 + 最近流水。
            if (method === 'credits.detail') {
                const sid = await resolveSid();
                try {
                    return { ok: true, value: await getCreditsDetail(sid, 3) };
                }
                catch (error) {
                    if (error instanceof LingxiCloudError && error.isUnauthorized) {
                        return { ok: true, value: await getCreditsDetail(await resolveSid(true), 3) };
                    }
                    throw error;
                }
            }
            if (method === 'checkin.status') {
                const sid = await resolveSid();
                try {
                    return { ok: true, value: await getDailyCheckIn(sid) };
                }
                catch (error) {
                    if (error instanceof LingxiCloudError && error.isUnauthorized) {
                        return { ok: true, value: await getDailyCheckIn(await resolveSid(true)) };
                    }
                    throw error;
                }
            }
            if (method === 'checkin.claim') {
                const sid = await resolveSid();
                try {
                    return { ok: true, value: await claimDailyCheckIn(sid) };
                }
                catch (error) {
                    if (error instanceof LingxiCloudError && error.isUnauthorized) {
                        return { ok: true, value: await claimDailyCheckIn(await resolveSid(true)) };
                    }
                    throw error;
                }
            }
            return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `未知方法：${method}` } };
        }
        catch (error) {
            ctx.logger?.warn?.(`[lingxi] RPC ${method} 失败：${error.message}`);
            return toErrorEnvelope(error);
        }
    }
    fetchRegistry.register({
        path: API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            if (request.method !== 'POST')
                return new Response('method not allowed', { status: 405 });
            const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
            if (contentType !== 'application/json') {
                return new Response('content type must be application/json', { status: 415 });
            }
            let message;
            try {
                message = (await request.json());
            }
            catch {
                return new Response('body is not JSON', { status: 400 });
            }
            const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request';
            const call = message.payload;
            if (message.type !== 'client-request'
                || typeof message.rpcId !== 'string'
                || message.method !== ENDPOINT
                || !call
                || typeof call.method !== 'string'
                || !Object.prototype.hasOwnProperty.call(call, 'payload')) {
                return reply(rpcId, {
                    ok: false,
                    error: { code: 'bad-request', message: 'Invalid wps-lingxi management request.' },
                });
            }
            const result = await handle(call.method);
            return reply(rpcId, result);
        },
    });
    ctx.logger?.info?.('[lingxi] 签到/余额管理 RPC 已注册（/api/wpslingxi）');
}
/** 宽松取 connection 服务（避免对未导出类型做强依赖）。 */
function safeGet(ctx) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ctx.get?.('connection');
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=lingxi-rpc.js.map