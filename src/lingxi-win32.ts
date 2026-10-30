/**
 * WSL ↔ Windows 宿主互操作：环境探测、路径定位、PowerShell 调用。
 *
 * 仅在 **WSL Linux** 上有意义（灵犀是 Windows 桌面 App）。纯 Linux / macOS
 * 上 `detectWsl()` 返回 `undefined`，适配器据此不注册任何模型。
 *
 * 路径全部**动态发现**，不硬编码用户名 / 中文目录名（实测中文目录
 * `WPS 灵犀` 在 PowerShell 里直写有时找不到文件，`Get-ChildItem -Filter WPS*`
 * 最稳）。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Windows PowerShell 可执行文件的候选路径（PATH 里不一定有 powershell.exe）。 */
const POWERSHELL_CANDIDATES = [
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
]

export interface WslEnvironment {
  /** powershell.exe 的 WSL 路径。 */
  readonly powershell: string
  /**
   * 是否必须经 `/init` 转发才能执行 Windows 程序（interop 注册缺失时为 true）。
   *
   * 省略/false 表示内核 binfmt 正常工作，可直接 execFile 一个 `.exe`。
   */
  readonly useInit?: boolean
}

/**
 * WSL interop 是否由 binfmt_misc 注册。
 *
 * 正常时 `/proc/sys/fs/binfmt_misc/WSLInterop` 存在，Linux 内核直接把 `.exe`
 * 交给 Windows 执行。该条目**可能丢失**（实测 2026-10-30：条目消失后任何
 * Windows exe 都报 `cannot execute binary file: Exec format error`，而
 * `/init` 依旧可执行）。此时必须改用 `/init <win-exe> <args...>` 启动。
 */
function hasInteropRegistration(): boolean {
  for (const name of ['WSLInterop', 'WSLInterop-late']) {
    if (existsSync(`/proc/sys/fs/binfmt_misc/${name}`)) return true
  }
  return false
}

/** `/init` 是否存在（WSL 的 init 二进制，interop 失效时唯一可用入口）。 */
function hasWslInit(): boolean {
  return existsSync('/init')
}

/**
 * 探测 WSL 环境：必须同时满足
 * 1. 内核是 WSL（`/proc/sys/kernel/osrelease` 含 microsoft / wsl）；
 * 2. `/mnt/c` 下的 Windows PowerShell 可执行。
 *
 * 两项都过才返回，避免在普通 Linux 上白跑一堆跨系统调用。
 *
 * 同时探测 interop 是否可用：binfmt 注册缺失但 `/init` 还在时，返回
 * `useInit: true`，调用方改走 `/init` 转发（见 {@link runPowerShell}）。
 */
export function detectWsl(): WslEnvironment | undefined {
  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase()
    if (!/microsoft|wsl/.test(release)) return undefined
  } catch {
    return undefined
  }
  const powershell = POWERSHELL_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!powershell) return undefined
  // binfmt 注册在、或 /init 在，都还有救；两者都没有才是真的用不了。
  const useInit = !hasInteropRegistration() && hasWslInit()
  if (!hasInteropRegistration() && !useInit) return undefined
  return useInit ? { powershell, useInit: true } : { powershell }
}

export interface PowerShellResult {
  readonly stdout: string
  readonly stderr: string
}

/**
 * 执行一段 PowerShell 脚本。
 *
 * ⚠️ **不用 stdin（`-Command -`）**：2026-10-12 实测，脚本含中文且经
 * WSL interop 的 stdin 管道传入时，powershell.exe 会**挂住直到超时**
 * （空 stdout/stderr、SIGTERM 退出）；同样脚本经 `-File` 执行则立即成功。
 * 故统一把脚本写成 Windows 侧临时 `.ps1` 文件再执行。
 *
 * - 临时目录固定在 Windows 盘（`C:\Windows\Temp` 的 WSL 挂载点），
 *   Windows 进程必然可读；不用 WSL `/tmp`（那是 drvfs 之外的 Linux 路径）。
 * - 文件写 **UTF-8 BOM**：Windows PowerShell 5.1 对无 BOM 的 `.ps1`
 *   按系统 ANSI 代码页解释，中文字符串会乱码。
 * - 用 `-NoProfile` 避开用户 profile 的输出污染；cwd 钉到
 *   `/mnt/c/Windows/System32`（实测工作目录是 UNC 路径 `\\wsl$\...`
 *   时会有告警但不影响执行）。
 *
 * ⚠️ **interop 可能整体失效**：2026-10-30 实测本机
 * `/proc/sys/fs/binfmt_misc/` 下的 `WSLInterop` 条目消失（只剩
 * `register`/`status`），此后直接 execFile 任何 `.exe` 都报
 * `cannot execute binary file: Exec format error`，而 `/init` 仍可执行。
 * 故当 {@link WslEnvironment.useInit} 为真时改走
 * `/init <powershell.exe> <args...>`——实测 UTF-8、中文、`-File`、cwd
 * 与直连完全等价。恢复 binfmt 注册需要 root，插件不自动修。
 */
