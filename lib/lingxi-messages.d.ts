/**
 * DSH 消息 → 灵犀云端 OpenAI 形状消息的转换。
 *
 * ## v2.0 与 v1.x 的根本区别
 *
 * v1.x 走灵犀 agent 循环时没有 function-calling 通道，只能把整段历史**渲染成
 * 一段带角色标签的纯文本**（模型看不到结构化的工具调用，DSH 的工具循环也
 * 因此无法驱动）。
 *
 * v2.0 直连云端的 `chat/completions`，它支持**标准 OpenAI 工具协议**：
 * `tools` 下发定义、`tool_calls` 发起调用、`role:'tool'` 回传结果。故本模块
 * 做的是**结构化映射**而非文本渲染：
 *
 * | DSH | 云端 wire |
 * |---|---|
 * | `role:'system'` / `options.system` | `context` 字段（灵犀专有，覆盖其内置提示词） |
 * | `role:'user'` + text 块 | `{role:'user', content}` |
 * | `role:'assistant'` + text 块 | `{role:'assistant', content}` |
 * | `role:'assistant'` + tool-call 块 | `{role:'assistant', content:'', tool_calls:[...]}` |
 * | `role:'tool'`（0.1.7+ 一等消息） | `{role:'tool', tool_call_id, content}` |
 * | `role:'developer'` | **丢弃**（只承载工具增删元数据） |
 *
 * 图片/文件块降级为占位文本：灵犀这一路按纯文本接入（DSH 侧
 * `inputModalities:['text']` 已如实声明，正常不会投递图片）。
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { DirectChatMessage, DirectToolSchema } from './lingxi-direct.js';
/** 转换结果：wire 消息 + 抽出的系统提示词。 */
export interface ConvertedMessages {
    /** 下发给 `messages` 字段的消息（不含 system）。 */
    readonly messages: DirectChatMessage[];
    /** 下发给 `context` 字段的系统提示词（可能为空）。 */
    readonly system: string;
}
/**
 * 把 DSH 的 messages 转换成云端 OpenAI 形状。
 *
 * @param messages DSH 传入的完整历史（`GenerateOptions.messages`）
 * @param optionsSystem `GenerateOptions.system`（一次性调用者用）
 */
export declare function toDirectMessages(messages: readonly GenerateOptions['messages'][number][], optionsSystem?: string): ConvertedMessages;
/**
 * 把 DSH 的工具定义转换成云端 OpenAI 形状。
 *
 * DSH 的 `ToolSchema` 已经是 `{name, description, parameters}`，只需包上
 * `{type:'function', function:{...}}` 外层。
 *
 * `deferLoading` 是 Anthropic 的延迟加载语义，灵犀不支持，直接忽略
 * （工具全量下发）。
 */
export declare function toDirectTools(tools: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}[] | undefined): DirectToolSchema[] | undefined;
