/**
 * WPS 灵犀（桌面版）provider 的静态模型目录与共享类型。
 *
 * 模型字段来自真机 `model/list`（2026-10-12，app-server v68 / 桌面 4.27.0，
 * 13 个内置模型，provider 恒为 `lingxi`）。灵犀的模型集合由其 app-server
 * 下发、随版本变化；这里保留一份**兜底内置目录**，使未启动桥（未装桌面版 /
 * WSL 外环境）时仍有可展示的模型，桥连上后可用远端 model/list 覆盖。
 */
/** 一个内置模型的目录条目（字段对齐 model/list 的下发形状）。 */
export interface LingxiModelEntry {
    /** run/start 与 expect_model 用的模型标识。 */
    readonly modelName: string;
    /** 展示名。 */
    readonly name: string;
    /** 一句话介绍（intro / desc）。 */
    readonly intro: string;
    /** 是否支持多模态（灵犀的多模态走桌面 App，DSH 文本桥暂不投递图片）。 */
    readonly multimodal: boolean;
    /** 最大上下文 token（max_context_tokens）。 */
    readonly contextTokens: number;
    /** 最大生成长度 token（max_new_tokens）。 */
    readonly maxNewTokens: number;
    /** 思考档位；空数组表示该模型不暴露档位（Pro/Max 模式、MiMo、MiniMax-M3）。 */
    readonly reasoningEfforts: readonly ('low' | 'high' | 'max')[];
}
/**
 * 兜底目录（真机 model/list 全量，2026-10-12）。
 */
export declare const LINGXI_FALLBACK_MODELS: readonly LingxiModelEntry[];
/** 默认模型（run/start 缺省 model_name 为 max）。 */
export declare const LINGXI_DEFAULT_MODEL = "max";
/** 按 model_name 查兜底条目。 */
export declare function findFallbackModel(modelName: string): LingxiModelEntry | undefined;
/** 把远端 model/list 的原始模型对象归一为目录条目（失败回退 undefined）。 */
export declare function normalizeRemoteModel(raw: unknown): LingxiModelEntry | undefined;
