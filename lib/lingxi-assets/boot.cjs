/*!
 * WPS 灵犀桥 —— Windows 侧引导脚本（CommonJS，由灵犀自带的 portable node.exe 执行）。
 *
 * 本文件是**随插件分发的静态资源**（不经过 tsc），由 WSL 侧 LingxiBridge 经
 * interop 以 `node.exe boot.cjs <APPROOT> <SID> <DATA>` 方式启动。
 *
 * 职责（尽量薄，逻辑都在 WSL 侧 TS）：
 * 1. 在 DATA 下准备 lingxi.exe session/start 需要的目录骨架
 *    （workspace + 三个 skills 目录；空 skills 实测可用）；
 * 2. spawn `app_server_link\service\lingxi.exe -stdin -auth-storage runtime`，
 *    经环境变量 LINGXI_WPS_SID 注入登录态（二进制内建：设了它即 auth from env，
 *    免登录）；
 * 3. stdin/stdout 原样透传（JSON-RPC over newline-delimited JSON），
 *    stderr 加前缀转出便于排障。
 *
 * ⚠️ 三个参数必须走 **argv** 而不是环境变量：实测在 WSL interop 链
 * （WSL Node → windows node.exe → lingxi.exe）中，自定义 env 在本引导层读到的
 * 是 undefined；argv 传递稳定。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const APPROOT = process.argv[2]
const SID = process.argv[3]
const DATA = process.argv[4]
if (!APPROOT || !SID || !DATA) {
  process.stderr.write('[boot] usage: node boot.cjs <APPROOT> <SID> <DATA>\n')
  process.exit(2)
}

// 目录骨架（与 WSL 侧 session/start 的 *_skills_dir / workspace_dir 对应）。
fs.mkdirSync(path.join(DATA, 'workspace'), { recursive: true })
for (const dir of ['sk/o', 'sk/u', 'sk/t']) {
  fs.mkdirSync(path.join(DATA, dir), { recursive: true })
}

const exe = path.join(APPROOT, 'app_server_link', 'service', 'lingxi.exe')
if (!fs.existsSync(exe)) {
  process.stderr.write(`[boot] lingxi.exe 不存在: ${exe}\n`)
  process.exit(3)
}

const child = spawn(
  exe,
  ['-stdin', '-auth-storage', 'runtime', '-data-dir', DATA, '-client-type', 'lingxi_claw'],
  {
    env: { ...process.env, LINGXI_WPS_SID: SID },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  },
)

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.on('data', (chunk) => process.stderr.write(`[lingxi] ${chunk}`))

const shutdown = (code) => {
  try { child.kill() } catch { /* 已退出 */ }
  process.exit(code ?? 0)
}
child.on('exit', shutdown)
// WSL 侧关闭管道后 EOF 自然传到 lingxi；信号兜底保证不残留进程。
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
