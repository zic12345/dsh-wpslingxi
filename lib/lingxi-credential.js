/**
 * 从 Windows 宿主「WPS 灵犀」桌面 App 的登录态提取 `wps_sid`。
 *
 * ## 实测落点与解密链（2026-10-12 真机验证）
 *
 * 1. 灵犀桌面是 Electron 应用，登录态（HttpOnly Secure cookie `wps_sid`，
 *    host=`.wps.cn`）落在 **passport 分区**的 Chromium Cookies SQLite：
 *    `%APPDATA%\WPS 灵犀\Partitions\lingxi-passport-v2-*\Network\Cookies`
 *    （分区名带哈希后缀，随安装变化 ⇒ 用 `lingxi-passport-v2-*` 通配）。
 *    主分区 `Network\Cookies` 与业务分区的库被进程**独占**，
 *    必须用 `[System.IO.File]::Open(FileShare.ReadWrite)` 共享读复制。
 * 2. Chromium cookie 加密：`v10`(3B magic) + 12B nonce + AES-256-GCM
 *    密文（尾部 16B tag）。AES key 存在根 `Local State` 的
 *    `os_crypt.encrypted_key`，base64 后前 5 字节是 `DPAPI` 前缀，
 *    去掉后用 Windows DPAPI（CurrentUser）解出 32B key。
 * 3. Node 侧解密后，明文**前 32 字节是 host 的 SHA256 前缀**，剥除后
 *    才是 UTF-8 cookie 值（实测 `wps_sid` 50 字符，形如 `V02S...`）。
 *
 * 鉴权口径（curl 实测）：云端**只认 Cookie 不认 Bearer**——
 * `Authorization: Bearer <sid>` → 401 UserUnauthorized；
 * `Cookie: wps_sid=<sid>` → 200。但本插件不直连云端，
 * SID 经 `LINGXI_WPS_SID` 环境变量交给 `lingxi.exe`（二进制内建支持，
 * 启动日志 `auth loaded from env`）。
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { psValue, runPowerShell } from './lingxi-win32.js';
const execFileAsync = promisify(execFile);
/** 允许显式注入 SID（调试 / 自动化），优先级最高。 */
const SID_ENV = 'DSH_LINGXI_WPS_SID';
/**
 * 进程内缓存：一次提取通常要 spawn PowerShell + DPAPI + 复制 SQLite，
 * 约数百毫秒；同一 dsh 进程内复用。
 *
 * ⚠️ 不带 TTL：SID 本身长寿命（WPS 网页会话周级），失效时适配器会在
 * 云端 401 后调 {@link extractWpsSid}（force=true）强制重取。
 */
let cachedSid;
/**
 * PowerShell 引导脚本：
 * - DPAPI 解出 Chromium AES key → `%TEMP%\dsh-lx-XXXX\aes.key`；
 * - 共享读复制 passport 分区 Cookies → 同目录 `Cookies`；
 * - 输出两个文件的 Windows 路径（随后用 `wslpath -u` 转 WSL 路径）。
 *
 * 全程只用 `Get-ChildItem -Filter WPS*` 通配中文目录（实测直写中文路径不稳）。
 */
const BOOTSTRAP_PS = String.raw `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$dir = Get-ChildItem $env:APPDATA -Directory | Where-Object { $_.Name -like 'WPS*' } | Select-Object -First 1
if (-not $dir) { throw 'WPS 灵犀 AppData 目录未找到（请先安装并登录桌面版）' }
$root = $dir.FullName

$work = Join-Path $env:TEMP ('dsh-lx-' + [guid]::NewGuid().ToString('N').Substring(0,12))
New-Item -ItemType Directory -Path $work -Force | Out-Null

# 1) Local State → DPAPI 解 AES key
$ls = Get-Content (Join-Path $root 'Local State') -Raw -Encoding UTF8 | ConvertFrom-Json
$encKey = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)
$dpapi = New-Object byte[] ($encKey.Length - 5)
[Array]::Copy($encKey, 5, $dpapi, 0, $dpapi.Length)
$aesKey = [Security.Cryptography.ProtectedData]::Unprotect($dpapi, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$keyPath = Join-Path $work 'aes.key'
[IO.File]::WriteAllBytes($keyPath, $aesKey)

# 2) passport 分区 Cookies（共享读复制，绕开 Electron 独占）
$part = Get-ChildItem (Join-Path $root 'Partitions') -Directory -Filter 'lingxi-passport-v2-*' | Select-Object -First 1
if (-not $part) { throw 'passport 分区未找到（灵犀版本不匹配？）' }
$cookieSrc = Join-Path $part.FullName 'Network\Cookies'
if (-not (Test-Path $cookieSrc)) { throw 'Cookies 数据库不存在（请先在桌面版登录灵犀）' }
$cookieDst = Join-Path $work 'Cookies'
$src = [IO.File]::Open($cookieSrc, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  $dst = [IO.File]::Open($cookieDst, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  try { $src.CopyTo($dst) } finally { $dst.Close() }
} finally { $src.Close() }

Write-Output ('WORKDIR=' + $work)
Write-Output ('KEY=' + $keyPath)
Write-Output ('COOKIES=' + $cookieDst)
`;
/** 把 Windows 路径转成 WSL 路径（`C:\x\y` → `/mnt/c/x/y`）。 */
async function toWslPath(windowsPath) {
    const { stdout } = await execFileAsync('wslpath', ['-u', windowsPath], { timeout: 10_000 });
    return stdout.trim();
}
/** 删除 Windows 侧临时目录（含敏感的 aes.key / Cookies 副本）。 */
async function removeWindowsWorkdir(env, windowsPath) {
    await runPowerShell(env, `Remove-Item -LiteralPath ${JSON.stringify(windowsPath)} -Recurse -Force -ErrorAction SilentlyContinue`, 15_000).catch(() => undefined);
}
/** 运行 PowerShell 引导并把产物路径转成 WSL 侧路径。 */
async function bootstrap(env) {
    const { stdout } = await runPowerShell(env, BOOTSTRAP_PS, 30_000);
    const workdirWin = psValue(stdout, 'WORKDIR');
    const keyWin = psValue(stdout, 'KEY');
    const cookiesWin = psValue(stdout, 'COOKIES');
    if (!workdirWin || !keyWin || !cookiesWin) {
        throw new Error(`灵犀登录态提取脚本输出不完整：${stdout.slice(0, 300)}`);
    }
    const [keyPath, cookiesPath] = await Promise.all([
        toWslPath(keyWin),
        toWslPath(cookiesWin),
    ]);
    return { workdirWin, keyPath, cookiesPath };
}
/**
 * 解一条 Chromium v10 cookie。
 *
 * 明文布局（Chromium `os_crypt`）：`SHA256(host_key)`(32B 前缀，可能存在)
 * + 实际值。实测灵犀的 cookie 带此前缀；对 host 做两种候选哈希
 *（`host_key` 原样 / 去前导点）各试一次，都不匹配则按「无前缀」处理。
 */
