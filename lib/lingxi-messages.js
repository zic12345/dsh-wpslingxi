/** 单个 block 的纯文本投影（图片/文件降级为占位说明）。 */
function blockToText(block) {
    switch (block.type) {
        case 'text':
            return block.text;
        case 'reasoning':
            // 历史思考内容不回传给模型：既占上下文，又可能干扰下一轮推理。
            return '';
        case 'image':
            return '<图片：本 provider 仅支持纯文本，图片未投递>';
        case 'file':
            return '<文件：本 provider 仅支持纯文本，文件未投递>';
        default:
            // tool-call / tool-addition / tool-removal 由调用方单独处理。
            return '';
    }
}
/** 把一组 content 块里的正文拼成一个字符串。 */
function contentToText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const raw of content) {
        if (typeof raw === 'string') {
            parts.push(raw);
            continue;
        }
        const block = raw;
        const text = blockToText(block);
        if (text)
            parts.push(text);
    }
    return parts.join('');
}
/** 从 assistant 消息里提取工具调用（tool-call 块）。 */
function extractToolCalls(content) {
    if (!Array.isArray(content))
        return [];
    const calls = [];
    for (const raw of content) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const block = raw;
        if (block.type !== 'tool-call')
            continue;
        const name = typeof block.name === 'string' ? block.name : '';
        if (!name)
            continue;
        // arguments 在 DSH 侧已是 JSON 字符串；容错处理对象形态。
        const args = typeof block.arguments === 'string'
            ? block.arguments
            : JSON.stringify(block.arguments ?? {});
        calls.push({
            id: typeof block.id === 'string' && block.id ? block.id : `call_${calls.length}`,
            type: 'function',
            function: { name, arguments: args },
        });
    }
    return calls;
}
/**
 * 把 DSH 的 messages 转换成云端 OpenAI 形状。
 *
 * @param messages DSH 传入的完整历史（`GenerateOptions.messages`）
 * @param optionsSystem `GenerateOptions.system`（一次性调用者用）
 */
export function toDirectMessages(messages, optionsSystem) {
    const systemParts = [];
    if (optionsSystem?.trim())
        systemParts.push(optionsSystem.trim());
    const out = [];
    for (const message of messages) {
        const role = message.role;
        const rawContent = message.content;
        if (role === 'system') {
            const text = contentToText(rawContent).trim();
            if (text)
                systemParts.push(text);
            continue;
        }
        // developer 只承载工具增删元数据（tool-addition / tool-removal），
        // 不是对话内容；工具定义已由 `options.tools` 全量下发，故整体丢弃。
        if (role === 'developer')
            continue;
        if (role === 'assistant') {
            const text = contentToText(rawContent);
            const toolCalls = extractToolCalls(rawContent);
            if (toolCalls.length > 0) {
                // 有工具调用：正文可为空串（OpenAI 允许），tool_calls 必带。
                out.push({ role: 'assistant', content: text, tool_calls: toolCalls });
            }
            else if (text.trim()) {
                out.push({ role: 'assistant', content: text });
            }
            // 既无正文又无工具调用（纯思考块）：跳过，避免发空消息。
            continue;
        }
        if (role === 'tool') {
            const toolCallId = message.toolCallId;
            const isError = message.isError === true;
            const text = contentToText(rawContent);
            out.push({
                role: 'tool',
                tool_call_id: typeof toolCallId === 'string' ? toolCallId : '',
                // 失败结果加前缀，让模型明确知道这是错误而非正常输出。
                content: isError ? `[工具执行失败] ${text}` : text,
            });
            continue;
        }
        // user（以及归一后承载工具结果的旧形状）：按普通用户消息下发。
        const text = contentToText(rawContent);
        if (text.trim())
            out.push({ role: 'user', content: text });
    }
    return {
        messages: out,
        // 多个 system 段去重后拼接（灵犀的 context 是单个字符串字段）。
        system: [...new Set(systemParts)].join('\n\n'),
    };
}
/**
 * 把 DSH 的工具定义转换成云端 OpenAI 形状。
 *
 * DSH 的 `ToolSchema` 已经是 `{name, description, parameters}`，只需包上
 * `{type:'function', function:{...}}` 外层。
 *
 * `deferLoading` 是 Anthropic 的延迟加载语义，灵犀不支持，直接忽略
 * （工具全量下发）。
 */
export function toDirectTools(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}
//# sourceMappingURL=lingxi-messages.js.map