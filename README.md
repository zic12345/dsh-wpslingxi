# dsh-wpslingxi

在 **WSL** 中运行的 DSH 里使用 **Windows 宿主上「WPS 灵犀」桌面版**的能力：

1. **灵犀模型路由**：把灵犀桌面版内置的 13 个模型（Max/Pro、DeepSeek、GLM、Kimi、Qwen、MiniMax、豆包等）注册为 DSH 的 `lingxi` provider，可直接用于对话/编码；
2. **插件设置页（收纳进内置「插件」Tab）**：客户端不占左侧独立图标，而是在 DSH
   自带的 **设置 → 插件** 页里注册一个名为「WPS 灵犀」的 Tab（槽位
   `settings.plugins.tab`），提供一键**每日签到领智点**、当前**智点余额**与连签日历；
   面板经 `connection.fetch` 的 `/api/wpslingxi` RPC 调宿主侧签到/余额接口。

> 只在 WSL 下可用（要读取 Windows 宿主的灵犀安装与登录态）。非 WSL 环境插件会加载但模型不注册，面板会提示环境原因。

---

## 它是怎么工作的

灵犀桌面版**没有**公开的 OpenAI 兼容 API，也没有 API Key：模型能力只由本地的
`lingxi.exe` 通过 stdio JSON-RPC 暴露，鉴权用的是登录后保存在 Windows 里的 `wps_sid`
cookie（DPAPI + AES-256-GCM 加密）。因此本插件做了三件事：

```
 DSH (WSL Node)
   │  ① 读取登录态：PowerShell 复制 passport 分区 Cookies，
   │     DPAPI 解密 Chromium AES key，再 AES-GCM 解出 wps_sid
   ▼
 Windows 自带 portable node.exe          ← 两层 interop 桥（WSL 直接管 lingxi.exe 会网络异常）
   │  boot.cjs：注入 LINGXI_WPS_SID，spawn lingxi.exe -stdin，透传 stdio
   ▼
 lingxi.exe  ── HTTPS ──▶  lingxi.wps.cn   （模型 / 智点 / 签到）
```

- **模型**：每次 `stream()` = 新建一个灵犀 `cowork_client` 会话 + 一次 `run/start`，
  把 DSH 的多轮消息渲染成单个 prompt（无状态多轮），实时收集
  `component.content`（正文 `c_text` / 思考 `c_reasoning`）逐字回传。
- **签到 / 余额**：浏览器面板 → `connection.fetch` 的 `/api/wpslingxi` RPC →
  宿主侧直接用 `wps_sid` cookie 调灵犀云端 HTTP 接口。

## 能力边界（请先读）

- **仅文本输入**：图片不会投递给灵犀（面板/模型都按文本接入）。
- **无原生 function-calling / 工具调用**：灵犀内置模型走 agent runtime，
  不是 OpenAI Chat Completions，所以 DSH 的工具不会下发给模型；适合当**对话/推理/写作模型**。
- **不下发 token 用量**：灵犀 run 结束不返回 token 计数，`stream()` 不伪造 usage。
- **强依赖 Windows 宿主**：需已安装并登录「WPS 灵犀」桌面版，且 WSL 能访问 `https://lingxi.wps.cn`。
- **工作区跟随每个 DSH 会话**：适配器拿 LLM 请求里的 `sessionId`，经宿主
  `ctx.sessionQuery.observeSession(sessionId).header.cwd` 反查该会话的项目目录
  （插件 `inject` 声明了 `sessionQuery`），再用 `wslpath -w` 转成 Windows 路径
  （`/mnt/c/...` → `C:\...`；ext4 → `\\wsl.localhost\<发行版>\...` UNC，已真机验证
  可读写）交给灵犀 agent。因此在 `/home/zic/test/lingxi` 开会话，灵犀的文件/命令
  就落在那个目录，与 dsh web 进程自身的启动 cwd 无关。每个 sessionId 只反查/转换一次。
  - 桥自身的 boot/data/空 skills 骨架仍放在 Windows `%TEMP%`（仅进程引导文件，不是工作区）。
  - 可用环境变量 **`DSH_LINGXI_WORKSPACE`**（WSL 路径）强制覆盖所有会话的工作目录；
    未设置且反查不到 cwd 时回退桥的临时工作区。
- 模型与签到是两条独立旁路，一条出问题不影响另一条。

---

## 目录结构