function decryptCookie(key, row) {
    // ⚠️ 必须拷成 Node Buffer：实测 node:sqlite 在多列查询下返回的 blob 是跨
    // realm 的 Uint8Array，其 `subarray(...).toString('latin1')` 会退化成
    // Array 的逗号拼接（"118,49,48" 而非 "v10"），GCM update 也随之认证失败。
    // `Buffer.from(Uint8Array)` 复制为本 realm Buffer 后一切正常（2026-10-12 实测）。
    const raw = Buffer.from(row.encrypted_value);
    if (raw.length < 3 + 12 + 16)
        return undefined;
    const prefix = raw.subarray(0, 3).toString('latin1');
    if (prefix !== 'v10')
        return undefined;
    const nonce = raw.subarray(3, 15);
    const ciphertext = raw.subarray(15, raw.length - 16);
    const authTag = raw.subarray(raw.length - 16);
    let plain;
    try {
        // ⚠️ Node GCM 与 Python cryptography 不同：tag 不能拼在密文尾部喂给 update，
        // 必须在 update/final 之前用 setAuthTag 单独设置，否则 final() 恒抛
        // 「Unsupported state or unable to authenticate data」（2026-10-12 实测）。
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(authTag);
        plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
    catch {
        // key 不匹配 / 数据损坏：跳过这一条（库里还有其它分区写入的无关 cookie）。
        return undefined;
    }
    const candidates = [row.host_key, row.host_key.replace(/^\./, '')];
    for (const host of candidates) {
        const digest = createHash('sha256').update(host).digest();
        if (plain.length >= 32 && plain.subarray(0, 32).equals(digest)) {
            return plain.subarray(32).toString('utf8');
        }
    }
    // 无前缀形态（部分 Chromium 版本不写 host 哈希）。
    return plain.toString('utf8');
}
/**
 * 提取当前登录用户的 `wps_sid`。
 *
 * @param env  WSL 环境（由 `detectWsl()` 得到）。
 * @param force 跳过进程内缓存强制重取（401 续期路径用）。
 * @throws 未安装 / 未登录 / 解密失败时抛带中文指引的 Error。
 */
export async function extractWpsSid(env, force = false) {
    if (!force && cachedSid)
        return cachedSid;
    const injected = process.env[SID_ENV];
    if (injected && injected.trim().length > 0) {
        cachedSid = injected.trim();
        return cachedSid;
    }
    const artifacts = await bootstrap(env);
    try {
        const key = await readFile(artifacts.keyPath);
        if (key.length !== 32) {
            throw new Error(`灵犀 AES key 长度异常（期望 32，实际 ${key.length}）`);
        }
        let db;
        try {
            // 只读打开副本；node:sqlite 为 Node 22.5+ 内建（本插件 engines 要求 ^22.19||>=24）。
            db = new DatabaseSync(artifacts.cookiesPath, { readOnly: true });
            const rows = db.prepare("SELECT host_key, name, encrypted_value FROM cookies WHERE name = 'wps_sid'").all();
            for (const row of rows) {
                const value = decryptCookie(key, row);
                // wps_sid 实测 50 字符、V02 前缀；做形状校验避免拿到脏值。
                if (value && /^V02[A-Za-z0-9]{20,}$/.test(value)) {
                    cachedSid = value;
                    return value;
                }
            }
            throw new Error('未在灵犀登录态中找到有效的 wps_sid —— 请先在 Windows 宿主打开「WPS 灵犀」桌面版并完成登录');
        }
        finally {
            db?.close();
        }
    }
    finally {
        // 密钥与 cookie 副本都是敏感临时文件，用完立刻删（Windows 侧目录）。
        await removeWindowsWorkdir(env, artifacts.workdirWin);
    }
}
/** 仅供测试：清空进程内缓存。 */
export function _resetLingxiSidCacheForTest() {
    cachedSid = undefined;
}
//# sourceMappingURL=lingxi-credential.js.map