export async function runPowerShell(
  env: WslEnvironment,
  script: string,
  timeoutMs = 30_000,
): Promise<PowerShellResult> {
  const wslPath = `/mnt/c/Windows/Temp/dsh-lx-${randomUUID()}.ps1`
  const winPath = `C:\\Windows\\Temp\\${wslPath.split('/').pop()}`
  // ⚠️ **输出编码必须显式钉成 UTF-8**：Windows PowerShell 5.1 默认用系统 ANSI
  // 代码页（中文系统是 GBK）写 stdout，而 Node 侧 execFile 固定按 UTF-8 解码。
  // 含中文的路径（如 `WPS 灵犀`）会因此变成 U+FFFD 替换符，spawn 拼出的
  // /mnt/c/... 路径永久损坏并 ENOENT。脚本最前强制 Console/OutputEncoding 为
  // UTF-8（OutputEncoding 决定管道写出字节，InputEncoding 一并对齐）。
  // EF BB BF = UTF-8 BOM（Windows PowerShell 5.1 需要它才能正确识别 UTF-8 脚本）。
  const encodingPrelude = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
`
  writeFileSync(wslPath, `﻿${encodingPrelude}${script}`, 'utf8')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winPath]
  // interop 注册缺失时改经 `/init` 转发：参数形态是 `/init <exe> <args...>`。
  const file = env.useInit ? '/init' : env.powershell
  const argv = env.useInit ? [env.powershell, ...args] : args
  try {
    return await execFileAsync(file, argv, {
      cwd: '/mnt/c/Windows/System32',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
  } finally {
    rmSync(wslPath, { force: true })
  }
}

/**
 * 从 PowerShell 的 `KEY=VALUE` 输出里取第一个值（trim 后）。
 * 找不到返回 undefined。
 */
export function psValue(stdout: string, key: string): string | undefined {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`))
  if (!line) return undefined
  const value = line.slice(key.length + 1).trim()
  return value.length > 0 ? value : undefined
}

/**
 * 把 WSL 路径转成 Windows 可访问路径（供 lingxi.exe 会话工作区使用）。
 *
 * 优先调用系统自带的 `wslpath -w`（自动处理当前发行版名与盘符映射）：
 * - /mnt/c/x        → C:\x
 * - /home/zic/...   → \\wsl.localhost\<distro>\home\zic\...（UNC，Windows 可直接访问）
 *
 * 失败时回退到手写规则。返回 undefined 表示无法转换（非 WSL 路径等）。
 */
export function wslPathToWindows(wslPath: string): string | undefined {
  try {
    const out = execFileSync('/usr/bin/wslpath', ['-w', wslPath], { encoding: 'utf8' }).trim()
    if (out) return out
  } catch {
    // 落到手写转换。
  }
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(wslPath)
  if (m) {
    const drive = m[1].toUpperCase()
    const rest = (m[2] ?? '').replace(/\//g, '\\')
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`
  }
  // ext4 上的路径无盘符，只能给 UNC——但发行版名这里拿不到，故放弃
  // （wslpath 正常时不会走到）。
  return undefined
}

/**
 * 解析显式覆盖的灵犀工作目录（WSL 路径）。
 *
 * 只认环境变量 DSH_LINGXI_WORKSPACE；**不再**回退 process.cwd()——
 * 进程 cwd 是 dsh web 服务的启动目录（固定），不等于某个会话的工作区，
 * 会话工作区应由适配器用 sessionId 经 sessionQuery 查询 header.cwd 得到。
 *
 * 返回的是 WSL 路径，调用方再用 {@link wslPathToWindows} 转成 Windows 路径。
 * 未设置/空白时返回 undefined。
 */
export function resolveLingxiWorkspaceOverride(): string | undefined {
  const explicit = process.env.DSH_LINGXI_WORKSPACE?.trim()
  return explicit && explicit.length > 0 ? explicit : undefined
}
