import { type WslEnvironment } from './lingxi-win32.js';
/**
 * 提取当前登录用户的 `wps_sid`。
 *
 * @param env  WSL 环境（由 `detectWsl()` 得到）。
 * @param force 跳过进程内缓存强制重取（401 续期路径用）。
 * @throws 未安装 / 未登录 / 解密失败时抛带中文指引的 Error。
 */
export declare function extractWpsSid(env: WslEnvironment, force?: boolean): Promise<string>;
/** 仅供测试：清空进程内缓存。 */
export declare function _resetLingxiSidCacheForTest(): void;
