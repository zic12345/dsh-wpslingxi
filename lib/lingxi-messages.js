import { normalizeHarnessMessages } from './message-shape.js';
/** 单个 block 渲染为纯文本（图片/文件降级为占位说明）。 */
function renderBlock(block) {
    switch (block.type) {
        case 'text':
            return block.text;
        case 'reasoning':
            // 历史思考过程对最终回答价值低且占上下文，折叠为一行。
            return block.text.trim() ? `<思考过程>${block.text.trim()}</思考过程>` : '';
        case 'tool-call':
            return `<工具调用 name="${block.name}">${block.arguments}</工具调用>`;
        case 'image':
            return '<图片>';
        default:
            // file / tool-addition / tool-removal / 未知块：对正文无贡献，忽略。
            // （file 块本就被组装层投影成文本句柄，正常不会到达这里。）
            return '';
    }
}
/**
 * 把 DSH 消息数组渲染成灵犀单条 prompt。
 *
 * @param optionsSystem GenerateOptions.system（一次性调用者用），并入最前。
 */
export function serializeLingxiPrompt(messages, optionsSystem) {
    // 0.1.7 工具结果（role:'tool'）先归一为旧形状，保证工具转录不丢。
    // 仅按 role/content/toolCallId 三个维度消费（见 HarnessMessageLike），故这里
    // 只做结构视图转换；dsh-llm 的 Message 类型没有该索引签名，但形状兼容。
    const normalized = normalizeHarnessMessages(messages);
    const parts = [];
    const systemTexts = [];
    if (optionsSystem?.trim())
        systemTexts.push(optionsSystem.trim());
    for (const message of normalized) {
        const role = message.role;
        const rawContent = message.content;
        const blocks = Array.isArray(rawContent)
            ? rawContent
            : (typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }] : []);
        const lines = [];
        for (const rawBlock of blocks) {
            if (typeof rawBlock === 'string') {
                lines.push(rawBlock);
                continue;
            }
            // 用宽松结构而非 Partial<ContentBlock>：'tool-result' 块来自
            // normalizeHarnessMessages 对 0.1.7+ role:'tool' 的包裹，而新版 dsh-llm
            // 的 ContentBlock 联合已不含该 type，直接断言成 ContentBlock 会被判 never。
            const block = rawBlock;
            if (block.type === 'tool-result') {
                // normalizeHarnessMessages 把 0.1.7 role:'tool' 包成此块。
                const inner = typeof block.content === 'string'
                    ? block.content
                    : safeJson(block.content);
                const failedTag = block.isError ? '（失败）' : '';
                lines.push(`<工具结果${failedTag}>${inner}</工具结果>`);
                continue;
            }
            const rendered = renderBlock(block);
            if (rendered)
                lines.push(rendered);
        }
        const body = lines.join('\n').trim();
        if (!body)
            continue;
        if (role === 'system' || role === 'developer') {
            systemTexts.push(body);
        }
        else if (role === 'assistant') {
            parts.push(`[助手]\n${body}`);
        }
        else {
            // user，以及归一后承载工具结果的 user 消息。
            parts.push(`[用户]\n${body}`);
        }
    }
    const sections = [];
    if (systemTexts.length > 0) {
        // 去重相邻重复的 system 文本，避免系统提示被重复灌入。
        const unique = [...new Set(systemTexts.map((text) => text.trim()))];
        sections.push(unique.join('\n\n'));
    }
    if (parts.length > 0)
        sections.push(parts.join('\n\n'));
    sections.push('请直接给出助手的回复内容。');
    return sections.join('\n\n');
}
function safeJson(value) {
    if (value === null || value === undefined)
        return '';
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=lingxi-messages.js.map