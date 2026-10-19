/**
 * 灵犀云端「智点」接口（每日签到 / 余额 / 任务）。
 *
 * ## 与模型侧的区别（重要）
 *
 * 模型对话**没有**公开的 OpenAI 兼容端点，必须走桌面 App 的 `lingxi.exe`
 * 私有 stdio 桥（见 lingxi-bridge.ts）。但「智点」是挂在 **WPS 账号**上的
 * 营销/计费能力，走的是普通 HTTPS + 账号 Cookie 鉴权：
 *
 * - 基址 `https://lingxi.wps.cn`（WSL 可直连，无需宿主代理，2026-10-13 实测）；
 * - 鉴权头是 `Cookie: wps_sid=<sid>`，**不是** `Authorization: Bearer`
 *   （Bearer 实测 401 UserUnauthorized）；
 * - SID 由 {@link extractWpsSid} 从桌面 App 登录态自动提取。
 *
 * ## 端点（真机抓取，2026-10-13）
 *
 * - `GET  /api/public/v1/credits/balance` 智点余额；
 * - `GET  /api/public/v1/tasks`            任务列表（含 `daily_check_in`）；
 * - `POST /api/public/v1/tasks/daily_check_in/claim`  每日签到领奖（幂等：
 *   当天已领时服务端返回同一 trade_no，不重复发奖）。
 *
 * 任务对象里每日签到的关键字段：
 * `{ task_key:'daily_check_in', type:'daily', status:'claimable'|'claimed',
 *    reward_amount:100, extra:{ consecutive_days, today_day, today_reward,
 *    check_in_days:[{day,date,reward,status}] } }`。
 */
/** 灵犀云错误（带 result/v7code，便于上层区分未授权）。 */
export declare class LingxiCloudError extends Error {
    readonly code?: string;
    readonly v7code?: number;
    readonly httpStatus: number;
    constructor(message: string, httpStatus: number, code?: string, v7code?: number);
    /** 是否为登录态失效（需要重新提取桌面 SID）。 */
    get isUnauthorized(): boolean;
}
/** 一个签到日历日。 */
export interface CheckInDay {
    readonly day: number;
    readonly date: string;
    readonly reward: number;
    readonly status: 'claimed' | 'locked' | 'claimable' | string;
}
/** GET /tasks 解析出的每日签到状态（已规整为面板好用的形状）。 */
export interface DailyCheckInStatus {
    /** 今日是否已签到。 */
    readonly claimedToday: boolean;
    /** 原始任务状态。 */
    readonly taskStatus: string;
    /** 今日可领/已领的智点数。 */
    readonly todayReward: number;
    /** 当前连签天数。 */
    readonly consecutiveDays: number;
    /** 今天是连签周期里的第几天。 */
    readonly todayDay: number;
    /** 连签日历（含次日 locked，用于展示明天奖励）。 */
    readonly days: readonly CheckInDay[];
}
/** 智点余额摘要。 */
export interface CreditsBalance {
    /** 总可用智点（赠送+购买+合约）。 */
    readonly totalBalance: number;
    readonly totalBonus: number;
    readonly totalPurchased: number;
    readonly enabled: boolean;
}
/**
 * 一笔「赠送智点」池条目的有效期信息（来自 balance 接口的 bonus_credits /
 * purchased_credits 数组，2026-10-17 真机抓取）。
 *
 * 灵犀的赠送智点（签到/活动奖励）是**分批入账、各自独立过期**的：
 * 每一笔有自己的 effect_time（生效）和 expire_time（到期）。
 */
export interface CreditPoolItem {
    /** 当前余额（剩余未用）。 */
    readonly balance: number;
    /** 入账总额。 */
    readonly value: number;
    /** 已消耗。 */
    readonly consumed: number;
    /** 生效时间（ISO 字符串）。 */
    readonly effectTime: string;
    /** 到期时间（ISO 字符串）。 */
    readonly expireTime: string;
    /** 来源 sku（如 ai_credits_grant = 活动赠送）。 */
    readonly skuKey: string;
}
/** 一笔积分流水（transaction/list 返回条目）。 */
export interface CreditTransaction {
    /** 'topup'=充值/赠送入账；'expense'=消费支出。 */
    readonly type: 'topup' | 'expense' | string;
    /** 带符号金额：入账为正、支出为负。 */
    readonly amount: number;
    /** 关联的任务/请求标题。 */
    readonly taskName: string;
    /** 来源（如「灵犀客户端」）。 */
    readonly source: string;
    /** 发生时间（ISO）。 */
    readonly time: string;
    /** topup 条目特有：该笔的到期时间（expense 条目无）。 */
    readonly expireTime?: string;
    /** topup 条目特有：备注（如「智点赠送」）。 */
    readonly remark?: string;
}
/** 积分明细汇总（面板展示用）。 */
export interface CreditsDetail {
    /** 全部赠送池条目（按到期时间升序，快到期的在前）。 */
    readonly bonusPools: readonly CreditPoolItem[];
    /** 近 N 天内（含今天）即将到期的赠送池条目（balance>0）。 */
    readonly expiringSoon: readonly CreditPoolItem[];
    /** 近 N 天到期的剩余智点合计（balance 求和）。 */
    readonly expiringSoonTotal: number;
    /** 统计窗口的天数（本次计算用的近 N 天）。 */
    readonly expiringWindowDays: number;
    /** 最近流水（默认取前 20 条，已按时间倒序）。 */
    readonly recentTransactions: readonly CreditTransaction[];
}
/** 一键签到结果。 */
export interface ClaimResult {
    /** true=今天本来就已签到（本次没有新发奖）；false=本次真的领到了。 */
    readonly alreadyClaimed: boolean;
    /** 本次（或今日已领的）智点数。 */
    readonly rewardAmount: number;
    /** 该签到任务累计领取的智点。 */
    readonly totalClaimedCredits: number;
    readonly consecutiveDays: number;
    readonly todayDay: number;
}
/** 查询智点余额。 */
export declare function getCreditsBalance(sid: string): Promise<CreditsBalance>;
/**
 * 查询积分明细：赠送池全量（含有效期）+ 近 N 天到期统计 + 最近流水。
 *
 * 三个数据来源：
 * 1. `/credits/balance` 的 `bonus_credits` 数组——每一笔赠送智点都有独立的
 *    `expire_time`，这就是「积分有效期」的权威来源；
 * 2. `/credits/transaction/list`——最近的收支流水（topup/expense 混合倒序）。
 *
 * @param expiringDays 「近期到期」的统计窗口天数（默认 3 天）。
 */
export declare function getCreditsDetail(sid: string, expiringDays?: number): Promise<CreditsDetail>;
/**
 * 拉取最近的积分流水。
 *
 * 真机参数：`page` + `page_size`（2026-10-17 实测有效；limit 参数无效）。
 */
export declare function fetchCreditTransactions(sid: string, pageSize?: number): Promise<CreditTransaction[]>;
/** 查询每日签到状态（不领奖）。 */
export declare function getDailyCheckIn(sid: string): Promise<DailyCheckInStatus>;
/**
 * 一键签到。
 *
 * 先 GET 判今日状态：已签到则**不发** POST（明确区分「今天已签过」与「本次新领」），
 * 只有 `status !== 'claimed'` 才 POST 领奖。POST 本身幂等，这层预检只是为了给
 * 用户准确的反馈文案，也避免依赖服务端幂等的副作用。
 */
export declare function claimDailyCheckIn(sid: string): Promise<ClaimResult>;
