/**
 * WPS 灵犀桌面版（lingxi-desktop）渠道的产品描述。
 *
 * 与本插件其它 15 个 provider 的根本差异：
 *
 * - **没有云端 OpenAI 兼容端点**：灵犀模型只经桌面 App 自带的
 *   `lingxi.exe`（app-server，Go 程序）对外服务，它走 **stdio JSON-RPC**
 *   （2026-10-12 实测：云端 `https://lingxi.wps.cn/api/public/v1/agent-runtime/
 *   chat/completions` 存活但要求私有 agent schema，OpenAI 形态 body 直接
 *   `InvalidArgument 参数错误`；`/api/v1`、`/api/v3/chat/completions`、
 *   `/api/v2/llm/chat` 全 404）。
 * - **没有 OAuth / API key**：鉴权靠桌面 App 登录后落在 Electron
 *   passport 分区 Cookies 里的 `wps_sid`（DPAPI + AES-256-GCM 保护）。
 * - 因此本 provider **不进账号池、不进 Jet Hub 面板、不登记 credits**，
 *   只在 `ctx.llm` 上注册一条路由；模型选择器里可见即可用。
 *
 * 调用链（WSL dsh → Windows 宿主灵犀）：
 *
 * ```
 * WSL Node (适配器)
 *   └─ spawn Windows 自带 node.exe（AppData 内 portable-node）
 *        └─ 运行随插件分发的 boot.js（Windows 侧）
 *             └─ spawn lingxi.exe -stdin -auth-storage runtime
 *                  env: LINGXI_WPS_SID=<从宿主登录态提取>
 * ```
 *
 * ⚠️ **不能由 WSL Node 直接 spawn `/mnt/c/.../lingxi.exe`**：实测
 * interop 直接托管 Windows exe 时 `initialize` 能成功，但 `model/list`
 * 恒报「网络异常，请检查网络后重试」（interop 网络栈问题）；中间隔一层
 * Windows node.exe 后一切正常。
 */
export interface LingxiProduct {
    /** provider 路由名（同时是模型 id 前缀的 provider 段）。纯小写。 */
    readonly id: 'lingxi';
    /** 展示名（模型选择器 / providerInfo.name）。 */
    readonly displayName: string;
}
export declare const LINGXI: LingxiProduct;
