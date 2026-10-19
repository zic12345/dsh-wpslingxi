/**
 * 灵犀消息序列化。
 *
 * 灵犀桌面 agent runtime **不提供原生 function-calling 通道**：它只接受一个
 * `agent_input.text` 自由文本，回复也是正文/思考两块文本。故本 provider 以
 * 「对话/推理模型」身份接入 DSH——
 *
 * - 入参 `messages`（system/user/assistant/tool 及各类 ContentBlock）被**渲染成
 *   一段带角色标签的转录文本**，让模型在单轮无状态调用里读到完整上下文；
 * - 工具调用/工具结果降级为转录行（保留「调了什么、返回了什么」），不产出
 *   `tool-call` chunk，因此不会驱动 DSH 的工具执行循环。需要 agentic 工具时
 *   用户应选用支持原生工具的 provider；灵犀定位是对话/写作/推理。
 *
 * 无状态多轮已真机验证（/tmp/lxdrv/poc.js：把 system+历史渲染成单条 text，
 * 新 session 能正确回答历史里的算术）。
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
/**
 * 把 DSH 消息数组渲染成灵犀单条 prompt。
 *
 * @param optionsSystem GenerateOptions.system（一次性调用者用），并入最前。
 */
export declare function serializeLingxiPrompt(messages: readonly GenerateOptions['messages'][number][], optionsSystem?: string): string;
