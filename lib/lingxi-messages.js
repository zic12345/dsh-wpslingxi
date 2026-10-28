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
export function toDirectTools(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: normalizeSchema(tool.parameters),
        },
    }));
}
/** JSON Schema 组合子关键字（灵犀云端不接受缺 `type` 的这三种）。 */
const COMBINATOR_KEYS = ['anyOf', 'oneOf', 'allOf'];
/**
 * 把 DSH 的 JSON Schema 规范化为灵犀云端能接受的形状。
 *
 * 递归处理 `properties` / `items` / 组合子分支，规则：
 * 1. 遇到 `anyOf`/`oneOf`/`allOf` 时，**折叠成第一个分支**（同层其它字段，
 *    如 `description`，优先级更高）；分支为空则退化为 `{type:'string'}`。
 * 2. 任何节点缺 `type`（或 `type` 不是字符串，如联合类型数组）时补 `string`。
 *
 * 折叠而不是删除的原因：删掉组合子会丢掉分支里的 `properties`/`items`，
 * 让模型看不到参数结构（实测直接删会触发 `InvalidArgument`）；折叠既满足
 * 云端的「必须有 type」要求，又保留了第一个分支的完整结构。
 */
function normalizeSchema(node) {
    if (Array.isArray(node))
        return node.map(normalizeSchema);
    if (!node || typeof node !== 'object')
        return node;
    let out = { ...node };
    const combinator = COMBINATOR_KEYS.find((key) => Array.isArray(out[key]));
    if (combinator) {
        const branches = out[combinator];
        delete out[combinator];
        const first = branches.length > 0 ? normalizeSchema(branches[0]) : { type: 'string' };
        // 同层字段（description 等）覆盖分支里的同名字段。
        out = { ...first, ...out };
    }
    if (typeof out.type !== 'string')
        out.type = 'string';
    if (out.properties && typeof out.properties === 'object') {
        out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, value]) => [key, normalizeSchema(value)]));
    }
    if (out.items !== undefined)
        out.items = normalizeSchema(out.items);
    return out;
}
//# sourceMappingURL=lingxi-messages.js.map