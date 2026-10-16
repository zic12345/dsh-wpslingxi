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
