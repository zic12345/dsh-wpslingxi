/**
 * WPS 灵犀 provider 的产品描述。
 *
 * ## v2.0：直连云端，agent 循环交回 DSH
 *
 * v1.x 经桌面 `lingxi.exe`（app-server）跑**灵犀自己的 agent 循环**，工具是
 * 灵犀沙箱里的 bash/file/web，DSH 的工具链完全用不上，宿主 PowerShell 还被
 * 灵犀的双层黑名单（Python 审计层 + Go 词法层）拦住。
 *
 * 2026-10-28 抓包 + 直连验证确认：`lingxi.exe` 本身也只是个 HTTP 客户端，
 * agent 循环全在本地，云端只提供一个纯 LLM 接口
 * `POST /api/public/v1/agent-runtime/chat/completions`（OpenAI 风格，支持
 * `tools` / `tool_calls`）。v2.0 因此**直接调这个接口**，把 agent 循环交回 DSH。
 *
 * ## 特征
 *
 * - **鉴权**：`Cookie: wps_sid=<sid>`（云端只认 Cookie，不认 Bearer）。SID 由
 *   `extractWpsSid` 从桌面 App 的 Electron passport cookie 自动提取
 *   （DPAPI + AES-256-GCM），也允许 `DSH_LINGXI_WPS_SID` 覆盖。
 *   **桌面版只需曾经登录过**，不必正在运行。
 * - **计费**：按 run 计。一个 DSH 会话建一个云端 run，**只扣 1 智点**，
 *   无论该会话里调多少次模型（真机实测：同 run 内 10 次调用仍只扣 1 点）。
 *   见 `src/lingxi-direct.ts`。
 * - **工具调用**：原生支持。DSH 的工具定义原样下发，模型返回的 `tool_calls`
 *   由 DSH 执行——宿主 PowerShell、WSL bash、DSH 全部内置工具都可用。
 * - **不进** provider-registry / Jet Hub 账号池（无 API Key、无 baseURL 设置项），
 *   只在 `ctx.llm` 上注册一条路由；模型选择器里可见即可用。
 */
export interface LingxiProduct {
  /** provider 路由名（同时是模型 id 前缀的 provider 段）。纯小写。 */
  readonly id: 'lingxi'
  /** 展示名（模型选择器 / providerInfo.name）。 */
  readonly displayName: string
}

export const LINGXI: LingxiProduct = {
  id: 'lingxi',
  displayName: 'WPS 灵犀',
}
