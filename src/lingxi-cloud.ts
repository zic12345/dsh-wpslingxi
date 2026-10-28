/**
 * 灵犀云端「智点」接口（每日签到 / 余额 / 任务）。
 *
 * ## 与模型侧的区别（重要）
 *
 * 模型对话走 `agent-runtime/chat/completions`（见 lingxi-direct.ts）；
 * 「智点」则是挂在 **WPS 账号**上的营销/计费能力，与模型通道共用同一个
 * 账号 Cookie 鉴权：
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

/** 云端基址；允许用环境变量覆盖（测试/未来域名迁移）。 */
const CLOUD_BASE = process.env.DSH_LINGXI_CLOUD_BASE ?? 'https://lingxi.wps.cn'
const API_PREFIX = '/api/public/v1'

/** 灵犀云错误（带 result/v7code，便于上层区分未授权）。 */
export class LingxiCloudError extends Error {
  readonly code?: string
  readonly v7code?: number
  readonly httpStatus: number
  constructor(message: string, httpStatus: number, code?: string, v7code?: number) {
    super(message)
    this.name = 'LingxiCloudError'
    this.httpStatus = httpStatus
    this.code = code
    this.v7code = v7code
  }
  /** 是否为登录态失效（需要重新提取桌面 SID）。 */
  get isUnauthorized(): boolean {
    return this.httpStatus === 401 || this.code === 'UserUnauthorized'
  }
}

/** 一个签到日历日。 */
export interface CheckInDay {
  readonly day: number
  readonly date: string
  readonly reward: number
  readonly status: 'claimed' | 'locked' | 'claimable' | string
}

/** GET /tasks 解析出的每日签到状态（已规整为面板好用的形状）。 */
export interface DailyCheckInStatus {
  /** 今日是否已签到。 */
  readonly claimedToday: boolean
  /** 原始任务状态。 */
  readonly taskStatus: string
  /** 今日可领/已领的智点数。 */
  readonly todayReward: number
  /** 当前连签天数。 */
  readonly consecutiveDays: number
  /** 今天是连签周期里的第几天。 */
  readonly todayDay: number
  /** 连签日历（含次日 locked，用于展示明天奖励）。 */
  readonly days: readonly CheckInDay[]
}

/** 智点余额摘要。 */
export interface CreditsBalance {
  /** 总可用智点（赠送+购买+合约）。 */
  readonly totalBalance: number
  readonly totalBonus: number
  readonly totalPurchased: number
  readonly enabled: boolean
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
  readonly balance: number
  /** 入账总额。 */
  readonly value: number
  /** 已消耗。 */
  readonly consumed: number
  /** 生效时间（ISO 字符串）。 */
  readonly effectTime: string
  /** 到期时间（ISO 字符串）。 */
  readonly expireTime: string
  /** 来源 sku（如 ai_credits_grant = 活动赠送）。 */
  readonly skuKey: string
}

/** 一笔积分流水（transaction/list 返回条目）。 */
export interface CreditTransaction {
  /** 'topup'=充值/赠送入账；'expense'=消费支出。 */
  readonly type: 'topup' | 'expense' | string
  /** 带符号金额：入账为正、支出为负。 */
  readonly amount: number
  /** 关联的任务/请求标题。 */
  readonly taskName: string
  /** 来源（如「灵犀客户端」）。 */
  readonly source: string
  /** 发生时间（ISO）。 */
  readonly time: string
  /** topup 条目特有：该笔的到期时间（expense 条目无）。 */
  readonly expireTime?: string
  /** topup 条目特有：备注（如「智点赠送」）。 */
  readonly remark?: string
}

/** 积分明细汇总（面板展示用）。 */
export interface CreditsDetail {
  /** 全部赠送池条目（按到期时间升序，快到期的在前）。 */
  readonly bonusPools: readonly CreditPoolItem[]
  /** 近 N 天内（含今天）即将到期的赠送池条目（balance>0）。 */
  readonly expiringSoon: readonly CreditPoolItem[]
  /** 近 N 天到期的剩余智点合计（balance 求和）。 */
  readonly expiringSoonTotal: number
  /** 统计窗口的天数（本次计算用的近 N 天）。 */
  readonly expiringWindowDays: number
  /** 最近流水（默认取前 20 条，已按时间倒序）。 */
  readonly recentTransactions: readonly CreditTransaction[]
}

/** 一键签到结果。 */
export interface ClaimResult {
  /** true=今天本来就已签到（本次没有新发奖）；false=本次真的领到了。 */
  readonly alreadyClaimed: boolean
  /** 本次（或今日已领的）智点数。 */
  readonly rewardAmount: number
  /** 该签到任务累计领取的智点。 */
  readonly totalClaimedCredits: number
  readonly consecutiveDays: number
  readonly todayDay: number
}

