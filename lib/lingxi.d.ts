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
/** 一个内置模型的目录条目（字段对齐 model/list 的下发形状）。 */
export interface LingxiModelEntry {
    /** 请求体 `model` 字段用的模型标识。 */
    readonly modelName: string;
    /** 展示名。 */
    readonly name: string;
    /** 一句话介绍（intro / desc）。 */
    readonly intro: string;
    /** 是否支持多模态（v2.0 直连按纯文本接入，暂不投递图片）。 */
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
/** 默认模型（灵犀桌面版缺省即 max）。 */
export declare const LINGXI_DEFAULT_MODEL = "max";
/** 按 model_name 查兜底条目。 */
export declare function findFallbackModel(modelName: string): LingxiModelEntry | undefined;
