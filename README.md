# dsh-wpslingxi

在 **WSL** 中运行的 DSH 里使用 **WPS 灵犀**的能力：

1. **灵犀模型路由**：把灵犀的 13 个模型（Max/Pro、DeepSeek、GLM、Kimi、Qwen、MiniMax、豆包等）注册为 DSH 的 `lingxi` provider。**v2.0 直连灵犀云端 LLM**，原生支持工具调用 —— 模型可以调用 DSH 的全部工具（宿主 PowerShell、WSL bash、文件读写、子代理……），agent 循环跑在 DSH 里；
2. **插件设置页（收纳进内置「插件」Tab）**：客户端不占左侧独立图标，而是在 DSH
   自带的 **设置 → 插件** 页里注册一个名为「WPS 灵犀」的 Tab（槽位
   `settings.plugins.tab`），提供一键**每日签到领智点**、当前**智点余额与到期明细**、最近积分流水；
   面板经 `connection.fetch` 的 `/api/wpslingxi` RPC 调宿主侧接口。

> 只在 WSL 下可用（要读取 Windows 宿主的灵犀登录态）。非 WSL 环境插件会加载但模型不注册，面板会提示环境原因。

---

## 它是怎么工作的（v2.0）

灵犀桌面版**没有** API Key，鉴权用的是登录后保存在 Windows 里的 `wps_sid` cookie
（DPAPI + AES-256-GCM 加密）。2026-10-28 抓包确认：桌面 `lingxi.exe` 本身也只是个
HTTP 客户端，agent 循环全在本地，云端只提供**一个纯 LLM 接口**
`POST /api/public/v1/agent-runtime/chat/completions`（OpenAI 风格，支持
`tools` / `tool_calls`）。

因此 v2.0 **直接调这个接口**，把 agent 循环交回 DSH：

```
 DSH (WSL Node)
   │  ① 读取登录态：PowerShell 复制 passport 分区 Cookies，
   │     DPAPI 解密 Chromium AES key，再 AES-GCM 解出 wps_sid
   ▼
 直连 HTTPS ──▶ lingxi.wps.cn
   ├─ POST /api/aioffice/v1/cowork/sessions              → session_id
   ├─ POST /api/public/v1/credits/runs                   → run_id（计费单位）
   └─ POST /api/public/v1/agent-runtime/chat/completions → SSE 流式（含 tool_calls）
```

- **工具调用**：`options.tools` 原样下发，模型返回的 `tool_calls` 转成 DSH 的
  `tool-call` 块由 DSH 执行，结果用 `role:'tool'` 回传。宿主 PowerShell、WSL
  bash、DSH 全部内置工具立即可用。
- **系统提示词**：走灵犀的 `context` 字段（实测可整体覆盖其内置提示词），
  上下文压缩、重试、权限审批全部由 DSH 负责。
- **签到 / 余额**：浏览器面板 → `connection.fetch` 的 `/api/wpslingxi` RPC →
  宿主侧直接用 `wps_sid` cookie 调灵犀云端 HTTP 接口。

### 为什么不再经 lingxi.exe（v1.x 路线）

v1.x 经两层 stdio 桥调用桌面 `lingxi.exe`，模型跑在**灵犀自己的 agent 循环**里：
工具是灵犀沙箱内的 bash/file/web，DSH 的工具链完全用不上，宿主 PowerShell 还被
灵犀的双层黑名单（`sitecustomize.py` 的 Python 审计层 + `blacklist.go` 的 Go
词法层）拦住。绕开它要么改灵犀安装文件、要么把 exe 改名，都脆弱且随版本失效。
直连云端是**纯插件侧**的干净方案。

## 能力边界（请先读）

- **仅文本输入**：图片不会投递给灵犀（`inputModalities: ['text']`）。
- **计费按 run**：一个 DSH 会话建一个云端 run，**只扣 1 智点**，无论该会话里
  调多少次模型（实测同 run 内 10 次调用、跨 5 分钟、含并发仍只扣 1 点）。
  新建会话 = 新 run = 再扣 1 点。
- **强依赖 Windows 宿主**：需**曾经**在 Windows 上登录过「WPS 灵犀」桌面版
  （不必正在运行，只要 cookie 还在），且 WSL 能访问 `https://lingxi.wps.cn`。