/** 灵犀统一响应包络。 */
interface LingxiEnvelope<T> {
  result?: string
  v7code?: number
  msg?: string
  hint?: string
  data?: T
}

/** 每日签到任务的原始结构（只声明用到的字段）。 */
interface DailyTaskRaw {
  task_key: string
  type: string
  title?: string
  status: string
  reward_amount: number
  extra?: {
    consecutive_days?: number
    today_day?: number
    today_reward?: number
    check_in_days?: Array<{ day: number; date: string; reward: number; status: string }>
  }
}

/** 用 SID 发 JSON 请求并解析统一包络；非 ok 抛 {@link LingxiCloudError}。 */
async function cloudFetch<T>(
  sid: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const url = `${CLOUD_BASE}${API_PREFIX}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Cookie: `wps_sid=${sid}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      // 调云端不允许无限挂起（按钮在等待）。
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    throw new LingxiCloudError(
      `无法连接灵犀云端（${CLOUD_BASE}）：${(error as Error).message}`,
      0,
      'NETWORK',
    )
  }

  let envelope: LingxiEnvelope<T> | null = null
  try {
    envelope = (await response.json()) as LingxiEnvelope<T>
  } catch {
    envelope = null
  }

  if (!response.ok || (envelope && envelope.result !== undefined && envelope.result !== 'ok')) {
    const code = typeof envelope?.result === 'string' ? envelope.result : undefined
    const message = envelope?.hint || envelope?.msg || `灵犀云端返回 ${response.status}`
    throw new LingxiCloudError(message, response.status, code, envelope?.v7code)
  }
  // data 可能为 undefined，但业务接口都应有 data；交给调用方判空。
  return envelope?.data as T
}

/* ---------------------------------- 余额 ---------------------------------- */

/** 余额原始响应里用到的字段。 */
interface BalanceRaw {
  enabled?: boolean
  total_balance?: number
  total_bonus?: number
  total_purchased?: number
  /** 赠送智点池（分批、各自带过期时间）。 */
  bonus_credits?: RawPoolItem[]
  /** 购买智点池（通常为空数组）。 */
  purchased_credits?: RawPoolItem[]
}

/** 一个池条目的原始形状。 */
interface RawPoolItem {
  balance?: number
  value?: number
  consumed?: number
  effect_time?: string
  expire_time?: string
  sku_key?: string
}

/** 把原始池条目规整为 {@link CreditPoolItem}。 */
function toPoolItem(raw: RawPoolItem): CreditPoolItem {
  return {
    balance: raw.balance ?? 0,
    value: raw.value ?? 0,
    consumed: raw.consumed ?? 0,
    effectTime: raw.effect_time ?? '',
    expireTime: raw.expire_time ?? '',
    skuKey: raw.sku_key ?? '',
  }
}

/** 查询智点余额。 */
export async function getCreditsBalance(sid: string): Promise<CreditsBalance> {
  const raw = await cloudFetch<BalanceRaw>(sid, '/credits/balance')
  return {
    totalBalance: raw.total_balance ?? 0,
    totalBonus: raw.total_bonus ?? 0,
    totalPurchased: raw.total_purchased ?? 0,
    enabled: raw.enabled ?? true,
  }
}

/* ------------------------------ 积分明细/到期 ------------------------------ */

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
export async function getCreditsDetail(sid: string, expiringDays = 3): Promise<CreditsDetail> {
  // ① 余额接口里的赠送池（已含到期时间）。
  const balance = await cloudFetch<BalanceRaw>(sid, '/credits/balance')
  const pools = (balance.bonus_credits ?? []).map(toPoolItem)
  // 按到期时间升序（早到期的在前），空 expire_time 的排末尾。
  pools.sort((a, b) => {
    if (!a.expireTime && !b.expireTime) return 0
    if (!a.expireTime) return 1
    if (!b.expireTime) return -1
    return a.expireTime.localeCompare(b.expireTime)
  })

  // ② 计算「近 N 天到期」窗口：从现在起 expiringDays 天内会过期、且仍有余额的条目。
  const now = Date.now()
  const windowMs = expiringDays * 24 * 60 * 60 * 1000
  const expiringSoon = pools.filter((item) => {
    if (item.balance <= 0 || !item.expireTime) return false
    const expireMs = Date.parse(item.expireTime)
    if (Number.isNaN(expireMs)) return false
    // 已过期的也算「即将到期/已到期预警」窗口内。
    return expireMs - now <= windowMs
  })
  const expiringSoonTotal = expiringSoon.reduce((sum, item) => sum + item.balance, 0)

  // ③ 最近流水（默认 20 条）。
  const txList = await fetchCreditTransactions(sid, 20)

  return {
    bonusPools: pools,
    expiringSoon,
    expiringSoonTotal,
    expiringWindowDays: expiringDays,
    recentTransactions: txList,
  }
}

