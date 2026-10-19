/**
 * WPS 灵犀（桌面版）provider 的静态模型目录与共享类型。
 *
 * 模型字段来自真机 `model/list`（2026-10-12，app-server v68 / 桌面 4.27.0，
 * 13 个内置模型，provider 恒为 `lingxi`）。灵犀的模型集合由其 app-server
 * 下发、随版本变化；这里保留一份**兜底内置目录**，使未启动桥（未装桌面版 /
 * WSL 外环境）时仍有可展示的模型，桥连上后可用远端 model/list 覆盖。
 */
/**
 * 兜底目录（真机 model/list 全量，2026-10-12）。
 */
export const LINGXI_FALLBACK_MODELS = [
    { modelName: 'max', name: 'Max 模式', intro: '为复杂任务设计，智点消耗较多', multimodal: true, contextTokens: 1048576, maxNewTokens: 131072, reasoningEfforts: [] },
    { modelName: 'pro', name: 'Pro 模式', intro: '适用于日常任务，智点消耗较少', multimodal: true, contextTokens: 1048576, maxNewTokens: 131072, reasoningEfforts: [] },
    { modelName: 'kimi-k3', name: 'Kimi-K3', intro: '编程能力突出，适用于大型代码库分析', multimodal: true, contextTokens: 1048576, maxNewTokens: 524288, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', intro: '适用于复杂代码与深度分析任务', multimodal: false, contextTokens: 1048576, maxNewTokens: 393216, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', intro: '原生多模态，推理性能全面提升', multimodal: true, contextTokens: 1048576, maxNewTokens: 393216, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', intro: '响应快成本低，适用于日常问答', multimodal: false, contextTokens: 1048576, maxNewTokens: 393216, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'GLM-5.3', name: 'GLM-5.3', intro: '智谱旗舰版模型，适用于高精复杂任务', multimodal: false, contextTokens: 1048576, maxNewTokens: 131072, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', intro: '原生多模态，前沿智能普惠', multimodal: true, contextTokens: 1048576, maxNewTokens: 131072, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'qwen3.8_max', name: 'Qwen3.8-Max', intro: '适用于高难度的综合业务场景', multimodal: true, contextTokens: 1048576, maxNewTokens: 131072, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'qwen3.8_flash', name: 'Qwen3.8-Flash', intro: '原生多模态，拥有出色的响应速度', multimodal: true, contextTokens: 1048576, maxNewTokens: 131072, reasoningEfforts: ['low', 'high', 'max'] },
    { modelName: 'minimax_m3', name: 'MiniMax-M3', intro: '自适应思考，无需手动调节推理强度', multimodal: true, contextTokens: 1048576, maxNewTokens: 524288, reasoningEfforts: [] },
    { modelName: 'mimo-v2.6-pro', name: 'Xiaomi MiMo-V2.6 Pro', intro: '小米自研模型，原生全模态', multimodal: true, contextTokens: 1048576, maxNewTokens: 131072, reasoningEfforts: [] },
    { modelName: 'doubao_seed_2_1_pro_260628', name: 'Doubao-Seed-2.1 Pro', intro: '适用于综合业务场景', multimodal: true, contextTokens: 262144, maxNewTokens: 262144, reasoningEfforts: ['low', 'high', 'max'] },
];
/** 默认模型（run/start 缺省 model_name 为 max）。 */
export const LINGXI_DEFAULT_MODEL = 'max';
/** 按 model_name 查兜底条目。 */
export function findFallbackModel(modelName) {
    return LINGXI_FALLBACK_MODELS.find((entry) => entry.modelName === modelName);
}
/** 把远端 model/list 的原始模型对象归一为目录条目（失败回退 undefined）。 */
export function normalizeRemoteModel(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const modelName = record.model_name;
    if (typeof modelName !== 'string' || !modelName)
        return undefined;
    const efforts = Array.isArray(record.reasoning_efforts)
        ? record.reasoning_efforts.filter((value) => value === 'low' || value === 'high' || value === 'max')
        : [];
    const asInt = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    return {
        modelName,
        name: typeof record.name === 'string' && record.name ? record.name : modelName,
        intro: typeof record.intro === 'string' ? record.intro
            : typeof record.desc === 'string' ? record.desc : '',
        multimodal: record.support_multimodal === true,
        contextTokens: asInt(record.max_context_tokens, 1048576),
        maxNewTokens: asInt(record.max_new_tokens, 131072),
        reasoningEfforts: efforts,
    };
}
//# sourceMappingURL=lingxi.js.map