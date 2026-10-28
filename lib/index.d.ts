/**
 * dsh-wpslingxi —— 把 WPS 灵犀接入 DSH（独立插件）。
 *
 * 两块能力：
 * 1. **模型路由**：成功探测到 WSL + 桌面登录态（wps_sid）时注册 `lingxi`
 *    provider。v2.0 **直连灵犀云端 LLM**（`agent-runtime/chat/completions`，
 *    OpenAI 风格、原生工具调用），agent 循环跑在 DSH 里 —— 宿主 PowerShell、
 *    WSL bash、DSH 全部内置工具都能用（见 lingxi-adapter.ts）；
 * 2. **签到/余额**：注册 connection.fetch RPC（/api/wpslingxi），供 Web 客户端
 *    左侧「WPS 灵犀」面板一键签到、看智点余额与明细（见 lingxi-rpc.ts）。
 *
 * 任一能力初始化失败都只记日志，不让整个插件 apply 失败：
 * - 非 WSL / 没登录过桌面版 ⇒ 不注册模型，但插件仍加载（面板会提示原因）；
 * - 模型与签到是独立旁路，互不影响。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-wpslingxi";
/**
 * llm：注册模型路由必需。
 * connection：Web profile 下由 dsh-client-connection 提供；缺席时 RPC 注册会
 * 自行降级（registerLingxiRpc 内部判空），不影响模型侧。
 * sessionQuery：按会话 id 反查该会话的项目工作目录（header.cwd），
 * 用于在云端会话上声明工作区（不影响工具执行目录 —— v2.0 工具跑在 DSH 侧）。
 */
export declare const inject: string[];
export declare function apply(ctx: Context): void;
