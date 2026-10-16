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
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { normalizeHarnessMessages, type HarnessMessageLike } from './message-shape.js'

/** 单个 block 渲染为纯文本（图片/文件降级为占位说明）。 */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      // 历史思考过程对最终回答价值低且占上下文，折叠为一行。
      return block.text.trim() ? `<思考过程>${block.text.trim()}</思考过程>` : ''
    case 'tool-call':
      return `<工具调用 name="${block.name}">${block.arguments}</工具调用>`
    case 'image':
      return '<图片>'
    default:
      // file / tool-addition / tool-removal / 未知块：对正文无贡献，忽略。
      // （file 块本就被组装层投影成文本句柄，正常不会到达这里。）
      return ''
  }
}

/**
 * 把 DSH 消息数组渲染成灵犀单条 prompt。
 *
 * @param optionsSystem GenerateOptions.system（一次性调用者用），并入最前。
 */
export function serializeLingxiPrompt(
  messages: readonly GenerateOptions['messages'][number][],
  optionsSystem?: string,
): string {
  // 0.1.7 工具结果（role:'tool'）先归一为旧形状，保证工具转录不丢。
  // 仅按 role/content/toolCallId 三个维度消费（见 HarnessMessageLike），故这里
  // 只做结构视图转换；dsh-llm 的 Message 类型没有该索引签名，但形状兼容。
  const normalized = normalizeHarnessMessages(
    messages as unknown as readonly HarnessMessageLike[],
  )
  const parts: string[] = []
  const systemTexts: string[] = []
  if (optionsSystem?.trim()) systemTexts.push(optionsSystem.trim())

  for (const message of normalized) {
    const role = message.role
    const rawContent = (message as { content?: unknown }).content
    const blocks: unknown[] = Array.isArray(rawContent)
      ? rawContent
      : (typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }] : [])

    const lines: string[] = []
    for (const rawBlock of blocks) {
      if (typeof rawBlock === 'string') {
        lines.push(rawBlock)
        continue
      }
      // 用宽松结构而非 Partial<ContentBlock>：'tool-result' 块来自
      // normalizeHarnessMessages 对 0.1.7+ role:'tool' 的包裹，而新版 dsh-llm
      // 的 ContentBlock 联合已不含该 type，直接断言成 ContentBlock 会被判 never。
      const block = rawBlock as {
        type?: string
        text?: unknown
        name?: unknown
        arguments?: unknown
        content?: unknown
        toolCallId?: unknown
        isError?: unknown
      }
      if (block.type === 'tool-result') {
        // normalizeHarnessMessages 把 0.1.7 role:'tool' 包成此块。
        const inner = typeof block.content === 'string'
          ? block.content
          : safeJson(block.content)
        const failedTag = block.isError ? '（失败）' : ''
        lines.push(`<工具结果${failedTag}>${inner}</工具结果>`)
        continue
      }
      const rendered = renderBlock(block as ContentBlock)
      if (rendered) lines.push(rendered)
    }
    const body = lines.join('\n').trim()
    if (!body) continue

    if (role === 'system' || role === 'developer') {
      systemTexts.push(body)
    } else if (role === 'assistant') {
      parts.push(`[助手]\n${body}`)
    } else {
      // user，以及归一后承载工具结果的 user 消息。
      parts.push(`[用户]\n${body}`)
    }
  }

  const sections: string[] = []
  if (systemTexts.length > 0) {
    // 去重相邻重复的 system 文本，避免系统提示被重复灌入。
    const unique = [...new Set(systemTexts.map((text) => text.trim()))]
    sections.push(unique.join('\n\n'))
  }
  if (parts.length > 0) sections.push(parts.join('\n\n'))
  sections.push('请直接给出助手的回复内容。')
  return sections.join('\n\n')
}

function safeJson(value: unknown): string {
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