```
src/
  index.ts                插件入口：注册模型 provider + 签到/余额 RPC
  lingxi-adapter.ts       DSH LlmAdapter（模型目录、stream、登录态失效重试）
  lingxi-bridge.ts        WSL 侧两层桥客户端（stdio JSON-RPC 多路复用）
  lingxi-assets/boot.cjs  Windows 侧引导脚本（spawn lingxi.exe，随包分发的静态资源）
  lingxi-cloud.ts         灵犀云端 HTTP：智点余额 / 每日签到状态 / 领奖
  lingxi-credential.ts    从 Windows 登录态提取 wps_sid（cookie + DPAPI + AES-GCM）
  lingxi-win32.ts         WSL 探测 / PowerShell 调用（含 UTF-8 编码处理）
  lingxi-rpc.ts           /api/wpslingxi 宿主 RPC（供 Web 面板调用）
  lingxi-messages.ts      DSH 消息 → 灵犀单 prompt 渲染
  lingxi.ts               13 个内置模型静态目录（云端拉取失败时的兜底）
  lingxi-product.ts / llm-register-compat.ts / message-shape.ts
plugin-src/client/        浏览器侧：注册到「设置 → 插件」页的「WPS 灵犀」Tab（React）
  index.js  panel.jsx  rpc.js  build.mjs
scripts/copy-assets.mjs   把 boot.cjs 拷进 lib/
cordis.patch.yml          作为 profile bundle 装载时向配置树插入插件行
```

## 从源码构建

本机 devDependencies 用的是软链到母插件（`deepseek-harness-codearts`）的工具链。
独立构建需要 Node ≥ 22.19，以及 `typescript`、`esbuild`、`@types/node`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`（这些在 DSH 运行时由宿主提供）。

```bash
cd dsh-wpslingxi
pnpm install        # 若 esbuild 构建脚本被忽略：pnpm approve-builds
pnpm build:all      # = tsc + copy-assets(boot.cjs) + esbuild(client/panel.js)
```

## 安装到 DSH（web profile）

```bash
dsh plugin --profile web add "file:$PWD"
```

随后把它登记为 profile bundle（让配置树加载本插件）。在
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组里加入
`"dsh-wpslingxi"`，再执行一次：

```bash
dsh plugin --profile web install
```

校验已被配置树加载：

```bash
dsh --profile web --dump-config | grep -A1 dsh-wpslingxi
# 应看到： - id: wpslingxi / name: dsh-wpslingxi
```

**重启 DSH web 后**，打开左下角 **设置 → 插件**，在插件页的 Tab 栏选择
**「WPS 灵犀」**（与内置「全部插件」清单并列）即可看到智点余额与一键签到。

> 安装时 `file:` 后必须是**绝对路径**（或 `$PWD`），否则 pnpm 会相对 profile
> 目录解析成 `~/.dsh/profiles/web/data/codearts/...` 而报
> `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`：
>
> ```bash
> dsh plugin --profile web add "file:$PWD"          # 正确
> dsh plugin --profile web add file:data/codearts/dsh-wpslingxi   # 错误（相对 cwd）
> ```

卸载：

```bash
dsh plugin --profile web remove dsh-wpslingxi
# 再从 package.json 的 dsh.profile.bundles 中删掉 "dsh-wpslingxi"
```

## 使用前提 / 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板提示「登录态失效」 | 在 Windows 打开「WPS 灵犀」桌面版重新登录，再点面板「重试」（SID 实时提取，无需重启 DSH） |
| 模型列表为空 / 无 `lingxi` provider | 不在 WSL、没装桌面版、或没登录；查看 DSH 日志里 `[lingxi]` 警告 |
| 面板/模型报网络异常 | 确认 WSL 能访问 `https://lingxi.wps.cn`（默认无需宿主代理） |
| 找不到 `lingxi.exe` | 插件在 `%APPDATA%\WPS 灵犀\app_server_link\service` 与安装目录下探测；用的是桌面版自带 portable node |
| PowerShell 输出中文乱码导致路径损坏 | 已在生成的脚本里强制 `[Console]::OutputEncoding=UTF8`（PS 5.1 默认 GBK） |

## 隐私 / 安全说明

- 提取 SID 时会把 Cookies 副本与 AES key 临时写到 **Windows `%TEMP%`**，读取后立即用
  PowerShell 删除；SID 只保存在插件进程内存，不落盘。
- 本插件不收集任何数据，所有请求只发往 `lingxi.wps.cn`。
