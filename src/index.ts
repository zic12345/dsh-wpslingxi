/**
 * dsh-wpslingxi —— 把 Windows 宿主的 WPS 灵犀桌面版接入 DSH（独立插件）。
 *
 * 两块能力：
 * 1. **模型路由**：成功探测到 WSL + 桌面 App + 登录态时，注册 `lingxi` provider
 *    （见 lingxi-adapter.ts 的 registerLingxiLlm）。模型经两层 interop 桥调用
 *    桌面自带的 lingxi.exe；
 * 2. **签到/余额**：注册 connection.fetch RPC（/api/wpslingxi），供 Web 客户端
 *    左侧「WPS 灵犀」面板一键签到、看智点余额（见 lingxi-rpc.ts）。
 *
 * 任一能力初始化失败都只记日志，不让整个插件 apply 失败：
 * - 非 WSL / 没装桌面版 / 没登录 ⇒ 不注册模型，但插件仍加载（面板会提示原因）；
 * - 模型与签到是独立旁路，互不影响。
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerLingxiLlm } from './lingxi-adapter.js'
import { registerLingxiRpc } from './lingxi-rpc.js'
import { detectWsl } from './lingxi-win32.js'

export const name = 'dsh-wpslingxi'

/**
 * llm：注册模型路由必需。
 * connection：Web profile 下由 dsh-client-connection 提供；缺席时 RPC 注册会
 * 自行降级（registerLingxiRpc 内部判空），不影响模型侧。
 * sessionQuery：按会话 id 反查该会话的项目工作目录（header.cwd），
 * 让灵犀 agent 的工作目录跟随当前 DSH 会话而不是进程 cwd。
 */
export const inject = ['llm', 'connection', 'sessionQuery']

export function apply(ctx: Context): void {
  const env = detectWsl()

  // ① 模型 provider（异步、失败只 warn；见 registerLingxiLlm 内的三道探测）。
  void registerLingxiLlm(ctx).catch((error: unknown) => {
    ctx.logger?.warn?.(`[lingxi] provider 注册异常：${(error as Error).message}`)
  })

  // ② 签到 / 余额 RPC（非 WSL 也注册端点，方法内部会返回明确的环境错误）。
  try {
    registerLingxiRpc(ctx, env ?? undefined)
  } catch (error) {
    ctx.logger?.warn?.(`[lingxi] 管理 RPC 注册异常：${(error as Error).message}`)
  }

  ctx.logger?.info?.('[lingxi] dsh-wpslingxi 插件已加载')
}
