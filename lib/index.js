import { registerLingxiLlm } from './lingxi-adapter.js';
import { registerLingxiRpc } from './lingxi-rpc.js';
import { detectWsl } from './lingxi-win32.js';
export const name = 'dsh-wpslingxi';
/**
 * llm：注册模型路由必需。
 * connection：Web profile 下由 dsh-client-connection 提供；缺席时 RPC 注册会
 * 自行降级（registerLingxiRpc 内部判空），不影响模型侧。
 * sessionQuery：按会话 id 反查该会话的项目工作目录（header.cwd），
 * 用于在云端会话上声明工作区（不影响工具执行目录 —— v2.0 工具跑在 DSH 侧）。
 */
export const inject = ['llm', 'connection', 'sessionQuery'];
export function apply(ctx) {
    const env = detectWsl();
    // ① 模型 provider（异步、失败只 warn；见 registerLingxiLlm 内的探测）。
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