- **工作区声明**：适配器拿 LLM 请求里的 `sessionId`，经宿主
  `ctx.sessionQuery.observeSession(sessionId).header.cwd` 反查该会话的项目目录，
  转成 Windows 路径作为云端会话的 `work_space_dir` 声明。
  ⚠️ v2.0 里它**不决定工具执行目录**——工具跑在 DSH 侧，天然跟随会话 cwd。
  可用环境变量 **`DSH_LINGXI_WORKSPACE`**（WSL 路径）强制覆盖。
- 模型与签到是两条独立旁路，一条出问题不影响另一条。

---

## 目录结构

```
src/
  index.ts                插件入口：注册模型 provider + 签到/余额 RPC
  lingxi-adapter.ts       DSH LlmAdapter（模型目录、stream、StreamChunk 翻译）
  lingxi-direct.ts        灵犀云端直连客户端（建会话/run、SSE 解析、run 复用与重试）
  lingxi-cloud.ts         灵犀云端 HTTP：智点余额 / 明细 / 流水 / 每日签到
  lingxi-credential.ts    从 Windows 登录态提取 wps_sid（cookie + DPAPI + AES-GCM）
  lingxi-win32.ts         WSL 探测 / PowerShell 调用（含 UTF-8 编码处理）
  lingxi-rpc.ts           /api/wpslingxi 宿主 RPC（供 Web 面板调用）
  lingxi-messages.ts      DSH 消息 → OpenAI 形状消息 + 工具定义转换
  lingxi.ts               13 个内置模型静态目录（唯一清单）
  lingxi-product.ts / llm-register-compat.ts
plugin-src/client/        浏览器侧：注册到「设置 → 插件」页的「WPS 灵犀」Tab（React）
  index.js  panel.jsx  rpc.js  build.mjs
cordis.patch.yml          作为 profile bundle 装载时向配置树插入插件行
```

## 从源码构建

独立构建需要 Node ≥ 22.19，以及 `typescript`、`esbuild`、`@types/node`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`（这些在 DSH 运行时由宿主提供）。

```bash
cd dsh-wpslingxi
pnpm install                       # 构建脚本授权见下方 pnpm-workspace.yaml 说明
rm -rf lib && pnpm run build:all   # = tsc + esbuild(client/panel.js)
```

> 仓库根的 `pnpm-workspace.yaml` 只为声明 `allowBuilds: { esbuild: true }`：
> pnpm 12 把该授权从 `package.json` 移到了这个文件，不声明就每次 install 报
> `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild@0.24.2`。它不含
> `packages:` 字段，因此不会把本仓库变成 monorepo。
>
> 习惯上仍建议写 `pnpm run build:all`：若把该文件删掉，`pnpm build:all` 会被
> 当成递归 exec 而报 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`。

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
| 模型列表为空 / 无 `lingxi` provider | 不在 WSL、或从未登录过桌面版；查看 DSH 日志里 `[lingxi]` 警告 |
| 模型报网络异常 | 确认 WSL 能访问 `https://lingxi.wps.cn`（默认无需宿主代理） |
| 对话报「数据不存在 / SQLNoRows」 | 云端 run 过期，客户端会自动重建并重试一次 |
| 对话立刻报「AI服务异常」（`code: UNKNOWN`，无细节） | 两个已修根因：①工具参数 schema 里有云端不接受的结构（缺 `type` 的组合子/节点、联合类型数组），v2.0.1 已在 `toDirectTools` 里自动清洗，若仍出现请查 DSH 版本新增的工具；②**同一 run 内并发请求**（DSH 会话开头会并发发起标题生成与正文），v2.0.2 已用 `withRunLock` 按会话串行化 |
| 会话第一条消息必失败、重发一次又正常 | 同上第 ② 条：v2.0.2 之前在同一 run 上并发两个 `chat/completions` 会踩云端状态，升级到 v2.0.2 即可 |
| 回复为空但用了智点 | `max_tokens` 太小，预算被思考内容吃光；DSH 侧调大 maxTokens |
| PowerShell 输出中文乱码导致路径损坏 | 已在生成的脚本里强制 `[Console]::OutputEncoding=UTF8`（PS 5.1 默认 GBK） |

## 隐私 / 安全说明

- 提取 SID 时会把 Cookies 副本与 AES key 临时写到 **Windows `%TEMP%`**，读取后立即用
  PowerShell 删除；SID 只保存在插件进程内存，不落盘。
- 本插件不收集任何数据，所有请求只发往 `lingxi.wps.cn`。
