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
 *
 * ## 为什么必须清洗 `parameters`（v2.0.1 修复）
 *
 * 灵犀云端的 `agent-runtime/chat/completions` 对 JSON Schema 的容忍度远低于
 * 标准 OpenAI：只要有一个工具的参数 schema 里出现「没有 `type` 的节点」，
 * 整个请求就直接返回 `{"code":"AIError","message":"AI服务异常"}`（HTTP 200，
 * 无任何细节）。实测触发条件（2026-10-28）：
 *
 * - `{ anyOf: [...] }` / `{ oneOf: [...] }` / `{ allOf: [...] }` 缺兄弟 `type`；
 * - 节点只有 `description` 而没有 `type`；
 * - `type: ['string','object']` 这种联合类型数组（报 `InvalidArgument`）。
 *
 * DSH 内置的 360 个工具里有 8 个踩中（`compress`、`jev_ask`、
 * `schedule_create`、`schedule_update`、`task_board_update`、`univer_lint`、
 * `univer_screenshot`、`validate_dsh_ui`），因此只要不清洗，**任何真实 DSH
 * 会话都必然失败**——这正是 v2.0 上线后「跑不通」的根因。
 *
 * 清洗策略（见 {@link normalizeSchema}）：把组合子折叠成首个分支（保留同层
 * 的 `description` 等字段），并给每个节点补上 `type`（缺省 `string`）。
 * 实测折叠后 360 个工具全部通过，且模型仍能正确调用（工具名与参数不变）。
 */
export declare function toDirectTools(tools: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}[] | undefined): DirectToolSchema[] | undefined;
