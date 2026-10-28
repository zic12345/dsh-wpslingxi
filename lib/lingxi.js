/**
 * WPS 灵犀 provider 的静态模型目录与共享类型。
 *
 * 模型字段来自真机 `model/list`（2026-10-12，app-server v68 / 桌面 4.27.0，
 * 13 个内置模型，provider 恒为 `lingxi`）。v2.0 直连云端后不再调用
 * `model/list`（云端按请求里的模型名路由，未知名回落默认模型），因此这份
 * 目录就是**唯一**的模型清单；增删模型直接改这里。
 *
 * 真机实测（2026-10-28）：13 个名字全部被云端接受并返回 200。
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
/** 默认模型（灵犀桌面版缺省即 max）。 */
export const LINGXI_DEFAULT_MODEL = 'max';
/** 按 model_name 查兜底条目。 */
export function findFallbackModel(modelName) {
    return LINGXI_FALLBACK_MODELS.find((entry) => entry.modelName === modelName);
}
//# sourceMappingURL=lingxi.js.map