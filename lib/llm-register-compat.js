/**
 * 适配器幂等注册（独立插件内的最小实现）。
 *
 * codearts 母插件里的同名模块还包了 Token 记账与「失效模型剔除」两层 Proxy，
 * 那两套机制依赖母插件的 openai-gateway / dead-model-store，本独立插件不需要：
 * - 灵犀走桌面 App 私有桥，没有经过本地 OpenAI 网关，无需网关记账；
 * - 失效模型剔除是针对 HTTP 供应商反复失败后的自动隐藏，灵犀模型目录由桥侧
 *   model/list 与内置兜底表提供，不参与该机制。
 *
 * 这里只保留「fiber 热重启竞态下重复注册不抛错」这一真正需要的语义。
 */
/** 判断是否为「适配器已注册」类错误（不同 dsh-llm 版本措辞可能不同）。 */
function isDuplicateRegistrationError(error) {
    if (!(error instanceof Error))
        return false;
    const msg = error.message.toLowerCase();
    return (msg.includes('already registered')
        || msg.includes('already been registered')
        || msg.includes('duplicate')
        || msg.includes('已注册'));
}
/**
 * 注册 LLM 适配器；重复注册时保留先注册者并返回 undefined，不抛错。
 */
export function registerAdapterIdempotent(llm, providers, adapter, warn) {
    try {
        return llm.registerAdapter(providers, adapter);
    }
    catch (error) {
        if (!isDuplicateRegistrationError(error))
            throw error;
        warn?.(`[lingxi] adapter for ${providers.map((p) => `"${p}"`).join(', ')} `
            + '已注册（插件 fiber 重启竞态），保留现有路由并跳过本次注册');
        return undefined;
    }
}
//# sourceMappingURL=llm-register-compat.js.map