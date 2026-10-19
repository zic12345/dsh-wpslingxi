import { registerLingxiLlm } from './lingxi-adapter.js';
import { registerLingxiRpc } from './lingxi-rpc.js';
import { detectWsl } from './lingxi-win32.js';
export const name = 'dsh-wpslingxi';
/**
 * llm：注册模型路由必需。
 * connection：Web profile 下由 dsh-client-connection 提供；缺席时 RPC 注册会
 * 自行降级（registerLingxiRpc 内部判空），不影响模型侧。
 * sessionQuery：按会话 id 反查该会话的项目工作目录（header.cwd），
 * 让灵犀 agent 的工作目录跟随当前 DSH 会话而不是进程 cwd。
 */
export const inject = ['llm', 'connection', 'sessionQuery'];
export function apply(ctx) {
    const env = detectWsl();
    // ① 模型 provider（异步、失败只 warn；见 registerLingxiLlm 内的三道探测）。
    void registerLingxiLlm(ctx).catch((error) => {
        ctx.logger?.warn?.(`[lingxi] provider 注册异常：${error.message}`);
    });
    // ② 签到 / 余额 RPC（非 WSL 也注册端点，方法内部会返回明确的环境错误）。
    try {
        registerLingxiRpc(ctx, env ?? undefined);
    }
    catch (error) {
        ctx.logger?.warn?.(`[lingxi] 管理 RPC 注册异常：${error.message}`);
    }
    ctx.logger?.info?.('[lingxi] dsh-wpslingxi 插件已加载');
}
//# sourceMappingURL=index.js.map