export interface WslEnvironment {
    /** powershell.exe 的 WSL 路径。 */
    readonly powershell: string;
    /**
     * 是否必须经 `/init` 转发才能执行 Windows 程序（interop 注册缺失时为 true）。
     *
     * 省略/false 表示内核 binfmt 正常工作，可直接 execFile 一个 `.exe`。
     */
    readonly useInit?: boolean;
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
export declare function detectWsl(): WslEnvironment | undefined;
export interface PowerShellResult {
    readonly stdout: string;
    readonly stderr: string;
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
export declare function runPowerShell(env: WslEnvironment, script: string, timeoutMs?: number): Promise<PowerShellResult>;
/**
 * 从 PowerShell 的 `KEY=VALUE` 输出里取第一个值（trim 后）。
 * 找不到返回 undefined。
 */
export declare function psValue(stdout: string, key: string): string | undefined;
/**
 * 把 WSL 路径转成 Windows 可访问路径（供 lingxi.exe 会话工作区使用）。
 *
 * 优先调用系统自带的 `wslpath -w`（自动处理当前发行版名与盘符映射）：
 * - /mnt/c/x        → C:\x
 * - /home/zic/...   → \\wsl.localhost\<distro>\home\zic\...（UNC，Windows 可直接访问）
 *
 * 失败时回退到手写规则。返回 undefined 表示无法转换（非 WSL 路径等）。
 */
export declare function wslPathToWindows(wslPath: string): string | undefined;
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
export declare function resolveLingxiWorkspaceOverride(): string | undefined;