/** 流水列表原始响应。 */
interface TransactionListRaw {
  list?: Array<{
    type?: string
    amount?: number
    task_name?: string
    source?: string
    time?: string
    remark?: string
    expire_time?: string
  }>
  has_more?: boolean
}

/**
 * 拉取最近的积分流水。
 *
 * 真机参数：`page` + `page_size`（2026-10-17 实测有效；limit 参数无效）。
 */
export async function fetchCreditTransactions(
  sid: string,
  pageSize = 20,
): Promise<CreditTransaction[]> {
  const raw = await cloudFetch<TransactionListRaw>(
    sid,
    `/credits/transaction/list?page=1&page_size=${pageSize}`,
  )
  return (raw.list ?? []).map((item) => ({
    type: item.type ?? 'expense',
    amount: item.amount ?? 0,
    taskName: item.task_name ?? '',
    source: item.source ?? '',
    time: item.time ?? '',
    remark: item.remark,
    expireTime: item.expire_time,
  }))
}

/* --------------------------------- 签到任务 -------------------------------- */

interface TasksRaw {
  tasks?: DailyTaskRaw[]
}

/** 取每日签到任务原始对象；找不到时抛错（接口形态变化的显式失败）。 */
async function fetchDailyTask(sid: string): Promise<DailyTaskRaw> {
  const raw = await cloudFetch<TasksRaw>(sid, '/tasks')
  const task = raw.tasks?.find((item) => item.task_key === 'daily_check_in')
  if (!task) {
    throw new LingxiCloudError('灵犀任务列表中没有「每日签到」任务', 200, 'TASK_MISSING')
  }
  return task
}

/** 把原始任务规整成面板状态。 */
function toCheckInStatus(task: DailyTaskRaw): DailyCheckInStatus {
  const extra = task.extra ?? {}
  return {
    claimedToday: task.status === 'claimed',
    taskStatus: task.status,
    todayReward: extra.today_reward ?? task.reward_amount ?? 0,
    consecutiveDays: extra.consecutive_days ?? 0,
    todayDay: extra.today_day ?? 0,
    days: (extra.check_in_days ?? []).map((day) => ({
      day: day.day,
      date: day.date,
      reward: day.reward,
      status: day.status,
    })),
  }
}

/** 查询每日签到状态（不领奖）。 */
export async function getDailyCheckIn(sid: string): Promise<DailyCheckInStatus> {
  return toCheckInStatus(await fetchDailyTask(sid))
}

/* --------------------------------- 领奖动作 -------------------------------- */

/** claim 响应原始结构（只声明用到的字段）。 */
interface ClaimRaw {
  task_key?: string
  reward_amount?: number
  trade_no?: string
  total_claimed_credits?: number
  extra?: {
    consecutive_days?: number
    today_day?: number
    today_reward?: number
  }
}

/**
 * 一键签到。
 *
 * 先 GET 判今日状态：已签到则**不发** POST（明确区分「今天已签过」与「本次新领」），
 * 只有 `status !== 'claimed'` 才 POST 领奖。POST 本身幂等，这层预检只是为了给
 * 用户准确的反馈文案，也避免依赖服务端幂等的副作用。
 */
export async function claimDailyCheckIn(sid: string): Promise<ClaimResult> {
  const before = await fetchDailyTask(sid)
  const beforeStatus = toCheckInStatus(before)
  if (before.status === 'claimed') {
    return {
      alreadyClaimed: true,
      rewardAmount: beforeStatus.todayReward,
      // 已签到时拿不到「累计领取」，用日历里 claimed 的奖励求和做最佳努力展示。
      totalClaimedCredits: beforeStatus.days
        .filter((day) => day.status === 'claimed')
        .reduce((sum, day) => sum + day.reward, 0),
      consecutiveDays: beforeStatus.consecutiveDays,
      todayDay: beforeStatus.todayDay,
    }
  }

  const raw = await cloudFetch<ClaimRaw>(sid, '/tasks/daily_check_in/claim', {
    method: 'POST',
    body: { task_key: 'daily_check_in' },
  })
  const extra = raw.extra ?? {}
  return {
    alreadyClaimed: false,
    rewardAmount: raw.reward_amount ?? beforeStatus.todayReward,
    totalClaimedCredits: raw.total_claimed_credits ?? 0,
    consecutiveDays: extra.consecutive_days ?? beforeStatus.consecutiveDays,
    todayDay: extra.today_day ?? beforeStatus.todayDay,
  }
}
